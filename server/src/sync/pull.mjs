/**
 * Pull：把服务端状态还原成 `ProjectExportData` 交给客户端。
 *
 * 支持 `rev` 参数取历史版本（来自 `project_versions` 快照），
 * 这是"覆盖云端"之后唯一的回滚手段，所以必须真的可用。
 */
import { HttpError, sendJson } from '../http/respond.mjs'
import { log } from '../log.mjs'
import { requireSession } from '../auth/routes.mjs'
import { assertProjectUid } from './validate.mjs'
import { assembleExport, readVersion } from './store.mjs'

export function handlePull(db, req, res, url) {
  const session = requireSession(db, req)
  const projectUid = assertProjectUid(url.searchParams.get('uid') ?? '')

  const project = db.prepare('SELECT * FROM projects WHERE project_uid = ?').get(projectUid)
  if (!project || project.owner_user_id !== session.user.id || project.deleted_at) {
    throw new HttpError(404, 'not_found', '项目不存在')
  }

  const requestedRev = url.searchParams.get('rev')
  if (requestedRev != null) {
    const rev = Number.parseInt(requestedRev, 10)
    if (!Number.isInteger(rev) || rev < 1) {
      throw new HttpError(400, 'bad_rev', 'rev 必须是正整数')
    }
    const snapshot = readVersion(db, projectUid, rev)
    if (!snapshot) throw new HttpError(404, 'version_not_found', `云端没有 rev=${rev} 的快照`)
    log.info('sync.pull.version', { userId: session.user.id, projectUid, rev })
    sendJson(res, 200, { projectUid, rev, historical: true, export: snapshot })
    return
  }

  // 客户端已是最新 → 304，省一次大传输
  const sinceRev = Number.parseInt(url.searchParams.get('sinceRev') ?? '', 10)
  if (Number.isInteger(sinceRev) && sinceRev === project.rev) {
    res.writeHead(304, { 'cache-control': 'no-store' })
    res.end()
    return
  }

  const exportData = assembleExport(db, project)
  const tables = db.prepare(
    'SELECT table_name, sha256, row_count FROM project_tables WHERE project_uid = ?',
  ).all(projectUid).map(row => ({
    name: row.table_name,
    sha256: row.sha256,
    rowCount: row.row_count,
  }))

  log.info('sync.pull.ok', { userId: session.user.id, projectUid, rev: project.rev })

  sendJson(res, 200, {
    projectUid,
    rev: project.rev,
    name: project.name,
    updatedAt: project.updated_at,
    contentSha256: project.content_sha256,
    sizeBytes: project.size_bytes,
    tables,
    export: exportData,
  })
}
