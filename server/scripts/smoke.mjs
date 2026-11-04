#!/usr/bin/env node
/**
 * 部署自检：对着**真实运行的服务**跑一遍"登录 → 推送 → 拉取 → 删除"。
 *
 * 用途：`docker compose up` 之后确认整条链路真的通，而不是只看 `/api/health`。
 * 会创建一个名为 `__smoke__` 的临时项目并在结束时软删除，不碰任何真实数据。
 *
 * 用法：
 *   node scripts/smoke.mjs --base https://sf.example.com --username author
 *   node scripts/smoke.mjs --base http://127.0.0.1:8787 --username author --password-stdin
 */
import readline from 'node:readline'
import crypto from 'node:crypto'
import { SYNC_TABLES } from '../src/generated/table-manifest.mjs'

function parseArgs(argv) {
  const args = { base: 'http://127.0.0.1:8787', username: null, password: null, passwordStdin: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--base') args.base = argv[++index]
    else if (arg === '--username') args.username = argv[++index]
    else if (arg === '--password') args.password = argv[++index]
    else if (arg === '--password-stdin') args.passwordStdin = true
  }
  return args
}

function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

async function readPassword(args) {
  if (args.passwordStdin) {
    const chunks = []
    for await (const chunk of process.stdin) chunks.push(chunk)
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')
  }
  if (args.password) return args.password
  return askHidden('密码：')
}

function buildExport(name) {
  const data = {
    version: 3,
    exportedAt: Date.now(),
    project: {
      name,
      genre: 'fantasy',
      genres: [],
      status: 'writing',
      description: 'smoke test',
      targetWordCount: 0,
    },
  }
  for (const tableName of SYNC_TABLES) {
    if (tableName !== 'projects') data[tableName] = []
  }
  return data
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (!args.username) {
    process.stderr.write('缺少 --username\n')
    process.exitCode = 1
    return
  }

  const base = args.base.replace(/\/+$/, '')
  const password = await readPassword(args)
  const headers = { 'content-type': 'application/json', 'x-sf-client': 'storyforge', origin: base }

  const step = (label) => process.stdout.write(`  ✓ ${label}\n`)

  process.stdout.write(`[smoke] 目标 ${base}\n`)

  // 1. 配置探测
  const config = await fetch(`${base}/api/config`, { headers })
  assert(config.ok, `/api/config 返回 ${config.status}`)
  const configBody = await config.json()
  assert(configBody.app === 'storyforge' && configBody.cloud === true, '/api/config 内容不符')
  step(`服务在线（协议 v${configBody.protocol}，${configBody.syncTableCount} 张同步表）`)

  // 2. 登录
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: args.username, password }),
  })
  // 注意：失败信息里的 `await res.text()` 必须放在 if 分支里。
  // 写成 assert(cond, `${await res.text()}`) 会在**条件为真时也消费响应体**，
  // 导致后续 res.json() 抛 "Body is unusable"。
  if (login.status !== 204) {
    throw new Error(`登录失败：${login.status} ${await login.text()}`)
  }
  const setCookie = login.headers.getSetCookie?.() ?? []
  const cookie = setCookie.map(item => item.split(';')[0]).join('; ')
  assert(cookie, '登录成功但没有下发 cookie（检查是否 HTTPS / SF_ALLOW_INSECURE）')
  step('登录成功，已拿到会话 cookie')

  const authHeaders = { ...headers, cookie }

  // 3. 推送
  const projectUid = crypto.randomUUID()
  const exportData = buildExport(`__smoke__ ${new Date().toISOString()}`)
  const push = await fetch(`${base}/api/sync/push`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      protocol: 1,
      opId: crypto.randomUUID(),
      projectUid,
      baseRev: 0,
      clientId: 'smoke',
      export: exportData,
    }),
  })
  if (!push.ok) {
    throw new Error(`推送失败：${push.status} ${await push.text()}`)
  }
  const pushed = await push.json()
  assert(pushed.rev === 1, `首次推送 rev 应为 1，实际 ${pushed.rev}`)
  step(`推送成功（rev=${pushed.rev}，${pushed.changedTables.length} 张表）`)

  // 4. 拉取并比对
  const pull = await fetch(`${base}/api/sync/pull?uid=${projectUid}`, { headers: authHeaders })
  assert(pull.ok, `拉取失败：${pull.status}`)
  const pulled = await pull.json()
  const expected = { ...exportData }
  const actual = { ...pulled.export }
  delete expected.exportedAt
  delete actual.exportedAt
  assert(JSON.stringify(expected) === JSON.stringify(actual), '往返内容不一致')
  step('拉取内容与推送内容逐字段一致')

  // 5. 清理
  const remove = await fetch(`${base}/api/projects/${projectUid}`, {
    method: 'DELETE',
    headers: authHeaders,
  })
  assert(remove.status === 204, `清理失败：${remove.status}`)
  step('临时项目已软删除')

  process.stdout.write('[smoke] 全部通过\n')
}

main().catch((error) => {
  process.stderr.write(`[smoke] 失败：${error.message}\n`)
  process.exitCode = 1
})
