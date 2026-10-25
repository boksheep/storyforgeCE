/**
 * NS-4 · 事实账本写回（单一入口，禁止组件/面板裸写 db.temporalFacts）。
 *
 * 设计权威 §14.4 / §14.6：
 * - 抽取产出一律落 status:'candidate'（Evidence Observation）；
 * - 谓词受 FACT_PREDICATE_REGISTRY 控制；
 * - 主体名 → 分类型 FK（characterId）在此解析（有主表才建 FK，否则只留 subjectName）；
 * - 去重：同主体+谓词+值的【未关闭候选】不重复写；
 * - ★不在此自动 supersede 旧权威事实——supersede 只发生在【作者确认候选/异常复核】时（confirmFactCandidate），
 *   候选(observation)不改 canon（§14.6「无证据 observation 不得自动升级为 Canon」）。
 */
import { db } from '../db/schema'
import { log } from '../logging/logger'
import { buildCharacterSurfaceIndex, resolveCharacterBySurface } from '../character/character-identity'
import type { TemporalFact } from '../types/temporal-fact'
import type { ExtractedFactCandidate } from '../ai/adapters/fact-extract-adapter'
import { getFactPredicate, normalizeFactValue } from '../registry/fact-predicate-registry'
import {
  checkSettingAssertionClashes,
  validateSettingAssertionSource,
  type SettingAssertionClash,
} from './setting-assertions'
import { resolveCanonicalChapterSequence } from '../ai/chapter-memory/canonical-chapter-sequence'

const now = () => Date.now()

function sameFactSubject(left: TemporalFact, right: TemporalFact): boolean {
  const typedFields = [
    'characterId',
    'locationId',
    'storyArcId',
    'subjectWorldGroupId',
    'codexEntryId',
  ] as const
  const leftTyped = typedFields.find(field => left[field] != null)
  const rightTyped = typedFields.find(field => right[field] != null)
  if (leftTyped && rightTyped) {
    return leftTyped === rightTyped && left[leftTyped] === right[rightTyped]
  }
  // 兼容旧事实：一侧尚未回填 typed FK 时，以同世界精确 subjectName 对齐。
  return left.subjectName === right.subjectName
}

async function canonicalOrderForProject(projectId: number): Promise<Map<number, number>> {
  const [outlineNodes, chapters] = await Promise.all([
    db.outlineNodes.where('projectId').equals(projectId).toArray(),
    db.chapters.where('projectId').equals(projectId).toArray(),
  ])
  const { sequence } = resolveCanonicalChapterSequence(outlineNodes, chapters)
  const orderOf = new Map<number, number>()
  sequence.forEach((entry, index) => {
    if (entry.chapter.id != null) orderOf.set(entry.chapter.id, index)
  })
  return orderOf
}

/**
 * 按名字 + 世界解析唯一角色 FK。
 *
 * ALIAS-1：名字可以是该角色的**任一称呼**（正名或别称）。正文写"禾姐"、角色卡正名"苏禾"时，
 * 旧实现永远绑不上 FK，事实只能以口语称呼留在账本里，读侧（characterFacts / 存亡判决）
 * 也就按名字对不上。重名/别称冲突仍**不猜**：歧义保留 subjectName 等待人工复核。
 */
export async function resolveCharacterId(
  projectId: number,
  name: string,
  worldGroupId?: number | null,
): Promise<number | null> {
  if (!name) return null
  const characters = await db.characters.where('projectId').equals(projectId).toArray()
  const index = buildCharacterSurfaceIndex(
    characters,
    worldGroupId === undefined ? undefined : (worldGroupId ?? null),
  )
  return resolveCharacterBySurface(index, name)?.id ?? null
}

export interface AdoptFactsResult {
  written: number
  skippedDuplicate: number
  skippedUnknownPredicate: number
  skippedInvalidValue: number
}

/**
 * 把抽取候选写入事实账本（单一注册入口）。
 * @param worldGroupId 当前章节所属世界组（多世界隔离），null = 默认主世界
 */
