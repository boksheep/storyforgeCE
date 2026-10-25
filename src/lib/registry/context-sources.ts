/**
 * CONTEXT_SOURCES(Phase 1.3a) · AI 上下文读取源注册表。
 *
 * 本文件只登记读取源和旧适配器桥接。1.3b 再把生成入口迁移到 assembleContext()。
 */
import { db } from '../db/schema'
import { resolveCanonicalChapterSequence } from '../ai/chapter-memory/canonical-chapter-sequence'
import { getFactPredicate } from './fact-predicate-registry'
import { retrieveChunks, embedQuery, readNarrativeSummaryContext } from '../retrieval/retrieval'
import { isEmbeddingReady, embeddingModelTag } from '../ai/adapters/embedding-adapter'
import { useAIConfigStore } from '../../stores/ai-config'
import {
  buildCreativeRulesContext,
  buildHistoricalContext,
  buildLocationContext,
  buildRefAnalysisContext,
  buildCharacterContext,
  formatCharacterRoster,
  formatPowerSystemBlock,
  formatStoryCoreBlock,
  formatWorldviewBlock,
  getContextMemo,
} from '../ai/context-builder'
import { buildCodexContext } from '../ai/codex-context'
import { buildCultivationContext } from '../ai/cultivation-context'
import { buildWorldRulesContext } from '../ai/world-rules-manifest'
import { formatHandoff } from '../ai/chapter-memory/handoff-format'
import { getChapterDerivedMemoryStatus, normalizeChapterText } from '../ai/chapter-memory/text-normalization'
import { parseStages } from '../types/story-arc'
import { parseFields } from '../types/state-card'
import { matchesStateCardReference } from '../state-card/selection'
import { parseBeats } from '../types/emotion-beat'
import { buildForeshadowTaskContext } from '../foreshadow/context'
import { buildEntityRoster } from '../ai/entity-roster'
import { formatHeldItemsContext, readProjectHeldItems } from '../consistency/held-items'
import { formatCharacterKnowledgeContext, readProjectCharacterKnowledge } from '../knowledge-ledger/knowledge-ledger'
import { formatCanonAssertionsContext, readCanonAssertions } from '../fact-ledger/setting-assertions'
import { readStorylineProgressContext } from '../storyline/storyline-progress'
import { readCultivationProgressContext } from '../cultivation/progress'
import type { Chapter, Character, DetailedOutline, OutlineNode, PowerSystem, Worldview } from '../types'
import { selectFocusCharacters, buildCharacterSurfaceIndex, resolveCharacterBySurface, characterSurfaces, findCharactersInText } from '../character/character-identity'
import { entitySurfaceNames } from '../entities/surface-match'
import {
  parseCharacterDrivenPlanArcs,
  parseCharacterDrivenPlotVolumes,
} from '../types/character-driven-plan'
import type { AssembleContextInput, ContextSource } from './types'
import { countWords, htmlToPlainText } from '../utils/html'
import {
  formatStyleCalibrationFeedback,
  formatStyleFewShotPairs,
  parseStyleCalibrationFeedback,
  parseStyleRevisionPairs,
} from '../style/style-learning'
import {
  buildInspirationFusionInput,
  latestInspirationVersion,
  parseInspirationFragments,
  parseInspirationVersions,
} from '../inspiration/workspace'
import {
  readAgentOutlineTree,
  readAgentProjectStatus,
  readAgentProseSamples,
  readAgentSearchResults,
  readAgentWorldGroups,
} from '../agent/read-sources'
import { readRagSelectionContext } from '../retrieval/rag-library'
import { readMasterConversationContext } from '../agent/conversation-memory'
import { projectTableCatalog, readProjectRecordField, readProjectTablePage, searchProjectRecordText } from '../agent/project-table-reader'
import { prepareChapterDeletionCandidate } from '../agent/project-lifecycle-copilot'
import { countCharacterAppearances, lookupOutlineReference } from '../agent/project-mentions'
import { readMapFactsContext } from '../world-map/map-data'
import { locationInWorld } from '../location/scope'
import { readMapRelevantFactsContext } from '../world-map/map-relevant'

async function readWorldview(projectId: number, worldGroupId?: number | null): Promise<Worldview | null> {
  const rows = await db.worldviews.where('projectId').equals(projectId).toArray()
  if (worldGroupId != null) {
    return rows.find(w => w.worldGroupId === worldGroupId) ?? null
  }
  return rows.find(w => (w.worldGroupId ?? null) === null) ?? rows[0] ?? null
}

async function readPowerSystem(projectId: number, worldGroupId?: number | null): Promise<PowerSystem | null> {
  const rows = await db.powerSystems.where('projectId').equals(projectId).toArray()
  if (worldGroupId != null) {
    return rows.find(p => p.worldGroupId === worldGroupId) ?? null
  }
  return rows.find(p => (p.worldGroupId ?? null) === null) ?? rows[0] ?? null
}

async function readCharacters(projectId: number, worldGroupId?: number | null): Promise<Character[]> {
  const rows = await db.characters.where('projectId').equals(projectId).toArray()
  if (worldGroupId === undefined) return rows
  const wg = worldGroupId ?? null
  return rows.filter(c => c.isCrossWorld || (c.homeWorldGroupId ?? null) === wg)
}

async function readGeographyContext(projectId: number, worldGroupId: number | null): Promise<string> {
  const rows = await db.geographies.where('projectId').equals(projectId).toArray()
  const geography = rows.find(row => (row.worldGroupId ?? null) === worldGroupId)
  if (!geography) return ''
  let locations: Array<{ name?: string; type?: string; description?: string; significance?: string }> = []
  try {
    const parsed: unknown = JSON.parse(geography.locations || '[]')
    if (Array.isArray(parsed)) locations = parsed.filter((item): item is typeof locations[number] => !!item && typeof item === 'object')
  } catch { /* Invalid legacy JSON is not evidence. */ }
  return [
    `【当前世界地理总述】${geography.overview || '未填写'}`,
    `【当前世界地理树】共 ${locations.length} 项`,
    ...locations.map(row => `- ${row.name ?? '未命名'} [${row.type ?? 'other'}]：${row.description ?? ''}${row.significance ? `；剧情意义：${row.significance}` : ''}`),
  ].join('\n')
}

/**
 * ALIAS-1 · 「本章相关角色」。
 *
 * 旧行为是把这个世界的**全部角色**档案灌进正文上下文，再由 token 预算从尾部随机砍。
 * 现在按确定性优先级选入：细纲声明的出场角色 > 正文/章纲提及（正名或**别称**都能命中）
 * > main 兜底；其余角色只进名单（`formatCharacterRoster`），避免模型不知道还有谁存在。
 *
 * 选不出任何角色时**回落全量**（与 state-card 的"无匹配回退全量"同型），
 * 保证不会出现"零角色上下文"这种比原来更糟的结果。
 */
