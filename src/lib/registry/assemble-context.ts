/**
 * assembleContext(Phase 1.3a) · 统一上下文装配入口。
 *
 * 1.3a 只新增入口。1.3b 再把 ai.start/chat 调用迁移到这里。
 */
import { estimateTokens, getActiveContextWindowOverride, resolveModelWindow, type ContextLayer, type ContextSegment } from '../ai/context-budget'
import { CONTEXT_SOURCES, CONTEXT_SOURCE_BY_KEY } from './context-sources'
import type { AssembleContextInput, AssembleContextResult, ContextSource } from './types'
import { prepareContinuityContext } from '../ai/chapter-memory/continuity-context'
import {
  deriveCharLimitFromTokens,
  loadContextBudgetPolicy,
  resolveSourceBudget,
  type ContextBudgetPolicy,
} from './context-budget-policy'

/** 拿不到模型时的保守默认输入预算(原固定 24K 偏紧,放宽避免内部提前裁) */
const FALLBACK_INPUT_BUDGET = 48_000
const LAYERS_BY_TRIM_PRIORITY: ContextLayer[] = ['L3', 'L2', 'L1']

/**
 * 输入预算 = 所选模型的上下文窗口(减输出预留与安全边际)。
 * 这样上下文只在「真的接近模型窗口」时才按优先级软裁,而不是被固定小预算提前砍。
 */
function deriveInputBudget(input: AssembleContextInput): number {
  if (input.inputBudgetTokens && input.inputBudgetTokens > 0) return input.inputBudgetTokens
  let modelBudget = FALLBACK_INPUT_BUDGET
  if (input.provider && input.model) {
    // 与底栏、消息裁剪用同一个窗口数字：显式覆盖 > 配置 store 生效值 > 名称族/服务商预设。
    const window = resolveModelWindow(
      input.provider,
      input.model,
      input.contextWindowOverride ?? getActiveContextWindowOverride(),
    )
    const budget = window.maxContext - window.maxOutput - Math.round(window.maxContext * 0.05)
    if (budget > 0) modelBudget = budget
  }
  if (input.inputBudgetMaxTokens && input.inputBudgetMaxTokens > 0) {
    return Math.min(modelBudget, input.inputBudgetMaxTokens)
  }
  return modelBudget
}

