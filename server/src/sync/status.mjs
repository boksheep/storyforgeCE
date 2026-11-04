/**
 * 项目列表与状态。**只返回元数据，绝不返回载荷** ——
 * 否则"看一眼列表"就等价于"下载全部手稿"。
 */
import { sendJson, sendNoContent, HttpError } from '../http/respond.mjs'
import { log } from '../log.mjs'
import { assertTrustedRequest, requireSession } from '../auth/routes.mjs'
import { assertProjectUid } from './validate.mjs'

const TABLE_COUNT_SQL = 'SELECT COUNT(*) AS count FROM project_tables WHERE project_uid = ?'

export function handleStatus(db, req, res) {
  const session = requireSession(db, req)

  const rows = db.prepare(
    `SELECT project_uid, name, rev, updated_at, content_sha256, size_bytes
       FROM projects
      WHERE owner_user_id = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC`,
  ).all(session.user.id)

  const countStatement = db.prepare(TABLE_COUNT_SQL)
  const projects = rows.map(row => ({
    projectUid: row.project_uid,
    name: row.name,
    rev: row.rev,
    updatedAt: row.updated_at,
    contentSha256: row.content_sha256,
    sizeBytes: row.size_bytes,
    tableCount: Number(countStatement.get(row.project_uid)?.count ?? 0),
  }))

  sendJson(res, 200, { projects })
}

export function handleListProjects(db, req, res) {
  handleStatus(db, req, res)
}

/** 软删除：保留数据与版本快照，便于误删恢复。 */
export function handleDeleteProject(db, req, res, projectUid) {
  const session = requireSession(db, req)
  assertTrustedRequest(req)
  assertProjectUid(projectUid)

  const row = db.prepare('SELECT * FROM projects WHERE project_uid = ?').get(projectUid)
  if (!row || row.owner_user_id !== session.user.id || row.deleted_at) {
    throw new HttpError(404, 'not_found', '项目不存在')
  }

  db.prepare('UPDATE projects SET deleted_at = ? WHERE project_uid = ?').run(Date.now(), projectUid)
  log.info('sync.project.deleted', { userId: session.user.id, projectUid })
  sendNoContent(res)
}

/** 列出某项目的历史版本（不含载荷）。 */
export function handleListVersions(db, req, res, url) {
  const session = requireSession(db, req)
  const projectUid = assertProjectUid(url.searchParams.get('uid') ?? '')

  const project = db.prepare('SELECT * FROM projects WHERE project_uid = ?').get(projectUid)
  if (!project || project.owner_user_id !== session.user.id) {
    throw new HttpError(404, 'not_found', '项目不存在')
  }

  const versions = db.prepare(
    `SELECT rev, reason, size_bytes, created_at FROM project_versions
      WHERE project_uid = ? ORDER BY created_at DESC, rev DESC`,
  ).all(projectUid).map(row => ({
    rev: row.rev,
    reason: row.reason,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
  }))

  sendJson(res, 200, { projectUid, versions })
}
