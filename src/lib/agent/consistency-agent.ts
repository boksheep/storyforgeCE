import { db } from '../db/schema'
import { assembleContext } from '../registry/assemble-context'
import { normalizeChapterText, hashChapterText } from '../ai/chapter-memory/text-normalization'
import {
  buildConsistencyAuditPrompt,
  parseConsistencyAuditResult,
  type ConsistencyAuditResult,
  type ConsistencyFinding,
} from '../ai/adapters/consistency-audit-adapter'
import {
  checkHeldItemAcquisition,
  readProjectHeldItems,
} from '../consistency/held-items'
import {
  checkCognitionBoundary,
  formatCognitionCatalog,
  parseCognitionReferences,
  readCognitionAuditSnapshot,
} from '../knowledge-ledger/knowledge-ledger'
import {
  checkCharacterLifecycleBoundary,
  formatLifecycleCatalog,
  parseLifecycleActivityReferences,
  readLifecycleAuditSnapshot,
} from '../consistency/lifecycle-boundary'
// CONSISTENCY-5（ALIAS-1 附带）：零 token 生成后守卫
import { checkForeignWorldEntities, collectForeignWorldSurfaces, type WorldScopedEntity } from '../consistency/world-iso'
import { checkDeclaredCastCoverage, type DeclaredCastEntry } from '../consistency/cast-coverage'
import { characterSurfaces } from '../character/character-identity'
import { entitySurfaceNames } from '../entities/surface-match'
import type { Character } from '../types'
import type {
  AgentConversation,
  AgentEvent,
  ChatMessage,
} from '../types'
import { parseAgentEventPayload } from '../types'
import {
  AgentTeamBudgetTracker,
  type AgentTeamBudgetEvidence,
} from './team-budget'

export const CONSISTENCY_AGENT_VERSION = 1
export const CONSISTENCY_AGENT_PAYLOAD_TYPE = 'consistency-agent'

export type ConsistencyAgentMode = 'background' | 'fast' | 'deep'

export interface ConsistencyAgentContextEvidence {
  included: string[]
  omitted: string[]
  trimmed: string[]
  inputTokens: number
  inputBudget: number
}

export interface ConsistencyAgentCandidate {
  version: typeof CONSISTENCY_AGENT_VERSION
  type: typeof CONSISTENCY_AGENT_PAYLOAD_TYPE
  projectId: number
  chapterId: number
  chapterTitle: string
  worldGroupId: number | null
  mode: ConsistencyAgentMode
  sourceTextHash: string
  createdAt: number
  findings: ConsistencyFinding[]
  context: ConsistencyAgentContextEvidence
  budget: AgentTeamBudgetEvidence
}

export interface ConsistencyAgentRun {
  conversation: AgentConversation
  event: AgentEvent
  candidate: ConsistencyAgentCandidate
}

const FAST_SOURCES = [
  'chapterContinuityHandoff',
  'previousPlanReconciliation',
  'currentFacts',
  'canonAssertions',
  'characterKnowledge',
  'creativeRules',
  'worldRules',
  'stateCards',
  'heldItems',
] as const

const DEEP_SOURCES = [
  ...FAST_SOURCES,
  'recentChapterSummaries',
  'retrievedPassages',
  'itemLedger',
  'storyTimeline',
  'characterRelations',
  'foreshadows',
  'storyArcs',
  'storylineProgress',
] as const

function emptyContext(): ConsistencyAgentContextEvidence {
  return {
    included: [],
    omitted: [],
    trimmed: [],
    inputTokens: 0,
    inputBudget: 0,
  }
}

