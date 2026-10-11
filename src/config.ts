/** Loader validation for ACP budgets and the independent native Basic policy. */
import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import type { AcpConfig, PluginConfig } from './types.ts'

const positive = () => z.number().step(1).min(1)
const route = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  nudgeAtTokens: positive().required(),
  resetBelowTokens: z.number().step(1).min(0).required(),
})

/** Budget defaults are conservative initial limits; route thresholds require deployment values. */
export const AcpConfigSchema = z.object({
  maxRegions: z.number().step(1).min(2).default(4),
  summaryMaxTokens: positive().default(8000),
  summaryMaxBytes: positive().default(32000),
  resultMaxBytes: positive().default(16000),
  confirmationMaxTokens: positive().default(256),
  confirmationMaxBytes: positive().default(2048),
  confirmationMaxIds: positive().default(4),
  reminderMaxTokens: positive().default(1200),
  reminderMaxBytes: positive().default(6000),
  reminderMaxRegions: z.number().step(1).min(0).default(3),
  reminderPreviewChars: z.number().step(1).min(0).default(160),
  taskSourceKinds: z.array(z.string()).default(['user', 'agent-message', 'goal', 'schedule']),
  pressureRoutes: z.array(route).default([]),
})

/** Public Cordis schema; native and ACP settings are never merged. */
export const Config = z.object({
  acp: AcpConfigSchema.default(AcpConfigSchema({})),
  basic: BasicCompactionEngine.Config.default({}),
})
export type Config = PluginConfig

/** Reject self-contained threshold errors before registering any provider or hook. */
export function validateAcpConfig(config: AcpConfig): void {
  const routes = new Set<string>()
  for (const route of config.pressureRoutes) {
    const key = `${route.provider}/${route.model}`
    if (routes.has(key)) throw new Error(`ACP: duplicate pressure route ${key}`)
    routes.add(key)
    if (route.provider.trim().length === 0 || route.model.trim().length === 0
      || route.resetBelowTokens >= route.nudgeAtTokens) {
      throw new Error(`ACP: route ${key} requires non-empty provider/model and resetBelowTokens < nudgeAtTokens`)
    }
  }
}
