/**
 * 生成前协商 · 需求申报的闭集校验（PROMPT-PLAN-1）。
 *
 * 这里只做**确定性**的事，不碰数据库、不碰注册表、不调模型：
 *   · 把模型返回的 JSON 解析成对象（容忍 ```json 围栏与前后废话）；
 *   · 把申报的源 / 记录字段 / 角色名与**调用方给的闭集目录**比对，
 *     未登记项进 `rejected`（绝不静默丢弃——这正是 assembleContext 旧实现的反面教材）；
 *   · 合并「必带地板」：协商只能**追加**，不能移除正文生成今天必读的源。
 *
 * 闭集目录由调用方从注册表/资料库/名册派生后传入，本模块不自己读注册表，
 * 因此可以脱离 IndexedDB 单测。
 *
 * ## 为什么地板 = 今天的默认源清单，且只许追加
 * 草案曾设想"AI 可以覆盖默认 L2 清单，只保留少量地板"。实现时改为**只许追加**，原因：
 * 申报协议里没有"我不要某个默认源"的表达方式，任何未申报的默认源都会被**隐式移除**；
 * 而模型从一行标签（如 `retrievedPassages — 相关前文召回`）无法判断"少了它就会与几十章前
 * 的细节矛盾"。隐式移除会让一次协商悄悄削弱连贯性，而收窄唯一的收益只是省 token，
 * 那件事已有的预算裁剪（`assembleSourceBudget`/`trimToFit`）已经在做。
 * 因此：地板 = `ChapterEditor` 原有的正文源清单（原样搬到这里成为单一事实源），
 * AI 申报的源一律**追加**；作者仍可在确认面板里取消 **AI 追加**的那些项。
 */
import type { PlanAskAnswer } from './plan-ask'

/**
 * 正文生成的必带源（= 搬迁前的组件内默认清单，现在这里是唯一事实源）。
 * 协商不能移除这些源；AI 申报的源一律追加。
 */
export const PLAN_FLOOR_SOURCES = [
  'contextMemo',
  'chapterOutline',
  'detailedOutline',
  'chapterContinuityHandoff',
  'previousPlanReconciliation',
  'previousChapterEnding',
  'recentChapterSummaries',
  'worldview',
  'storyCore',
  'characterDrivenPlan',
  'powerSystem',
  'cultivationProgress',
  'codex',
  'creativeRules',
  'worldRules',
  'historical',
  'locations',
  'mapRelevantFacts',
  'foreshadows',
  'storyArcs',
  'storylineProgress',
  'emotionBeats',
  'stateCards',
  'currentFacts',
  'canonAssertions',
  'characterKnowledge',
  'heldItems',
  'retrievedPassages',
  'references',
  'userStyleProfile',
] as const

/**
 * 大纲生成（卷纲 / 章纲 / 批量章纲）的必带源。
 *
 * = `OutlinePanel` 搬迁前的组件内固定清单，现在这里是**唯一事实源**。
 * 与正文地板分开的原因：大纲规划看不到"某章的正文状态卡/物品流水"，
 * 把正文地板灌进大纲请求只会推高 token 而不提质量；而 AI 在大纲协商里
 * 申报的、恰好落在正文地板里的源（如 `recentChapterSummaries`）现在由
 * `withPlanFloor` 补进来，不会被隐式丢掉。
 */
export const OUTLINE_FLOOR_SOURCES = [
  'canonAssertions',
  'worldview',
  'storyCore',
  'characterDrivenPlan',
  'powerSystem',
  'cultivationProgress',
  'codex',
  'characters',
  'creativeRules',
  'worldRules',
  'historical',
  'locations',
  'mapRelevantFacts',
  'foreshadows',
  'storyArcs',
  'storylineProgress',
  'existingVolumeOutlines',
  'writtenChapterProgress',
] as const

/**
 * 申报了主体角色时自动并入的证据源（C2 反向哺喂的两个源都以 `subjectCharacterName` 为准）。
 * 让"我需要苏禾的正文表现"一句话真正带回证据，而不要求模型同时记住两个源 key。
 */
export const PLAN_SUBJECT_SOURCES = ['characterPassages', 'characterFacts'] as const