export async function adoptFactCandidates(args: {
  projectId: number
  sourceChapterId: number
  worldGroupId?: number | null
  candidates: ExtractedFactCandidate[]
}): Promise<AdoptFactsResult> {
  const result: AdoptFactsResult = {
    written: 0,
    skippedDuplicate: 0,
    skippedUnknownPredicate: 0,
    skippedInvalidValue: 0,
  }

  // 本项目当前所有未关闭候选，用于去重（一次性取，避免逐条查库）
  const existing = await db.temporalFacts
    .where('projectId').equals(args.projectId)
    .filter(f => f.validToChapterId == null && f.status === 'candidate')
    .toArray()
  const seen = new Set(existing.map(f => {
    const spec = getFactPredicate(f.predicate)
    const value = spec ? normalizeFactValue(spec, f.value) ?? f.value : f.value
    return `${f.worldGroupId ?? 'null'}|${f.subjectName}|${f.predicate}|${value}`
  }))

  for (const c of args.candidates) {
    const spec = getFactPredicate(c.predicate)
    if (!spec) { result.skippedUnknownPredicate++; continue }   // 受控谓词守卫（双保险）
    const normalizedValue = normalizeFactValue(spec, c.value)
    if (!normalizedValue) { result.skippedInvalidValue++; continue }

    const key = `${args.worldGroupId ?? 'null'}|${c.subjectName}|${c.predicate}|${normalizedValue}`
    if (seen.has(key)) { result.skippedDuplicate++; continue }
    seen.add(key)

    const characterId = await resolveCharacterId(args.projectId, c.subjectName, args.worldGroupId)
    const objectCharacterId = c.objectName
      ? await resolveCharacterId(args.projectId, c.objectName, args.worldGroupId)
      : null

    const fact: TemporalFact = {
      projectId: args.projectId,
      worldGroupId: args.worldGroupId ?? null,
      characterId,
      subjectName: c.subjectName,
      objectCharacterId: spec.objectEntityTypes?.includes('character') ? objectCharacterId : null,
      predicate: c.predicate,
      factKind: c.factKind,
      value: normalizedValue,
      sourceType: 'chapter',
      sourceChapterId: args.sourceChapterId,
      sourceQuote: c.sourceQuote,
      validFromChapterId: args.sourceChapterId,
      validToChapterId: null,
      status: 'candidate',
      locked: false,
      createdAt: now(),
      updatedAt: now(),
    }
    await db.temporalFacts.add(fact)
    result.written++
  }
  log.info('FactLedger', 'fact.candidates.adopted', '事实候选采纳已结束', {
    projectId: args.projectId, sourceChapterId: args.sourceChapterId,
    worldGroupId: args.worldGroupId ?? null, requested: args.candidates.length,
    written: result.written, skippedDuplicate: result.skippedDuplicate,
    skippedUnknownPredicate: result.skippedUnknownPredicate,
    skippedInvalidValue: result.skippedInvalidValue,
  })
  return result
}

/**
 * 作者确认候选/异常事实 → 升为 Canon（confirmed）。§14.4：state 单值谓词在此【关闭被它取代的旧有效事实】，
 * 不按字符串相似度自动覆盖、不动 locked、event 不可被 supersede。
 */
export interface ConfirmFactResult {
  confirmed: boolean
  clashes: SettingAssertionClash[]
  reason?: 'missing' | 'invalid-status' | 'source-stale' | 'source-missing'
}

