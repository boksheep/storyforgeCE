/**
 * SQLite 访问层。
 *
 * 用 Node 内置 `node:sqlite`（Node ≥ 22.5），因此服务端**零运行时依赖**：
 * 部署时不需要 `npm install`，没有 native 编译、没有供应链审计噪声。
 *
 * 事务一律用 `BEGIN IMMEDIATE`（见 `immediate()`）：
 * deferred 事务在"读后升级为写锁"时会抛 `SQLITE_BUSY`，
 * 而我们的 push 都是"先读 rev 再写"，正好命中该场景。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { env } from './env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEMA_SQL = fs.readFileSync(path.join(HERE, 'schema.sql'), 'utf8')

/** 打开（并按需初始化）数据库。 */
export function openDatabase(file = env.dbFile) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new DatabaseSync(file)

  // WAL：读写不互相阻塞。没有它，`backup.mjs` / `create-user.mjs` 这类
  // 外部进程与服务端同时访问时很容易撞上 `SQLITE_BUSY`。
  // 注意：WAL 是**写进库文件**的持久设置，对已有库只需执行一次即生效。
  db.exec('PRAGMA journal_mode = WAL')
  // 真的撞上写锁时等 5 秒再报错，而不是立刻失败。
  db.exec('PRAGMA busy_timeout = 5000')
  // WAL 下 NORMAL 已足够安全（崩溃不会损坏库，最多丢最后一个事务）。
  db.exec('PRAGMA synchronous = NORMAL')

  db.exec(SCHEMA_SQL)
  return db
}

/**
 * 立即写事务。`fn` **必须是同步函数**（node:sqlite 是同步 API）。
 *
 * 任何抛错都会回滚，因此调用方可以放心在事务里做校验并直接 throw。
 */
export function immediate(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const result = fn()
    db.exec('COMMIT')
    return result
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // 事务可能已因错误自动回滚
    }
    throw error
  }
}

export const now = () => Date.now()