/**
 * 记录字段（ragEntryKeys）必须由 `ragSelection` 源消费（该源 `enabled` 要求 ragEntryKeys 非空）。
 * 申报了记录字段就把这个源一并并入，否则 AI 点名的字段会**静默不生效**。
 */
export const PLAN_RAG_SELECTION_SOURCE = 'ragSelection' as const

export const PLAN_MAX_SOURCE_KEYS = 14
export const PLAN_MAX_RAG_KEYS = 24
export const PLAN_MAX_CHARACTERS = 1
export const PLAN_MAX_BEATS = 12
export const PLAN_MAX_PLAN_ITEMS = 12
export const PLAN_MAX_PLAN_ITEM_CHARS = 120
export const PLAN_MAX_NOTES_CHARS = 600

export interface PlanNeedsCatalogs {
  /** 可申报的登记源 key（由 CONTEXT_SOURCES 派生）。 */
  sourceKeys: readonly string[]
  /** 可申报的记录/字段 key（由资料库 buildRagLibrary 派生）。 */
  ragEntryKeys: readonly string[]
  /** 记录字段 key 到作者可读中文标签的映射。 */
  ragEntryLabels?: Readonly<Record<string, string>>
  /** 可申报的角色正名（由实体名册派生）。 */
  characterNames: readonly string[]
}

export interface PlanWritingPlan {
  beats: string[]
  mustPayOff: string[]
  mustNotReveal: string[]
  notes: string
}

export interface PlanNeedsRejection {
  unknownSources: string[]
  unknownRagKeys: string[]
  unknownCharacters: string[]
  /** 超出数量上限被丢掉的项（不是"未登记"，是"太多"）。 */
  overLimit: Array<{ field: 'sourceKeys' | 'ragEntryKeys' | 'subjectCharacterName'; dropped: number }>
}

export interface PlanSelection {
  /** 最终装配清单 = 地板 ∪ AI 追加（去重，地板在前，顺序稳定）。 */
  sourceKeys: string[]
  /** AI 申报且**地板里没有**的源（面板里可取消的就是这些）。 */
  aiAddedSourceKeys: string[]
  /** AI 也申报了、但本来就在地板里的源（信息性展示，不重复注入）。 */
  aiKnownSourceKeys: string[]
  /** 因申报主体角色而自动并入的源（面板需如实标注，不能让作者以为是自己要的）。 */
  subjectSourceKeys: string[]
  /** `ragSelection` 是否因申报了记录字段而自动并入。 */
  ragSelectionAutoAdded: boolean
  ragEntryKeys: string[]
  /** 本次协商目录里的记录字段中文标签，随会话结果传递到预览。 */
  ragEntryLabels?: Record<string, string>
  subjectCharacterName: string | null
  plan: PlanWritingPlan
  rejected: PlanNeedsRejection
  /**
   * PROMPT-PLAN-2：作者对「生成前提问」的回答（会话级、不落库）。
   * 未经过提问轮时为空数组——缺少它不得改变既有行为。
   */
  answers?: PlanAskAnswer[]
}

/**
 * 从模型原文里抠出 JSON 对象。解析失败返回 null（调用方必须显式报错，不得用"半套需求"继续）。
 */
export function parsePlanNeedsPayload(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim())
      .filter(Boolean)
  }
  if (typeof value === 'string' && value.trim()) return [value.trim()]
  return []
}

function planItems(value: unknown, max: number): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of stringList(value)) {
    const clipped = item.slice(0, PLAN_MAX_PLAN_ITEM_CHARS)
    if (seen.has(clipped)) continue
    seen.add(clipped)
    out.push(clipped)
    if (out.length >= max) break
  }
  return out
}

function validList(
  requested: readonly string[],
  allowed: readonly string[],
  max: number,
): { accepted: string[]; unknown: string[]; dropped: number } {
  const allow = new Set(allowed)
  const seen = new Set<string>()
  const accepted: string[] = []
  const unknown: string[] = []
  let dropped = 0
  for (const raw of requested) {
    const key = raw.trim()
    if (!key || seen.has(key)) continue
    seen.add(key)
    if (!allow.has(key)) {
      unknown.push(key)
      continue
    }
    if (accepted.length >= max) {
      dropped++
      continue
    }
    accepted.push(key)
  }
  return { accepted, unknown, dropped }
}

