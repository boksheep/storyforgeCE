import { db } from '../db/schema'
import { parseCultivationStages, type CultivationStage } from '../types'

/** 章节删除保留正文证据与冗余标题，只断开 FK 并降级复核。 */
export async function detachCultivationProgressForDeletedChapters(
  chapterIds: readonly number[],
): Promise<void> {
  if (!chapterIds.length) return
  const deleted = new Set(chapterIds)
  const rows = await db.cultivationProgress.toArray()
  for (const row of rows) {
    if (row.id == null || row.sourceChapterId == null || !deleted.has(row.sourceChapterId)) continue
    await db.cultivationProgress.update(row.id, {
      sourceChapterId: null,
      status: 'source-missing',
      updatedAt: Date.now(),
    })
  }
}

/** 角色合并重映射；删除则保留角色名并断开软引用。 */
export async function remapCultivationProgressCharacterRefs(args: {
  projectId: number
  fromCharacterId: number
  toCharacterId?: number
  toName?: string
}): Promise<void> {
  const rows = await db.cultivationProgress
    .where('projectId').equals(args.projectId)
    .filter(row => row.characterId === args.fromCharacterId)
    .toArray()
  for (const row of rows) {
    if (row.id == null) continue
    await db.cultivationProgress.update(row.id, {
      characterId: args.toCharacterId ?? null,
      ...(args.toCharacterId != null && args.toName ? { characterName: args.toName } : {}),
      ...(args.toCharacterId == null ? { status: 'source-missing' as const } : {}),
      updatedAt: Date.now(),
    })
  }
}

/** 体系删除时保留历史证据和冗余名称，清除结构化引用。 */
export async function detachCultivationProgressSystems(
  projectId: number,
  systemIds: ReadonlySet<number>,
): Promise<void> {
  if (!systemIds.size) return
  const rows = await db.cultivationProgress.where('projectId').equals(projectId).toArray()
  for (const row of rows) {
    if (
      row.id == null
      || row.cultivationSystemId == null
      || !systemIds.has(row.cultivationSystemId)
    ) continue
    await db.cultivationProgress.update(row.id, {
      cultivationSystemId: null,
      stageId: null,
      status: 'source-missing',
      updatedAt: Date.now(),
    })
  }
}

/**
 * 阶段图谱变化：
 * - 被删阶段断引用并 source-missing；
 * - 保留 ID 但名称/父关系变化时标 stale，避免旧路径继续注入。
 */
export async function refreshCultivationProgressStageSources(args: {
  projectId: number
  systemId: number
  previousStages: string
  nextStages: string
}): Promise<void> {
  const previous = new Map(parseCultivationStages(args.previousStages).map(stage => [stage.id, stage]))
  const next = new Map(parseCultivationStages(args.nextStages).map(stage => [stage.id, stage]))
  const rows = await db.cultivationProgress
    .where('projectId').equals(args.projectId)
    .filter(row => row.cultivationSystemId === args.systemId)
    .toArray()
  for (const row of rows) {
    if (row.id == null || row.stageId == null) continue
    const before = previous.get(row.stageId)
    const after = next.get(row.stageId)
    if (!after) {
      await db.cultivationProgress.update(row.id, {
        stageId: null,
        status: 'source-missing',
        updatedAt: Date.now(),
      })
      continue
    }
    if (before && stageDefinitionChanged(before, after) && row.status === 'confirmed') {
      await db.cultivationProgress.update(row.id, {
        status: 'stale',
        updatedAt: Date.now(),
      })
    }
  }
}

function stageDefinitionChanged(left: CultivationStage, right: CultivationStage): boolean {
  return left.name !== right.name
    || [...left.parentStageIds].sort().join('\u0000') !== [...right.parentStageIds].sort().join('\u0000')
}
