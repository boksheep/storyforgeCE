import { db } from '../db/schema'
import { parseEntryRefs, stringifyEntryRefs } from '../types/codex'

/**
 * 从项目内所有剩余词条的 refs JSON 中移除已删除词条 ID。
 *
 * 调用方负责把本函数与实际删除放进同一个 Dexie 事务，确保不会出现
 * “目标已删但引用清理失败”的半完成状态。
 */
export async function removeCodexEntryReferences(
  projectId: number,
  deletedIds: ReadonlySet<number>,
): Promise<void> {
  if (deletedIds.size === 0) return
  const rows = await db.codexEntries.where('projectId').equals(projectId).toArray()
  for (const row of rows) {
    if (row.id == null || deletedIds.has(row.id)) continue
    const refs = parseEntryRefs(row.refs)
    let changed = false
    const next: Record<string, number[]> = {}
    for (const [field, ids] of Object.entries(refs)) {
      const kept = ids.filter(id => !deletedIds.has(id))
      if (kept.length !== ids.length) changed = true
      next[field] = kept
    }
    if (changed) {
      await db.codexEntries.update(row.id, {
        refs: stringifyEntryRefs(next),
        updatedAt: Date.now(),
      })
    }
  }
  const characters = await db.characters.where('projectId').equals(projectId).toArray()
  for (const character of characters) {
    if (character.id != null && character.raceEntryId != null && deletedIds.has(character.raceEntryId)) {
      await db.characters.update(character.id, { raceEntryId: null, updatedAt: Date.now() })
    }
  }
  const mapFeatures = await db.mapFeatures.where('projectId').equals(projectId).toArray()
  for (const feature of mapFeatures) {
    if (feature.id != null && feature.codexEntryId != null && deletedIds.has(feature.codexEntryId)) {
      await db.mapFeatures.update(feature.id, { codexEntryId: null, updatedAt: Date.now() })
    }
  }
}
