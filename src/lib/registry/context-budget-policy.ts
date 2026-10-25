/**
 * BUDGET-1 · 上下文预算策略（作者可调）
 *
 * 背景：登记源（`CONTEXT_SOURCES.budgetTokens`）原本是只读常量。用户只能改「模型窗口」
 * 和主 Agent 的领域档位，因此「词条较多，已截断」这类**源内部**硬截断无法调整——
 * 例如 `buildCodexContext` 的 2500 字上限先于源 token 预算生效，把预算调大也没用。
 *
 * 本模块把「能否自动截断」和「每个源的真实预算」变成作者的显式策略，并保持三条边界：
 *
 *  1. 策略只**放宽**到「本轮可用输入预算（模型窗口 − 输出预留 − 安全边际）」为止，
 *     绝不允许单个源突破模型物理窗口；关掉截断后仍由总窗口兜底，不会发出必被 API 拒绝的请求。
 *  2. 每源 token 预算与模型窗口取较小值；`0` 表示沿用登记表默认值。
 *  3. 属于「本机 AI 执行偏好」，与 AI 连接预设、领域档位同级：只进 localStorage，
 *     不进 Canon / IndexedDB / 项目 JSON / API Key 生命周期。
 *
 * 注意：领域级 `maxInputTokens`（主 Agent 角色档位）保持独立，仍按比例收窄源预算。
 */

/** localStorage 键。与 AI 连接预设、领域档位同级：本机执行偏好，不随项目导出。 */
export const CONTEXT_BUDGET_POLICY_KEY = 'storyforge-context-budget-policy'

/** 单个上下文源的作者覆盖值。 */
export interface ContextSourceBudgetPolicy {
  /**
   * 该源的实际 token 预算。
   * - `undefined` / `0` = 沿用注册表 `budgetTokens`（默认，零行为变化）。
   * - `> 0` = 覆盖值；仍与「本轮可用输入预算」取较小值，不能突破模型窗口。
   */
  budgetTokens?: number
  /**
   * 该源的字符硬上限（仅对声明 `acceptsCharLimits` 的源生效，如设定词条）。
   * - `undefined` / `0` = 不截断（交给 token 预算与总窗口兜底）。
   * - `> 0` = 超出即截断，并留显式标记。
   */
  maxChars?: number
  /** 每分类最多注入的词条数。`undefined` / `0` = 不限。 */
  maxPerCategory?: number
  /** 每条词条最多内联的专属字段数。`undefined` / `0` = 不限。 */
  maxFieldsPerEntry?: number
  /**
   * 「全书截至本章」段字数上限（`retrievedPassages`）。
   * `undefined` / `0` = 沿用内部默认（1800 字）。
   */
  maxTotalChars?: number
  /**
   * 「本卷截至本章」取**本卷内本章之前的头多少章**（`retrievedPassages`）。
   *
   * 起点固定为本卷第一章（最前为本卷开始），到第 N 章为止。
   * `undefined` / `0` = 原行为：输出本卷第一章 → 本章之前的整段卷纲。
   *
   * 这是本卷段的**主控**；`maxVolumeChars` 只是字数安全阀。
   */
  maxVolumeChapters?: number
  /**
   * 「本卷截至本章」段字数安全阀，防止选了很多章时把上下文撑爆
   * （`retrievedPassages`）。`undefined` / `0` = 沿用内部默认（1200 字）。
   */
  maxVolumeChars?: number
}

export interface ContextBudgetPolicy {
  /**
   * 主开关：关闭后，`assembleContext` 不再做**单源预算截断**。
   * 内容只在真的装不下模型窗口时才被总预算裁剪（此时仍在请求前完成，不会静默丢弃）。
   */
  truncationEnabled: boolean
  /** 按 `CONTEXT_SOURCES.key` 覆盖；未登记的键在 sanitizer 中丢弃。 */
  sources: Record<string, ContextSourceBudgetPolicy>
}

export const DEFAULT_CONTEXT_BUDGET_POLICY: ContextBudgetPolicy = {
  truncationEnabled: true,
  sources: {},
}

