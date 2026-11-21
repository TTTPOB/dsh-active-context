// Test installed DSH release packages without source aliases.
export default {
  cacheDir: '.scratch/text-anchors/vite-published',
  test: { include: ['tests/guard.spec.ts', 'tests/executors.spec.ts', 'tests/loop-tools-replay.spec.ts', 'tests/ptc.spec.ts', 'tests/reminder-lifecycle.spec.ts', 'tests/prompt-examples.spec.ts'], maxWorkers: 1, pool: 'forks' },
}