async function readCharacterFocus(input: AssembleContextInput): Promise<string> {
  const [characters, outlineNodes, chapters, details] = await Promise.all([
    db.characters.where('projectId').equals(input.projectId).toArray(),
    db.outlineNodes.where('projectId').equals(input.projectId).toArray(),
    db.chapters.where('projectId').equals(input.projectId).toArray(),
    input.outlineNodeId != null
      ? db.detailedOutlines.where('outlineNodeId').equals(input.outlineNodeId).toArray()
      : Promise.resolve([] as DetailedOutline[]),
  ])

  const { sequence } = resolveCanonicalChapterSequence(outlineNodes, chapters)
  const orderOfChapter = new Map<number, number>()
  sequence.forEach((entry, index) => {
    if (entry.chapter.id != null) orderOfChapter.set(entry.chapter.id, index)
  })
  const targetChapterId = input.chapterId
    ?? chapters.find(chapter => chapter.outlineNodeId === input.outlineNodeId)?.id
    ?? null
  const chapterOrder = targetChapterId != null ? orderOfChapter.get(targetChapterId) ?? null : null

  const declaredCharacterIds = details.flatMap(detail => detail.appearingCharacterIds ?? [])
  const detailText = details
    .flatMap(detail => (detail.scenes ?? []).map(scene => `${scene.title} ${scene.summary}`))
    .join('\n')
  const referenceText = [input.stateReferenceText, detailText].filter(Boolean).join('\n')

  const selection = selectFocusCharacters({
    characters,
    worldGroupId: input.worldGroupId,
    declaredCharacterIds,
    referenceText,
    chapterOrder,
    orderOfChapter,
  })

  if (!selection.focus.length) {
    return buildCharacterContext(await readCharacters(input.projectId, input.worldGroupId))
  }
  return [
    buildCharacterContext(selection.focus),
    formatCharacterRoster(selection.roster),
  ].filter(Boolean).join('\n\n')
}

async function readForeshadows(projectId: number, chapterId?: number | null): Promise<string> {
  const [rows, chapters, outlineNodes] = await Promise.all([
    db.foreshadows.where('projectId').equals(projectId).toArray(),
    db.chapters.where('projectId').equals(projectId).toArray(),
    db.outlineNodes.where('projectId').equals(projectId).toArray(),
  ])
  return buildForeshadowTaskContext(rows, {
    currentChapterId: chapterId ?? null,
    chapters,
    outlineNodes,
  })
}

/** FB-5:作者文风画像。仅当画像存在且 enabled 时返回,否则空串(不进上下文)。 */
async function readUserStyleProfile(projectId: number): Promise<string> {
  const profile = await db.userStyleProfiles.where('projectId').equals(projectId).first()
  if (!profile || !profile.enabled || !profile.profile.trim()) return ''
  const pairExamples = formatStyleFewShotPairs(parseStyleRevisionPairs(profile.revisionPairs))
  const feedback = formatStyleCalibrationFeedback(
    parseStyleCalibrationFeedback(profile.calibrationFeedback),
  )
  return [
    '【作者文风偏好】',
    '请在本次写作中贴合作者一贯的表达习惯，但不要照搬样本中的剧情、人物名、地点名或专有名词。',
    profile.profile.trim(),
    pairExamples ? `【作者改稿对照（仅学习改写方向）】\n${pairExamples}` : '',
    feedback ? `【最近校准反馈】\n${feedback}` : '',
  ].filter(Boolean).join('\n\n')
}

async function readInspirationWorkspaceContext(
  projectId: number,
  selectedIds: string[] | undefined,
  mode: 'single' | 'multiworld' = 'single',
): Promise<string> {
  if (!selectedIds?.length) return ''
  const workspace = await db.inspirationWorkspaces.where('projectId').equals(projectId).first()
  if (!workspace) return ''
  const fragments = parseInspirationFragments(workspace.fragments)
  const versions = parseInspirationVersions(workspace.versions)
  return buildInspirationFusionInput({
    fragments,
    selectedIds: new Set(selectedIds),
    previousVersion: latestInspirationVersion(versions, mode),
  })
}

export async function readActiveCharacterDrivenPlanContext(projectId: number): Promise<string> {
  const project = await db.projects.get(projectId)
  const activeId = project?.activeCharacterDrivenPlanId
  if (activeId == null) return ''

  const plan = await db.characterDrivenPlans.get(activeId)
  if (!plan || plan.projectId !== projectId) return ''

  const [characters, arcs] = await Promise.all([
    db.characters.where('projectId').equals(projectId).toArray(),
    Promise.resolve(parseCharacterDrivenPlanArcs(plan.arcs)),
  ])
  const byId = new Map(characters.flatMap(character =>
    character.id == null ? [] : [[character.id, character] as const],
  ))
  const lines = [
    `【当前生效的角色驱动方案】${plan.name}（v${plan.version}，${plan.status}）`,
  ]
  if (plan.userHint.trim()) lines.push(`作者要求：${plan.userHint.trim()}`)
  for (const arc of arcs) {
    const current = arc.characterId == null ? null : byId.get(arc.characterId)
    const identity = current
      ? `${current.name}${current.name !== arc.name ? `（方案快照名：${arc.name}）` : ''}`
      : `${arc.name}（原角色已删除，仅保留方案快照）`
    lines.push(
      `- ${identity}｜${arc.role || '未标注身份'}：${arc.initialState || '未填写'} → ${arc.targetState || '未填写'}`,
    )
  }
  const volumes = parseCharacterDrivenPlotVolumes(plan.generatedVolumes)
  for (const volume of volumes) {
    lines.push(`卷：${volume.volumeTitle}｜${volume.volumeSummary}`)
    if (volume.characterArcs) lines.push(`  弧光：${volume.characterArcs}`)
    for (const chapter of volume.chapters) {
      lines.push(`  - ${chapter.title}：${chapter.summary}${chapter.arcProgress ? `；弧光推进：${chapter.arcProgress}` : ''}`)
    }
  }
  return lines.join('\n')
}

async function readStoryArcs(projectId: number): Promise<string> {
  const arcs = await db.storyArcs.where('projectId').equals(projectId).toArray()
  if (!arcs.length) return ''
  const parts = ['【全局故事线】']
  for (const arc of arcs.slice(0, 8)) {
    const stages = parseStages(arc.stages)
    parts.push(`[${arc.type}] ${arc.name}${arc.description ? `:${arc.description.slice(0, 120)}` : ''}`)
    for (const stage of stages.slice(0, 6)) {
      parts.push(`- ${stage.title}: ${stage.description.slice(0, 120)}`)
    }
  }
  return parts.join('\n')
}

async function readEmotionBeats(projectId: number, chapterId?: number | null): Promise<string> {
  if (chapterId == null) return ''
  const rows = await db.emotionBeatCards.where('projectId').equals(projectId).toArray()
  const card = rows.find(c => c.chapterId === chapterId)
  if (!card) return ''
  const beats = parseBeats(String(card.beats || '[]'))
  if (!beats.length) return ''
  return [
    '【本章情感节拍规划】',
    card.overallArc ? `整体弧线:${card.overallArc}` : '',
    ...beats.map(b => `- ${b.label}${b.sceneGoal ? `: ${b.sceneGoal}` : ''}`),
  ].filter(Boolean).join('\n')
}

async function readStateCards(projectId: number, referenceText?: string, extraIds?: number[], worldGroupId: number | null = null): Promise<string> {
  const rows = await db.stateCards.where('projectId').equals(projectId).toArray()
  if (!rows.length) return ''
  const extra = new Set(extraIds ?? [])
  const text = referenceText || ''
  // ALIAS-1: 状态卡的 `entityName` 可能是角色的别称（历史数据或作者手填）。
  // 允许"正文写别称、状态卡记正名"也能互相命中。
  const surfaceAliases = await aliasSurfacesForStateCards(projectId, rows.map(row => row.entityName), worldGroupId)
  const selected = text
    ? rows.filter(c => extra.has(c.id!) || matchesStateCardReference(c, text, surfaceAliases.get(c.entityName)))
    : rows.slice(0, 40)
  if (!selected.length) return ''
  const lines = selected.map(c => {
    const fields = parseFields(c.fields).slice(0, 8).map(f => `${f.key}:${f.value}`).join(' | ')
    return `- ${c.category}/${c.entityName}: ${fields}`
  })
  return `【当前状态表】\n${lines.join('\n')}`
}