/** 按上下文层级把团队总预算分给各登记源；调用方只需提供 key/layer/default。 */
export function allocateContextBudgetOverrides(
  totalTokens: number,
  sources: readonly { key: string; layer: string; budgetTokens: number }[],
): Record<string, ContextSourceBudgetPolicy> {
  // 核心事实（L0）优先于细节、检索与低优先级补充，避免总预算提高时反而挤压核心上下文。
  const layerRatios: Record<string, number> = { L0: 0.50, L1: 0.30, L2: 0.15, L3: 0.05 }
  const result: Record<string, ContextSourceBudgetPolicy> = {}
  const groups = new Map<string, typeof sources[number][]>()
  for (const source of sources) {
    const group = groups.get(source.layer) ?? []
    group.push(source)
    groups.set(source.layer, group)
  }
  for (const [layer, group] of groups) {
    const pool = totalTokens * (layerRatios[layer] ?? 0.1)
    const weight = group.reduce((sum, source) => sum + Math.max(1, source.budgetTokens), 0)
    for (const source of group) {
      result[source.key] = { budgetTokens: Math.max(64, Math.floor(pool * Math.max(1, source.budgetTokens) / weight)) }
    }
  }
  return result
}

/**
 * 各控制项的合法区间。上限刻意放在「不可能误伤正常使用、又能挡住误输入」的位置：
 * 数值型输入框在浏览器里可被手填任意值，越界必须在此收敛。
 */
export const CONTEXT_BUDGET_LIMITS = {
  budgetTokens: { min: 64, max: 1_000_000 },
  maxChars: { min: 200, max: 2_000_000 },
  maxPerCategory: { min: 1, max: 1_000 },
  maxFieldsPerEntry: { min: 1, max: 20 },
  maxTotalChars: { min: 100, max: 1_000_000 },
  maxVolumeChars: { min: 100, max: 1_000_000 },
  maxVolumeChapters: { min: 1, max: 500 },
} as const

function clampOptional(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(max, Math.max(min, Math.floor(n)))
}

/** 把一个源对象的未知输入收敛成合法覆盖值；全部为空时返回 null（表示不登记该源）。 */
export function sanitizeSourceBudgetPolicy(value: unknown): ContextSourceBudgetPolicy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const raw = value as Record<string, unknown>
  const out: ContextSourceBudgetPolicy = {}
  const budgetTokens = clampOptional(raw.budgetTokens, CONTEXT_BUDGET_LIMITS.budgetTokens.min, CONTEXT_BUDGET_LIMITS.budgetTokens.max)
  const maxChars = clampOptional(raw.maxChars, CONTEXT_BUDGET_LIMITS.maxChars.min, CONTEXT_BUDGET_LIMITS.maxChars.max)
  const maxPerCategory = clampOptional(raw.maxPerCategory, CONTEXT_BUDGET_LIMITS.maxPerCategory.min, CONTEXT_BUDGET_LIMITS.maxPerCategory.max)
  const maxFieldsPerEntry = clampOptional(raw.maxFieldsPerEntry, CONTEXT_BUDGET_LIMITS.maxFieldsPerEntry.min, CONTEXT_BUDGET_LIMITS.maxFieldsPerEntry.max)
  const maxTotalChars = clampOptional(raw.maxTotalChars, CONTEXT_BUDGET_LIMITS.maxTotalChars.min, CONTEXT_BUDGET_LIMITS.maxTotalChars.max)
  const maxVolumeChars = clampOptional(raw.maxVolumeChars, CONTEXT_BUDGET_LIMITS.maxVolumeChars.min, CONTEXT_BUDGET_LIMITS.maxVolumeChars.max)
  const maxVolumeChapters = clampOptional(raw.maxVolumeChapters, CONTEXT_BUDGET_LIMITS.maxVolumeChapters.min, CONTEXT_BUDGET_LIMITS.maxVolumeChapters.max)
  if (budgetTokens !== undefined) out.budgetTokens = budgetTokens
  if (maxChars !== undefined) out.maxChars = maxChars
  if (maxPerCategory !== undefined) out.maxPerCategory = maxPerCategory
  if (maxFieldsPerEntry !== undefined) out.maxFieldsPerEntry = maxFieldsPerEntry
  if (maxTotalChars !== undefined) out.maxTotalChars = maxTotalChars
  if (maxVolumeChars !== undefined) out.maxVolumeChars = maxVolumeChars
  if (maxVolumeChapters !== undefined) out.maxVolumeChapters = maxVolumeChapters
  return Object.keys(out).length ? out : null
}

/**
 * 收敛完整策略。未知源键被丢弃；未知字段被忽略；非法数值回落到「沿用注册表默认」。
 * @param knownKeys 合法源键。不传 = 不校验键（仅用于纯函数测试）。
 */
