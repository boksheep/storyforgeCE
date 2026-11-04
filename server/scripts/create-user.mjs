#!/usr/bin/env node
/**
 * 管理员建号 / 改密 / 禁用 / 列号 / 批量导入。
 *
 * 私有化部署**关闭自助注册**，账号只从这里产生。
 *
 * ## 为什么不能直接手写一个"用户名:密码"的文本文件
 *
 * 数据库里存的是 **scrypt 哈希**（`$scrypt$N=32768,r=8,p=1$salt$hash`），
 * 不是明文。手写明文文件贴进 SQLite 只会得到一个永远登录不上的坏账号。
 *
 * 想"用文件代替手输密码"，正确做法是把**明文喂给这个脚本**，由它算哈希：
 *   - 单个账号：`--password-file <路径|->`
 *   - 批量账号：`--import <路径|->`（JSON）
 * 脚本读完不会保留任何明文，导出文件用完请自行删除。
 *
 * 用法：
 *   node scripts/create-user.mjs <用户名> [--role admin|author]
 *   node scripts/create-user.mjs <用户名> --password-stdin      # 从管道读密码（推荐）
 *   node scripts/create-user.mjs <用户名> --password-file <路径|->  # 从文件/标准输入读
 *   node scripts/create-user.mjs <用户名> --password <明文>      # 会留在 shell history 里
 *   node scripts/create-user.mjs <用户名> --reset-password
 *   node scripts/create-user.mjs <用户名> --disable
 *   node scripts/create-user.mjs <用户名> --enable
 *   node scripts/create-user.mjs --import <路径|-> [--update-existing]
 *   node scripts/create-user.mjs --list
 */
import fs from 'node:fs'
import readline from 'node:readline'
import { openDatabase } from '../src/db.mjs'
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password.mjs'
import { deleteAllSessionsForUser } from '../src/auth/session.mjs'

/** 用户名规则：与登录侧的 `MAX_USERNAME_LENGTH` 对齐。 */
const USERNAME_PATTERN = /^[A-Za-z0-9_.@-]{2,64}$/

function usage() {
  process.stdout.write(`StoryForge 账号管理

用法：
  node scripts/create-user.mjs <用户名> [--role admin|author]
  node scripts/create-user.mjs <用户名> --password-stdin      从管道读密码（推荐）
  node scripts/create-user.mjs <用户名> --password-file <路径|->  从文件或标准输入读密码
  node scripts/create-user.mjs <用户名> --password <明文>      会留在 shell history 里
  node scripts/create-user.mjs <用户名> --reset-password      重置密码并踢掉所有会话
  node scripts/create-user.mjs <用户名> --disable             禁用（并踢掉所有会话）
  node scripts/create-user.mjs <用户名> --enable
  node scripts/create-user.mjs --import <路径|-> [--update-existing]
  node scripts/create-user.mjs --list

批量导入文件格式（JSON，数组或 { "users": [...] }）：
  [
    { "username": "admin", "password": "至少12位的密码", "role": "admin" },
    { "username": "alice", "password": "另一个至少12位的密码" }
  ]

密码要求：至少 ${MIN_PASSWORD_LENGTH} 个字符。
用户名要求：2-64 位，只允许字母、数字与 _ . @ -
`)
}

