/** 主 Agent 原生只读循环的作者可调上限；Runner 仍负责最终硬限制。 */
export const DEFAULT_NATIVE_AGENT_LIMITS = { maxSteps: 12, maxToolCalls: 16 } as const
export const NATIVE_AGENT_LIMIT_BOUNDS = {
  maxSteps: { min: 2, max: 20 },
  maxToolCalls: { min: 1, max: 40 },
} as const

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  if (value == null || value === '') return fallback
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(min, Math.floor(parsed)))
}

export function resolveNativeAgentLimits(input: {
  masterAgentMaxSteps?: unknown
  masterAgentMaxToolCalls?: unknown
}): { maxSteps: number; maxToolCalls: number } {
  return {
    maxSteps: clamp(input.masterAgentMaxSteps, DEFAULT_NATIVE_AGENT_LIMITS.maxSteps,
      NATIVE_AGENT_LIMIT_BOUNDS.maxSteps.min, NATIVE_AGENT_LIMIT_BOUNDS.maxSteps.max),
    maxToolCalls: clamp(input.masterAgentMaxToolCalls, DEFAULT_NATIVE_AGENT_LIMITS.maxToolCalls,
      NATIVE_AGENT_LIMIT_BOUNDS.maxToolCalls.min, NATIVE_AGENT_LIMIT_BOUNDS.maxToolCalls.max),
  }
}
