/**
 * 版本快照（手动 / 自动）的云端存储。
 *
 * ## 为什么快照不跟着项目一起同步
 *
 * `snapshots.data` 本身就是一份完整的 `ProjectExportData`：
 *   1. 塞进 `project_tables` 会递归（快照里还有快照？不会，但整包套整包）
 *   2. 每项目最多 20 份 × ~1.5 MB ≈ 30 MB，会让**每次** push 都重传全部历史
 *   3. 快照是"可选上传"的，不该被自动同步带走
 *
 * 所以这里是一组独立端点：按需上传、按需拉取、按需删除。
 *
 * ## 幂等
 *
 * `snapshot_uid` 由客户端生成。同一份快照重复上传（网络重试、多标签页）
 * 只会覆盖同一行，不会产生重复。这也是"本地快照 ↔ 云端快照"的对应键。
 */
import { env } from '../env.mjs'
import { readJsonBody } from '../http/body.mjs'
import { HttpError, sendJson, sendNoContent } from '../http/respond.mjs'
import { log } from '../log.mjs'
import { assertTrustedRequest, requireSession } from '../auth/routes.mjs'
import { sha256Hex } from './content-hash.mjs'
import { findOwnedProject } from './store.mjs'
import { assertProjectUid } from './validate.mjs'

/** 客户端生成的快照标识（UUID 或 nanoid 风格）。 */
const SNAPSHOT_UID_RE = /^[A-Za-z0-9_-]{8,64}$/
const MAX_LABEL_LENGTH = 200
const ALLOWED_TYPES = new Set(['auto', 'manual'])

function assertSnapshotUid(value) {
  if (typeof value !== 'string' || !SNAPSHOT_UID_RE.test(value)) {
    throw new HttpError(400, 'bad_snapshot_uid', '快照标识格式无效')
  }
  return value
}

function assertLabel(value) {
  const label = typeof value === 'string' ? value.trim() : ''
  if (!label) throw new HttpError(422, 'bad_label', '快照名称不能为空')
  if (label.length > MAX_LABEL_LENGTH) {
    throw new HttpError(422, 'bad_label', `快照名称超过 ${MAX_LABEL_LENGTH} 字符`)
  }
  return label
}

function assertType(value) {
  if (!ALLOWED_TYPES.has(value)) throw new HttpError(422, 'bad_type', '快照类型必须是 auto 或 manual')
  return value
}

/** 列表接口：**只返回元数据**，绝不带 `data`。 */
export function handleListSnapshots(db, req, res, url) {
  const session = requireSession(db, req)
  const projectUid = assertProjectUid(url.searchParams.get('uid') ?? '')
  findOwnedProject(db, projectUid, session.user.id)

  const rows = db.prepare(
    `SELECT snapshot_uid, label, type, size_bytes, created_at, uploaded_at
       FROM project_snapshots
      WHERE project_uid = ?
      ORDER BY created_at DESC`,
  ).all(projectUid)

  sendJson(res, 200, {
    projectUid,
    snapshots: rows.map(row => ({
      snapshotUid: row.snapshot_uid,
      label: row.label,
      type: row.type,
      sizeBytes: row.size_bytes,
      createdAt: row.created_at,
      uploadedAt: row.uploaded_at,
    })),
  })
}

