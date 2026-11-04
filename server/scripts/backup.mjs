#!/usr/bin/env node
/**
 * 在线备份：`VACUUM INTO` 生成一致性快照 + 打包版本目录。
 *
 * 为什么不用 `cp`：WAL 模式下直接拷 `.db` 文件可能拷到"半提交"状态。
 * `VACUUM INTO` 是 SQLite 官方推荐的在线备份方式，产出的是一个已整理、
 * 可直接打开的单文件。
 *
 * 用法：
 *   node scripts/backup.mjs                # 备份到 <dataDir>/backups
 *   node scripts/backup.mjs --out /path    # 指定输出目录
 *   node scripts/backup.mjs --keep 14      # 只保留最近 14 份
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { env } from '../src/env.mjs'

function parseArgs(argv) {
  const args = { out: path.join(env.dataDir, 'backups'), keep: 14 }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') args.out = path.resolve(argv[++index])
    else if (argv[index] === '--keep') args.keep = Number.parseInt(argv[++index], 10)
  }
  return args
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  if (!fs.existsSync(env.dbFile)) {
    throw new Error(`数据库不存在：${env.dbFile}`)
  }

  fs.mkdirSync(args.out, { recursive: true })

  const stamp = timestamp()
  const target = path.join(args.out, `storyforge-cloud-${stamp}.db`)

  // 路径由本脚本生成（时间戳），仍做一次引号转义作为纵深防御。
  const escaped = target.replace(/'/g, "''")
  const db = new DatabaseSync(env.dbFile)
  db.exec(`VACUUM INTO '${escaped}'`)
  db.close()

  const bytes = fs.statSync(target).size
  const digest = sha256File(target)

  process.stdout.write(`[backup] ${target}\n`)
  process.stdout.write(`[backup] ${(bytes / 1024 / 1024).toFixed(1)} MiB, sha256=${digest}\n`)
  process.stdout.write(`[backup] 版本快照目录（请单独归档）：${env.versionsDir}\n`)

  // 轮转：只保留最近 N 份
  const files = fs.readdirSync(args.out)
    .filter(name => name.startsWith('storyforge-cloud-') && name.endsWith('.db'))
    .sort()
    .reverse()
  for (const name of files.slice(args.keep)) {
    fs.rmSync(path.join(args.out, name), { force: true })
    process.stdout.write(`[backup] removed old ${name}\n`)
  }
}

try {
  main()
} catch (error) {
  process.stderr.write(`[backup] ${error.message}\n`)
  process.exitCode = 1
}
