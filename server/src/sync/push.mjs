/**
 * Push：把一份整包 `ProjectExportData` 写入服务端。
 *
 * ## 事务语义（`BEGIN IMMEDIATE`）
 *
 * 1. owner 校验（不匹配一律 **404**，不是 403 —— 避免泄露"该 uid 存在"）
 * 2. `opId` 幂等查重 → 已应用则返回当时的 `rev`（**200，不是 409**）
 * 3. `rev === baseRev`，否则 409 + 远端摘要
 * 4. 逐表算规范化哈希，与 `project_tables.sha256` 相同即跳过写
 * 5. `rev+1`、更新 `projects`、写 `project_tables`、写 `sync_log`
 * 6. 提交后（事务外）写版本快照文件
 *
 * 第 2 步是必须的：推送成功但响应丢失时，客户端会用**同一个** `opId` 重试；
 * 若此时重新生成 `opId`，服务端会因 `baseRev` 过期返回 409，用户看到"冲突"
 * 并可能误选"覆盖云端"，造成无谓的数据替换。
 */
import { immediate } from '../db.mjs'
import { env } from '../env.mjs'
import { HttpError, sendJson } from '../http/respond.mjs'
import { readJsonBody } from '../http/body.mjs'
import { log } from '../log.mjs'
import { assertTrustedRequest, requireSession } from '../auth/routes.mjs'
import { contentSha256, sha256Hex, stableStringify, tableSha256 } from './content-hash.mjs'
import { assembleExport, pruneVersions, summarizeProject, writeVersionFile } from './store.mjs'
import { validatePushEnvelope } from './validate.mjs'

function loadOwnedProject(db, projectUid, userId) {
  const row = db.prepare('SELECT * FROM projects WHERE project_uid = ?').get(projectUid)
  if (!row) return null
  if (row.owner_user_id !== userId || row.deleted_at) {
    // 不区分"不存在"与"不是你的"，统一 404
    throw new HttpError(404, 'not_found', '项目不存在')
  }
  return row
}

/**
 * 应用一次推送。
 *
 * @returns {{ status: number, body: object }}
 */
