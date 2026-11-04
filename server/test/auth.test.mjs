/**
 * 认证与 CSRF/限流。
 *
 * 每个用例对应一条安全承诺，失败即代表承诺被破坏。
 */
import { test, before, after, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  startTestServer,
  createUser,
  login,
  request,
  TEST_PASSWORD,
} from './helpers.mjs'
import { env } from '../src/env.mjs'
import { __resetLoginAttemptsForTest } from '../src/auth/routes.mjs'

let ctx

before(async () => {
  ctx = await startTestServer()
  await createUser(ctx.db, 'author')
})

after(async () => {
  await ctx.close()
})

describe('登录', () => {
  test('正确凭据 → 204 且下发受保护的会话 cookie', async () => {
    const { response } = await login(ctx.baseUrl, 'author')
    assert.equal(response.status, 204)

    const raw = [response.headers['set-cookie']].flat().join(';')
    assert.match(raw, /sf_sid=/)
    assert.match(raw, /HttpOnly/i)
    assert.match(raw, /SameSite=Lax/i)
    assert.match(raw, /Path=\/api/i)
    // 数据库里不能出现明文 sid
    const stored = ctx.db.prepare('SELECT id_hash FROM sessions').all()
    assert.ok(stored.length > 0)
    for (const row of stored) {
      assert.match(row.id_hash, /^[0-9a-f]{64}$/)
    }
  })

  test('密码错误 → 401，且不区分"用户不存在"与"密码错误"', async () => {
    const { response } = await login(ctx.baseUrl, 'author', 'wrong-password-value')
    assert.equal(response.status, 401)
    assert.equal(response.json.error.code, 'unauthorized')
    // 提示必须同时提到"用户名或密码"，不能指出到底哪一项错（否则等于账号枚举）
    assert.equal(response.json.error.message, '用户名或密码不正确')
    assert.equal(response.json.error.field, undefined)
  })

  test('账号不存在 → 401（与密码错误同形，避免枚举）', async () => {
    const { response } = await login(ctx.baseUrl, 'nobody-here', 'whatever-password')
    assert.equal(response.status, 401)
    assert.equal(response.json.error.code, 'unauthorized')
  })

  test('缺少 X-SF-Client → 403 csrf', async () => {
    const response = await request(ctx.baseUrl, 'POST', '/api/auth/login', {
      body: { username: 'author', password: TEST_PASSWORD },
      headers: { 'x-sf-client': '' },
    })
    assert.equal(response.status, 403)
    assert.equal(response.json.error.code, 'csrf')
  })

  test('来源不受信任 → 403 csrf', async () => {
    const response = await request(ctx.baseUrl, 'POST', '/api/auth/login', {
      body: { username: 'author', password: TEST_PASSWORD },
      headers: { origin: 'https://evil.example.com' },
    })
    assert.equal(response.status, 403)
    assert.equal(response.json.error.code, 'csrf')
  })

  test('HTTP 下且未开 allowInsecure → 400 insecure_transport', async () => {
    const original = env.allowInsecure
    env.allowInsecure = false
    try {
      const { response } = await login(ctx.baseUrl, 'author')
      assert.equal(response.status, 400)
      assert.equal(response.json.error.code, 'insecure_transport')
    } finally {
      env.allowInsecure = original
    }
  })
})

describe('会话', () => {
  test('/auth/me 无 cookie → 401；有 cookie → 200', async () => {
    const anonymous = await request(ctx.baseUrl, 'GET', '/api/auth/me')
    assert.equal(anonymous.status, 401)

    const { cookie } = await login(ctx.baseUrl, 'author')
    const authenticated = await request(ctx.baseUrl, 'GET', '/api/auth/me', { cookie })
    assert.equal(authenticated.status, 200)
    assert.equal(authenticated.json.user.username, 'author')
  })

  test('登出后会话立即失效', async () => {
    const { cookie } = await login(ctx.baseUrl, 'author')
    const logout = await request(ctx.baseUrl, 'POST', '/api/auth/logout', { cookie })
    assert.equal(logout.status, 204)

    const after = await request(ctx.baseUrl, 'GET', '/api/auth/me', { cookie })
    assert.equal(after.status, 401)
  })

  test('伪造 sid → 401', async () => {
    const response = await request(ctx.baseUrl, 'GET', '/api/auth/me', {
      cookie: 'sf_sid=deadbeef'.repeat(4),
    })
    assert.equal(response.status, 401)
  })
})

describe('登录限流', () => {
  test('连续失败达到上限 → 429 且带 Retry-After', async () => {
    __resetLoginAttemptsForTest()
    await createUser(ctx.db, 'ratelimited')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { response } = await login(ctx.baseUrl, 'ratelimited', 'definitely-wrong-pass')
      assert.equal(response.status, 401, `第 ${attempt + 1} 次应为 401`)
    }

    const blocked = await login(ctx.baseUrl, 'ratelimited', 'definitely-wrong-pass')
    assert.equal(blocked.response.status, 429)
    assert.equal(blocked.response.json.error.code, 'rate_limited')
    assert.ok(blocked.response.headers['retry-after'])
  })

  test('锁定后再试 → 423', async () => {
    __resetLoginAttemptsForTest()
    await createUser(ctx.db, 'locked-user')

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await login(ctx.baseUrl, 'locked-user', 'wrong-password-again')
    }

    const locked = await login(ctx.baseUrl, 'locked-user', TEST_PASSWORD)
    assert.equal(locked.response.status, 423)
    assert.equal(locked.response.json.error.code, 'locked')
  })
})

describe('响应头', () => {
  test('所有 /api 响应带 no-store，防止手稿进缓存', async () => {
    const config = await request(ctx.baseUrl, 'GET', '/api/config')
    assert.equal(config.status, 200)
    assert.equal(config.headers['cache-control'], 'no-store')
    assert.equal(config.json.app, 'storyforge')
    assert.equal(config.json.cloud, true)

    const unauthorized = await request(ctx.baseUrl, 'GET', '/api/auth/me')
    assert.equal(unauthorized.headers['cache-control'], 'no-store')
  })

  test('非 /api 路径返回 JSON 404（静态资源由 nginx 负责）', async () => {
    const response = await request(ctx.baseUrl, 'GET', '/index.html')
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'not_found')
  })
})