function parseArgs(argv) {
  const args = {
    username: null,
    role: 'author',
    password: null,
    passwordStdin: false,
    passwordFile: null,
    importFile: null,
    updateExisting: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--list') args.list = true
    else if (arg === '--role') args.role = argv[++index]
    else if (arg === '--password') args.password = argv[++index]
    else if (arg === '--password-stdin') args.passwordStdin = true
    else if (arg === '--password-file') args.passwordFile = argv[++index]
    else if (arg === '--import') args.importFile = argv[++index]
    else if (arg === '--update-existing') args.updateExisting = true
    else if (arg === '--reset-password') args.resetPassword = true
    else if (arg === '--disable') args.disable = true
    else if (arg === '--enable') args.enable = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (!arg.startsWith('-')) args.username = arg
  }
  return args
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    const onData = (char) => {
      // 简单遮罩：不把输入回显到终端
      if (char.toString() !== '\n' && char.toString() !== '\r') {
        readline.moveCursor(process.stdout, -1, 0)
        readline.clearLine(process.stdout, 1)
      }
    }
    process.stdin.on('data', onData)
    rl.question(question, (answer) => {
      process.stdin.off('data', onData)
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

/** 从文件或标准输入读一段文本（`-` 表示标准输入）。 */
async function readTextSource(source) {
  if (source === '-') return readStdin()
  return fs.readFileSync(source, 'utf8')
}

async function readPassword(args) {
  if (args.passwordStdin) {
    return (await readStdin()).replace(/\r?\n$/, '')
  }
  if (args.passwordFile) {
    // 只取第一行：允许文件里带注释行或后续说明，避免把整段文本当密码。
    const raw = await readTextSource(args.passwordFile)
    return raw.split(/\r?\n/)[0] ?? ''
  }
  if (args.password) return args.password

  const first = await askHidden(`设置密码（至少 ${MIN_PASSWORD_LENGTH} 位）：`)
  const second = await askHidden('再输入一次：')
  if (first !== second) throw new Error('两次输入不一致')
  return first
}

/**
 * 批量导入。
 *
 * 两阶段：**先全量校验，再统一写入**。否则一个拼错的行会让前面几行已经落库，
 * 用户面对"一半成功"的状态很难收拾。
 */
async function importUsers(db, args) {
  const raw = await readTextSource(args.importFile)
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('导入文件不是合法 JSON')
  }

  const list = Array.isArray(parsed) ? parsed : parsed?.users
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('导入文件里没有账号：应为数组，或 { "users": [...] }')
  }

  // ── 阶段一：全量校验 ──
  const problems = []
  const entries = list.map((item, index) => {
    const line = `第 ${index + 1} 条`
    const username = typeof item?.username === 'string' ? item.username.trim() : ''
    const password = typeof item?.password === 'string' ? item.password : ''
    const role = item?.role === 'admin' ? 'admin' : 'author'

    if (!USERNAME_PATTERN.test(username)) problems.push(`${line}：用户名不合法（${username || '空'}）`)
    if (password.length < MIN_PASSWORD_LENGTH) {
      problems.push(`${line}：密码不足 ${MIN_PASSWORD_LENGTH} 位（${username || '空'}）`)
    }
    return { username, password, role }
  })

  const seen = new Set()
  for (const entry of entries) {
    const key = entry.username.toLowerCase()
    if (seen.has(key)) problems.push(`用户名重复：${entry.username}`)
    seen.add(key)
  }

  if (problems.length > 0) {
    throw new Error(`导入文件有 ${problems.length} 处问题，未写入任何账号：\n  - ${problems.join('\n  - ')}`)
  }

  // ── 阶段二：先算完全部哈希（异步），再开同步事务写入 ──
  // 顺序很重要：scrypt 是 await，如果在事务里 await，其它请求的写入会
  // 掉进同一个事务里，一起提交或一起回滚。所以哈希必须在事务外算完。
  const hashed = []
  for (const entry of entries) {
    hashed.push({ ...entry, hash: await hashPassword(entry.password) })
  }

  const timestamp = Date.now()
  const selectStmt = db.prepare('SELECT id FROM users WHERE username = ?')
  const insertStmt = db.prepare(
    `INSERT INTO users (username, password_hash, role, disabled, created_at, password_changed_at)
     VALUES (?, ?, ?, 0, ?, ?)`,
  )
  const updateStmt = db.prepare(
    'UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?',
  )

  const created = []
  const updated = []
  const skipped = []

  db.exec('BEGIN IMMEDIATE')
  try {
    for (const entry of hashed) {
      const existing = selectStmt.get(entry.username)
      if (existing) {
        if (!args.updateExisting) {
          skipped.push(entry.username)
          continue
        }
        updateStmt.run(entry.hash, timestamp, existing.id)
        deleteAllSessionsForUser(db, existing.id)
        updated.push(entry.username)
        continue
      }
      insertStmt.run(entry.username, entry.hash, entry.role, timestamp, timestamp)
      created.push(entry.username)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  process.stdout.write(
    `导入完成：新建 ${created.length} 个，重置 ${updated.length} 个，跳过 ${skipped.length} 个\n`,
  )
  if (created.length) process.stdout.write(`  新建：${created.join(', ')}\n`)
  if (updated.length) process.stdout.write(`  重置：${updated.join(', ')}\n`)
  if (skipped.length) {
    process.stdout.write(
      `  跳过（已存在）：${skipped.join(', ')} —— 需要覆盖密码请加 --update-existing\n`,
    )
  }
  process.stdout.write('提示：明文密码文件用完请删除，服务端不会保留它。\n')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) return usage()

  const db = openDatabase()

  if (args.list) {
    const rows = db.prepare(
      'SELECT id, username, role, disabled, created_at FROM users ORDER BY id',
    ).all()
    if (rows.length === 0) {
      process.stdout.write('（还没有任何账号）\n')
    } else {
      for (const row of rows) {
        process.stdout.write(
          `#${row.id}\t${row.username}\t${row.role}\t${row.disabled ? 'disabled' : 'active'}\t`
          + `${new Date(row.created_at).toISOString()}\n`,
        )
      }
    }
    db.close()
    return
  }

  if (args.importFile) {
    await importUsers(db, args)
    db.close()
    return
  }

  if (!args.username) {
    usage()
    process.exitCode = 1
    db.close()
    return
  }

  const username = String(args.username).trim()
  if (!USERNAME_PATTERN.test(username)) {
    throw new Error('用户名只能包含字母、数字与 _ . @ -，长度 2-64')
  }

  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username)

  if (args.disable || args.enable) {
    if (!existing) throw new Error(`账号不存在：${username}`)
    db.prepare('UPDATE users SET disabled = ? WHERE id = ?').run(args.disable ? 1 : 0, existing.id)
    if (args.disable) deleteAllSessionsForUser(db, existing.id)
    process.stdout.write(`${args.disable ? '已禁用' : '已启用'}：${username}\n`)
    db.close()
    return
  }

  if (existing && !args.resetPassword) {
    throw new Error(`账号已存在：${username}（改密请加 --reset-password）`)
  }

  const password = await readPassword(args)
  const passwordHash = await hashPassword(password)
  const timestamp = Date.now()

  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?')
      .run(passwordHash, timestamp, existing.id)
    // 改密必须让旧会话全部失效
    deleteAllSessionsForUser(db, existing.id)
    process.stdout.write(`已重置密码：${username}（该账号所有会话已失效）\n`)
  } else {
    const role = args.role === 'admin' ? 'admin' : 'author'
    db.prepare(
      `INSERT INTO users (username, password_hash, role, disabled, created_at, password_changed_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    ).run(username, passwordHash, role, timestamp, timestamp)
    process.stdout.write(`已创建账号：${username}（role=${role}）\n`)
  }

  db.close()
}

main().catch((error) => {
  process.stderr.write(`[create-user] ${error.message}\n`)
  process.exitCode = 1
})
