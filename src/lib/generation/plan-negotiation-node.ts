/**
 * PROMPT-PLAN-1 · 生成前协商的两个节点 + 它们的数据准备。
 *
 * 与 `createChapterGenerationNode` 同一条约定：节点本身**不读数据库**，
 * 项目数据一律由调用方先经 `assembleContext()` 装配好再传进来
 * （`assembleInput` 是同步接口，无法在里面 await；这也是正文节点的既有形态）。
 * 这里把"装配"收口在 `preparePlanBasis()` / `preparePlanNeedsCatalogs()` 两个 async 函数里，
 * 保证协商调用读到的每个字段都来自登记源或注册表派生数据，没有第二条读取路径。
 *
 * 有意**不加 gate**：未知源/未知记录字段是"报告并继续"，不是"阻断"
 * （校验结果由 `plan-needs.validatePlanNeeds` 给出，面板逐条展示）。
 */
import type { UseAIStreamReturn } from '../../hooks/useAIStream'
import type { AIProvider } from '../types'
import { assembleContext } from '../registry/assemble-context'
import { log } from '../logging/logger'
import { TimeoutError, withTimeout } from '../utils/with-timeout'
import { CONTEXT_SOURCES } from '../registry/context-sources'
import { buildRagLibrary } from '../retrieval/rag-library'
import { parseRosterCharacterNames } from '../ai/entity-roster'
import {
  buildPlanAskPrompt,
  buildPlanNeedsPrompt,
  buildPlanSummaryPrompt,
  type PlanAskInput,
  type PlanNeedsCatalogsText,
  type PlanNeedsInput,
  type PlanSummaryInput,
} from '../ai/adapters/chapter-plan-adapter'
import type { GenerationNode } from './generation-node'

/**
 * 协商调用使用的窄源集：只够判断"这一章要写什么、需要什么"，
 * 不含全量角色档案/词条/世界观——那属于最终正文装配，不属于协商。
 */
export const PLAN_NEGOTIATION_SOURCE_KEYS = [
  'chapterOutline',
  'detailedOutline',
  'chapterContinuityHandoff',
  'previousPlanReconciliation',
  'previousChapterEnding',
  'recentChapterSummaries',
  'characterDrivenPlan',
  'storylineProgress',
  'foreshadows',
  'entityRoster',
] as const

/** 协商输入上限：与正文生成相比刻意收紧（这是一次辅助判断）。 */
export const PLAN_NEGOTIATION_INPUT_BUDGET_TOKENS = 8_000

/** 记录字段目录的公平上限：每类来源最多列这些条，总量再兜一层。 */
export const PLAN_RAG_CATALOG_PER_SOURCE = 12
export const PLAN_RAG_CATALOG_MAX_LINES = 120

/**
 * 协商的**数据准备**超时。
 *
 * 事故教训：协商面板打开后先 `preparePlanBasis()`（内部 `assembleContext`），
 * 而它此前**没有超时** —— 网络半死时（检索/嵌入不可达）这一步会一直挂着，
 * 面板显示"正在跑"却永远没有任何输出，作者点不出下一步也确认不了：
 * 这就是"生成前协商长期加载后无任何输出，无法继续"的直接原因。
 * 装配属于**可降级**步骤（拿不到就少给点背景），因此超时后按"空骨架"继续，
 * 而不是把作者永久卡在协商里。
 */
export const PLAN_BASIS_TIMEOUT_MS = 30_000
/** 申报所需的目录（登记源/记录字段/实体名册）准备超时。 */
export const PLAN_CATALOGS_TIMEOUT_MS = 30_000

export interface PlanNegotiationRuntime {
  projectId: number
  worldGroupId: number | null
  outlineNodeId: number | null
  chapterId: number | null
  provider?: AIProvider
  model?: string
}

export interface PlanNegotiationEvidence {
  included: string[]
  omitted: string[]
  trimmed: string[]
  /** 调用方/协商申报里未在 CONTEXT_SOURCES 登记的 key（旧实现会静默丢弃）。 */
  unknownSourceKeys: string[]
  totalInputTokens: number
  inputBudget: number
}