export function applyPush(db, input) {
  const { userId, opId, projectUid, baseRev, exportData, tables, name, exportVersion } = input
  const force = input.force === true

  const outcome = immediate(db, () => {
    const existing = loadOwnedProject(db, projectUid, userId)

    // ── 幂等：同一个 opId 已应用过 ──
    const applied = db.prepare('SELECT project_uid, rev FROM sync_log WHERE op_id = ?').get(opId)
    if (applied) {
      if (applied.project_uid !== projectUid) {
        throw new HttpError(409, 'op_id_reused', 'opId 已被其它项目使用')
      }
      return {
        status: 200,
        body: {
          ok: true,
          projectUid,
          rev: applied.rev,
          idempotent: true,
          changedTables: [],
        },
        skipVersion: true,
      }
    }

    // ── 并发：乐观锁 ──
    if (!force) {
      if (!existing && baseRev !== 0) {
        throw new HttpError(409, 'conflict', '远端不存在该项目，请以 baseRev=0 创建', { remote: null })
      }
      if (existing && existing.rev !== baseRev) {
        throw new HttpError(409, 'conflict', '远端已有更新', { remote: summarizeProject(existing) })
      }
    }

    const nextRev = (existing?.rev ?? 0) + 1
    const timestamp = Date.now()

    // ── 第一遍：只算哈希，判断哪些表真的变了（不写库） ──
    // 必须先算再写：`project_tables` 对 `projects` 有外键，
    // 首次推送时 projects 行还不存在，先写表会触发 FOREIGN KEY 失败。
    const selectTable = db.prepare(
      'SELECT sha256 FROM project_tables WHERE project_uid = ? AND table_name = ?',
    )
    const pendingWrites = []
    const changedTables = []
    for (const [tableName, rows] of tables) {
      const sha = tableSha256(rows)
      const previous = selectTable.get(projectUid, tableName)
      if (previous && previous.sha256 === sha) continue
      pendingWrites.push({ tableName, sha, rowCount: rows.length, payload: JSON.stringify(rows) })
      changedTables.push(tableName)
    }

    const contentHash = contentSha256(exportData)
    const sizeBytes = Buffer.byteLength(stableStringify(exportData), 'utf8')

    // ── 内容未变：不推进 rev、不产生版本快照 ──
    // 每日对账会推送"看起来脏但实际没变"的项目，这条分支让它是零成本的。
    if (existing && changedTables.length === 0 && existing.content_sha256 === contentHash) {
      db.prepare(
        'INSERT INTO sync_log (op_id, project_uid, rev, applied_at) VALUES (?, ?, ?, ?)',
      ).run(opId, projectUid, existing.rev, timestamp)
      return {
        status: 200,
        body: {
          ok: true,
          projectUid,
          rev: existing.rev,
          contentSha256: contentHash,
          sizeBytes: existing.size_bytes,
          changedTables: [],
          unchanged: true,
        },
        skipVersion: true,
      }
    }

    // ── 第二遍：先确保父行存在，再写表 ──
    if (existing) {
      db.prepare(
        `UPDATE projects SET name = ?, rev = ?, export_version = ?, content_sha256 = ?,
                size_bytes = ?, updated_at = ? WHERE project_uid = ?`,
      ).run(name, nextRev, exportVersion, contentHash, sizeBytes, timestamp, projectUid)
    } else {
      db.prepare(
        `INSERT INTO projects (project_uid, owner_user_id, name, rev, export_version,
                content_sha256, size_bytes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(projectUid, userId, name, nextRev, exportVersion, contentHash, sizeBytes, timestamp, timestamp)
    }

    const upsertTable = db.prepare(
      `INSERT INTO project_tables (project_uid, table_name, rev, sha256, row_count, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_uid, table_name) DO UPDATE SET
         rev = excluded.rev,
         sha256 = excluded.sha256,
         row_count = excluded.row_count,
         payload_json = excluded.payload_json`,
    )
    for (const write of pendingWrites) {
      upsertTable.run(projectUid, write.tableName, nextRev, write.sha, write.rowCount, write.payload)
    }

    db.prepare(
      'INSERT INTO sync_log (op_id, project_uid, rev, applied_at) VALUES (?, ?, ?, ?)',
    ).run(opId, projectUid, nextRev, timestamp)

    const payloadPath = `${projectUid}/${nextRev}-push.json.gz`
    db.prepare(
      `INSERT OR REPLACE INTO project_versions
        (project_uid, rev, content_sha256, size_bytes, reason, payload_path, created_at)
       VALUES (?, ?, ?, ?, 'push', ?, ?)`,
    ).run(projectUid, nextRev, contentHash, sizeBytes, payloadPath, timestamp)

    return {
      status: existing ? 200 : 201,
      body: {
        ok: true,
        projectUid,
        rev: nextRev,
        contentSha256: contentHash,
        sizeBytes,
        changedTables,
        created: !existing,
      },
      version: { rev: nextRev, reason: 'push', exportData },
    }
  })

  // ── 事务外写快照：失败不影响已提交的数据，只让该历史版本不可下载 ──
  if (!outcome.skipVersion && outcome.version) {
    const { rev, reason, exportData: snapshot } = outcome.version
    try {
      writeVersionFile(projectUid, rev, reason, snapshot)
      pruneVersions(db, projectUid)
    } catch (error) {
      log.error('sync.version.write_failed', { projectUid, rev, reason })
      db.prepare(
        'DELETE FROM project_versions WHERE project_uid = ? AND rev = ? AND reason = ?',
      ).run(projectUid, rev, reason)
    }
  }

  return { status: outcome.status, body: outcome.body }
}

export async function handlePush(db, req, res) {
  const session = requireSession(db, req)
  assertTrustedRequest(req)

  const body = await readJsonBody(req)
  const envelope = validatePushEnvelope(body)

  const result = applyPush(db, { userId: session.user.id, ...envelope })

  log.info('sync.push.ok', {
    userId: session.user.id,
    projectUid: envelope.projectUid,
    rev: result.body.rev,
    changed: result.body.changedTables?.length ?? 0,
    sizeBytes: result.body.sizeBytes,
    idempotent: result.body.idempotent === true,
  })

  sendJson(res, result.status, result.body)
}

/**
 * 强制覆盖云端。
 *
 * 与普通 push 的唯一差别：忽略 `baseRev`，并在覆盖前**先给当前状态留一份
 * `pre-force` 快照**。因此"覆盖"永远不等于"丢数据"。
 */
export async function handleForce(db, req, res) {
  const session = requireSession(db, req)
  assertTrustedRequest(req)

  const body = await readJsonBody(req)
  const envelope = validatePushEnvelope(body)

  const current = db.prepare('SELECT * FROM projects WHERE project_uid = ?').get(envelope.projectUid)
  if (current && current.owner_user_id === session.user.id && !current.deleted_at) {
    try {
      const snapshot = assembleExport(db, current)
      writeVersionFile(envelope.projectUid, current.rev, 'pre-force', snapshot)
      db.prepare(
        `INSERT OR REPLACE INTO project_versions
          (project_uid, rev, content_sha256, size_bytes, reason, payload_path, created_at)
         VALUES (?, ?, ?, ?, 'pre-force', ?, ?)`,
      ).run(
        envelope.projectUid,
        current.rev,
        sha256Hex(stableStringify(snapshot)),
        current.size_bytes ?? 0,
        `${envelope.projectUid}/${current.rev}-pre-force.json.gz`,
        Date.now(),
      )
      pruneVersions(db, envelope.projectUid, env.versionKeep + 1)
    } catch {
      log.error('sync.force.snapshot_failed', { projectUid: envelope.projectUid })
      throw new HttpError(500, 'snapshot_failed', '无法为当前云端版本创建快照，已中止覆盖')
    }
  }

  const result = applyPush(db, { userId: session.user.id, ...envelope, force: true })
  log.warn('sync.force.ok', {
    userId: session.user.id,
    projectUid: envelope.projectUid,
    rev: result.body.rev,
  })
  sendJson(res, result.status, result.body)
}
