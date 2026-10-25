import type { Transaction } from 'dexie'
import { log } from '../logging/logger'

interface LegacyWorldviewRow {
  projectId: number
  worldGroupId?: number | null
  historyLine?: string
  worldEvents?: string
}

interface HistoryRow {
  id?: number
  projectId: number
  worldGroupId?: number | null
  overview?: string
}

function sameWorld(
  left: { worldGroupId?: number | null },
  right: { worldGroupId?: number | null },
): boolean {
  return (left.worldGroupId ?? null) === (right.worldGroupId ?? null)
}

/** 保留旧原文，只增加最小标签来防止两段文本粘连。 */
export function formatLegacyHistoryOverview(worldview: LegacyWorldviewRow): string {
  const historyLine = worldview.historyLine?.trim() ? worldview.historyLine : undefined
  const worldEvents = worldview.worldEvents?.trim() ? worldview.worldEvents : undefined
  if (historyLine && worldEvents) return `${historyLine}\n\n【旧版世界大事记】\n${worldEvents}`
  return historyLine || worldEvents || ''
}

/**
 * v42 → v43：把旧 Worldview 历史文本桥接到正式 History 总述。
 *
 * 只填空目标，不覆盖作者已经在历史面板维护的内容，也不清除任何旧字段。
 */
export async function migrateWorldHistoryConsolidation(tx: Transaction): Promise<void> {
  const worldviews = await tx.table('worldviews').toArray() as LegacyWorldviewRow[]
  const histories = await tx.table('histories').toArray() as HistoryRow[]
  const now = Date.now()
  let created = 0
  let filled = 0
  let preserved = 0

  for (const worldview of worldviews) {
    const overview = formatLegacyHistoryOverview(worldview)
    if (!overview) continue

    const existing = histories.find(history =>
      history.projectId === worldview.projectId && sameWorld(history, worldview))
    if (existing) {
      if (!existing.overview?.trim() && existing.id != null) {
        await tx.table('histories').update(existing.id, { overview, updatedAt: now })
        existing.overview = overview
        filled++
      } else {
        preserved++
      }
      continue
    }

    const row = {
      projectId: worldview.projectId,
      worldGroupId: worldview.worldGroupId ?? null,
      overview,
      eraSystem: '',
      events: '[]',
      createdAt: now,
      updatedAt: now,
    }
    const id = await tx.table('histories').add(row) as number
    histories.push({ ...row, id })
    created++
  }
  log.info('Migration', 'migration.world-history.prepared', '世界历史归并迁移事务已处理', {
    worldviewCount: worldviews.length, existingHistoryCount: histories.length - created,
    createdCount: created, filledCount: filled, preservedCount: preserved,
  })
}