export async function confirmFactCandidate(factId: number): Promise<ConfirmFactResult> {
  const fact = await db.temporalFacts.get(factId)
  if (!fact || fact.id == null) {
    log.warn('FactLedger', 'fact.confirm.denied', '事实候选确认被拒绝', { factId, reason: 'missing' })
    return { confirmed: false, clashes: [], reason: 'missing' }
  }
  if (!['candidate', 'stale', 'source-missing', 'invalid-range'].includes(fact.status)) {
    log.warn('FactLedger', 'fact.confirm.denied', '事实候选确认被拒绝', { projectId: fact.projectId, factId, reason: 'invalid-status' })
    return { confirmed: false, clashes: [], reason: 'invalid-status' }
  }
  const spec = getFactPredicate(fact.predicate)
  if (spec?.constitution) {
    const sourceState = await validateSettingAssertionSource(fact)
    if (sourceState !== 'current') {
      await db.temporalFacts.update(fact.id, { status: sourceState, updatedAt: now() })
      log.warn('FactLedger', 'fact.confirm.denied', '事实候选来源失效', { projectId: fact.projectId, factId, reason: sourceState })
      return {
        confirmed: false,
        clashes: [],
        reason: sourceState === 'stale' ? 'source-stale' : 'source-missing',
      }
    }
    const confirmed = await db.temporalFacts
      .where('projectId').equals(fact.projectId)
      .filter(row => row.status === 'confirmed')
      .toArray()
    const clashes = checkSettingAssertionClashes(fact, confirmed)
    if (clashes.length) {
      log.warn('FactLedger', 'fact.confirm.clash', '事实候选与已确认宪法冲突', { projectId: fact.projectId, factId, clashCount: clashes.length })
      return { confirmed: false, clashes }
    }
  }

  let confirmedStatus: TemporalFact['status'] = 'confirmed'
  let validToChapterId = fact.validToChapterId ?? null
  let supersedesFactId = fact.supersedesFactId ?? null

  // 单值 state 谓词：按规范章序关闭同主体+谓词的旧事实。
  // 若作者先确认了后章、再补确认前章，前章事实成为有截止点的历史 Canon，
  // 不能倒过来把后章当前状态关闭。
  if (spec && spec.factKind === 'state' && spec.cardinality === 'single' && spec.conflictPolicy === 'supersede') {
    const priors = await db.temporalFacts
      .where('projectId').equals(fact.projectId)
      .filter(f =>
        f.id !== fact.id &&
        f.predicate === fact.predicate &&
        (f.worldGroupId ?? null) === (fact.worldGroupId ?? null) &&
        sameFactSubject(f, fact) &&
        f.validToChapterId == null &&
        f.status === 'confirmed',
      )
      .toArray()
    const orderOf = spec.temporal ? await canonicalOrderForProject(fact.projectId) : null
    const factOrder = fact.validFromChapterId == null
      ? -1
      : orderOf?.get(fact.validFromChapterId)
    const closable: TemporalFact[] = []
    const future: Array<{ fact: TemporalFact; order: number }> = []
    for (const prior of priors) {
      const priorOrder = prior.validFromChapterId == null
        ? -1
        : orderOf?.get(prior.validFromChapterId)
      if (orderOf && factOrder != null && priorOrder != null) {
        if (priorOrder > factOrder) future.push({ fact: prior, order: priorOrder })
        else if (!prior.locked) closable.push(prior)
      } else if (!prior.locked) {
        closable.push(prior)
      }
    }
    future.sort((a, b) => a.order - b.order || (a.fact.id ?? 0) - (b.fact.id ?? 0))
    if (future[0]?.fact.validFromChapterId != null) {
      validToChapterId = future[0].fact.validFromChapterId
      confirmedStatus = 'superseded'
    }
    const timestamp = now()
    await db.transaction('rw', db.temporalFacts, async () => {
      for (const prior of closable) {
        if (prior.id == null) continue
        await db.temporalFacts.update(prior.id, {
          validToChapterId: fact.validFromChapterId ?? null,
          status: 'superseded',
          updatedAt: timestamp,
        })
        supersedesFactId ??= prior.id
      }
      await db.temporalFacts.update(fact.id!, {
        status: confirmedStatus,
        validToChapterId,
        supersedesFactId,
        updatedAt: timestamp,
      })
    })
    log.info('FactLedger', 'fact.confirmed', '事实候选已确认并处理旧事实', {
      projectId: fact.projectId, factId, supersededCount: closable.length,
      status: confirmedStatus,
    })
    return { confirmed: true, clashes: [] }
  }
  await db.temporalFacts.update(fact.id, {
    status: confirmedStatus,
    validToChapterId,
    supersedesFactId,
    updatedAt: now(),
  })
  log.info('FactLedger', 'fact.confirmed', '事实候选已确认', {
    projectId: fact.projectId, factId, supersededCount: 0, status: confirmedStatus,
  })
  return { confirmed: true, clashes: [] }
}