/**
 * 校验并合并一次申报。`raw` 必须是已解析的对象（用 parsePlanNeedsPayload 得到）。
 * 返回 null 只表示"完全不可用"（不是对象）；其余问题都体现为 rejected，不阻断。
 */
export function validatePlanNeeds(
  raw: unknown,
  catalogs: PlanNeedsCatalogs,
): PlanSelection | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>

  const sources = validList(stringList(record.sourceKeys), catalogs.sourceKeys, PLAN_MAX_SOURCE_KEYS)
  const rag = validList(stringList(record.ragEntryKeys), catalogs.ragEntryKeys, PLAN_MAX_RAG_KEYS)
  const characterCandidates = validList(
    stringList(record.subjectCharacterName ?? record.subjectCharacterNames),
    catalogs.characterNames,
    PLAN_MAX_CHARACTERS,
  )

  const subjectCharacterName = characterCandidates.accepted[0] ?? null
  const floorSet = new Set<string>(PLAN_FLOOR_SOURCES)
  const aiAddedSourceKeys = sources.accepted.filter(key => !floorSet.has(key))
  const aiKnownSourceKeys = sources.accepted.filter(key => floorSet.has(key))
  const subjectSourceKeys = subjectCharacterName
    ? PLAN_SUBJECT_SOURCES.filter(key => !floorSet.has(key) && !aiAddedSourceKeys.includes(key))
    : []
  const ragSelectionAutoAdded = rag.accepted.length > 0
    && !floorSet.has(PLAN_RAG_SELECTION_SOURCE)
    && !aiAddedSourceKeys.includes(PLAN_RAG_SELECTION_SOURCE)

  const sourceKeys = [
    ...PLAN_FLOOR_SOURCES,
    ...aiAddedSourceKeys,
    ...subjectSourceKeys,
    ...(ragSelectionAutoAdded ? [PLAN_RAG_SELECTION_SOURCE] : []),
  ]

  const overLimit: PlanNeedsRejection['overLimit'] = []
  if (sources.dropped) overLimit.push({ field: 'sourceKeys', dropped: sources.dropped })
  if (rag.dropped) overLimit.push({ field: 'ragEntryKeys', dropped: rag.dropped })
  if (characterCandidates.dropped) {
    overLimit.push({ field: 'subjectCharacterName', dropped: characterCandidates.dropped })
  }

  const planRecord = (record.writingPlan && typeof record.writingPlan === 'object' && !Array.isArray(record.writingPlan))
    ? record.writingPlan as Record<string, unknown>
    : {}

  return {
    sourceKeys,
    aiAddedSourceKeys,
    aiKnownSourceKeys,
    subjectSourceKeys,
    ragSelectionAutoAdded,
    ragEntryKeys: rag.accepted,
    ragEntryLabels: Object.fromEntries(rag.accepted.map(key => [key, catalogs.ragEntryLabels?.[key] ?? key])),
    subjectCharacterName,
    plan: {
      beats: planItems(planRecord.beats, PLAN_MAX_BEATS),
      mustPayOff: planItems(planRecord.mustPayOff, PLAN_MAX_PLAN_ITEMS),
      mustNotReveal: planItems(planRecord.mustNotReveal, PLAN_MAX_PLAN_ITEMS),
      notes: typeof planRecord.notes === 'string' ? planRecord.notes.trim().slice(0, PLAN_MAX_NOTES_CHARS) : '',
    },
    rejected: {
      unknownSources: sources.unknown,
      unknownRagKeys: rag.unknown,
      unknownCharacters: characterCandidates.unknown,
      overLimit,
    },
  }
}

/**
 * 作者在确认面板里改动后的选择（取消 AI 追加项 / 手动补源 / 清除主体角色）。
 * 地板与主体证据源保持不可变——地板是连贯性下限，主体源跟着 subjectCharacterName 走。
 */
