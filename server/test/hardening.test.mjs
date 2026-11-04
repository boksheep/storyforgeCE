/**
 * 认证加固回归：防轰炸（限流双层 + 内存上限）、注入、CSRF、建号文件输入。
 *
 * 这些用例的共同点：**每条都能真的失败**。限流表不设上限、SQL 拼接、
 * 用户名不校验长度，任何一条漏掉都会在真实部署里变成可被利用的入口。
 */
import './setup.mjs'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { env } from '../src/env.mjs'
import {
  __loginTrackSizesForTest,
  __resetLoginAttemptsForTest,
} from '../src/auth/routes.mjs'
import { createUser, login, request, startTestServer, TEST_PASSWORD } from './helpers.mjs'

/** 用 fileURLToPath 而不是 `.pathname`：Windows 下后者会得到 `/C:/...`。 */
const CREATE_USER_SCRIPT = fileURLToPath(new URL('../scripts/create-user.mjs', import.meta.url))

/** 临时改写一个 env 值，返回恢复函数。 */
function withEnv(patch) {
  const backup = {}
  for (const key of Object.keys(patch)) backup[key] = env[key]
  Object.assign(env, patch)
  return () => Object.assign(env, backup)
}

/** 跑一次建号脚本（子进程），继承测试环境的 SF_* 变量。 */
function runCreateUser(args, options = {}) {
  return spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', CREATE_USER_SCRIPT, ...args], {
    env: { ...process.env },
    input: options.input,
    encoding: 'utf8',
  })
}

function userCount(db) {
  return db.prepare('SELECT COUNT(*) AS c FROM users').get().c
}

describe('防轰炸：限流双层', () => {
  let ctx
  before(async () => {
    ctx = await startTestServer()
  })
  after(async () => {
    await ctx.close()
  })

  it('换用户名也逃不掉：同一 IP 的全局失败上限会拦下密码喷洒', async () => {
    __resetLoginAttemptsForTest()
    const restore = withEnv({ loginIpMaxAttempts: 6 })
    try {
      // 每个用户名只试一次 —— 单账号限流完全不会触发
      for (let index = 0; index < 6; index += 1) {
        const { response } = await login(ctx.baseUrl, `spray-target-${index}`, 'one-shot-wrong-pass')
        assert.equal(response.status, 401, `第 ${index + 1} 次应为 401`)
      }

      const blocked = await login(ctx.baseUrl, 'spray-target-final', 'one-shot-wrong-pass')
      assert.equal(blocked.response.status, 429)
      assert.equal(blocked.response.json.error.code, 'ip_rate_limited')
      assert.ok(blocked.response.headers['retry-after'])
    } finally {
      restore()
    }
  })

  it('限流表有硬上限：海量随机用户名不会把它撑爆', async () => {
    __resetLoginAttemptsForTest()
    const restore = withEnv({ loginTrackMax: 5, loginIpMaxAttempts: 1000 })
    try {
      for (let index = 0; index < 12; index += 1) {
        await login(ctx.baseUrl, `flood-${index}-${Math.random().toString(36).slice(2, 8)}`, 'wrong-pass-value')
      }
      const sizes = __loginTrackSizesForTest()
      assert.ok(sizes.byUser <= 5, `按用户表应被压到 5 以内，实际 ${sizes.byUser}`)
      assert.ok(sizes.byIp <= 5, `按 IP 表应被压到 5 以内，实际 ${sizes.byIp}`)
    } finally {
      restore()
    }
  })

  it('超长用户名 → 401（不是 500，也不成为巨型限流键）', async () => {
    __resetLoginAttemptsForTest()
    const huge = 'a'.repeat(2000)
    const { response } = await login(ctx.baseUrl, huge, 'whatever-password')
    assert.equal(response.status, 401)
    assert.equal(response.json.error.code, 'unauthorized')
    assert.ok(__loginTrackSizesForTest().byUser <= 2)
  })
})

describe('注入', () => {
  let ctx
  before(async () => {
    ctx = await startTestServer()
  })
  after(async () => {
    await ctx.close()
  })

  it('用户名里的 SQL 注入串被当作普通字符串', async () => {
    __resetLoginAttemptsForTest()
    await createUser(ctx.db, 'inject-probe')
    const before = userCount(ctx.db)

    for (const payload of [
      "admin' OR '1'='1",
      "'; DROP TABLE users; --",
      'inject-probe\' --',
      'admin" OR "1"="1',
    ]) {
      const { response } = await login(ctx.baseUrl, payload, TEST_PASSWORD)
      assert.equal(response.status, 401, `载荷应被拒绝：${payload}`)
    }

    // users 表还在，行数没变
    assert.equal(userCount(ctx.db), before)
    // 真正的账号仍然只能用正确密码登录
    const ok = await login(ctx.baseUrl, 'inject-probe', TEST_PASSWORD)
    assert.equal(ok.response.status, 204)
  })

  it('密码里的注入串不会绕过校验', async () => {
    __resetLoginAttemptsForTest()
    await createUser(ctx.db, 'inject-pass')
    for (const payload of ["' OR 1=1 --", '"; DROP TABLE users; --', "x' OR 'x'='x"]) {
      const { response } = await login(ctx.baseUrl, 'inject-pass', payload)
      assert.equal(response.status, 401)
    }
    assert.ok(userCount(ctx.db) > 0)
  })
})