export interface PlanNegotiationBasis {
  /** 前情与连续性文本（已登记源的片段拼接），供摘要调用使用。 */
  previousContext: string
  /** 本章细纲文本（`detailedOutline` 源内容；单列是因为模板有独立变量）。 */
  detailedOutline: string
  /** 已登记源目录：`key — 标签`。 */
  sourceCatalog: string
  /** 实体名册文本（entityRoster 源内容）。 */
  roster: string
  evidence: PlanNegotiationEvidence
  /** 装配降级原因（超时/失败）。有值说明这次协商拿不到完整背景，面板要如实显示。 */
  degraded?: string
}

function segmentReader(assembled: Awaited<ReturnType<typeof assembleContext>>) {
  return (key: string): string => {
    const index = assembled.included.indexOf(key)
    return index >= 0 ? assembled.segments[index]?.content ?? '' : ''
  }
}

/** 与摘要调用共用的连续性片段顺序（读者按这个顺序看到前情）。细纲单列，不在这里重复。 */
const PREVIOUS_CONTEXT_KEYS = [
  'chapterContinuityHandoff',
  'previousPlanReconciliation',
  'previousChapterEnding',
  'recentChapterSummaries',
  'characterDrivenPlan',
  'storylineProgress',
  'foreshadows',
] as const

/**
 * 一次性装配协商所需的登记数据（宽口径：摘要与需求两步共用，只读一次库）。
 */
export async function preparePlanBasis(runtime: PlanNegotiationRuntime): Promise<PlanNegotiationBasis> {
  /**
   * 装配超时后**降级继续**（而不是把作者卡住）：协商的价值是"申报需要哪些资料"，
   * 即使拿不到前情/细纲也仍能基于章节大纲与名册完成协商；少给的背景会在 evidence 里如实标注。
   */
  let assembled: Awaited<ReturnType<typeof assembleContext>>
  try {
    assembled = await withTimeout(assembleContext({
      projectId: runtime.projectId,
      worldGroupId: runtime.worldGroupId,
      outlineNodeId: runtime.outlineNodeId,
      chapterId: runtime.chapterId,
      provider: runtime.provider,
      model: runtime.model,
      sourceKeys: [...PLAN_NEGOTIATION_SOURCE_KEYS],
      inputBudgetMaxTokens: PLAN_NEGOTIATION_INPUT_BUDGET_TOKENS,
    }), PLAN_BASIS_TIMEOUT_MS, '协商数据装配')
  } catch (reason) {
    log.warn('PromptPlan', 'promptplan', '[PromptPlan] 协商数据装配失败，已降级为空骨架继续', {
      timeout: reason instanceof TimeoutError,
      error: reason instanceof Error ? reason.name : 'unknown',
    })
    return {
      previousContext: '',
      detailedOutline: '',
      sourceCatalog: CONTEXT_SOURCES.map(source => `${source.key} — ${source.label}`).join('\n'),
      roster: '',
      degraded: reason instanceof TimeoutError ? '装配超时' : '装配失败',
      evidence: {
        included: [],
        omitted: [...PLAN_NEGOTIATION_SOURCE_KEYS],
        trimmed: [],
        unknownSourceKeys: [],
        totalInputTokens: 0,
        inputBudget: PLAN_NEGOTIATION_INPUT_BUDGET_TOKENS,
      },
    }
  }
  const segment = segmentReader(assembled)
  return {
    previousContext: PREVIOUS_CONTEXT_KEYS.map(segment).filter(Boolean).join('\n\n'),
    detailedOutline: segment('detailedOutline'),
    sourceCatalog: CONTEXT_SOURCES.map(source => `${source.key} — ${source.label}`).join('\n'),
    roster: segment('entityRoster'),
    evidence: {
      included: assembled.included,
      omitted: assembled.omitted,
      trimmed: assembled.trimmed,
      unknownSourceKeys: assembled.unknownSourceKeys,
      totalInputTokens: assembled.totalInputTokens,
      inputBudget: assembled.inputBudget,
    },
  }
}

/**
 * 记录字段目录（RAG-1 投影的稳定键）：只列作者已启用的字段，
 * 每类来源限量、总量兜底，避免把上千条键灌进协商提示词。
 *
 * 注：`buildRagLibrary` 会给缺稳定 ID 的源记录补 `ragDocumentId`（幂等元数据），
 * 既有 RAG 选择源（`ragSelection`）在 AI 上下文装配时已经这么做，行为一致。
 */
