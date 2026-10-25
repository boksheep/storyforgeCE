import { db } from '../db/schema'

/**
 * 删除重要地点前清理城池词条的软引用。
 *
 * 调用方必须把本函数放在同时覆盖 importantLocations 与 codexEntries 的事务中，
 * 这样地点子树和引用不会出现半删除状态。
 */
export async function clearImportantLocationReferences(
  projectId: number,
  locationIds: ReadonlySet<number>,
): Promise<number> {
  if (locationIds.size === 0) return 0
  const entries = await db.codexEntries.where('projectId').equals(projectId).toArray()
  const affected = entries.filter(entry =>
    entry.id != null &&
    entry.importantLocationId != null &&
    locationIds.has(entry.importantLocationId))
  const mapFeatures = (await db.mapFeatures.where('projectId').equals(projectId).toArray())
    .filter(feature => feature.id != null && feature.importantLocationId != null && locationIds.has(feature.importantLocationId))
  if (affected.length === 0 && mapFeatures.length === 0) return 0

  const now = Date.now()
  await db.codexEntries.bulkPut(affected.map(entry => ({
    ...entry,
    importantLocationId: null,
    updatedAt: now,
  })))
  for (const feature of mapFeatures) await db.mapFeatures.update(feature.id!, { importantLocationId: null, updatedAt: now })
  return affected.length + mapFeatures.length
}
