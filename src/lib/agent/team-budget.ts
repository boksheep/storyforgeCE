import { estimateTokens } from '../ai/context-budget'
import type { ChatMessage } from '../types'

export const AGENT_TEAM_BUDGET_PROFILES = ['economy', 'balanced', 'expanded'] as const
export type AgentTeamBudgetProfile = typeof AGENT_TEAM_BUDGET_PROFILES[number] | 'custom'

export const AGENT_TEAM_BUDGET_TOKENS_KEY = 'storyforge-agent-team-budget-tokens'
export const TEAM_BUDGET_MIN_TOKENS = 50_000
export const TEAM_BUDGET_MAX_TOKENS = 999_000
export const AGENT_TEAM_BUDGET_PRESET_META = {
  economy: { label: '节省', description: '50–100K 区间，适合快速迭代', maxTokens: 80_000 },
  balanced: { label: '均衡', description: '100–250K 区间，质量与成本平衡', maxTokens: 160_000 },
  expanded: { label: '充分', description: '250–500K 区间，适合复杂长上下文任务', maxTokens: 400_000 },
} as const

export function clampTeamBudgetTokens(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return AGENT_TEAM_BUDGET_PRESET_META.balanced.maxTokens
  return Math.min(TEAM_BUDGET_MAX_TOKENS, Math.max(TEAM_BUDGET_MIN_TOKENS, Math.floor(n / 1000) * 1000))
}

export interface AgentTeamBudgetPolicy {
  profile: AgentTeamBudgetProfile
  maxTokens: number
  maxCalls: number
  maxCanonRetries: number
}

export interface AgentTeamBudgetEvidence extends AgentTeamBudgetPolicy {
  usedTokens: number
  calls: number
  canonRetries: number
}

export interface AgentTeamCallReservation {
  label: string
  estimatedInputTokens: number
  reservedOutputTokens: number
}

const POLICIES: Record<Exclude<AgentTeamBudgetProfile, 'custom'>, AgentTeamBudgetPolicy> = {
  economy: { profile: 'economy', maxTokens: 80_000, maxCalls: 12, maxCanonRetries: 1 },
  balanced: { profile: 'balanced', maxTokens: 160_000, maxCalls: 12, maxCanonRetries: 1 },
  expanded: { profile: 'expanded', maxTokens: 400_000, maxCalls: 12, maxCanonRetries: 1 },
}

export class AgentTeamBudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentTeamBudgetExceededError'
  }
}

export function sanitizeAgentTeamBudgetProfile(value: unknown): AgentTeamBudgetProfile {
  if (value === 'custom') return 'custom'
  return AGENT_TEAM_BUDGET_PROFILES.includes(value as Exclude<AgentTeamBudgetProfile, 'custom'>)
    ? value as Exclude<AgentTeamBudgetProfile, 'custom'>
    : 'balanced'
}

export function resolveAgentTeamBudgetPolicy(
  profile: AgentTeamBudgetProfile,
  customMaxTokens?: number,
): AgentTeamBudgetPolicy {
  if (profile === 'custom') {
    let stored = customMaxTokens
    if (stored == null && typeof localStorage !== 'undefined') {
      stored = Number(localStorage.getItem(AGENT_TEAM_BUDGET_TOKENS_KEY))
    }
    return { profile: 'custom', maxTokens: clampTeamBudgetTokens(stored), maxCalls: 12, maxCanonRetries: 1 }
  }
  return { ...POLICIES[profile] }
}

function outputText(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export class AgentTeamBudgetTracker {
  readonly policy: AgentTeamBudgetPolicy
  private usedTokens = 0
  private calls = 0
  private canonRetries = 0
  private readonly onReserve?: (reservation: AgentTeamCallReservation) => void

  /**
   * `onReserve` 只用于观测（底部状态栏的上下文压力），不参与预算判定，
   * 因此实现里抛错也不会影响调用链。
   */
  constructor(profile: AgentTeamBudgetProfile, onReserve?: (reservation: AgentTeamCallReservation) => void,
    maxCallsOverride?: number) {
    const policy = resolveAgentTeamBudgetPolicy(profile)
    this.policy = Number.isFinite(maxCallsOverride) && maxCallsOverride != null
      ? { ...policy, maxCalls: Math.min(20, Math.max(1, Math.floor(maxCallsOverride))) }
      : policy
    this.onReserve = onReserve
  }

  reserveCall(input: {
    label: string
    messages: readonly ChatMessage[]
    maxOutputTokens: number
  }): AgentTeamCallReservation {
    const estimatedInputTokens = input.messages
      .reduce((sum, message) => sum + estimateTokens(message.content), 0)
    const reservedOutputTokens = Math.max(1, Math.floor(input.maxOutputTokens))
    if (this.calls + 1 > this.policy.maxCalls) {
      throw new AgentTeamBudgetExceededError(
        `本轮 Agent 团队已达到 ${this.policy.maxCalls} 次模型调用上限，已在发起“${input.label}”前停止。`,
      )
    }
    const projected = this.usedTokens + estimatedInputTokens + reservedOutputTokens
    if (projected > this.policy.maxTokens) {
      throw new AgentTeamBudgetExceededError(
        `本轮 Agent 团队预算不足：已用约 ${this.usedTokens.toLocaleString()} tokens，`
        + `“${input.label}”最坏还需约 ${(estimatedInputTokens + reservedOutputTokens).toLocaleString()}，`
        + `上限为 ${this.policy.maxTokens.toLocaleString()}。已在调用前停止，没有产生这次费用。`,
      )
    }
    this.calls += 1
    const reservation = { label: input.label, estimatedInputTokens, reservedOutputTokens }
    try {
      this.onReserve?.(reservation)
    } catch {
      // 观测失败不影响调用
    }
    return reservation
  }

  settleCall(reservation: AgentTeamCallReservation, output: unknown): void {
    this.usedTokens += reservation.estimatedInputTokens + estimateTokens(outputText(output))
  }

  settleFailedCall(reservation: AgentTeamCallReservation): void {
    this.usedTokens += reservation.estimatedInputTokens
  }

  claimCanonRetry(issues: readonly { message: string }[]): void {
    if (this.canonRetries >= this.policy.maxCanonRetries) {
      throw new AgentTeamBudgetExceededError(
        `确定性 Canon 校验仍未通过，且本轮 ${this.policy.maxCanonRetries} 次受控打回机会已经用完：`
        + issues.map(issue => issue.message).join('；'),
      )
    }
    this.canonRetries += 1
  }

  snapshot(): AgentTeamBudgetEvidence {
    return {
      ...this.policy,
      usedTokens: this.usedTokens,
      calls: this.calls,
      canonRetries: this.canonRetries,
    }
  }
}
