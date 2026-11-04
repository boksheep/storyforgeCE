/**
 * 项目状态装配与版本快照。
 *
 * 版本文件放在 `SF_VERSIONS_DIR`（默认 `<dataDir>/versions`），按
 * `<projectUid>/<rev>-<reason>.json.gz` 命名。写入用 **临时文件 + 原子改名**，
 * 避免半截文件被当成有效版本。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { env } from '../env.mjs'
import { SYNC_TABLES } from '../generated/table-manifest.mjs'
import { HttpError } from '../http/respond.mjs'
import { log } from '../log.mjs'

/**
 * 从 `project_tables` 拼回一份 `ProjectExportData`。
 *
 * 与前端 `deriveExportProjectJSON` 的输出形状一致：`projects` 表还原成
 * 单对象 `project`，其余表还原成数组，顺序按 `SYNC_TABLES`。
 */
export function assembleExport(db, projectRow) {
  const rows = db.prepare(
    'SELECT table_name, payload_json FROM project_tables WHERE project_uid = ?',
  ).all(projectRow.project_uid)

  const byName = new Map()
  for (const row of rows) {
    try {
      byName.set(row.table_name, JSON.parse(row.payload_json))
    } catch {
      // 库内 JSON 损坏：当作空表，避免整个拉取失败（并由调用方在日志里看到）
      log.error('sync.assemble.corrupt', { projectUid: projectRow.project_uid, table: row.table_name })
      byName.set(row.table_name, [])
    }
  }

  const projectRows = byName.get('projects')
  const exportData = {
    version: projectRow.export_version ?? 4,
    exportedAt: Date.now(),
    project: Array.isArray(projectRows) ? (projectRows[0] ?? {}) : (projectRows ?? {}),
  }

  for (const tableName of SYNC_TABLES) {
    if (tableName === 'projects') continue
    const tableRows = byName.get(tableName)
    exportData[tableName] = Array.isArray(tableRows) ? tableRows : []
  }

  return exportData
}

/**
 * 读取当前用户拥有的项目（**必须已存在**）。
 *
 * 用于"项目一定已经在云端"的接口：pull / status / snapshots。
 * push 是例外——它要负责**创建**项目，所以那边用"缺失返回 null"的变体。
 *
 * **不匹配一律 404（不是 403）**：403 等于告诉对方"这个 uid 存在但不是你的"，
 * 可以被用来枚举别人的项目。这条规则在所有接口上必须一致。
 */
export function findOwnedProject(db, projectUid, userId) {
  const row = db.prepare('SELECT * FROM projects WHERE project_uid = ?').get(projectUid)
  if (!row) throw new HttpError(404, 'not_found', '项目不存在')
  if (row.owner_user_id !== userId || row.deleted_at) {
    throw new HttpError(404, 'not_found', '项目不存在')
  }
  return row
}

/** 409 与列表接口用的远端摘要（**不含载荷**）。 */
export function summarizeProject(row) {  return {
    rev: row.rev,
    name: row.name,
    updatedAt: row.updated_at,
    contentSha256: row.content_sha256,
    sizeBytes: row.size_bytes,
  }
}

/** 写出一个版本快照，返回相对路径。 */
export function writeVersionFile(projectUid, rev, reason, exportData) {
  const dir = path.join(env.versionsDir, projectUid)
  fs.mkdirSync(dir, { recursive: true })

  const relative = path.join(projectUid, `${rev}-${reason}.json.gz`)
  const absolute = path.join(env.versionsDir, relative)
  const temporary = `${absolute}.tmp`

  const gzipped = zlib.gzipSync(Buffer.from(JSON.stringify(exportData), 'utf8'))
  fs.writeFileSync(temporary, gzipped)
  fs.renameSync(temporary, absolute)
  return relative
}

/** 只保留最近 `keep` 个版本（按时间倒序），其余连文件一起删。 */
export function pruneVersions(db, projectUid, keep = env.versionKeep) {
  const rows = db.prepare(
    `SELECT rev, reason, payload_path FROM project_versions
      WHERE project_uid = ? ORDER BY created_at DESC, rev DESC`,
  ).all(projectUid)

  for (const row of rows.slice(keep)) {
    if (row.payload_path) {
      try {
        fs.rmSync(path.join(env.versionsDir, row.payload_path), { force: true })
      } catch {
        // 文件可能已被手动清理
      }
    }
    db.prepare(
      'DELETE FROM project_versions WHERE project_uid = ? AND rev = ? AND reason = ?',
    ).run(projectUid, row.rev, row.reason)
  }
}

/** 读取指定版本快照；不存在返回 `null`。 */
export function readVersion(db, projectUid, rev) {
  const row = db.prepare(
    `SELECT payload_path FROM project_versions
      WHERE project_uid = ? AND rev = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(projectUid, rev)
  if (!row?.payload_path) return null

  try {
    const buffer = fs.readFileSync(path.join(env.versionsDir, row.payload_path))
    return JSON.parse(zlib.gunzipSync(buffer).toString('utf8'))
  } catch {
    return null
  }
}