export interface ReplaceConstitutionFactResult {
  confirmed: boolean
  clashes: SettingAssertionClash[]
  replaced: number
  reason?: ConfirmFactResult['reason'] | 'not-constitution' | 'locked-conflict'
}

/**
 * 作者第二次显式操作：以候选取代所有同主体/同主题的互斥世界宪法。
 * 普通确认绝不会走这里；locked 旧断言仍拒绝覆盖。
 */
export async function replaceConstitutionFactCandidate(
  factId: number,
): Promise<ReplaceConstitutionFactResult> {
  const fact = await db.temporalFacts.get(factId)
  if (!fact || fact.id == null) return { confirmed: false, clashes: [], replaced: 0, reason: 'missing' }
  const spec = getFactPredicate(fact.predicate)
  if (!spec?.constitution) {
    return { confirmed: false, clashes: [], replaced: 0, reason: 'not-constitution' }
  }
  if (!['candidate', 'stale', 'source-missing', 'invalid-range'].includes(fact.status)) {
    return { confirmed: false, clashes: [], replaced: 0, reason: 'invalid-status' }
  }
  const sourceState = await validateSettingAssertionSource(fact)
  if (sourceState !== 'current') {
    await db.temporalFacts.update(fact.id, { status: sourceState, updatedAt: now() })
    return {
      confirmed: false,
      clashes: [],
      replaced: 0,
      reason: sourceState === 'stale' ? 'source-stale' : 'source-missing',
    }
  }
  const confirmed = await db.temporalFacts
    .where('projectId').equals(fact.projectId)
    .filter(row => row.status === 'confirmed')
    .toArray()
  const clashes = checkSettingAssertionClashes(fact, confirmed)
  if (clashes.some(clash => clash.confirmed.locked)) {
    return { confirmed: false, clashes, replaced: 0, reason: 'locked-conflict' }
  }
  const timestamp = now()
  await db.transaction('rw', db.temporalFacts, async () => {
    for (const clash of clashes) {
      if (clash.confirmed.id == null) continue
      await db.temporalFacts.update(clash.confirmed.id, {
        status: 'superseded',
        updatedAt: timestamp,
      })
    }
    await db.temporalFacts.update(fact.id!, {
      status: 'confirmed',
      supersedesFactId: clashes[0]?.confirmed.id ?? null,
      updatedAt: timestamp,
    })
  })
  log.info('FactLedger', 'fact.constitution.replaced', '世界宪法候选已替换冲突事实', {
    projectId: fact.projectId, factId, replacedCount: clashes.length,
  })
  return { confirmed: true, clashes, replaced: clashes.length }
}

/** 作者否决候选/异常事实（不入 Canon、不再注入生成）。不动已确认/已锁定事实。 */
export async function rejectFactCandidate(factId: number): Promise<void> {
  const fact = await db.temporalFacts.get(factId)
  if (!fact || fact.id == null || fact.status === 'confirmed' || fact.locked) {
    log.warn('FactLedger', 'fact.reject.denied', '事实候选否决被拒绝', {
      factId, projectId: fact?.projectId, reason: !fact ? 'missing' : fact.locked ? 'locked' : 'confirmed',
    })
    return
  }
  await db.temporalFacts.update(fact.id, { status: 'rejected', updatedAt: now() })
  log.info('FactLedger', 'fact.rejected', '事实候选已否决', { projectId: fact.projectId, factId })
}

/** 读某项目的事实（按状态可选过滤），供事实库 UI 与投影使用。 */
export async function listFacts(projectId: number, status?: TemporalFact['status']): Promise<TemporalFact[]> {
  const rows = await db.temporalFacts.where('projectId').equals(projectId).toArray()
  return status ? rows.filter(f => f.status === status) : rows
}
