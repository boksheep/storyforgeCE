import { db } from '../db/schema'
import { deriveExportProjectJSON } from '../export/registry-export'
import { CHARACTER_AXES_SNAPSHOT_KIND } from './character-axes-upgrade'
import { log } from '../logging/logger'

interface PendingSnapshot {
  kind: string
  characters: Array<Record<string, unknown>>
}

/**
 * 升级事务里无法通过 PROJECT_TABLES 导出（schema 模块尚在打开）。
 * DB 打开后把迁移 marker 完成成可直接恢复的标准 ProjectExportData。
 */
export async function finalizeCharacterAxesMigrationSnapshots(): Promise<void> {
  const snapshots = await db.snapshots
    .filter(snapshot => snapshot.label === 'R1 角色轴迁移前自动快照')
    .toArray()

  for (const snapshot of snapshots) {
    let pending: PendingSnapshot
    try {
      pending = JSON.parse(snapshot.data) as PendingSnapshot
    } catch (error) {
      log.warn('Migration', 'migration.character-axes.snapshot.invalid', '迁移前角色快照无法解析，保留原快照', {
        projectId: snapshot.projectId,
        snapshotId: snapshot.id,
        dataLength: snapshot.data.length,
        errorName: error instanceof Error ? error.name : typeof error,
      })
      continue
    }
    if (pending.kind !== CHARACTER_AXES_SNAPSHOT_KIND || !Array.isArray(pending.characters)) continue

    const sourceRowIds = new Map<string, number[]>()
    const exported = await deriveExportProjectJSON(snapshot.projectId, sourceRowIds)
    const exportedById = new Map<number, Record<string, unknown>>()
    sourceRowIds.get('characters')?.forEach((id, index) => {
      if (id != null && exported.characters[index]) {
        exportedById.set(id, exported.characters[index] as Record<string, unknown>)
      }
    })
    exported.characters = pending.characters.map(oldRow => {
      const {
        roleWeight: _portableRoleWeight,
        moralAxis: _portableMoralAxis,
        orderAxis: _portableOrderAxis,
        ...portable
      } = exportedById.get(Number(oldRow.id)) ?? {}
      const { id: _id, projectId: _projectId, roleWeight: _rw, moralAxis: _ma, orderAxis: _oa, ...legacy } = oldRow
      return { ...portable, ...legacy } as typeof exported.characters[number]
    })
    const data = JSON.stringify(exported)
    await db.snapshots.update(snapshot.id!, {
      data,
      size: new Blob([data]).size,
    })
    log.info('Migration', 'migration.character-axes.snapshot.finalized', '角色轴迁移快照已补全', {
      projectId: snapshot.projectId,
      snapshotId: snapshot.id,
      characterCount: exported.characters.length,
      byteCount: new Blob([data]).size,
    })
  }
}