async function buildPlanRagCatalog(runtime: PlanNegotiationRuntime): Promise<{ text: string; keys: string[]; labels: Record<string, string> }> {
  const entries = await buildRagLibrary({
    projectId: runtime.projectId,
    worldGroupId: runtime.worldGroupId,
  })
  const perSource = new Map<string, string[]>()
  const keys: string[] = []
  const labels: Record<string, string> = {}
  let overflow = 0
  for (const entry of entries) {
    if (!entry.enabled) continue
    const bucket = perSource.get(entry.sourceLabel) ?? []
    if (bucket.length >= PLAN_RAG_CATALOG_PER_SOURCE) continue
    if (keys.length >= PLAN_RAG_CATALOG_MAX_LINES) { overflow++; continue }
    const label = `${entry.title} / ${entry.fieldLabel}`
    bucket.push(`${entry.key} — ${label}`)
    labels[entry.key] = label
    perSource.set(entry.sourceLabel, bucket)
    keys.push(entry.key)
  }
  const lines: string[] = []
  for (const [label, items] of perSource) {
    lines.push(`[${label}]`)
    lines.push(...items)
  }
  if (overflow) lines.push(`…（另有 ${overflow} 条记录字段未列出；如需整类资料可申报上面的来源 key）`)
  return { text: lines.join('\n'), keys, labels }
}

export interface PlanNegotiationCatalogs extends PlanNeedsCatalogsText {
  /** 申报校验用的闭集（与上面的文本目录同源派生，调用方不需要再解析文本）。 */
  sourceKeys: string[]
  ragEntryKeys: string[]
  ragEntryLabels: Record<string, string>
  characterNames: string[]
  evidence: PlanNegotiationEvidence
}

/** 需求+计划这一步的清单（在作者确认摘要之后才构建，避免摘要步多做一次全库投影）。 */
export async function preparePlanNeedsCatalogs(
  runtime: PlanNegotiationRuntime,
  basis: PlanNegotiationBasis,
): Promise<PlanNegotiationCatalogs> {
  const rag = await buildPlanRagCatalog(runtime)
  return {
    sourceCatalog: basis.sourceCatalog,
    roster: basis.roster,
    ragCatalog: rag.text,
    sourceKeys: CONTEXT_SOURCES.map(source => source.key),
    ragEntryKeys: rag.keys,
    ragEntryLabels: rag.labels,
    characterNames: parseRosterCharacterNames(basis.roster),
    evidence: basis.evidence,
  }
}

export function createChapterPlanSummaryNode(input: {
  projectId: number
  chapterIdentity: number | string
  ai: Pick<UseAIStreamReturn, 'start'>
}): GenerationNode<PlanSummaryInput, string> {
  return {
    id: `chapter.plan.summary:${input.chapterIdentity}`,
    kind: 'chapter.plan.summary',
    editableInput: true,
    assembleInput: nodeInput => buildPlanSummaryPrompt(nodeInput),
    run: messages => input.ai.start(messages, undefined, {
      category: 'chapter.plan.summary',
      projectId: input.projectId,
    }),
  }
}

/**
 * PROMPT-PLAN-2：提问轮节点。
 *
 * 与摘要/需求同型（冻结输入快照、不自动采纳）：它只产生"要问什么"，
 * 答案**只能来自作者**并由界面写回，模型无法自问自答。
 */
export function createChapterPlanAskNode(input: {
  projectId: number
  chapterIdentity: number | string
  ai: Pick<UseAIStreamReturn, 'start'>
}): GenerationNode<PlanAskInput, string> {
  return {
    id: `chapter.plan.ask:${input.chapterIdentity}`,
    kind: 'chapter.plan.ask',
    editableInput: true,
    assembleInput: nodeInput => buildPlanAskPrompt(nodeInput),
    run: messages => input.ai.start(messages, undefined, {
      category: 'chapter.plan.ask',
      projectId: input.projectId,
    }),
  }
}

export function createChapterPlanNeedsNode(input: {
  projectId: number
  chapterIdentity: number | string
  ai: Pick<UseAIStreamReturn, 'start'>
}): GenerationNode<PlanNeedsInput, string> {
  return {
    id: `chapter.plan.needs:${input.chapterIdentity}`,
    kind: 'chapter.plan.needs',
    editableInput: true,
    assembleInput: nodeInput => buildPlanNeedsPrompt(nodeInput),
    run: messages => input.ai.start(messages, undefined, {
      category: 'chapter.plan.needs',
      projectId: input.projectId,
    }),
  }
}
