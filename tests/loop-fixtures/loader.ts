import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import * as ActiveContext from '../../src/index.ts'
import type { AcpConfig } from '../../src/types.ts'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'

/** Load the real ACP namespace through a test-only YAML and the production Loader.
 * This is source-plane composition, not a replacement for package-manager peer resolution.
 */
export async function loadActiveContext(ctx: Context, config: { acp?: Partial<AcpConfig>; basic?: BasicCompactionConfig } = {}) {
  const scratch = fileURLToPath(new URL('../../.scratch/text-anchors/tests/', import.meta.url))
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'loader-'))
  try {
    const yaml = join(root, 'cordis.yml')
    await writeFile(yaml, '- name: cordis:active-context\n  config: ' + JSON.stringify(config) + '\n')
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.builtins['active-context'] = ActiveContext
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(yaml).href } })
    await ctx.loader.await()
    const pending = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
    if (pending.length !== 0) throw new Error('ACP Loader entry did not activate')
    ctx.effect(() => () => rm(root, { recursive: true, force: true }))
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
