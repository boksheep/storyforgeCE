import { db } from '../db/schema'

/**
 * 主 Agent 运行指标（AGENT-2 · 底部状态栏数据源）。
 *
 * 两类数据来源不同，必须分开看：
 *  1. **累计用量**：来自 aiUsageLog 中 category 以 `agent.` 开头的调用，含 token 与缓存命中，
 *     跨刷新持久；这是"花了多少"的真相。
 *  2. **当前上下文压力**：AgentTeamBudgetTracker 在每次 reserveCall 前估算的输入 token，
 *     只反映"这一次调用往模型里塞了多少"，属于会话级状态（localStorage 缓存一次，刷新后仍可见）。
 */

export interface AgentUsageSummary {
  calls: number
  inputTokens: number
  outputTokens: number
  /** 服务端报告命中缓存的输入 token 合计。 */
  cachedInputTokens: number
  /**
   * 缓存命中率 = 命中输入 / 总输入。
   * 只要有一次调用返回过缓存字段就给出数值；全部未返回时为 null（未知，不是 0%）。
   */
  cacheHitRate: number | null
  costUsd: number
  lastCallAt: number | null
}

export const EMPTY_AGENT_USAGE: AgentUsageSummary = {
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheHitRate: null,
  costUsd: 0,
  lastCallAt: null,
}

/** 汇总某项目主 Agent（category 前缀 agent.）的累计用量。 */
export async function summarizeAgentUsage(input: {
  projectId: number
  since?: number
}): Promise<AgentUsageSummary> {
  const rows = await db.aiUsageLog.where('projectId').equals(input.projectId).toArray()
  let calls = 0
  let inputTokens = 0
  let outputTokens = 0
  let cachedInputTokens = 0
  let costUsd = 0
  let cacheReported = false
  let lastCallAt: number | null = null
  for (const row of rows) {
    if (!row.category?.startsWith('agent.')) continue
    if (input.since != null && row.timestamp < input.since) continue
    calls += 1
    inputTokens += row.inputTokens ?? 0
    outputTokens += row.outputTokens ?? 0
    costUsd += row.costUsd ?? 0
    if (typeof row.cachedInputTokens === 'number') {
      cachedInputTokens += row.cachedInputTokens
      cacheReported = true
    }
    if (lastCallAt == null || row.timestamp > lastCallAt) lastCallAt = row.timestamp
  }
  return {
    calls,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheHitRate: cacheReported && inputTokens > 0 ? cachedInputTokens / inputTokens : null,
    costUsd,
    lastCallAt,
  }
}

export interface AgentContextUsage {
  /** 最近一次模型调用的估算输入 token。 */
  lastInputTokens: number
  /** 本轮所有调用里最大的估算输入 token（上下文压力峰值）。 */
  peakInputTokens: number
  /** 本轮 Agent 团队预算快照（可能尚不可用）。 */
  teamBudget?: { usedTokens: number; maxTokens: number; calls: number; maxCalls: number }
  updatedAt: number
}

const STORAGE_PREFIX = 'storyforge-agent-context-usage-'
const memory = new Map<number, AgentContextUsage>()

export function recordAgentContextUsage(projectId: number, usage: AgentContextUsage): void {
  memory.set(projectId, usage)
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${projectId}`, JSON.stringify(usage))
  } catch {
    // 存储不可用（隐私模式/配额）时只保留内存值，不影响主流程
  }
}

export function readAgentContextUsage(projectId: number): AgentContextUsage | null {
  const cached = memory.get(projectId)
  if (cached) return cached
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${projectId}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as AgentContextUsage
    if (typeof parsed?.updatedAt !== 'number') return null
    memory.set(projectId, parsed)
    return parsed
  } catch {
    return null
  }
}

export function clearAgentContextUsage(projectId: number): void {
  memory.delete(projectId)
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${projectId}`)
  } catch {
    // 忽略
  }
}

/** 1_234 → 1.2K；1_234_567 → 1.23M。状态栏空间有限。 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0'
  if (value < 1_000) return String(Math.round(value))
  if (value < 1_000_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}K`
  return `${(value / 1_000_000).toFixed(2)}M`
}

export function formatPercent(ratio: number | null): string {
  if (ratio == null || !Number.isFinite(ratio)) return '—'
  return `${Math.round(ratio * 100)}%`
}