describe('CSRF：配了 SF_PUBLIC_ORIGIN 后不认 Host 推导', () => {
  let ctx
  before(async () => {
    ctx = await startTestServer()
  })
  after(async () => {
    await ctx.close()
  })

  it('伪造 Host 让 Origin 与自己自洽 → 仍然 403', async () => {
    const restore = withEnv({ publicOrigin: 'https://sfce.example.com' })
    try {
      const response = await request(ctx.baseUrl, 'POST', '/api/auth/login', {
        body: { username: 'anyone', password: 'any-password-value' },
        // 攻击者把 Host 也改成自己的域名，想让 Origin 校验"自洽"
        headers: { origin: 'https://evil.example', host: 'evil.example' },
      })
      assert.equal(response.status, 403)
      assert.equal(response.json.error.code, 'csrf')
    } finally {
      restore()
    }
  })

  it('配了 SF_PUBLIC_ORIGIN 后，正确来源仍然放行', async () => {
    const restore = withEnv({ publicOrigin: ctx.baseUrl })
    try {
      const response = await request(ctx.baseUrl, 'POST', '/api/auth/login', {
        body: { username: 'nobody-here', password: 'any-password-value' },
      })
      // 401 说明 CSRF 已通过（走到密码校验）
      assert.equal(response.status, 401)
    } finally {
      restore()
    }
  })
})

describe('建号：文件输入', () => {
  let ctx
  let tempDir

  before(async () => {
    ctx = await startTestServer()
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-create-user-'))
  })
  after(async () => {
    await ctx.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('--password-file 建号后能直接登录', async () => {
    __resetLoginAttemptsForTest()
    const password = 'file-based-password-1'
    const file = path.join(tempDir, 'pw.txt')
    fs.writeFileSync(file, `${password}\n第二行应被忽略\n`, 'utf8')

    const result = runCreateUser(['fileuser', '--password-file', file])
    assert.equal(result.status, 0, result.stderr)

    const { response } = await login(ctx.baseUrl, 'fileuser', password)
    assert.equal(response.status, 204)
  })

  it('--password-file - 从标准输入读（管道场景）', async () => {
    __resetLoginAttemptsForTest()
    const password = 'stdin-based-password-2'
    const result = runCreateUser(['stdinuser', '--password-file', '-'], { input: `${password}\n` })
    assert.equal(result.status, 0, result.stderr)

    const { response } = await login(ctx.baseUrl, 'stdinuser', password)
    assert.equal(response.status, 204)
  })

  it('--import 批量建号，两个账号都能登录', async () => {
    __resetLoginAttemptsForTest()
    const file = path.join(tempDir, 'users.json')
    fs.writeFileSync(file, JSON.stringify([
      { username: 'bulk-admin', password: 'bulk-admin-password', role: 'admin' },
      { username: 'bulk-author', password: 'bulk-author-password' },
    ]), 'utf8')

    const result = runCreateUser(['--import', file])
    assert.equal(result.status, 0, result.stderr)

    assert.equal((await login(ctx.baseUrl, 'bulk-admin', 'bulk-admin-password')).response.status, 204)
    assert.equal((await login(ctx.baseUrl, 'bulk-author', 'bulk-author-password')).response.status, 204)
  })

  it('--import 遇到已存在账号默认跳过，密码不变', async () => {
    __resetLoginAttemptsForTest()
    const file = path.join(tempDir, 'again.json')
    fs.writeFileSync(file, JSON.stringify([
      { username: 'bulk-admin', password: 'a-completely-different-pass' },
    ]), 'utf8')

    const result = runCreateUser(['--import', file])
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /跳过 1 个/)

    // 旧密码仍有效，新密码无效
    assert.equal((await login(ctx.baseUrl, 'bulk-admin', 'bulk-admin-password')).response.status, 204)
  })

  it('--import --update-existing 才覆盖密码', async () => {
    __resetLoginAttemptsForTest()
    const file = path.join(tempDir, 'force.json')
    fs.writeFileSync(file, JSON.stringify([
      { username: 'bulk-admin', password: 'rotated-password-value' },
    ]), 'utf8')

    const result = runCreateUser(['--import', file, '--update-existing'])
    assert.equal(result.status, 0, result.stderr)
    assert.equal((await login(ctx.baseUrl, 'bulk-admin', 'rotated-password-value')).response.status, 204)
  })

  it('--import 有一条非法 → 一个都不写（先全量校验）', async () => {
    const before = userCount(ctx.db)
    const file = path.join(tempDir, 'bad.json')
    fs.writeFileSync(file, JSON.stringify([
      { username: 'should-not-exist-a', password: 'valid-enough-password' },
      { username: 'bad name with space', password: 'valid-enough-password' },
      { username: 'should-not-exist-b', password: 'short' },
    ]), 'utf8')

    const result = runCreateUser(['--import', file])
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /未写入任何账号/)
    assert.equal(userCount(ctx.db), before, '非法导入不得写入任何账号')
  })

  it('数据库里存的是哈希，不是明文', async () => {
    const row = ctx.db.prepare('SELECT password_hash FROM users WHERE username = ?').get('fileuser')
    assert.ok(row)
    assert.match(row.password_hash, /^\$scrypt\$N=32768,r=8,p=1\$/)
    assert.ok(!row.password_hash.includes('file-based-password-1'))
  })
})