/** 状态卡实体名 → 该实体的全部称呼（角色/地点/词条；解析不到就不加映射）。 */
async function aliasSurfacesForStateCards(
  projectId: number,
  entityNames: readonly string[],
  worldGroupId: number | null,
): Promise<Map<string, string[]>> {
  const [characters, locations, codexEntries, mapFeatures, project] = await Promise.all([
    db.characters.where('projectId').equals(projectId).toArray(),
    db.importantLocations.where('projectId').equals(projectId).toArray(),
    db.codexEntries.where('projectId').equals(projectId).toArray(),
    db.mapFeatures.where('projectId').equals(projectId).toArray(),
    db.projects.get(projectId),
  ])
  const byName = new Map<string, string[]>()
  const register = (surfaces: string[]) => {
    for (const surface of surfaces) {
      const key = surface.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
      const existing = byName.get(key)
      if (existing) existing.push(...surfaces.filter(item => !existing.includes(item)))
      else byName.set(key, [...surfaces])
    }
  }
  for (const character of characters) if (character.isCrossWorld || (character.homeWorldGroupId ?? null) === worldGroupId) register(characterSurfaces(character))
  for (const location of locations) if (locationInWorld(location, Boolean(project?.enableMultiWorld), worldGroupId)) register(entitySurfaceNames(location))
  for (const entry of codexEntries) if ((entry.worldGroupId ?? null) === worldGroupId) register(entitySurfaceNames(entry))
  for (const feature of mapFeatures) if (feature.status === 'confirmed' && (feature.worldGroupId ?? null) === worldGroupId) register(entitySurfaceNames(feature))
  const out = new Map<string, string[]>()
  for (const name of entityNames) {
    const key = name.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
    const surfaces = byName.get(key)
    if (surfaces) out.set(name, surfaces)
  }
  return out
}

async function readChapterOutline(projectId: number, outlineNodeId?: number | null, chapterId?: number | null): Promise<string> {
  let nodeId = outlineNodeId ?? null
  if (nodeId == null && chapterId != null) {
    const chapter = await db.chapters.get(chapterId)
    nodeId = chapter?.outlineNodeId ?? null
  }
  if (nodeId == null) return ''
  const node = await db.outlineNodes.get(nodeId)
  if (!node || node.projectId !== projectId) return ''
  return `【当前章节大纲】\n${node.title}${node.summary ? `\n${node.summary}` : ''}`
}

async function readExistingVolumeOutlines(projectId: number): Promise<string> {
  const rows = await db.outlineNodes.where('projectId').equals(projectId).toArray()
  const volumes = rows
    .filter(node => node.type === 'volume' && node.parentId == null)
    .sort((a, b) => a.order - b.order)
  if (!volumes.length) return ''
  return [
    '【已有卷大纲（必须接续，禁止重复）】',
    ...volumes.map((volume, index) => (
      `${index + 1}. ${volume.title}${volume.summary ? `\n   ${volume.summary}` : '\n   （尚未填写卷纲）'}`
    )),
  ].join('\n')
}

function findVolumeAncestor(nodeId: number, nodesById: Map<number, OutlineNode>): OutlineNode | null {
  let current = nodesById.get(nodeId) ?? null
  const visited = new Set<number>()
  while (current) {
    if (current.type === 'volume') return current
    if (current.parentId == null || visited.has(current.id ?? -1)) return null
    if (current.id != null) visited.add(current.id)
    current = nodesById.get(current.parentId) ?? null
  }
  return null
}

function excerptChapterText(chapter: Chapter, maxChars = 360): string {
  const text = normalizeChapterText(chapter.content || '')
  if (!text) return ''
  if (text.length <= maxChars) return text
  const edge = Math.max(100, Math.floor(maxChars / 2))
  return `${text.slice(0, edge)}\n...\n${text.slice(-edge)}`
}

async function summarizeWrittenChapterForOutline(entry: {
  ordinal: number
  chapter: Chapter
  outlineNode: OutlineNode | null
}): Promise<string> {
  const title = entry.outlineNode?.title ?? entry.chapter.title
  const plain = normalizeChapterText(entry.chapter.content || '')
  const words = Math.max(entry.chapter.wordCount || 0, countWords(htmlToPlainText(entry.chapter.content || '').trim()))
  const lines = [`第 ${entry.ordinal} 章 ${title}（已写正文，约 ${words} 字）`]

  const memory = await getChapterDerivedMemoryStatus(entry.chapter)
  if (entry.chapter.summary?.trim() && memory.summary === 'verified') {
    lines.push(`章节记忆:${entry.chapter.summary.trim()}`)
  } else if (entry.outlineNode?.summary?.trim()) {
    lines.push(`原章纲:${entry.outlineNode.summary.trim()}`)
  }

  if (entry.chapter.continuityHandoff && memory.handoff === 'verified') {
    const handoffLines = formatHandoff(entry.chapter.continuityHandoff).slice(0, 8)
    if (handoffLines.length) lines.push(`结尾交接:${handoffLines.join('；')}`)
  }

  const reconciliation = entry.chapter.planReconciliation
  if (reconciliation?.confirmedActualProgress?.trim()) {
    lines.push(`作者确认实际进展:${reconciliation.confirmedActualProgress.trim()}`)
  } else if (reconciliation) {
    const deltas = [
      ...reconciliation.deviations.map(item => `实际偏移:${item.text}`),
      ...reconciliation.newConstraints.map(item => `新增约束:${item.text}`),
      ...reconciliation.nextChapterImpacts.map(item => `后续影响:${item.text}`),
    ].slice(0, 6)
    if (deltas.length) lines.push(`计划-正文对账:${deltas.join('；')}`)
  }

  if (plain && !entry.chapter.summary?.trim()) {
    lines.push(`正文短摘:${excerptChapterText(entry.chapter)}`)
  }

  return `- ${lines.join('\n  ')}`
}

async function readWrittenChapterProgress(
  projectId: number,
  outlineNodeId?: number | null,
  worldGroupId?: number | null,
): Promise<string> {
  if (outlineNodeId == null) return ''
  const [outlineNodes, chapters] = await Promise.all([
    db.outlineNodes.where('projectId').equals(projectId).toArray(),
    db.chapters.where('projectId').equals(projectId).toArray(),
  ])
  const nodesById = new Map(outlineNodes.filter(node => node.id != null).map(node => [node.id!, node]))
  const target = nodesById.get(outlineNodeId)
  if (!target) return ''
  const targetVolume = target.type === 'volume' ? target : findVolumeAncestor(outlineNodeId, nodesById)
  if (!targetVolume?.id) return ''

  const { sequence } = resolveCanonicalChapterSequence(outlineNodes, chapters)
  const written = sequence
    .filter(entry => entry.outlineNode && findVolumeAncestor(entry.outlineNode.id!, nodesById)?.id === targetVolume.id)
    .filter(entry => worldGroupId === undefined || entry.worldGroupId === (worldGroupId ?? null))
    .filter(entry => normalizeChapterText(entry.chapter.content || '').length > 0)
    .slice(0, 40)

  if (!written.length) return ''

  const lines = await Promise.all(written.map((entry, index) => summarizeWrittenChapterForOutline({
    ordinal: sequence.findIndex(item => item.chapter === entry.chapter) + 1 || index + 1,
    chapter: entry.chapter,
    outlineNode: entry.outlineNode,
  })))

  return [
    `【本卷已写正文进度 · ${targetVolume.title}】`,
    '以下内容来自已保存章节正文/章节记忆，是补卷纲或章纲时必须尊重的事实边界；不要改写、否认、重排这些已写内容。',
    ...lines,
  ].join('\n')
}