/** 上传（或覆盖）一份快照。 */
export async function handleUploadSnapshot(db, req, res) {
  const session = requireSession(db, req)
  assertTrustedRequest(req)

  const body = await readJsonBody(req, {
    maxBytes: env.maxSnapshotBytes,
    maxCompressedBytes: env.maxSnapshotCompressedBytes,
  })

  const projectUid = assertProjectUid(body?.projectUid)
  const snapshotUid = assertSnapshotUid(body?.snapshotUid)
  const label = assertLabel(body?.label)
  const type = assertType(body?.type)
  const createdAt = Number.isFinite(body?.createdAt) ? Number(body.createdAt) : Date.now()

  // data 是序列化后的 ProjectExportData（字符串），不接受对象：
  // 保持"客户端已序列化"这一契约，避免服务端二次序列化改变字节
  const data = body?.data
  if (typeof data !== 'string' || data.length === 0) {
    throw new HttpError(422, 'bad_data', '快照内容必须是已序列化的 JSON 字符串')
  }
  try {
    JSON.parse(data)
  } catch {
    throw new HttpError(422, 'bad_data', '快照内容不是合法 JSON')
  }

  findOwnedProject(db, projectUid, session.user.id)

  // snapshot_uid 是全局唯一键，不能把“客户端幂等覆盖”误当成跨项目授权。
  // 若 UID 已属于其它项目/用户，拒绝写入，避免攻击者用已知 UID 覆盖他人的备份。
  const existing = db.prepare(
    'SELECT owner_user_id, project_uid FROM project_snapshots WHERE snapshot_uid = ?',
  ).get(snapshotUid)
  if (existing && (existing.owner_user_id !== session.user.id || existing.project_uid !== projectUid)) {
    throw new HttpError(409, 'snapshot_uid_conflict', '快照标识已属于其它项目')
  }

  const sizeBytes = Buffer.byteLength(data, 'utf8')
  const digest = sha256Hex(data)
  const uploadedAt = Date.now()

  db.prepare(
    `INSERT INTO project_snapshots
       (snapshot_uid, project_uid, owner_user_id, label, type, size_bytes, sha256, payload_json, created_at, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(snapshot_uid) DO UPDATE SET
       label = excluded.label,
       type = excluded.type,
       size_bytes = excluded.size_bytes,
       sha256 = excluded.sha256,
       payload_json = excluded.payload_json,
       created_at = excluded.created_at,
       uploaded_at = excluded.uploaded_at`,
  ).run(snapshotUid, projectUid, session.user.id, label, type, sizeBytes, digest, data, createdAt, uploadedAt)

  // 保留最近 N 份（按创建时间），超出删最旧
  const stale = db.prepare(
    `SELECT snapshot_uid FROM project_snapshots
      WHERE project_uid = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?`,
  ).all(projectUid, env.snapshotKeep)
  for (const row of stale) {
    db.prepare('DELETE FROM project_snapshots WHERE snapshot_uid = ?').run(row.snapshot_uid)
  }

  log.info('sync.snapshot.uploaded', {
    userId: session.user.id,
    projectUid,
    snapshotUid,
    type,
    sizeBytes,
    pruned: stale.length,
  })

  sendJson(res, 201, { snapshotUid, sizeBytes, sha256: digest, uploadedAt })
}

/** 取回单份快照的完整内容（用于恢复）。 */
export function handleGetSnapshot(db, req, res, snapshotUid) {
  const session = requireSession(db, req)
  assertSnapshotUid(snapshotUid)

  const row = db.prepare('SELECT * FROM project_snapshots WHERE snapshot_uid = ?').get(snapshotUid)
  if (!row || row.owner_user_id !== session.user.id) {
    throw new HttpError(404, 'not_found', '快照不存在')
  }

  sendJson(res, 200, {
    snapshotUid: row.snapshot_uid,
    projectUid: row.project_uid,
    label: row.label,
    type: row.type,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    uploadedAt: row.uploaded_at,
    data: row.payload_json,
  })
}

/** 删除云端快照。 */
export function handleDeleteSnapshot(db, req, res, snapshotUid) {
  const session = requireSession(db, req)
  assertTrustedRequest(req)
  assertSnapshotUid(snapshotUid)

  const row = db.prepare(
    'SELECT owner_user_id, project_uid FROM project_snapshots WHERE snapshot_uid = ?',
  ).get(snapshotUid)
  if (!row || row.owner_user_id !== session.user.id) {
    throw new HttpError(404, 'not_found', '快照不存在')
  }

  db.prepare('DELETE FROM project_snapshots WHERE snapshot_uid = ?').run(snapshotUid)
  log.info('sync.snapshot.deleted', {
    userId: session.user.id,
    projectUid: row.project_uid,
    snapshotUid,
  })
  sendNoContent(res)
}