export async function assembleContext(input: AssembleContextInput): Promise<AssembleContextResult> {
  const { sources: selected, unknownSourceKeys } = selectSources(input)
  const inputBudget = deriveInputBudget(input)
  const needsContinuity = selected.some(source => (
    source.key === 'previousChapterEnding'
    || source.key === 'chapterContinuityHandoff'
    || source.key === 'previousPlanReconciliation'
    || source.key === 'recentChapterSummaries'
  ))
  const resolvedInput: AssembleContextInput = needsContinuity && input.chapterId != null
    ? {
        ...input,
        continuitySnapshot: input.continuitySnapshot ?? await prepareContinuityContext({
          projectId: input.projectId,
          chapterId: input.chapterId,
        }),
      }
    : input
  const omitted: string[] = []
  const keyedSegments: { key: string; segment: ContextSegment }[] = []
  /** BUDGET-1: 被「单源预算」截断的源 key（区别于整段被总预算裁掉的 trimmed）。 */
  const cappedSources: string[] = []
  const policy = resolveBudgetPolicy(input)
  const sourceBudgetScale = Number.isFinite(input.sourceBudgetScale)
    ? Math.max(0.1, Math.min(1, input.sourceBudgetScale!))
    : 1
  // 旧状态卡只作尚无时序事实时的兼容来源；同一请求不能注入两份互相矛盾的“当前真相”。
  const currentFactsSource = selected.find(source => source.key === 'currentFacts')
  const currentFactsText = currentFactsSource && requirementsMet(currentFactsSource, resolvedInput)
    ? await currentFactsSource.read(resolvedInput)
    : ''

  for (const source of selected) {
    if (source.key === 'stateCards' && currentFactsText.trim()) {
      omitted.push(source.key)
      continue
    }
    if (!requirementsMet(source, resolvedInput)) {
      omitted.push(source.key)
      continue
    }
    if (source.enabled && !await source.enabled(resolvedInput)) {
      omitted.push(source.key)
      continue
    }
    const resolved = resolveSourceBudget({
      registryBudgetTokens: source.budgetTokens,
      override: policy.sources[source.key],
      profileScale: sourceBudgetScale,
      inputBudgetTokens: inputBudget,
      truncationEnabled: policy.truncationEnabled,
    })
    const content = source.key === 'currentFacts'
      ? currentFactsText
      : await source.read(withCharLimits(source, resolved, resolvedInput, policy))
    if (!content.trim()) {
      omitted.push(source.key)
      continue
    }
    // 单一源也不能突破整个请求预算。L0/protected 只表示不得整段丢弃，
    // 不表示可以绕过总窗口；截断会留下显式标记并进入 tokens 元数据。
    //
    // BUDGET-1: 关闭自动截断时不再套用「单源预算」，改由本轮可用输入预算兜底——
    // 内容只在装不下模型窗口时才被裁，而不是被登记源软上限提前砍掉。
    const capTo = resolved.uncapped ? Math.max(64, Math.floor(inputBudget)) : resolved.budgetTokens
    const capped = capBySourceBudget(content, capTo)
    if (capped !== content) cappedSources.push(source.key)
    keyedSegments.push({
      key: source.key,
      segment: {
        label: source.label,
        layer: source.layer,
        content: capped,
        tokens: estimateTokens(capped),
        trimmable: source.layer !== 'L0' && !source.protectedFromTrim,
      },
    })
  }

  const totalBeforeTrim = keyedSegments.reduce((sum, s) => sum + s.segment.tokens, 0)
  const overBudgetBeforeTrim = totalBeforeTrim > inputBudget
  const { kept, trimmed } = trimToFit(keyedSegments, inputBudget)
  const segments = kept.map(s => s.segment)
  const totalInputTokens = segments.reduce((sum, s) => sum + s.tokens, 0)

  return {
    text: segments.map(s => s.content).join('\n\n'),
    segments,
    included: kept.map(s => s.key),
    omitted,
    // 单源被截断的 key 也并入 trimmed：既有的证据面板与忽略列表天然去重，
    // 「这个源被砍过」这件事不会因为只是截断而非整段删除就丢失。
    trimmed: [...trimmed, ...cappedSources],
    unknownSourceKeys,
    totalInputTokens,
    inputBudget,
    overBudgetBeforeTrim,
    overBudgetAfterTrim: totalInputTokens > inputBudget,
  }
}

/**
 * BUDGET-1: 取本轮生效的预算策略。
 * 调用方显式传入（测试 / 运行时快照）优先，否则读本机 localStorage 策略。
 */
function resolveBudgetPolicy(input: AssembleContextInput): ContextBudgetPolicy {
  return input.budgetPolicy ?? loadContextBudgetPolicy()
}

/**
 * 只对声明 `acceptsCharLimits` 的源透传字数上限，避免把无关字段灌进其它读取器。
 *
 * 每个源使用的字段是互斥的（`codex` 用词条级三项，`retrievedPassages` 用叙事摘要两项），
 * 因此按 key 分支，不把全部字段灌给每个读取器。
 *
 * 当作者显式调过 `maxChars` 或 `budgetTokens` 时，按源 token 预算反推 `maxChars`——
 * 这样「调高预算」能真实拿到更多内容，而不是被旧的内部常量卡住。两者都没动时
 * **不传** `maxChars`，让读取器使用自己的内部默认，避免收紧现有行为。
 */