/** 主 Agent 审阅指定卷时读取完整卷内摘要和场景细纲，保留节点 ID 供报告引用。 */
async function readVolumeAuditOutline(input: AssembleContextInput): Promise<string> {
  if (input.outlineNodeId == null) return ''
  const nodes = await db.outlineNodes.where('projectId').equals(input.projectId).toArray()
  const byId = new Map(nodes.flatMap(node => node.id == null ? [] : [[node.id, node] as const]))
  const volume = byId.get(input.outlineNodeId)
  if (!volume || volume.type !== 'volume'
    || (volume.worldGroupId ?? null) !== (input.worldGroupId ?? null)) return ''
  const inVolume = nodes
    .filter(node => node.id === volume.id || (node.id != null
      && findVolumeAncestor(node.id, byId)?.id === volume.id))
    .sort((left, right) => left.order - right.order || (left.id ?? 0) - (right.id ?? 0))
    .slice(0, 120)
  const ids = new Set(inVolume.map(node => node.id))
  const [details, chapters] = await Promise.all([
    db.detailedOutlines.where('projectId').equals(input.projectId).toArray(),
    db.chapters.where('projectId').equals(input.projectId).toArray(),
  ])
  const detailByNode = new Map(details.filter(row => ids.has(row.outlineNodeId))
    .map(row => [row.outlineNodeId, row]))
  const chapterByNode = new Map(chapters.filter(row => ids.has(row.outlineNodeId))
    .map(row => [row.outlineNodeId, row]))
  return [
    `【${volume.title} · 卷内剧情证据】`,
    ...inVolume.map(node => {
      const detail = detailByNode.get(node.id!)
      const chapter = chapterByNode.get(node.id!)
      return [
        `#${node.id} [${node.type}] ${node.title}`,
        node.summary ? `大纲：${node.summary.slice(0, 1600)}` : '',
        detail?.scenes?.length ? `场景：${detail.scenes.slice(0, 20)
          .map(scene => `${scene.title}：${scene.summary}`).join('；').slice(0, 1800)}` : '',
        chapter?.summary ? `已写正文摘要：${chapter.summary.slice(0, 800)}` : '',
      ].filter(Boolean).join('\n')
    }),
    inVolume.length === 120 ? '注：卷内节点已达 120 条上限，后续节点未纳入。' : '',
  ].filter(Boolean).join('\n\n')
}

/**
 * FB-9 修复:读取本章「场景细纲」(detailedOutlines)。
 * 细纲此前只是 DB 表(写得进、删得掉),但从未登记成上下文源 → AI 生成读不到它。
 * 这里按当前章节节点读出场景拆解(开头衔接/逐场景:标题·概要·冲突·地点/结尾悬念),
 * 供正文等下游生成时注入,实现"用细纲指导正文",小上下文也能写出贴合的文字。
 */
async function readDetailedOutline(projectId: number, outlineNodeId?: number | null, chapterId?: number | null): Promise<string> {
  let nodeId = outlineNodeId ?? null
  if (nodeId == null && chapterId != null) {
    const chapter = await db.chapters.get(chapterId)
    nodeId = chapter?.outlineNodeId ?? null
  }
  if (nodeId == null) return ''
  const rows = await db.detailedOutlines.where('projectId').equals(projectId).toArray()
  const detail = rows.find(d => d.outlineNodeId === nodeId)
  if (!detail || !Array.isArray(detail.scenes) || detail.scenes.length === 0) return ''
  const parts: string[] = ['【本章细纲(场景拆解)】']
  if (detail.openingHook) parts.push(`开头衔接:${detail.openingHook}`)
  detail.scenes.forEach((s, i) => {
    const bits = [s.summary, s.conflict ? `冲突:${s.conflict}` : '', s.location ? `地点:${s.location}` : '']
      .filter(Boolean).join(' / ')
    parts.push(`场景${i + 1} ${s.title || ''}: ${bits}`)
  })
  if (detail.prohibitions?.length) {
    parts.push(`不可写清单:${detail.prohibitions.join('；')}`)
  }
  if (detail.endingCliffhanger) parts.push(`结尾悬念:${detail.endingCliffhanger}`)
  return parts.join('\n')
}

