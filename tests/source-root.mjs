import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Source-plane acceptance requires the capture-capable Session/Query fork.
export const harness = resolve(process.env.DSH_SOURCE_ROOT ?? fileURLToPath(new URL('../../deepseek-harness/', import.meta.url)))