function withCharLimits(
  source: ContextSource,
  resolved: ReturnType<typeof resolveSourceBudget>,
  input: AssembleContextInput,
  policy: ContextBudgetPolicy,
): AssembleContextInput {
  if (!source.acceptsCharLimits) return input
  const base = {
    ...input,
    sourceMaxChars: undefined,
    sourceMaxPerCategory: undefined,
    sourceMaxFieldsPerEntry: undefined,
    sourceMaxTotalChars: undefined,
    sourceMaxVolumeChars: undefined,
    sourceMaxVolumeChapters: undefined,
  } as AssembleContextInput

  const override = policy.sources[source.key]
  const tuned = (override?.budgetTokens ?? 0) > 0 || (override?.maxChars ?? 0) > 0

  switch (source.key) {
    case 'codex':
      return {
        ...base,
        sourceMaxChars: resolved.maxChars ?? (tuned ? deriveCharLimitFromTokens(resolved.budgetTokens) : undefined),
        sourceMaxPerCategory: resolved.maxPerCategory,
        sourceMaxFieldsPerEntry: resolved.maxFieldsPerEntry,
      }
    case 'retrievedPassages':
      return {
        ...base,
        sourceMaxTotalChars: resolved.maxTotalChars,
        sourceMaxVolumeChars: resolved.maxVolumeChars,
        sourceMaxVolumeChapters: resolved.maxVolumeChapters,
      }
    default:
      return base
  }
}

/**
 * 把调用方给的 `sourceKeys` 解析成登记源。
 *
 * 未登记的 key **不再静默丢弃**：原样回传给调用方，由它决定是报错、提示还是忽略
 * （PROMPT-PLAN-1 的「AI 申报字段」必须能区分"不可用"与"未登记"）。
 * 已登记 key 的顺序与重复次数保持原行为；旧状态卡请求额外前置当前事实，避免旁路优先级。
 */
function selectSources(input: AssembleContextInput): {
  sources: ContextSource[]
  unknownSourceKeys: string[]
} {
  if (!input.sourceKeys?.length) return { sources: CONTEXT_SOURCES, unknownSourceKeys: [] }
  const sources: ContextSource[] = []
  const unknownSourceKeys: string[] = []
  for (const key of input.sourceKeys) {
    // 旧状态卡是兼容后备。即使调用方只请求旧 key，也先检查事实账本。
    if (key === 'stateCards' && !input.sourceKeys.includes('currentFacts')) {
      sources.push(CONTEXT_SOURCE_BY_KEY.get('currentFacts')!)
    }
    const source = CONTEXT_SOURCE_BY_KEY.get(key)
    if (source) sources.push(source)
    else unknownSourceKeys.push(key)
  }
  return { sources, unknownSourceKeys }
}

function requirementsMet(source: ContextSource, input: AssembleContextInput): boolean {
  if (source.requiresWorldGroupId && !Object.prototype.hasOwnProperty.call(input, 'worldGroupId')) return false
  if (source.requiresOutlineNodeId && input.outlineNodeId == null && input.chapterId == null) return false
  if (
    source.requiresChapterId
    && input.chapterId == null
    && !(source.acceptsOutlineNodeAsChapterBoundary && input.outlineNodeId != null)
  ) return false
  return true
}

function capBySourceBudget(content: string, budgetTokens: number): string {
  if (!budgetTokens || estimateTokens(content) <= budgetTokens) return content
  const marker = '\n…（该上下文源已按预算截断）'
  let low = 0
  let high = content.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (estimateTokens(`${content.slice(0, middle)}${marker}`) <= budgetTokens) low = middle
    else high = middle - 1
  }
  return `${content.slice(0, low)}${marker}`
}

function trimToFit(
  segments: { key: string; segment: ContextSegment }[],
  inputBudget: number,
): { kept: { key: string; segment: ContextSegment }[]; trimmed: string[] } {
  let kept = [...segments]
  const trimmed: string[] = []
  let total = kept.reduce((sum, s) => sum + s.segment.tokens, 0)
  if (total <= inputBudget) return { kept, trimmed }

  for (const layer of LAYERS_BY_TRIM_PRIORITY) {
    if (total <= inputBudget) break
    const removed = kept.filter(s => s.segment.layer === layer && s.segment.trimmable)
    if (!removed.length) continue
    kept = kept.filter(s => s.segment.layer !== layer || !s.segment.trimmable)
    total = kept.reduce((sum, s) => sum + s.segment.tokens, 0)
    trimmed.push(...removed.map(s => s.key))
  }

  return { kept, trimmed }
}