async function readItemLedger(projectId: number, characterId?: number | null): Promise<string> {
  const rows = await db.itemLedger.where('projectId').equals(projectId).toArray()
  const filtered = characterId != null
    ? rows.filter(r => (r.characterId ?? null) === (characterId ?? null))
    : rows
  if (!filtered.length) return ''
  return [
    '【物品流水证据】',
    ...filtered.slice(-120).map(row =>
      `#${row.id ?? 0} ${row.chapterTitle ?? `章节#${row.chapterId ?? '?'}`}：${row.action === 'gain' ? '获得' : '消耗'} ${row.itemName} ×${row.quantity}${row.heldByName ? `（${row.heldByName}）` : ''}${row.note ? ` ${row.note}` : ''}`),
  ].join('\n')
}

async function readHeldItems(
  projectId: number,
  chapterId?: number | null,
  worldGroupId?: number | null,
  characterId?: number | null,
  outlineNodeId?: number | null,
): Promise<string> {
  if (chapterId == null && outlineNodeId == null) return ''
  return formatHeldItemsContext(await readProjectHeldItems(
    projectId,
    chapterId,
    worldGroupId,
    characterId,
    outlineNodeId,
  ))
}

async function readStoryTimeline(
  projectId: number,
  chapterId?: number | null,
  worldGroupId?: number | null,
): Promise<string> {
  const [rows, chapters, outlineNodes] = await Promise.all([
    db.storyTimelineEvents.where('projectId').equals(projectId).sortBy('order'),
    db.chapters.where('projectId').equals(projectId).toArray(),
    db.outlineNodes.where('projectId').equals(projectId).toArray(),
  ])
  const nodeById = new Map(outlineNodes.filter(node => node.id != null).map(node => [node.id!, node]))
  const orderedChapterIds = chapters
    .map(chapter => ({ chapter, node: nodeById.get(chapter.outlineNodeId) }))
    .filter(item => item.node != null)
    .sort((a, b) => (a.node!.order - b.node!.order) || (a.chapter.id ?? 0) - (b.chapter.id ?? 0))
  const chapterOrder = new Map(orderedChapterIds.map((item, index) => [item.chapter.id, index]))
  const boundary = chapterId != null ? chapterOrder.get(chapterId) : undefined
  const visibleWorld = worldGroupId ?? null
  const filtered = rows.filter(row => {
    if (boundary != null && row.chapterId != null && (chapterOrder.get(row.chapterId) ?? Number.MAX_SAFE_INTEGER) > boundary) return false
    if (worldGroupId === undefined || row.chapterId == null) return true
    const chapter = chapters.find(item => item.id === row.chapterId)
    const node = chapter ? nodeById.get(chapter.outlineNodeId) : undefined
    return (node?.worldGroupId ?? null) === visibleWorld
  })
  const visibleRows = filtered.slice(-120)
  if (!visibleRows.length) return ''
  return [
    '【故事年表证据（截至当前章节，不含未来剧情）】',
    ...visibleRows.map(row =>
      `#${row.id ?? 0} ${row.storyTime ? `${row.storyTime} · ` : ''}${row.title}${row.description ? `：${row.description}` : ''}（${row.chapterTitle ?? `章节#${row.chapterId ?? '?'}`}）`),
  ].join('\n')
}

async function readCharacterRelations(projectId: number, worldGroupId?: number | null): Promise<string> {
  const [rows, characters] = await Promise.all([
    db.characterRelations.where('projectId').equals(projectId).toArray(),
    db.characters.where('projectId').equals(projectId).toArray(),
  ])
  const visibleCharacters = worldGroupId === undefined
    ? characters
    : characters.filter(character => (
        character.isCrossWorld || (character.homeWorldGroupId ?? null) === (worldGroupId ?? null)
      ))
  const names = new Map(visibleCharacters.filter(item => item.id != null).map(item => [item.id!, item.name]))
  const visibleRows = worldGroupId === undefined
    ? rows
    : rows.filter(row => names.has(row.fromCharacterId) && names.has(row.toCharacterId))
  if (!visibleRows.length) return ''
  return [
    '【角色关系证据】',
    ...visibleRows.slice(0, 160).map(row =>
      `#${row.id ?? 0} ${names.get(row.fromCharacterId) ?? `角色#${row.fromCharacterId}`} → ${names.get(row.toCharacterId) ?? `角色#${row.toCharacterId}`}：${row.label}${row.description ? `（${row.description}）` : ''}`),
  ].join('\n')
}

/**
 * NS-4 · 当前有效事实投影（事实账本 → 生成上下文）。
 * 注入当前有效的 confirmed，以及在目标时点仍有效的 superseded 历史 Canon。
 * 按【规范章序】实时解析 validFrom/To（绝不缓存 order）判定"截止本章是否有效"，
 * 并按当前世界（∪ 默认 null 世界）过滤。这是事实账本改善长期一致性的回报通道。
 */
async function readCurrentFacts(projectId: number, chapterId?: number | null, worldGroupId?: number | null): Promise<string> {
  if (chapterId == null) return ''
  const [facts, outlineNodes, chapters] = await Promise.all([
    db.temporalFacts.where('projectId').equals(projectId)
      .filter(f => f.status === 'confirmed' || f.status === 'superseded')
      .toArray(),
    db.outlineNodes.where('projectId').equals(projectId).toArray(),
    db.chapters.where('projectId').equals(projectId).toArray(),
  ])
  if (!facts.length) return ''
  const { sequence } = resolveCanonicalChapterSequence(outlineNodes, chapters)
  const orderOf = new Map<number, number>()
  sequence.forEach((entry, i) => { if (entry.chapter.id != null) orderOf.set(entry.chapter.id, i) })
  const currentOrder = orderOf.get(chapterId)
  if (currentOrder == null) return ''

  const validNow = facts.filter(fact => {
    if (fact.worldGroupId != null && fact.worldGroupId !== (worldGroupId ?? null)) return false // 世界隔离
    const from = fact.validFromChapterId != null ? orderOf.get(fact.validFromChapterId) : -1
    if (from == null || from > currentOrder) return false   // 引用不存在的章 / 尚未生效
    if (fact.validToChapterId != null) {
      const to = orderOf.get(fact.validToChapterId)
      if (to != null && to <= currentOrder) return false     // 已失效
    }
    return true
  })
  if (!validNow.length) return ''
  const lines = validNow.slice(0, 80).map(fact => {
    const spec = getFactPredicate(fact.predicate)
    return `- ${fact.subjectName}｜${spec?.label ?? fact.predicate}：${fact.value}`
  })
  return ['【当前有效事实（截止本章·已确认，请勿与之矛盾）】', ...lines].join('\n')
}

/**
 * NS-5 · 相关前文召回（叙事感知混合检索的回报通道）。
 * 按本章涉及的实体召回历史块（关键词通道，未来章硬过滤、世界隔离、按时间重组），
 * 解决"几百章前的远距离细节/伏笔"被遗忘导致的矛盾。
 */
async function readRetrievedPassages(projectId: number, chapterId?: number | null, outlineNodeId?: number | null, worldGroupId?: number | null, input?: AssembleContextInput): Promise<string> {
  if (chapterId == null) return ''
  // BUDGET-1: 两段叙事摘要的取法由作者预算策略决定；缺省时函数内部用原默认值。
  const narrativeLimits = {
    maxTotalChars: input?.sourceMaxTotalChars,
    maxVolumeChars: input?.sourceMaxVolumeChars,
    maxVolumeChapters: input?.sourceMaxVolumeChapters,
  }
  const [characters, node] = await Promise.all([
    db.characters.where('projectId').equals(projectId).toArray(),
    outlineNodeId != null ? db.outlineNodes.get(outlineNodeId) : Promise.resolve(undefined),
  ])
  const summary = node?.summary || ''
  // ALIAS-1: 召回词表按"全部称呼"展开。摘要里写的是别称（"禾姐走进巷口"）时，
  // 旧实现会一个角色都匹配不到 → 退化成"全部角色宽召回"；现在能准确定位到那个人。
  const characterIndex = buildCharacterSurfaceIndex(characters, worldGroupId)
  const mentionedCharacters = findCharactersInText(summary, characterIndex)
  const queryTerms = mentionedCharacters.length
    ? mentionedCharacters.flatMap(character => characterSurfaces(character)).filter(name => name.length >= 2)
    : characterIndex.characters.flatMap(character => characterSurfaces(character)).filter(name => name.length >= 2)
  if (!queryTerms.length) {
    return await readNarrativeSummaryContext({ projectId, currentChapterId: chapterId, worldGroupId, ...narrativeLimits })
  }

  // NS-5：若启用 embedding，按"章纲摘要 + 涉及角色"嵌一次查询向量 → 混合检索（失败自动退回关键词）
  const embCfg = useAIConfigStore.getState().embedding
  const queryEmbedding = isEmbeddingReady(embCfg)
    ? await embedQuery([summary, ...queryTerms].filter(Boolean).join(' ').slice(0, 1000), embCfg, projectId)
    : null

  const got = await retrieveChunks({
    projectId, currentChapterId: chapterId, worldGroupId, queryTerms, queryEmbedding,
    queryEmbeddingModel: queryEmbedding ? embeddingModelTag(embCfg) : null, topK: 6,
  })
  const hierarchy = await readNarrativeSummaryContext({ projectId, currentChapterId: chapterId, worldGroupId, ...narrativeLimits })
  if (!got.length) return hierarchy
  const chapters = await db.chapters.where('projectId').equals(projectId).toArray()
  const titleOf = new Map(chapters.filter(c => c.id != null).map(c => [c.id!, c.title]))
  const lines = got.map(r => `〖${titleOf.get(r.chunk.sourceChapterId) ?? '前文'}〗${r.chunk.text}`)
  return [hierarchy, '【相关前文召回（防止远距离细节/伏笔矛盾，仅供参考）】', ...lines].filter(Boolean).join('\n\n')
}

/**
 * C2 反向哺喂 · 某角色的「已确认事实」证据。
 *
 * ALIAS-1：角色可能是用**别称**被点名的（作者补全角色时填的是他习惯的称呼，事实账本里的
 * `subjectName` 也可能是正文里的写法）。因此按"该角色的任一称呼"命中，并优先按 `characterId`
 * 命中（有 FK 时最可靠）；**不重写既有 subjectName**，保留逐字可追溯性。
 */
async function readCharacterFacts(projectId: number, name?: string, worldGroupId?: number | null): Promise<string> {
  const subject = name?.trim()
  if (!subject) return ''
  const surfaces = await characterSurfacesByName(projectId, subject, worldGroupId)
  const characterIds = await characterIdsByName(projectId, subject, worldGroupId)
  const facts = await db.temporalFacts.where('projectId').equals(projectId)
    .filter(f => f.status === 'confirmed' && (
      surfaces.includes(f.subjectName ?? '')
      || (f.characterId != null && characterIds.includes(f.characterId))
    )).toArray()
  const scoped = facts.filter(f => f.worldGroupId == null || f.worldGroupId === (worldGroupId ?? null))
  if (!scoped.length) return ''
  const lines = scoped.slice(0, 60).map(fact => {
    const spec = getFactPredicate(fact.predicate)
    return `- ${spec?.label ?? fact.predicate}：${fact.value}`
  })
  const matchedName = await canonicalNameFor(projectId, subject, worldGroupId)
  return [`【「${matchedName}」在剧情中已确认的事实（补全须与之一致，勿矛盾）】`, ...lines].join('\n')
}

/**
 * C2 反向哺喂 · 某角色的「正文表现」证据。
 * 关键词扫描全书 retrievalChunks（提到该角色的**任一称呼**的块，当前世界 ∪ null），
 * 按章序取靠后的若干段。不依赖 currentChapterId（要全书证据，不做未来章过滤）。
 */
async function readCharacterPassages(projectId: number, name?: string, worldGroupId?: number | null): Promise<string> {
  const subject = name?.trim()
  if (!subject || subject.length < 2) return ''
  const surfaces = await characterSurfacesByName(projectId, subject, worldGroupId)
  const [chunks, chapters] = await Promise.all([
    db.retrievalChunks.where('projectId').equals(projectId).toArray(),
    db.chapters.where('projectId').equals(projectId).toArray(),
  ])
  const hits = chunks
    .filter(c => (c.worldGroupId == null || c.worldGroupId === (worldGroupId ?? null))
      && surfaces.some(surface => surface.length >= 2 && c.text.includes(surface)))
    .sort((a, b) => (b.sourceChapterId ?? 0) - (a.sourceChapterId ?? 0))
    .slice(0, 6)
  if (!hits.length) return ''
  const titleOf = new Map(chapters.filter(c => c.id != null).map(c => [c.id!, c.title]))
  const lines = hits.map(c => `〖${titleOf.get(c.sourceChapterId) ?? '正文'}〗${c.text}`)
  const matchedName = await canonicalNameFor(projectId, subject, worldGroupId)
  return [`【「${matchedName}」在正文中的真实表现（补全须符合，勿编造与正文矛盾的设定）】`, ...lines].join('\n\n')
}

/**
 * ALIAS-1：把作者/调用方给的一个角色称呼，展开成"该角色的全部称呼"。
 * 命中不了任何角色时退回原字符串（保持既有"按名字找"的行为不变）。
 */
async function characterSurfacesByName(
  projectId: number,
  name: string,
  worldGroupId?: number | null,
): Promise<string[]> {
  const characters = await readCharacters(projectId, worldGroupId)
  const index = buildCharacterSurfaceIndex(characters, worldGroupId)
  const character = resolveCharacterBySurface(index, name)
    ?? index.byCanonicalName.get(name.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase())
    ?? null
  return character ? characterSurfaces(character) : [name]
}

/** ALIAS-1：称呼对应的角色 id（用于按 FK 命中事实）。 */
async function characterIdsByName(
  projectId: number,
  name: string,
  worldGroupId?: number | null,
): Promise<number[]> {
  const characters = await readCharacters(projectId, worldGroupId)
  const index = buildCharacterSurfaceIndex(characters, worldGroupId)
  const character = resolveCharacterBySurface(index, name)
  return character?.id != null ? [character.id] : []
}

/** ALIAS-1：展示用的规范正名；解析不到就用调用方给的写法。 */
async function canonicalNameFor(
  projectId: number,
  name: string,
  worldGroupId?: number | null,
): Promise<string> {
  const characters = await readCharacters(projectId, worldGroupId)
  const index = buildCharacterSurfaceIndex(characters, worldGroupId)
  return resolveCharacterBySurface(index, name)?.name ?? name
}

export const CONTEXT_SOURCES: ContextSource[] = [
  {
    key: 'agentConversation',
    label: '主 Agent 会话记忆',
    scope: 'project',
    layer: 'L1',
    budgetTokens: 2800,
    enabled: input => input.agentConversationId != null,
    read: input => readMasterConversationContext({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId ?? null,
      conversationId: input.agentConversationId!,
      beforeSequence: input.agentHistoryBeforeSequence,
      query: input.searchQuery ?? '',
    }),
  },
  {
    // AGENT-1: 对话副驾只读工具使用的紧凑项目摘要，不返回整表原始数据。
    key: 'projectStatus',
    label: '项目概况',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 1200,
    read: readAgentProjectStatus,
  },
  {
    key: 'proseSamples',
    label: '文章正文分布抽样',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 9000,
    requiresWorldGroupId: true,
    read: readAgentProseSamples,
  },
  {
    key: 'projectTableCatalog',
    label: '项目注册表目录',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 4000,
    read: async () => projectTableCatalog(),
  },
  {
    key: 'projectTableRecords',
    label: '项目表分页记录',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 8500,
    enabled: input => !!input.projectTableName,
    read: input => readProjectTablePage({
      projectId: input.projectId,
      tableName: input.projectTableName!,
      offset: input.projectTableOffset,
      pageSize: input.projectTablePageSize,
      query: input.projectTableQuery,
    }),
  },
  {
    key: 'projectRecordField',
    label: '项目记录字段片段',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 7500,
    enabled: input => !!input.projectTableName && input.projectTableRecordId != null
      && !!input.projectTableFieldName,
    read: input => readProjectRecordField({
      projectId: input.projectId,
      tableName: input.projectTableName!,
      recordId: input.projectTableRecordId!,
      fieldName: input.projectTableFieldName!,
      charOffset: input.projectTableCharOffset,
      charLimit: input.projectTableCharLimit,
    }),
  },
  {
    key: 'projectTableSearch',
    label: '跨登记表完整文本搜索',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 4500,
    enabled: input => !!input.searchQuery?.trim(),
    read: input => searchProjectRecordText({
      projectId: input.projectId,
      query: input.searchQuery!,
      cursor: input.projectSearchCursor,
      limit: input.searchLimit,
      tableName: input.projectSearchTableName,
    }),
  },
  {
    key: 'chapterDeletionImpact',
    label: '章节删除影响预览',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 1200,
    enabled: input => input.projectTableRecordId != null,
    read: async input => (await prepareChapterDeletionCandidate({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId ?? null,
      recordId: input.projectTableRecordId!,
      contextSources: ['chapterDeletionImpact'],
    })).draft,
  },
  {
    // AGENT-1: 世界组与连接关系的有界目录。
    key: 'worldGroups',
    label: '世界组目录',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 1500,
    read: readAgentWorldGroups,
  },
  {
    // AGENT-1: 按当前执行世界过滤的有界大纲树。
    key: 'outlineTree',
    label: '大纲树',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 6000,
    requiresWorldGroupId: true,
    read: readAgentOutlineTree,
  },
  {
    key: 'volumeAuditOutline',
    label: '指定卷剧情证据',
    scope: 'node',
    layer: 'L1',
    budgetTokens: 10_000,
    requiresOutlineNodeId: true,
    requiresWorldGroupId: true,
    read: readVolumeAuditOutline,
  },
  {
    // AGENT-1: 零网络、零 embedding 的本地包含匹配，仅返回短摘。
    key: 'searchResults',
    label: '项目内搜索结果',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 2200,
    requiresWorldGroupId: true,
    enabled: input => !!input.searchQuery?.trim(),
    read: readAgentSearchResults,
  },
  {
    // AGENT-2 检索修复：把作者口中的“序篇/第一卷/第3章”落到真实大纲节点。
    // 旧 search_text 是纯子串匹配，「序篇」永远命不中「序卷-阳光与阴云」，模型于是误报“项目里没有”。
    key: 'outlineReferenceLookup',
    label: '大纲引用解析',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 3000,
    requiresWorldGroupId: true,
    enabled: input => !!input.searchQuery?.trim(),
    read: input => lookupOutlineReference({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId ?? null,
      reference: input.searchQuery ?? '',
    }),
  },
  {
    // AGENT-2 检索修复：出场次数必须由确定性计数给出，不能靠模型读几页正文心算。
    key: 'characterMentionCounts',
    label: '角色出场统计',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 4500,
    requiresWorldGroupId: true,
    enabled: input => !!input.searchQuery?.trim(),
    read: input => countCharacterAppearances({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId ?? null,
      characterName: input.searchQuery ?? '',
      scopeNodeId: input.outlineNodeId ?? null,
    }),
  },
  {
    // RAG-1: 作者在可见资料库/节点中精确选择的记录字段。正文仍实时读取 Canon，
    // 稳定选择键和实际纳入证据分别由源记录元数据与节点运行快照保存。
    key: 'ragSelection',
    label: '作者选择的资料字段',
    scope: 'manual',
    layer: 'L0',
    budgetTokens: 100_000,
    enabled: input => !!input.ragEntryKeys?.length,
    read: input => readRagSelectionContext({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      entryKeys: input.ragEntryKeys,
      inputBudgetTokens: input.inputBudgetTokens,
      trace: input.ragSelectionTrace,
    }),
  },
  {
    key: 'manualText',
    label: '用户指定内容',
    scope: 'manual',
    layer: 'L0',
    budgetTokens: 100_000,
    read: async input => input.manualSourceText || '',
  },
  {
    key: 'chapterContent',
    label: '章节正文',
    scope: 'chapter',
    layer: 'L0',
    budgetTokens: 100_000,
    requiresChapterId: true,
    read: async input => {
      const chapter = await db.chapters.get(input.chapterId!)
      if (!chapter || chapter.projectId !== input.projectId) return ''
      return htmlToPlainText(chapter.content || '')
    },
  },
  {
    key: 'contextMemo',
    label: '上下文快照',
    scope: 'project',
    layer: 'L3',
    budgetTokens: 1500,
    read: async input => getContextMemo(input.projectId),
  },
  {
    key: 'chapterOutline',
    label: '当前章节大纲',
    scope: 'node',
    layer: 'L1',
    budgetTokens: 800,
    protectedFromTrim: true,
    requiresOutlineNodeId: true,
    read: input => readChapterOutline(input.projectId, input.outlineNodeId, input.chapterId),
  },
  {
    key: 'existingVolumeOutlines',
    label: '已有卷大纲',
    scope: 'project',
    layer: 'L1',
    budgetTokens: 2400,
    read: input => readExistingVolumeOutlines(input.projectId),
  },
  {
    key: 'writtenChapterProgress',
    label: '本卷已写正文进度',
    scope: 'node',
    layer: 'L1',
    budgetTokens: 3000,
    protectedFromTrim: true,
    requiresOutlineNodeId: true,
    read: input => readWrittenChapterProgress(input.projectId, input.outlineNodeId, input.worldGroupId),
  },
  {
    key: 'currentFacts',
    label: '当前有效事实(事实账本投影)',
    scope: 'chapter',
    layer: 'L1',
    budgetTokens: 2000,
    requiresChapterId: true,
    read: input => readCurrentFacts(input.projectId, input.chapterId, input.worldGroupId),
  },
  {
    key: 'canonAssertions',
    label: '世界宪法(已确认设定断言)',
    scope: 'world',
    layer: 'L1',
    budgetTokens: 1800,
    protectedFromTrim: true,
    requiresWorldGroupId: true,
    read: async input => formatCanonAssertionsContext(
      await readCanonAssertions(input.projectId, input.worldGroupId),
    ),
  },
  {
    key: 'characterKnowledge',
    label: '角色认知边界(认知账本投影)',
    scope: 'chapter',
    layer: 'L1',
    budgetTokens: 1600,
    protectedFromTrim: true,
    requiresChapterId: true,
    acceptsOutlineNodeAsChapterBoundary: true,
    read: async input => formatCharacterKnowledgeContext(await readProjectCharacterKnowledge(
      input.projectId,
      input.chapterId,
      input.worldGroupId,
      input.characterId,
      input.outlineNodeId,
    )),
  },
  {
    key: 'retrievedPassages',
    label: '相关前文召回(NS-5 混合检索)',
    scope: 'chapter',
    layer: 'L2',
    budgetTokens: 2500,
    // BUDGET-1: 「全书/本卷截至本章」两段的字数上限由作者决定,不再写死 1800/1200。
    acceptsCharLimits: true,
    requiresChapterId: true,
    read: input => readRetrievedPassages(input.projectId, input.chapterId, input.outlineNodeId, input.worldGroupId, input),
  },
  {
    key: 'detailedOutline',
    label: '本章细纲(场景拆解)',
    scope: 'node',
    layer: 'L1',
    budgetTokens: 1500,
    requiresOutlineNodeId: true,
    read: input => readDetailedOutline(input.projectId, input.outlineNodeId, input.chapterId),
  },
  {
    key: 'previousChapterEnding',
    label: '全局直接前驱原文尾部',
    scope: 'manual',
    layer: 'L1',
    budgetTokens: 1800,
    protectedFromTrim: true,
    enabled: input => !!(input.continuitySnapshot?.previousTailText || input.previousChapterEnding),
    read: async input => input.continuitySnapshot?.previousTailText
      || (input.previousChapterEnding ? `【上一章结尾】\n${input.previousChapterEnding}` : ''),
  },
  {
    key: 'chapterContinuityHandoff',
    label: '全局直接前驱连续性交接',
    scope: 'chapter',
    layer: 'L1',
    budgetTokens: 1600,
    protectedFromTrim: true,
    requiresChapterId: true,
    read: async input => input.continuitySnapshot?.handoffText || '',
  },
  {
    key: 'previousPlanReconciliation',
    label: '前章计划正文对账',
    scope: 'chapter',
    layer: 'L1',
    budgetTokens: 1400,
    protectedFromTrim: true,
    requiresChapterId: true,
    read: async input => input.continuitySnapshot?.planReconciliationText || '',
  },
  {
    key: 'recentChapterSummaries',
    label: '当前世界最近已验证摘要',
    scope: 'chapter',
    layer: 'L1',
    budgetTokens: 2200,
    requiresChapterId: true,
    read: async input => input.continuitySnapshot?.recentSummariesText || '',
  },
  {
    key: 'worldview',
    label: '世界观',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 8000, // 放宽:容下完整世界观设定,超大才软截断(并配合总窗口软裁)
    requiresWorldGroupId: true,
    read: async input => formatWorldviewBlock(await readWorldview(input.projectId, input.worldGroupId)),
  },
  {
    key: 'storyCore',
    label: '故事核心',
    scope: 'project',
    layer: 'L1',
    budgetTokens: 4000, // 放宽:容下完整故事核心(主线/复线)
    read: async input => formatStoryCoreBlock(await db.storyCores.where('projectId').equals(input.projectId).first() ?? null),
  },
  {
    key: 'characterDrivenPlan',
    label: '当前生效角色驱动方案',
    scope: 'project',
    layer: 'L1',
    budgetTokens: 5000,
    protectedFromTrim: true,
    read: input => readActiveCharacterDrivenPlanContext(input.projectId),
  },
  {
    key: 'powerSystem',
    label: '力量体系',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 4000, // 放宽:容下完整力量体系(描述/等级/规则)
    requiresWorldGroupId: true,
    read: async input => {
      const [foundation, cultivation] = await Promise.all([
        readPowerSystem(input.projectId, input.worldGroupId)
          .then(formatPowerSystemBlock),
        buildCultivationContext(input.projectId, input.worldGroupId),
      ])
      return [foundation, cultivation].filter(Boolean).join('\n')
    },
  },
  {
    key: 'codex',
    label: '设定词条',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 6000, // 放宽:容下更多设定词条
    // BUDGET-1: 词条数由作者在「设置 → 上下文预算」决定,不再有内部 2500 字硬截断。
    acceptsCharLimits: true,
    requiresWorldGroupId: true,
    read: input => buildCodexContext(input.projectId, input.worldGroupId, {
      maxChars: input.sourceMaxChars,
      maxPerCategory: input.sourceMaxPerCategory,
      maxFieldsPerEntry: input.sourceMaxFieldsPerEntry,
    }),
  },
  {
    key: 'characters',
    label: '角色档案',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 8000, // 放宽:容下完整角色档案(核心角色不再被砍残)
    requiresWorldGroupId: true,
    read: async input => buildCharacterContext(await readCharacters(input.projectId, input.worldGroupId)),
  },
  {
    // ALIAS-1:正文生成用这个源(全量档案仍由 characters 源服务世界/大纲类任务)。
    key: 'characterFocus',
    label: '本章相关角色（按别称与提及自动选入）',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 8000,
    requiresWorldGroupId: true,
    read: readCharacterFocus,
  },
  {
    // PROMPT-PLAN-1:生成前协商的实体名册。只出名,让模型能点名申报"我需要谁的正文表现",
    // 而不用把全量档案塞进协商调用。ALIAS-1 落地后 namesOf 会带上别称。
    key: 'entityRoster',
    label: '实体名册（角色/词条/地点）',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 1200,
    requiresWorldGroupId: true,
    read: async input => buildEntityRoster({
      characters: await db.characters.where('projectId').equals(input.projectId).toArray(),
      codexCategories: await db.codexCategories.where('projectId').equals(input.projectId).toArray(),
      codexEntries: await db.codexEntries.where('projectId').equals(input.projectId).toArray(),
      locations: await db.importantLocations.where('projectId').equals(input.projectId).toArray(),
      mapFeatures: await db.mapFeatures.where('projectId').equals(input.projectId).toArray(),
      multiWorld: Boolean((await db.projects.get(input.projectId))?.enableMultiWorld),
      worldGroupId: input.worldGroupId ?? null,
    }),
  },
  {
    key: 'creativeRules',
    label: '创作规则',
    scope: 'project',
    layer: 'L1',
    budgetTokens: 1000,
    read: async input => buildCreativeRulesContext(await db.creativeRules.where('projectId').equals(input.projectId).first() ?? null),
  },
  {
    key: 'worldRules',
    label: '真实与幻想规则',
    scope: 'world',
    layer: 'L1',
    budgetTokens: 1200,
    requiresWorldGroupId: true,
    read: input => buildWorldRulesContext(input.projectId, input.worldGroupId),
  },
  {
    key: 'historical',
    label: '历史时间线',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 1800,
    requiresWorldGroupId: true,
    read: input => buildHistoricalContext(input.projectId, input.worldGroupId),
  },
  {
    key: 'geography',
    label: '当前世界地理总述与地理树',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 2500,
    requiresWorldGroupId: true,
    read: input => readGeographyContext(input.projectId, input.worldGroupId ?? null),
  },
  {
    key: 'locations',
    label: '重要地点',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 1200,
    requiresWorldGroupId: true,
    read: input => buildLocationContext(input.projectId, input.worldGroupId ?? null),
  },
  {
    key: 'mapFacts',
    label: '作者确认的地图事实',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 1800,
    requiresWorldGroupId: true,
    read: input => readMapFactsContext(input.projectId, input.worldGroupId ?? null),
  },
  {
    key: 'mapRelevantFacts',
    label: '本次创作相关的已确认地图事实',
    scope: 'world',
    layer: 'L2',
    budgetTokens: 1200,
    requiresWorldGroupId: true,
    read: readMapRelevantFactsContext,
  },
  {
    key: 'foreshadows',
    label: '伏笔状态',
    scope: 'chapter',
    layer: 'L2',
    budgetTokens: 1200,
    read: input => readForeshadows(input.projectId, input.chapterId),
  },
  {
    key: 'storyArcs',
    label: '故事线',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 1500,
    read: input => readStoryArcs(input.projectId),
  },
  {
    key: 'storylineProgress',
    label: '作者确认的故事线进度与交汇',
    scope: 'project',
    layer: 'L1',
    budgetTokens: 1400,
    protectedFromTrim: true,
    read: input => readStorylineProgressContext(input.projectId, input.chapterId),
  },
  {
    key: 'cultivationProgress',
    label: '作者确认的正文修炼进度',
    scope: 'world',
    layer: 'L1',
    budgetTokens: 1000,
    protectedFromTrim: true,
    requiresWorldGroupId: true,
    read: input => readCultivationProgressContext(
      input.projectId,
      input.worldGroupId,
      input.chapterId,
      input.outlineNodeId,
    ),
  },
  {
    key: 'emotionBeats',
    label: '情感节拍',
    scope: 'chapter',
    layer: 'L1',
    budgetTokens: 1000,
    requiresChapterId: true,
    read: input => readEmotionBeats(input.projectId, input.chapterId),
  },
  {
    key: 'stateCards',
    label: '状态卡',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 1800,
    read: input => readStateCards(input.projectId, input.stateReferenceText, input.extraStateIds, input.worldGroupId ?? null),
  },
  {
    key: 'itemLedger',
    label: '物品流水',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 2400,
    read: input => readItemLedger(input.projectId, input.characterId),
  },
  {
    key: 'heldItems',
    label: '当前已持有物品',
    scope: 'chapter',
    layer: 'L1',
    budgetTokens: 1000,
    protectedFromTrim: true,
    requiresChapterId: true,
    acceptsOutlineNodeAsChapterBoundary: true,
    read: input => readHeldItems(
      input.projectId,
      input.chapterId,
      input.worldGroupId,
      input.characterId,
      input.outlineNodeId,
    ),
  },
  {
    key: 'storyTimeline',
    label: '故事年表',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 2600,
    read: input => readStoryTimeline(input.projectId, input.chapterId, input.worldGroupId),
  },
  {
    key: 'characterRelations',
    label: '角色关系',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 2200,
    read: input => readCharacterRelations(input.projectId, input.worldGroupId),
  },
  {
    key: 'references',
    label: '引用手法',
    scope: 'project',
    layer: 'L3',
    budgetTokens: 2000,
    enabled: input => !!input.citedReferenceIds?.length,
    read: input => buildRefAnalysisContext(input.citedReferenceIds ?? []),
  },
  {
    // FB-5 自适应文风学习:作者文风画像(enabled=true 才注入)。
    key: 'userStyleProfile',
    label: '我的文风',
    scope: 'project',
    layer: 'L2',
    budgetTokens: 1800,
    read: input => readUserStyleProfile(input.projectId),
  },
  {
    // CM-1:只读取作者本次明确勾选的短灵感和同模式最近确认版本。
    key: 'inspirationWorkspace',
    label: '增量灵感工作区',
    scope: 'project',
    layer: 'L0',
    budgetTokens: 11_000,
    enabled: input => !!input.inspirationFragmentIds?.length,
    read: input => readInspirationWorkspaceContext(
      input.projectId,
      input.inspirationFragmentIds,
      input.inspirationMode,
    ),
  },
  {
    // C2 反向哺喂：某角色在剧情里已确认的事实（需 subjectCharacterName）。
    key: 'characterFacts',
    label: '该角色的剧情事实',
    scope: 'project',
    layer: 'L1',
    budgetTokens: 1500,
    enabled: input => !!input.subjectCharacterName?.trim(),
    read: input => readCharacterFacts(input.projectId, input.subjectCharacterName, input.worldGroupId),
  },
  {
    // C2 反向哺喂：某角色在正文里的真实表现（需 subjectCharacterName）。
    key: 'characterPassages',
    label: '该角色的正文表现',
    scope: 'project',
    layer: 'L1',
    budgetTokens: 2500,
    enabled: input => !!input.subjectCharacterName?.trim(),
    read: input => readCharacterPassages(input.projectId, input.subjectCharacterName, input.worldGroupId),
  },
]

export const CONTEXT_SOURCE_BY_KEY: ReadonlyMap<string, ContextSource> = new Map(
  CONTEXT_SOURCES.map(source => [source.key, source] as const),
)
