/**
 * CLOUD-DB-1 · 拉取并落地
 *
 * 复用既有 `importProjectJSON`（注册表派生的导入引擎），所以：
 *   - 外键重映射、拓扑排序、地图二进制校验全部现成
 *   - 永远**新建项目**，绝不就地覆盖（与"恢复永远新建"的既有约定一致）
 *
 * ## 两个必须处理的坑
 *
 * 1. **名称累积**：`deriveImportProjectJSON` 会无条件追加「（导入）」。
 *    直接反复拉取会得到「书（导入）（导入）」。所以先 `stripImportSuffix()` 再传干净名字，
 *    结果稳定是「书（导入）」。
 * 2. **同一云端身份只能对应一个本地项目**：否则两个本地项目会争着推同一个服务器项目。
 *    因此拉取时如果本地已有绑定该 `syncUid` 的项目，新副本**不绑定**，
 *    并（在"用云端覆盖本地"时）把旧项目解绑。
 */
import { importProjectJSON, type ProjectExportData } from '../export/json-export'
import { log } from '../logging/logger'
import { withCaptureSuppressed } from './change-capture'
import { pull } from './client'
import { clearSyncUid, findProjectBySyncUid, stripImportSuffix } from './project-identity'

export interface PullApplyOptions {
  /** 取指定历史版本（来自 `project_versions` 快照）。 */
  rev?: number
  /**
   * 新副本是否接管云端身份。
   *
   * - `true`（"用云端覆盖本地"）：新副本绑定 `syncUid`，旧项目解绑。
   * - `false`（"另存为副本"）：新副本保持游离，旧项目继续持有绑定。
   */
  rebind?: boolean
}

export interface PullApplyResult {
  projectId: number
  /** 新副本是否已接管云端身份。 */
  bound: boolean
  /** 被解绑的旧项目（没有则为 null）。 */
  detachedProjectId: number | null
}

/**
 * 把云端项目拉成本地项目。
 *
 * @returns 落地结果；服务端没有更新（304）或失败时返回 null
 */
export async function pullProject(
  projectUid: string,
  options: PullApplyOptions = {},
): Promise<PullApplyResult | null> {
  const rebind = options.rebind !== false
  const response = await pull(projectUid, { rev: options.rev })
  if (!response) return null

  const existing = await findProjectBySyncUid(projectUid)
  const baseName = stripImportSuffix(
    response.name ?? existing?.name ?? '云端项目',
  )

  // 抑制捕获：导入 55 张表若被当成用户编辑，会立刻产生一次回推风暴。
  // `withCaptureSuppressed` 的 finally 会补一个全库对账，兜住抑制期间的并发写入。
  const projectId = await withCaptureSuppressed(async () => {
    return importProjectJSON(response.export as ProjectExportData, {
      name: baseName,
      // 已有本地项目持有时不重复绑定，避免"两个项目抢一个云端身份"
      syncUid: rebind || !existing ? projectUid : undefined,
    })
  })

  let detachedProjectId: number | null = null
  if (rebind && existing?.id != null) {
    await clearSyncUid(existing.id)
    detachedProjectId = existing.id
  }

  log.info('Cloud', 'cloud.pull.applied', '云端版本已落地为新项目', {
    projectUid,
    projectId,
    rev: response.rev,
    historical: response.historical === true,
    detached: detachedProjectId,
  })

  return {
    projectId,
    bound: rebind || !existing,
    detachedProjectId,
  }
}
