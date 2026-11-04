/**
 * 图形验证码回归。
 *
 * 核心要守住的三件事：
 *   ① 判定"要不要验证码"用的是**服务端状态**，客户端传什么都绕不过去
 *   ② 挑战**一次性**：答错也作废，不给反复试答案的额度
 *   ③ 挑战表与发码频率都有上限，不能被"疯狂拉验证码"打爆内存
 */
import './setup.mjs'

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'

import { env } from '../src/env.mjs'
import {
  __captchaAnswerForTest,
  __captchaSizesForTest,
  __resetCaptchaForTest,
} from '../src/auth/captcha.mjs'
import { __resetLoginAttemptsForTest } from '../src/auth/routes.mjs'
import { createUser, login, request, startTestServer, TEST_PASSWORD } from './helpers.mjs'

function withEnv(patch) {
  const backup = {}
  for (const key of Object.keys(patch)) backup[key] = env[key]
  Object.assign(env, patch)
  return () => Object.assign(env, backup)
}

/** 取一张验证码。`forwardedFor` 用于模拟不同来源 IP。 */
async function fetchCaptcha(baseUrl, forwardedFor) {
  const response = await request(baseUrl, 'GET', '/api/auth/captcha', {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  })
  return response
}

/** 带上验证码登录。 */
async function loginWithCaptcha(baseUrl, username, password, captcha, forwardedFor) {
  return request(baseUrl, 'POST', '/api/auth/login', {
    body: {
      username,
      password,
      ...(captcha ? { captchaId: captcha.id, captchaAnswer: captcha.answer } : {}),
    },
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  })
}