function dedupeFindings(findings: readonly ConsistencyFinding[]): ConsistencyFinding[] {
  const seen = new Set<string>()
  return findings.filter(finding => {
    const key = [
      finding.category.trim(),
      finding.severity,
      finding.quote.trim(),
      finding.reason.trim(),
    ].join('\u0000')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * 后台（零 token）守卫的确定性检查集合。
 *
 * CONSISTENCY-5（ALIAS-1 附带）新增两项，都是**只读 + 无模型调用**：
 * - 跨世界实体泄漏：正文里出现只属于其它世界的专有名词（此前只有检索期隔离）；
 * - 细纲出场对账：细纲声明出场的角色在正文里一个称呼都没出现（此前该字段只写不读）。
 * 按"谁的名字可能被写成什么"判断，因此都依赖 ALIAS-1 的称呼索引（别称同样算命中）。
 */
async function buildDeterministicFindings(input: {
  projectId: number
  chapterId: number
  worldGroupId: number | null
  chapterText: string
}): Promise<ConsistencyFinding[]> {
  const [heldItems, characters, codexEntries, project, outlineNodeId, locations, mapFeatures] = await Promise.all([
    readProjectHeldItems(input.projectId, input.chapterId, input.worldGroupId),
    db.characters.where('projectId').equals(input.projectId).toArray(),
    db.codexEntries.where('projectId').equals(input.projectId).toArray(),
    db.projects.get(input.projectId),
    resolveChapterOutlineNodeId(input.chapterId),
    db.importantLocations.where('projectId').equals(input.projectId).toArray(),
    db.mapFeatures.where('projectId').equals(input.projectId).toArray(),
  ])

  const findings = checkHeldItemAcquisition(
    input.chapterText,
    heldItems,
    [],
    characters.map(character => character.name),
  )

  // ── 跨世界实体泄漏（仅多世界且确有其它世界时才有意义） ──
  const worldGroups = project?.enableMultiWorld
    ? await db.worldGroups.where('projectId').equals(input.projectId).count()
    : 0
  if (project?.enableMultiWorld && worldGroups > 1) {
    const entities: WorldScopedEntity[] = [
      ...characters.map(character => ({
        kind: 'character' as const,
        id: character.id,
        name: character.name,
        surfaces: characterSurfaces(character),
        worldGroupId: character.homeWorldGroupId ?? null,
        crossWorld: character.isCrossWorld,
      })),
      ...codexEntries.map(entry => ({
        kind: 'codex' as const,
        id: entry.id,
        name: entry.name,
        surfaces: entitySurfaceNames(entry),
        worldGroupId: entry.worldGroupId ?? null,
      })),
      ...locations.filter(location => location.scope !== 'unassigned').map(location => ({
        kind: 'location' as const,
        id: location.id,
        name: location.name,
        surfaces: entitySurfaceNames(location),
        worldGroupId: location.worldGroupId ?? null,
        crossWorld: location.scope === 'shared',
      })),
      ...mapFeatures.filter(feature => feature.status === 'confirmed').map(feature => ({
        kind: 'map' as const,
        id: feature.id,
        name: feature.name,
        surfaces: entitySurfaceNames(feature),
        worldGroupId: feature.worldGroupId ?? null,
      })),
    ]
    findings.push(
      ...checkForeignWorldEntities(
        input.chapterText,
        collectForeignWorldSurfaces(entities, input.worldGroupId),
      ),
    )
  }

  // ── 细纲声明角色缺席对账 ──
  if (outlineNodeId != null) {
    const details = await db.detailedOutlines.where('outlineNodeId').equals(outlineNodeId).toArray()
    const declaredIds = new Set(details.flatMap(detail => detail.appearingCharacterIds ?? []))
    const byId = new Map(characters.flatMap(character => (
      character.id != null ? [[character.id, character] as const] : []
    )))
    const declared: DeclaredCastEntry[] = [...declaredIds]
      .map(id => byId.get(id))
      .filter((character): character is Character => !!character)
      .map(character => ({
        id: character.id,
        name: character.name,
        surfaces: characterSurfaces(character),
      }))
    findings.push(...checkDeclaredCastCoverage(input.chapterText, declared))
  }

  return findings
}

/** 章节 → 大纲节点（细纲对账用；找不到返回 null，不猜）。 */
async function resolveChapterOutlineNodeId(chapterId: number): Promise<number | null> {
  const chapter = await db.chapters.get(chapterId)
  return chapter?.outlineNodeId ?? null
}

function candidateBase(input: {
  projectId: number
  chapterId: number
  chapterTitle: string
  worldGroupId: number | null
  mode: ConsistencyAgentMode
  sourceTextHash: string
  findings: ConsistencyFinding[]
  context: ConsistencyAgentContextEvidence
  budget: AgentTeamBudgetEvidence
}): ConsistencyAgentCandidate {
  return {
    version: CONSISTENCY_AGENT_VERSION,
    type: CONSISTENCY_AGENT_PAYLOAD_TYPE,
    projectId: input.projectId,
    chapterId: input.chapterId,
    chapterTitle: input.chapterTitle,
    worldGroupId: input.worldGroupId,
    mode: input.mode,
    sourceTextHash: input.sourceTextHash,
    createdAt: Date.now(),
    findings: dedupeFindings(input.findings),
    context: input.context,
    budget: input.budget,
  }
}

/** 保存正文后的零 token Fast Guard。不会装配模型上下文，也不会调用提供商。 */
export async function runBackgroundConsistencyAgent(input: {
  projectId: number
  chapterId: number
  chapterTitle: string
  worldGroupId: number | null
  chapterContent: string
  budget: AgentTeamBudgetTracker
}): Promise<ConsistencyAgentCandidate> {
  const chapterText = normalizeChapterText(input.chapterContent)
  const sourceTextHash = await hashChapterText(chapterText)
  const findings = await buildDeterministicFindings({
    projectId: input.projectId,
    chapterId: input.chapterId,
    worldGroupId: input.worldGroupId,
    chapterText,
  })
  return candidateBase({
    ...input,
    mode: 'background',
    sourceTextHash,
    findings,
    context: emptyContext(),
    budget: input.budget.snapshot(),
  })
}

/**
 * 作者明确触发的单调用审计。模型只提取封闭引用；认知、存亡和物品判决继续由代码完成。
 */
export async function runConsistencyAgent(input: {
  projectId: number
  chapterId: number
  chapterTitle: string
  worldGroupId: number | null
  outlineNodeId?: number | null
  chapterContent: string
  mode: Exclude<ConsistencyAgentMode, 'background'>
  provider?: Parameters<typeof assembleContext>[0]['provider']
  model?: string
  budget: AgentTeamBudgetTracker
  call: (messages: ChatMessage[]) => Promise<string>
}): Promise<ConsistencyAgentCandidate> {
  const chapterText = normalizeChapterText(input.chapterContent)
  const sourceTextHash = await hashChapterText(chapterText)
  const [evidence, cognition, lifecycle, deterministicFindings] = await Promise.all([
    assembleContext({
      projectId: input.projectId,
      chapterId: input.chapterId,
      outlineNodeId: input.outlineNodeId,
      worldGroupId: input.worldGroupId,
      sourceKeys: [...(input.mode === 'fast' ? FAST_SOURCES : DEEP_SOURCES)],
      provider: input.provider,
      model: input.model,
      inputBudgetMaxTokens: input.mode === 'fast' ? 16_000 : 32_000,
      sourceBudgetScale: input.mode === 'fast' ? 0.55 : 1,
    }),
    readCognitionAuditSnapshot(input.projectId, input.chapterId, input.worldGroupId),
    readLifecycleAuditSnapshot(input.projectId, input.chapterId, input.worldGroupId),
    buildDeterministicFindings({
      projectId: input.projectId,
      chapterId: input.chapterId,
      worldGroupId: input.worldGroupId,
      chapterText,
    }),
  ])
  const messages = buildConsistencyAuditPrompt({
    mode: input.mode,
    chapterTitle: input.chapterTitle,
    chapterContent: chapterText,
    evidenceContext: evidence.text,
    cognitionCatalog: formatCognitionCatalog(cognition.catalog),
    lifecycleCatalog: formatLifecycleCatalog(lifecycle.catalog),
  })
  const reservation = input.budget.reserveCall({
    label: input.mode === 'fast' ? '一致性 Fast Guard' : '一致性 Deep Audit',
    messages,
    maxOutputTokens: input.mode === 'fast' ? 4_000 : 6_000,
  })
  let raw: string
  try {
    raw = await input.call(messages)
    input.budget.settleCall(reservation, raw)
  } catch (error) {
    input.budget.settleFailedCall(reservation)
    throw error
  }
  const parsed = parseConsistencyAuditResult({
    raw,
    mode: input.mode,
    chapterContent: chapterText,
    evidenceContext: evidence.text,
  })
  if (!parsed) {
    throw new Error('一致性 Agent 返回的 JSON 无法解析；没有保存不完整报告。')
  }
  const cognitionFindings = checkCognitionBoundary(
    chapterText,
    parseCognitionReferences(raw, chapterText, cognition.catalog),
    cognition.projected,
  )
  const lifecycleFindings = checkCharacterLifecycleBoundary(
    chapterText,
    parseLifecycleActivityReferences(raw, chapterText, lifecycle.catalog),
    lifecycle.projected,
  )
  return candidateBase({
    ...input,
    sourceTextHash,
    findings: [
      ...deterministicFindings,
      ...cognitionFindings,
      ...lifecycleFindings,
      ...parsed.findings,
    ],
    context: {
      included: evidence.included,
      omitted: evidence.omitted,
      trimmed: evidence.trimmed,
      inputTokens: evidence.totalInputTokens,
      inputBudget: evidence.inputBudget,
    },
    budget: input.budget.snapshot(),
  })
}

function isConsistencyAgentCandidate(value: unknown): value is ConsistencyAgentCandidate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Partial<ConsistencyAgentCandidate>
  return candidate.version === CONSISTENCY_AGENT_VERSION
    && candidate.type === CONSISTENCY_AGENT_PAYLOAD_TYPE
    && typeof candidate.projectId === 'number'
    && typeof candidate.chapterId === 'number'
    && typeof candidate.sourceTextHash === 'string'
    && ['background', 'fast', 'deep'].includes(String(candidate.mode))
    && Array.isArray(candidate.findings)
}

export function summarizeConsistencyAgentCandidate(candidate: ConsistencyAgentCandidate): string {
  const hard = candidate.findings.filter(finding => finding.severity === 'hard').length
  const risk = candidate.findings.filter(finding => finding.severity === 'risk').length
  return `${candidate.mode} · 硬冲突 ${hard} · 风险 ${risk} · 共 ${candidate.findings.length}`
}

/**
 * 同一章、同一正文 hash、同一模式只保留一个可恢复事件；显式重跑会更新原事件而非制造重复。
 */
export async function persistConsistencyAgentCandidate(
  candidate: ConsistencyAgentCandidate,
): Promise<ConsistencyAgentRun> {
  const events = await db.agentEvents.where('projectId').equals(candidate.projectId).toArray()
  const existing = events
    .filter(event => event.kind === 'candidate')
    .map(event => ({ event, candidate: parseAgentEventPayload<unknown>(event, null) }))
    .find(row => (
      isConsistencyAgentCandidate(row.candidate)
      && row.candidate.chapterId === candidate.chapterId
      && row.candidate.mode === candidate.mode
      && row.candidate.sourceTextHash === candidate.sourceTextHash
    ))
  const now = Date.now()
  if (existing?.event.id != null) {
    const conversation = await db.agentConversations.get(existing.event.conversationId)
    if (conversation) {
      await db.transaction('rw', db.agentConversations, db.agentEvents, async () => {
        await db.agentEvents.update(existing.event.id!, {
          content: summarizeConsistencyAgentCandidate(candidate),
          payload: JSON.stringify(candidate),
          createdAt: now,
        })
        await db.agentConversations.update(conversation.id!, { updatedAt: now })
      })
      return {
        conversation: { ...conversation, updatedAt: now },
        event: {
          ...existing.event,
          content: summarizeConsistencyAgentCandidate(candidate),
          payload: JSON.stringify(candidate),
          createdAt: now,
        },
        candidate,
      }
    }
  }

  const conversation: AgentConversation = {
    projectId: candidate.projectId,
    worldGroupId: candidate.worldGroupId,
    title: `一致性 Agent · ${candidate.chapterTitle}`,
    status: 'archived',
    createdAt: now,
    updatedAt: now,
  }
  return db.transaction('rw', db.agentConversations, db.agentEvents, async () => {
    const conversationId = await db.agentConversations.add(conversation) as number
    const event: AgentEvent = {
      projectId: candidate.projectId,
      conversationId,
      sequence: 1,
      kind: 'candidate',
      role: 'assistant',
      content: summarizeConsistencyAgentCandidate(candidate),
      payload: JSON.stringify(candidate),
      createdAt: now,
    }
    const eventId = await db.agentEvents.add(event) as number
    return {
      conversation: { ...conversation, id: conversationId },
      event: { ...event, id: eventId },
      candidate,
    }
  })
}

export async function readLatestConsistencyAgentRun(input: {
  projectId: number
  chapterId: number
}): Promise<ConsistencyAgentRun | null> {
  const events = await db.agentEvents.where('projectId').equals(input.projectId).toArray()
  const matches = events
    .filter(event => event.kind === 'candidate')
    .map(event => ({ event, candidate: parseAgentEventPayload<unknown>(event, null) }))
    .filter((row): row is { event: AgentEvent; candidate: ConsistencyAgentCandidate } => (
      isConsistencyAgentCandidate(row.candidate)
      && row.candidate.chapterId === input.chapterId
    ))
    .sort((left, right) => right.event.createdAt - left.event.createdAt)
  const latest = matches[0]
  if (!latest) return null
  const conversation = await db.agentConversations.get(latest.event.conversationId)
  return conversation ? { conversation, event: latest.event, candidate: latest.candidate } : null
}

export async function isConsistencyAgentCurrent(
  candidate: ConsistencyAgentCandidate,
): Promise<boolean> {
  const chapter = await db.chapters.get(candidate.chapterId)
  return Boolean(
    chapter
    && chapter.projectId === candidate.projectId
    && await hashChapterText(chapter.content ?? '') === candidate.sourceTextHash
  )
}

export function toConsistencyAuditResult(
  candidate: ConsistencyAgentCandidate,
): ConsistencyAuditResult {
  return {
    mode: candidate.mode === 'deep' ? 'deep' : 'fast',
    findings: candidate.findings,
  }
}
