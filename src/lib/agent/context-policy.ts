export const AGENT_CONTEXT_PROFILES = ['lean', 'balanced', 'full'] as const
export type AgentContextProfile = typeof AGENT_CONTEXT_PROFILES[number]

export const AGENT_CONTEXT_TASK_KINDS = [
  'agent-world-origin',
  'agent-character',
  'agent-inspiration',
  'agent-outline',
  'agent-prose',
] as const
export type AgentContextTaskKind = typeof AGENT_CONTEXT_TASK_KINDS[number]

export type AgentContextProfiles = Record<AgentContextTaskKind, AgentContextProfile>

export interface AgentContextPolicy {
  profile: AgentContextProfile
  /** 每个登记源自身软上限的比例，只允许收窄，不允许突破注册表。 */
  sourceBudgetScale: number
  /** 当前领域一次上下文装配的上限；实际还会受模型窗口约束。 */
  maxInputTokens: number
}

export interface AgentContextEvidence {
  profile: AgentContextProfile
  included: string[]
  omitted: string[]
  trimmed: string[]
  estimatedInputTokens: number
  inputBudgetTokens: number
}

export const DEFAULT_AGENT_CONTEXT_PROFILES: AgentContextProfiles = {
  'agent-world-origin': 'balanced',
  'agent-character': 'balanced',
  'agent-inspiration': 'balanced',
  'agent-outline': 'balanced',
  'agent-prose': 'balanced',
}

const PROFILE_SCALE: Record<AgentContextProfile, number> = {
  lean: 0.45,
  balanced: 0.72,
  full: 1,
}

const ROLE_MAX_INPUT_TOKENS: Record<AgentContextTaskKind, Record<AgentContextProfile, number>> = {
  'agent-world-origin': { lean: 9_000, balanced: 14_000, full: 19_400 },
  'agent-character': { lean: 13_000, balanced: 20_000, full: 28_500 },
  'agent-inspiration': { lean: 5_000, balanced: 8_000, full: 11_000 },
  'agent-outline': { lean: 18_000, balanced: 32_000, full: 48_000 },
  'agent-prose': { lean: 24_000, balanced: 42_000, full: 64_000 },
}

export function sanitizeAgentContextProfiles(value: unknown): AgentContextProfiles {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const profiles = { ...DEFAULT_AGENT_CONTEXT_PROFILES }
  for (const taskKind of AGENT_CONTEXT_TASK_KINDS) {
    const profile = raw[taskKind]
    if (AGENT_CONTEXT_PROFILES.includes(profile as AgentContextProfile)) {
      profiles[taskKind] = profile as AgentContextProfile
    }
  }
  return profiles
}

export function resolveAgentContextPolicy(
  taskKind: AgentContextTaskKind,
  profile: AgentContextProfile,
): AgentContextPolicy {
  return {
    profile,
    sourceBudgetScale: PROFILE_SCALE[profile],
    maxInputTokens: ROLE_MAX_INPUT_TOKENS[taskKind][profile],
  }
}

/** 多个正式 read tool 共同服务一个领域时，按权重拆分同一总预算，避免各工具重复拿满上限。 */
export function splitAgentContextPolicy(
  policy: AgentContextPolicy,
  weights: readonly number[],
): AgentContextPolicy[] {
  const safeWeights = weights.map(weight => Number.isFinite(weight) && weight > 0 ? weight : 1)
  const totalWeight = safeWeights.reduce((sum, weight) => sum + weight, 0)
  let remaining = policy.maxInputTokens
  return safeWeights.map((weight, index) => {
    const maxInputTokens = index === safeWeights.length - 1
      ? remaining
      : Math.max(1, Math.floor(policy.maxInputTokens * weight / totalWeight))
    remaining -= maxInputTokens
    return { ...policy, maxInputTokens }
  })
}

export function evidenceFromContextResult(
  profile: AgentContextProfile,
  result: {
    included: readonly string[]
    omitted: readonly string[]
    trimmed: readonly string[]
    totalInputTokens: number
    inputBudget: number
  },
): AgentContextEvidence {
  return {
    profile,
    included: [...new Set(result.included)],
    omitted: [...new Set(result.omitted)],
    trimmed: [...new Set(result.trimmed)],
    estimatedInputTokens: result.totalInputTokens,
    inputBudgetTokens: result.inputBudget,
  }
}

export function mergeContextEvidence(
  profile: AgentContextProfile,
  results: Array<{
    included: readonly string[]
    omitted: readonly string[]
    trimmed: readonly string[]
    totalInputTokens: number
    inputBudget: number
  }>,
): AgentContextEvidence {
  return {
    profile,
    included: [...new Set(results.flatMap(result => result.included))],
    omitted: [...new Set(results.flatMap(result => result.omitted))],
    trimmed: [...new Set(results.flatMap(result => result.trimmed))],
    estimatedInputTokens: results.reduce((sum, result) => sum + result.totalInputTokens, 0),
    inputBudgetTokens: results.reduce((sum, result) => sum + result.inputBudget, 0),
  }
}
