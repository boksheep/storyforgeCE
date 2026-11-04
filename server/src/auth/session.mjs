/**
 * 会话：不透明随机 ID + **只存哈希** + 滑动续期。
 *
 * 关键决定：
 *   - sid 是 32 字节随机（256 bit），不可猜测
 *   - 数据库只存 `sha256(sid)`：即使库被拖走也不能直接冒用会话
 *   - cookie 属性见 `http/cookies.mjs`（HttpOnly / Secure / SameSite=Lax / Path=/api）
 */
import crypto from 'node:crypto'
import { env } from '../env.mjs'

export const SESSION_COOKIE = 'sf_sid'

/** 会话 ID → 库内主键。 */
export function hashSessionId(sid) {
  return crypto.createHash('sha256').update(sid).digest('hex')
}

/** 用于 ua / ip 的不可逆短标识（不落明文）。 */
export function hashTag(value) {
  if (!value) return null
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)
}

export function createSession(db, userId, { ua, ip, ttlMs = env.sessionTtlMs } = {}) {
  const sid = crypto.randomBytes(32).toString('hex')
  const timestamp = Date.now()
  db.prepare(
    `INSERT INTO sessions (id_hash, user_id, created_at, last_seen_at, expires_at, ua_hash, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(hashSessionId(sid), userId, timestamp, timestamp, timestamp + ttlMs, hashTag(ua), hashTag(ip))
  return { sid, expiresAt: timestamp + ttlMs }
}

export function deleteSession(db, sid) {
  if (!sid) return
  db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hashSessionId(sid))
}

export function deleteAllSessionsForUser(db, userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId)
}

/** 清理过期会话（启动时与定时任务调用）。 */
export function pruneExpiredSessions(db) {
  const result = db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now())
  return Number(result.changes ?? 0)
}

/**
 * 查找会话并做滑动续期。
 *
 * @returns {{ user: { id: number, username: string, role: string }, expiresAt: number } | null}
 */
export function lookupSession(db, sid, ttlMs = env.sessionTtlMs) {
  if (!sid) return null

  const row = db.prepare(
    `SELECT s.id_hash, s.expires_at, s.last_seen_at,
            u.id AS user_id, u.username, u.role, u.disabled
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id_hash = ?`,
  ).get(hashSessionId(sid))

  if (!row) return null

  const timestamp = Date.now()
  if (row.expires_at <= timestamp || row.disabled) {
    db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(row.id_hash)
    return null
  }

  // 剩余不足一半有效期才续期，避免每个请求都写库。
  const remaining = row.expires_at - timestamp
  if (remaining < ttlMs / 2) {
    const expiresAt = timestamp + ttlMs
    db.prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id_hash = ?')
      .run(expiresAt, timestamp, row.id_hash)
    return { user: { id: row.user_id, username: row.username, role: row.role }, expiresAt }
  }

  if (timestamp - row.last_seen_at > 5 * 60_000) {
    db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id_hash = ?').run(timestamp, row.id_hash)
  }

  return {
    user: { id: row.user_id, username: row.username, role: row.role },
    expiresAt: row.expires_at,
  }
}
