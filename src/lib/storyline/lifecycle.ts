import { db } from '../db/schema'
import { log } from '../logging/logger'

/** 删章时保留作者确认的数据和冗余章名，只断开可能悬空的 FK。 */
export async function detachStorylineForDeletedChapters(
  chapterIds: number[],
): Promise<{ progressTouched: number; crossingsTouched: number }> {
  if (!chapterIds.length) return { progressTouched: 0, crossingsTouched: 0 }
  const ids = new Set(chapterIds)
  const [progress, crossings] = await Promise.all([
    db.storylineProgress.toArray(),
    db.storylineCrossings.toArray(),
  ])
  let progressTouched = 0
  let crossingsTouched = 0
  const now = Date.now()
  for (const row of progress) {
    if (row.id == null || row.lastActiveChapterId == null || !ids.has(row.lastActiveChapterId)) continue
    await db.storylineProgress.update(row.id, { lastActiveChapterId: null, updatedAt: now })
    progressTouched++
  }
  for (const row of crossings) {
    if (row.id == null || row.chapterId == null || !ids.has(row.chapterId)) continue
    await db.storylineCrossings.update(row.id, { chapterId: null, updatedAt: now })
    crossingsTouched++
  }
  if (progressTouched || crossingsTouched) log.info('Storyline', 'storyline.chapter.detached', '删章后故事线引用已断开', {
    chapterCount: ids.size, progressTouched, crossingsTouched,
  })
  return { progressTouched, crossingsTouched }
}

/** StoryArc 是动态投影的硬父项；删线必须在同一事务里清掉所有投影和交汇。 */
export async function deleteStoryArcLifecycle(arcId: number): Promise<void> {
  const deleted = await db.transaction(
    'rw',
    db.storyArcs,
    db.storylineProgress,
    db.storylineCrossings,
    async () => {
      const arc = await db.storyArcs.get(arcId)
      const progressCount = await db.storylineProgress.where('arcId').equals(arcId).delete()
      const crossings = await db.storylineCrossings
        .filter(row => row.arcIdA === arcId || row.arcIdB === arcId)
        .primaryKeys()
      if (crossings.length) await db.storylineCrossings.bulkDelete(crossings as number[])
      await db.storyArcs.delete(arcId)
      return { projectId: arc?.projectId, arcExisted: Boolean(arc), progressCount, crossingCount: crossings.length }
    },
  )
  log.info('Storyline', 'storyline.arc.deleted', '故事线及投影删除事务已执行', {
    projectId: deleted.projectId, arcId, arcExisted: deleted.arcExisted,
    progressCount: deleted.progressCount, crossingCount: deleted.crossingCount,
  })
}

/** 编辑静态阶段后，不能让动态投影继续指向已删除的 stageId。 */
export async function updateStoryArcStagesLifecycle(args: {
  arcId: number
  stages: string
  validStageIds: readonly string[]
}): Promise<void> {
  const detached = await db.transaction('rw', db.storyArcs, db.storylineProgress, async () => {
    await db.storyArcs.update(args.arcId, { stages: args.stages, updatedAt: Date.now() })
    const progress = await db.storylineProgress.where('arcId').equals(args.arcId).first()
    if (
      progress?.id != null
      && progress.currentStageId != null
      && !args.validStageIds.includes(progress.currentStageId)
    ) {
      await db.storylineProgress.update(progress.id, {
        currentStageId: null,
        updatedAt: Date.now(),
      })
      return true
    }
    return false
  })
  log.info('Storyline', 'storyline.arc.stages.updated', '故事线阶段已更新', {
    arcId: args.arcId, validStageCount: args.validStageIds.length, progressDetached: detached,
  })
}
