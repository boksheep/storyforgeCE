/**
 * CLOUD-DB-1 · 项目身份映射
 *
 * 本地主键是自增整数，跨设备必然冲突（A 机的 3 号项目和 B 机的 3 号项目不是同一个）。
 * 所以云端用 `Project.syncUid`（UUID）对齐"同一个项目"。
 *
 * ## 为什么写库不在这里
 *
 * `check-architecture` 规则⑧ 禁止 `src/lib/**`（registry 目录除外）直接写受治理表，
 * 而 `projects` 已有归属的采纳扩展条目（`step-restore-projects`），同一 target 不能登记两次。
 * 所以本文件只负责**策略**（何时生成、如何查重），实际写库交给注册表层的
 * `src/lib/registry/project-sync-identity.ts` —— 那里才是"受治理直接写库"该待的地方。
 *
 * ## 为什么 `syncUid` 不进导出
 *
 * 它是"本机 ↔ 服务器"的映射，不是作品内容。若跟着备份跑到别的设备，
 * 会把两台机器的映射搅乱（两边都以为自己才是原主）。见 `PROJECT_TABLES.projects.exportOmit`。
 */
import { db } from '../db/schema'
import { setProjectSyncUid } from '../registry/project-sync-identity'
import type { Project } from '../types'

/** 导入时追加的后缀（`registry-import.ts` 会无条件加一层）。 */
const IMPORT_SUFFIX = '（导入）'

export function generateSyncUid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  // 兜底：老浏览器没有 randomUUID
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * 去掉导入后缀，避免反复拉取把名字堆成「书（导入）（导入）」。
 *
 * 服务端存的是干净名字；`deriveImportProjectJSON` 会自己加一层，
 * 所以这里只要保证"传给它的名字不含后缀"即可。
 */
export function stripImportSuffix(name: string): string {
  let result = name
  while (result.endsWith(IMPORT_SUFFIX)) {
    result = result.slice(0, -IMPORT_SUFFIX.length).trim()
  }
  return result || name
}

/** 读取项目的云端身份（未绑定返回 null）。 */
export async function getSyncUid(projectId: number): Promise<string | null> {
  const project = await db.projects.get(projectId)
  return project?.syncUid ?? null
}

/**
 * 确保项目有云端身份：已有则原样返回，没有则生成并写入。
 *
 * 写入是**单字段 update**（见 `setProjectSyncUid`），不碰其他字段，也不改 `updatedAt`
 * —— 否则每次同步都会让项目"看起来被改过"。
 */
export async function ensureSyncUid(projectId: number): Promise<string | null> {
  const project = await db.projects.get(projectId)
  if (!project) return null
  if (project.syncUid) return project.syncUid

  const syncUid = generateSyncUid()
  await setProjectSyncUid(projectId, syncUid)
  return syncUid
}

/** 按云端身份找本地项目（`projects` 只有几十行，内存扫描足够，不建索引）。 */
export async function findProjectBySyncUid(syncUid: string): Promise<Project | null> {
  if (!syncUid) return null
  const rows = await db.projects.toArray()
  return rows.find(row => row.syncUid === syncUid) ?? null
}

/** 已绑定云端的本地项目（同步引擎的推送候选）。 */
export async function listBoundProjects(): Promise<Project[]> {
  const rows = await db.projects.toArray()
  return rows.filter(row => typeof row.syncUid === 'string' && row.syncUid.length > 0)
}

/** 解除绑定（删除项目 / 用户主动"断开云端"时调用）。 */
export async function clearSyncUid(projectId: number): Promise<void> {
  await setProjectSyncUid(projectId, undefined)
}