export function sanitizeContextBudgetPolicy(value: unknown, knownKeys?: readonly string[]): ContextBudgetPolicy {
  const raw = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
  const allow = knownKeys ? new Set(knownKeys) : null
  const sources: Record<string, ContextSourceBudgetPolicy> = {}
  const rawSources = raw.sources && typeof raw.sources === 'object' && !Array.isArray(raw.sources)
    ? raw.sources as Record<string, unknown>
    : {}
  for (const [key, entry] of Object.entries(rawSources)) {
    if (allow && !allow.has(key)) continue
    const sanitized = sanitizeSourceBudgetPolicy(entry)
    if (sanitized) sources[key] = sanitized
  }
  return {
    // 只有显式 `false` 才关闭截断；旧配置缺该键时保持开启（零行为变化）。
    truncationEnabled: raw.truncationEnabled !== false,
    sources,
  }
}

/** 从 localStorage 读取并收敛策略。SSR / 隐私模式 / 坏 JSON 一律回落默认值。 */
export function loadContextBudgetPolicy(knownKeys?: readonly string[]): ContextBudgetPolicy {
  try {
    const stored = localStorage.getItem(CONTEXT_BUDGET_POLICY_KEY)
    return sanitizeContextBudgetPolicy(stored ? JSON.parse(stored) : {}, knownKeys)
  } catch {
    return { ...DEFAULT_CONTEXT_BUDGET_POLICY, sources: {} }
  }
}

export function saveContextBudgetPolicy(policy: ContextBudgetPolicy, knownKeys?: readonly string[]): void {
  localStorage.setItem(CONTEXT_BUDGET_POLICY_KEY, JSON.stringify(sanitizeContextBudgetPolicy(policy, knownKeys)))
}

/** 源的有效预算与字符上限（`assembleContext` 每轮对每个源求一次）。 */
export interface ResolvedSourceBudget {
  /** 截断后实际生效的 token 预算。 */
  budgetTokens: number
  /** 字符上限；undefined = 不设字符截断。 */
  maxChars?: number
  maxPerCategory?: number
  maxFieldsPerEntry?: number
  maxTotalChars?: number
  maxVolumeChars?: number
  maxVolumeChapters?: number
  /** 是否跳过单源预算截断（主开关关闭，或作者显式把该源预算设为「不限」）。 */
  uncapped: boolean
}

export interface ResolveSourceBudgetInput {
  /** 注册表登记值。 */
  registryBudgetTokens: number
  /** 作者对该源的覆盖值。 */
  override?: ContextSourceBudgetPolicy
  /** 调用方领域档位比例（仅能收窄，不能放大）。 */
  profileScale?: number
  /** 本轮可用输入预算（已含模型窗口与领域上限）。 */
  inputBudgetTokens: number
  truncationEnabled: boolean
}

/**
 * 计算单个源的有效预算。
 *
 * 截断开启：`min(覆盖值或登记值 × 档位比例, 可用输入预算)`，至少 64 token。
 * 截断关闭：允许该源用满**全部**可用输入预算（用户可把词条/角色调得比登记值大得多），
 *           但仍不会超过模型窗口——超窗内容由总预算裁剪统一处理。
 */
export function resolveSourceBudget(input: ResolveSourceBudgetInput): ResolvedSourceBudget {
  const scale = Number.isFinite(input.profileScale)
    ? Math.max(0.1, Math.min(1, input.profileScale ?? 1))
    : 1
  const overrideTokens = input.override?.budgetTokens
  const base = overrideTokens && overrideTokens > 0 ? overrideTokens : input.registryBudgetTokens
  const scaled = Math.max(64, Math.floor(base * scale))
  const ceiling = Math.max(64, Math.floor(input.inputBudgetTokens))
  return {
    budgetTokens: Math.min(scaled, ceiling),
    maxChars: input.override?.maxChars,
    maxPerCategory: input.override?.maxPerCategory,
    maxFieldsPerEntry: input.override?.maxFieldsPerEntry,
    maxTotalChars: input.override?.maxTotalChars,
    maxVolumeChars: input.override?.maxVolumeChars,
    maxVolumeChapters: input.override?.maxVolumeChapters,
    uncapped: !input.truncationEnabled,
  }
}

/**
 * 词条源在「只给 token 预算、没给字符上限」时，按中文字符/token 比反推字符上限。
 * 这样作者调高词条 token 预算能真实拿到更多词条，而不是被内部 2500 字常量卡住。
 * 中文实测约 1.5 token/字（见 `estimateTokens`），留 0.75 的余量避免截断过早。
 */
export const CJK_CHARS_PER_TOKEN = 0.75

export function deriveCharLimitFromTokens(budgetTokens: number): number {
  return Math.max(200, Math.floor(budgetTokens * CJK_CHARS_PER_TOKEN))
}