describe('图形验证码', () => {
  let ctx

  before(async () => {
    ctx = await startTestServer()
    await createUser(ctx.db, 'captcha-user')
  })
  after(async () => {
    await ctx.close()
  })

  it('签发：返回 id 与 SVG data URI，且不缓存', async () => {
    __resetCaptchaForTest()
    const response = await fetchCaptcha(ctx.baseUrl)
    assert.equal(response.status, 200)
    assert.match(response.json.id, /^[A-Za-z0-9_-]{16,}$/)
    assert.match(response.json.image, /^data:image\/svg\+xml;base64,/)
    assert.equal(response.json.expiresInSec, 300)
    assert.match(String(response.headers['cache-control']), /no-store/)

    // 解出来确实是一张 SVG，且不含脚本
    const svg = Buffer.from(response.json.image.split(',')[1], 'base64').toString('utf8')
    assert.match(svg, /^<svg[^>]+>/)
    assert.ok(!/<script/i.test(svg))
    assert.ok(!/<foreignObject/i.test(svg))
  })

  it('不需要登录就能取（否则登录前拿不到题）', async () => {
    const response = await fetchCaptcha(ctx.baseUrl)
    assert.equal(response.status, 200)
  })

  it('未达阈值时不需要验证码，正常登录直接成功', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 2 })
    try {
      const result = await login(ctx.baseUrl, 'captcha-user', TEST_PASSWORD)
      assert.equal(result.response.status, 204)
    } finally {
      restore()
    }
  })

  it('达到阈值后不带验证码 → 400 captcha_required', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 2 })
    try {
      await login(ctx.baseUrl, 'captcha-user', 'wrong-password-1')
      await login(ctx.baseUrl, 'captcha-user', 'wrong-password-2')

      const blocked = await login(ctx.baseUrl, 'captcha-user', TEST_PASSWORD)
      assert.equal(blocked.response.status, 400)
      assert.equal(blocked.response.json.error.code, 'captcha_required')
      assert.equal(blocked.response.json.captchaRequired, true)
    } finally {
      restore()
    }
  })

  it('答对验证码 + 正确密码 → 登录成功', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 1 })
    try {
      await login(ctx.baseUrl, 'captcha-user', 'wrong-password-x')

      const issued = await fetchCaptcha(ctx.baseUrl)
      const answer = __captchaAnswerForTest(issued.json.id)
      assert.ok(answer)

      const ok = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer,
      })
      assert.equal(ok.status, 204)
    } finally {
      restore()
    }
  })

  it('答案大小写不敏感', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 1 })
    try {
      await login(ctx.baseUrl, 'captcha-user', 'wrong-password-y')
      const issued = await fetchCaptcha(ctx.baseUrl)
      const answer = __captchaAnswerForTest(issued.json.id)

      const ok = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer: answer.toLowerCase(),
      })
      assert.equal(ok.status, 204)
    } finally {
      restore()
    }
  })

  it('答错 → 400 captcha_invalid，且该挑战立刻作废（一次性）', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 0 })
    try {
      const issued = await fetchCaptcha(ctx.baseUrl)
      const wrong = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer: 'ZZZZZ',
      })
      assert.equal(wrong.status, 400)
      assert.equal(wrong.json.error.code, 'captcha_invalid')

      // 同一个 id 再用（哪怕这次答对）也必须是"已失效"
      const answer = __captchaAnswerForTest(issued.json.id)
      const reused = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer: answer ?? 'ZZZZZ',
      })
      assert.equal(reused.status, 400)
      assert.equal(reused.json.error.code, 'captcha_expired')
    } finally {
      restore()
    }
  })

  it('答对用掉后，同一 id 不能再用', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 0 })
    try {
      const issued = await fetchCaptcha(ctx.baseUrl)
      const answer = __captchaAnswerForTest(issued.json.id)

      const first = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer,
      })
      assert.equal(first.status, 204)

      const second = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer,
      })
      assert.equal(second.status, 400)
      assert.equal(second.json.error.code, 'captcha_expired')
    } finally {
      restore()
    }
  })

  it('过期 → captcha_expired', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 0, captchaTtlMs: 1 })
    try {
      const issued = await fetchCaptcha(ctx.baseUrl)
      const answer = __captchaAnswerForTest(issued.json.id)
      await new Promise(resolve => setTimeout(resolve, 10))

      const response = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer,
      })
      assert.equal(response.status, 400)
      assert.equal(response.json.error.code, 'captcha_expired')
    } finally {
      restore()
    }
  })

  it('绑定来源 IP：别处取的题拿来用 → captcha_invalid', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 0 })
    try {
      const issued = await fetchCaptcha(ctx.baseUrl, '203.0.113.10')
      const answer = __captchaAnswerForTest(issued.json.id)

      const response = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer,
      }, '198.51.100.20')

      assert.equal(response.status, 400)
      assert.equal(response.json.error.code, 'captcha_invalid')
    } finally {
      restore()
    }
  })

  it('发码频率有上限：超了直接 429', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaIssueMax: 3 })
    try {
      for (let index = 0; index < 3; index += 1) {
        assert.equal((await fetchCaptcha(ctx.baseUrl)).status, 200)
      }
      const blocked = await fetchCaptcha(ctx.baseUrl)
      assert.equal(blocked.status, 429)
      assert.equal(blocked.json.error.code, 'rate_limited')
    } finally {
      restore()
    }
  })

  it('挑战表有硬上限：连拉也不会无界增长', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaStoreMax: 5, captchaIssueMax: 1000 })
    try {
      for (let index = 0; index < 12; index += 1) {
        assert.equal((await fetchCaptcha(ctx.baseUrl)).status, 200)
      }
      assert.ok(__captchaSizesForTest().challenges <= 5)
    } finally {
      restore()
    }
  })

  it('答错验证码也计入失败次数（否则等于免费试验证码）', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: 0 })
    try {
      for (let index = 0; index < 3; index += 1) {
        const issued = await fetchCaptcha(ctx.baseUrl)
        const response = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
          id: issued.json.id,
          answer: 'ZZZZZ',
        })
        assert.equal(response.status, 400)
      }

      // 单账号窗口上限是 3 → 第 4 次必须被限流拦下
      const issued = await fetchCaptcha(ctx.baseUrl)
      const blocked = await loginWithCaptcha(ctx.baseUrl, 'captcha-user', TEST_PASSWORD, {
        id: issued.json.id,
        answer: 'ZZZZZ',
      })
      assert.equal(blocked.status, 429)
    } finally {
      restore()
    }
  })

  it('SF_CAPTCHA_AFTER 为负 → 完全关闭验证码', async () => {
    __resetLoginAttemptsForTest()
    __resetCaptchaForTest()
    const restore = withEnv({ captchaAfter: -1 })
    try {
      await login(ctx.baseUrl, 'captcha-user', 'wrong-password-z')
      const response = await login(ctx.baseUrl, 'captcha-user', TEST_PASSWORD)
      assert.equal(response.response.status, 204)
    } finally {
      restore()
    }
  })
})
