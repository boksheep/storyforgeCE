import { db } from '../db/schema'
import type { FactStatus } from '../types/temporal-fact'
import { log } from '../logging/logger'

const now = () => Date.now()

function markReviewStatus(status: FactStatus, next: FactStatus): FactStatus {
  if (status === 'rejected' || status === 'superseded') return status
  return next
}

/**
 * 角色删除/合并时同步事实账本引用。
 * - 合并：FK 重映射到主角色，主体名同步为主角色名；
 * - 删除：清空 FK，并标 source-missing，避免悬空 Canon 继续注入生成。
 */
export async function remapTemporalFactCharacterRefs(args: {
  projectId: number
  fromCharacterId: number
  toCharacterId?: number
  toName?: string
}): Promise<{ touched: number }> {
  const rows = await db.temporalFacts.where('projectId').equals(args.projectId).toArray()
  let touched = 0
  for (const fact of rows) {
    if (fact.id == null) continue
    const patch: Record<string, unknown> = {}
    let changed = false

    if (fact.characterId === args.fromCharacterId) {
      patch.characterId = args.toCharacterId ?? null
      if (args.toName) patch.subjectName = args.toName
      changed = true
    }
    if (fact.objectCharacterId === args.fromCharacterId) {
      patch.objectCharacterId = args.toCharacterId ?? null
      changed = true
    }
    if (fact.sourceCharacterId === args.fromCharacterId) {
      patch.sourceCharacterId = args.toCharacterId ?? null
      changed = true
    }

    if (!changed) continue
    if (args.toCharacterId == null) {
      patch.status = markReviewStatus(fact.status, 'source-missing')
    }
    patch.updatedAt = now()
    await db.temporalFacts.update(fact.id, patch)
    touched++
  }
  if (touched) log.info('FactLedger', 'fact.character.remapped', '事实账本角色引用已处理', {
    projectId: args.projectId, fromCharacterId: args.fromCharacterId,
    toCharacterId: args.toCharacterId ?? null, touched,
  })
  return { touched }
}

/**
 * 章节删除时同步事实账本引用。
 * 不重算相邻章节、不移动有效区间；只清除已删除章 FK，并把受影响事实标记为具体异常状态待复核。
 */
export async function detachTemporalFactsForDeletedChapters(chapterIds: number[]): Promise<{ touched: number }> {
  if (!chapterIds.length) return { touched: 0 }
  const deleted = new Set(chapterIds)
  const rows = await db.temporalFacts.toArray()
  let touched = 0
  for (const fact of rows) {
    if (fact.id == null) continue
    const patch: Record<string, unknown> = {}
    let changed = false
    let nextStatus: FactStatus | null = null

    if (fact.sourceChapterId != null && deleted.has(fact.sourceChapterId)) {
      patch.sourceChapterId = null
      changed = true
      nextStatus = 'source-missing'
    }
    if (fact.validFromChapterId != null && deleted.has(fact.validFromChapterId)) {
      patch.validFromChapterId = null
      changed = true
      nextStatus = 'invalid-range'
    }
    if (fact.validToChapterId != null && deleted.has(fact.validToChapterId)) {
      patch.validToChapterId = null
      changed = true
      nextStatus = 'invalid-range'
    }

    if (!changed) continue
    if (nextStatus) patch.status = markReviewStatus(fact.status, nextStatus)
    patch.updatedAt = now()
    await db.temporalFacts.update(fact.id, patch)
    touched++
  }
  if (touched) log.info('FactLedger', 'fact.chapter.detached', '事实账本章节引用已断开', {
    chapterCount: deleted.size, touched,
  })
  return { touched }
}
