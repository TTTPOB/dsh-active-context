// Published executor behavior does not require the capture-capable Query fork.
export default {
  cacheDir: '.scratch/text-anchors/vite-published',
  test: { include: ['tests/guard.spec.ts', 'tests/executors.spec.ts'], maxWorkers: 1, pool: 'forks' },
}
