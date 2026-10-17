import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  acp: { type: 'string' }, query: { type: 'string' }, session: { type: 'string' }, sqlite: { type: 'string' },
} })
for (const key of ['acp', 'query', 'session', 'sqlite']) assert.ok(values[key], `--${key} requires a tarball path or verified Release URL`)
const source = value => value.startsWith('https://') ? value : 'file:' + resolve(value)
const scratch = process.env.DSH_CONFIG_TEST_ROOT ?? fileURLToPath(new URL('../../.scratch/text-anchors/delivery/', import.meta.url))
await mkdir(scratch, { recursive: true })
const root = await mkdtemp(join(scratch, 'delivery-'))
const host = join(root, 'installation')
const home = join(root, 'home')
const profile = join(home, 'profiles/web')
const manifestPath = join(profile, 'package.json')
const session = source(values.session)
const sqlite = source(values.sqlite)
const put = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n')
const install = cwd => execFileSync('pnpm', [
  'install', ...(cwd === host ? [] : ['--ignore-workspace']), '--config.auto-install-peers=false',
  '--config.enable-global-virtual-store=false', '--config.verify-deps-before-run=false',
], { cwd, stdio: 'inherit', env: { ...process.env, npm_config_verify_deps_before_run: 'false', DSH_HOME: home }, timeout: 600_000 })
try {
  await mkdir(host, { recursive: true })
  await mkdir(profile, { recursive: true })
  await put(join(host, 'package.json'), {
    name: 'acp-isolated-host', private: true, type: 'module',
    dependencies: {
      '@deepseek-ai/dsh': '0.2.1-rc.1', '@deepseek-ai/cordis-plugin-group': '1.0.5',
      '@deepseek-ai/cordis': '4.0.5', '@deepseek-ai/schemastery': '3.18.5',
      // Required peers of Tools, AgentLoop, Persistence and Basic belong to the Host root.
      ...Object.fromEntries([
        'llm', 'agent', 'scope', 'sandbox', 'session', 'ptc-runtime',
        'system-prompt', 'user-approval', 'sandbox-policy', 'tools', 'session-projection',
        'session-persistence', 'commands', 'compaction', 'token-meter',
        'compaction-tool-result-pruner', 'agent-loop',
      ].map(name => ['@deepseek-ai/dsh-' + name, '0.2.1-rc.1'])),
    },
  })
  await put(join(host, 'pnpm-workspace.yaml'), {
    packages: [], blockExoticSubdeps: false,
    allowBuilds: { '@deepseek-ai/dsh-subprocess-local': true, '@google/genai': true, koffi: true, 'node-pty': true, protobufjs: true },
    overrides: {
      '@deepseek-ai/dsh-session': session,
      '@deepseek-ai/dsh-session-query': source(values.query),
      '@deepseek-ai/dsh-session-query-sqlite': sqlite,
    },
  })
  const dependencies = { 'dsh-active-context': source(values.acp) }
  await put(manifestPath, { name: 'acp-isolated-profile', private: true, type: 'module', dependencies, dsh: { profile: { bundles: [] } } })
  install(host)
  install(profile)
  assert.deepEqual(JSON.parse(await readFile(manifestPath, 'utf8')).dependencies, dependencies)
  // The profile must not acquire its own Cordis/DSH service packages, even transitively.
  const profileLock = await readFile(join(profile, 'pnpm-lock.yaml'), 'utf8')
  assert.doesNotMatch(profileLock, /^  ['"]?@deepseek-ai\/(?:cordis|dsh-[^/'"]+)@/m)
  const hostRequire = createRequire(join(host, 'package.json'))
  const anchor = await realpath(hostRequire.resolve('@deepseek-ai/dsh/package.json'))
  const result = execFileSync(process.execPath, [fileURLToPath(new URL('./verify.mjs', import.meta.url)), anchor, home], {
    cwd: profile, env: { ...process.env, npm_config_verify_deps_before_run: 'false', DSH_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: 120_000,
  })
  console.log(result.trim())
} finally {
  await rm(root, { recursive: true, force: true })
}
console.log(JSON.stringify({ installation: 'clean pnpm Host + plugin-only profile', hostStarted: false, renderedConfigurationVerified: false, cleaned: true }))