export function applyAuthorEdits(
  selection: PlanSelection,
  edits: {
    removedAddedSourceKeys?: readonly string[]
    extraSourceKeys?: readonly string[]
    removedRagEntryKeys?: readonly string[]
  },
): PlanSelection {
  const removed = new Set(edits.removedAddedSourceKeys ?? [])
  const extra = (edits.extraSourceKeys ?? []).filter(key => !PLAN_FLOOR_SOURCES.includes(key as typeof PLAN_FLOOR_SOURCES[number]))
  const removedRag = new Set(edits.removedRagEntryKeys ?? [])
  const aiAddedSourceKeys = selection.aiAddedSourceKeys.filter(key => !removed.has(key))
  const merged = new Set<string>([...aiAddedSourceKeys, ...extra])
  return {
    ...selection,
    aiAddedSourceKeys: [...merged],
    ragEntryKeys: selection.ragEntryKeys.filter(key => !removedRag.has(key)),
    sourceKeys: [
      ...PLAN_FLOOR_SOURCES,
      ...merged,
      ...selection.subjectSourceKeys,
      ...(selection.ragSelectionAutoAdded ? [PLAN_RAG_SELECTION_SOURCE] : []),
    ],
  }
}

/**
 * 把一次协商结果按**调用方自己的地板**重建最终装配清单。
 *
 * 为什么需要它（真实缺陷）：`validatePlanNeeds` 的地板是**正文**的 `PLAN_FLOOR_SOURCES`，
 * 所以它算出的 `sourceKeys` 里混着正文专用源（正文前情、状态卡、物品流水…）。
 * 大纲生成若直接拿这份清单装配，会把整套正文源灌进大纲请求（token 暴涨，且不是作者确认的内容）；
 * 若反过来只用 `aiAddedSourceKeys`，AI 申报的、恰好落在正文地板里的源
 * （如 `recentChapterSummaries`）又会被**静默丢弃**——那正是本函数要修的另一半。
 *
 * 规则：地板 ∪ AI 申报（`aiKnownSourceKeys ∪ aiAddedSourceKeys`）∪ 主体证据源 ∪ ragSelection。
 * `aiKnownSourceKeys` 必须计入：它表示"AI 申报了、但恰好在正文地板里"，
 * 对地板不同的大纲调用方而言，这正是需要补进来的申报项。
 */
export function withPlanFloor(selection: PlanSelection, floor: readonly string[]): string[] {
  const out: string[] = [...floor]
  const declared = [...selection.aiKnownSourceKeys, ...selection.aiAddedSourceKeys]
  const extra = [
    ...declared,
    ...selection.subjectSourceKeys,
    ...(selection.ragSelectionAutoAdded ? [PLAN_RAG_SELECTION_SOURCE] : []),
  ]
  for (const key of extra) {
    if (key && !out.includes(key)) out.push(key)
  }
  return out
}

/** 一次申报是否完全空白（作者应被提示"AI 没提出任何需求"）。 */
export function isEmptyPlanSelection(selection: PlanSelection): boolean {
  return selection.aiAddedSourceKeys.length === 0
    && selection.aiKnownSourceKeys.length === 0
    && selection.ragEntryKeys.length === 0
    && selection.subjectCharacterName == null
    && selection.plan.beats.length === 0
    && selection.plan.mustPayOff.length === 0
    && selection.plan.mustNotReveal.length === 0
    && !selection.plan.notes
}

/**
 * 把写作计划渲染成最终提示词的追加要求（经 `userHint` 变量进入 `chapter.content` 模板）。
 *
 * 为什么走 userHint 而不新开上下文源：计划是"本次写作指令"，不是项目资料；
 * userHint 已经是被模板承认、且在透明模式里逐字可见可改的通道。
 */
export function formatPlanUserHint(plan: PlanWritingPlan, authorHint?: string): string {
  const blocks: string[] = []
  const base = authorHint?.trim()
  if (base) blocks.push(base)
  const lines: string[] = []
  if (plan.beats.length) lines.push(`节拍：${plan.beats.map((beat, index) => `${index + 1}) ${beat}`).join(' ')}`)
  if (plan.mustPayOff.length) lines.push(`本章必须兑现：${plan.mustPayOff.join('；')}`)
  if (plan.mustNotReveal.length) lines.push(`本章必须不透露：${plan.mustNotReveal.join('；')}`)
  if (plan.notes) lines.push(`其他注意：${plan.notes}`)
  if (lines.length) blocks.push(['【本章写作计划（生成前协商，作者已确认）】', ...lines].join('\n'))
  return blocks.join('\n\n')
}
