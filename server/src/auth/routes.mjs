/**
 * 认证路由 + 会话守卫 + CSRF/限流。
 *
 * 安全设计（每条都对应一个可失败的测试）：
 *   1. **传输**：非 HTTPS 且未开 `SF_ALLOW_INSECURE` → 400 `insecure_transport`。
 *      否则 `Secure` cookie 会被浏览器静默丢弃，表现为"登录成功但没登录"。
 *   2. **CSRF 三层**：`SameSite=Lax`（cookie 属性）+ Origin/Referer 白名单 + 自定义头 `X-SF-Client`。
 *   3. **账号枚举**：用户不存在时也跑一遍 scrypt（`DUMMY_PASSWORD_HASH`），耗时同阶。
 *   4. **限流双层**：`IP + 用户名` 窗口内 5 次 → 429，连续 10 次 → 锁 15 分钟（423）；
 *      **另有按 IP 的全局上限**（默认 30 次/15 分钟），挡住"换用户名"的密码喷洒。
 *      两张表都有硬上限 + 过期清理，防止被海量随机用户名撑爆内存。
 *   5. **会话**：DB 只存 `sha256(sid)`。
 *   6. **注入**：所有 SQL 一律参数绑定（`?`），零字符串拼接；登录体上限 8 KiB。
 */
import { env, requestIp, requestProtocol } from '../env.mjs'
import { readJsonBody } from '../http/body.mjs'
import { clearCookie, parseCookies, serializeCookie } from '../http/cookies.mjs'
import { HttpError, sendJson, sendNoContent } from '../http/respond.mjs'
import { log } from '../log.mjs'
import { DUMMY_PASSWORD_HASH, verifyPassword } from './password.mjs'
import { createCaptcha, verifyCaptcha } from './captcha.mjs'
import {
  SESSION_COOKIE,
  createSession,
  deleteSession,
  hashTag,
  lookupSession,
} from './session.mjs'

/**
 * 登录尝试记录（内存即可：单进程、重启清空可接受）。
 *
 * 两张表各管一件事：
 *   - `loginAttempts`：按 `IP + 用户名` 计，管"盯着一个账号猛试"
 *   - `ipAttempts`：按 IP 计，管"拿一份密码对所有账号各试一次"（密码喷洒）
 *
 * **两张表都必须有硬上限**：键由请求内容决定，攻击者可以用海量随机用户名
 * 让它们无界增长直到 OOM。`maybeSweep()` 负责过期清理与按时间淘汰。
 */
const loginAttempts = new Map()
const ipAttempts = new Map()

/** 上次清理时间：避免每个失败请求都全表扫描。 */
let lastSweepAt = 0
const SWEEP_INTERVAL_MS = 10_000

export function __resetLoginAttemptsForTest() {
  loginAttempts.clear()
  ipAttempts.clear()
  lastSweepAt = 0
}

/** 仅供测试：观察两张限流表的实际条目数（验证内存不会无界增长）。 */
export function __loginTrackSizesForTest() {
  return { byUser: loginAttempts.size, byIp: ipAttempts.size }
}

/** 登录体上限：正常只有几百字节，给 8 KiB 足够且能挡住大体积探测。 */
const LOGIN_BODY_LIMIT = 8 * 1024

/** 用户名最大长度（与 create-user 的校验一致）；超长直接按"密码错误"处理。 */
const MAX_USERNAME_LENGTH = 64

/** 按 `firstAt` 淘汰最旧的条目，把表压回上限内。 */
function trimOldest(map, limit) {
  const overflow = map.size - limit
  if (overflow <= 0) return
  const entries = [...map.entries()].sort((a, b) => a[1].firstAt - b[1].firstAt)
  for (let index = 0; index < overflow; index += 1) map.delete(entries[index][0])
}

/**
 * 过期清理 + 硬上限。
 *
 * 注意：**只有清理还不够**。攻击进行中所有条目都是"新鲜"的，清不掉，
 * 所以清理之后还要按时间淘汰，才能真正保证内存不随攻击量增长。
 */
function maybeSweep(timestamp) {
  const overLimit = loginAttempts.size > env.loginTrackMax || ipAttempts.size > env.loginTrackMax
  if (!overLimit && timestamp - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = timestamp

  for (const [key, entry] of loginAttempts) {
    const locked = entry.lockedUntil && entry.lockedUntil > timestamp
    if (!locked && timestamp - entry.firstAt > env.loginWindowMs) loginAttempts.delete(key)
  }
  for (const [key, entry] of ipAttempts) {
    if (timestamp - entry.firstAt > env.loginWindowMs) ipAttempts.delete(key)
  }

  trimOldest(loginAttempts, env.loginTrackMax)
  trimOldest(ipAttempts, env.loginTrackMax)
}

function requestOrigin(req) {
  return `${requestProtocol(req)}://${req.headers.host}`
}

/**
 * CSRF / 跨站写入防护。
 *
 * 只对**变更类请求**生效；GET 不需要（没有副作用，且 `no-store` 已防缓存投毒）。
 *
 * 来源白名单的构成：
 *   - 配了 `SF_PUBLIC_ORIGIN` → **只认它**（不再看 `Host`，杜绝 Host 伪造自洽）
 *   - 没配 → 按请求的 `Host` 推导 + `SF_ALLOWED_ORIGINS`
 */
export function assertTrustedRequest(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return

  const allowed = new Set(
    env.publicOrigin ? [env.publicOrigin, ...env.allowedOrigins] : [requestOrigin(req), ...env.allowedOrigins],
  )
  const origin = req.headers.origin
  let candidate = typeof origin === 'string' ? origin : null

  if (!candidate && typeof req.headers.referer === 'string') {
    try {
      candidate = new URL(req.headers.referer).origin
    } catch {
      candidate = null
    }
  }

  if (!candidate) throw new HttpError(403, 'csrf', '缺少 Origin/Referer，拒绝跨站写入')
  if (!allowed.has(candidate)) throw new HttpError(403, 'csrf', '请求来源不受信任')

  if (String(req.headers['x-sf-client'] ?? '') !== 'storyforge') {
    throw new HttpError(403, 'csrf', '缺少 X-SF-Client 头')
  }
}

/** 读取并校验会话；失败抛 401。 */
export function requireSession(db, req) {
  const sid = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
  const session = lookupSession(db, sid)
  if (!session) throw new HttpError(401, 'unauthorized', '未登录或会话已过期')
  return { ...session, sid }
}

function rateLimitKey(req, username) {
  return `${hashTag(requestIp(req))}:${String(username).toLowerCase()}`
}

/** 同一 IP 的全局键（跨用户名）。 */
function ipRateLimitKey(req) {
  return hashTag(requestIp(req))
}

/** 返回 429 错误体（带 `Retry-After`）。`code` 区分"单账号"与"整条 IP"。 */
function tooManyAttempts(retryAfterMs, code = 'rate_limited') {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000))
  return new HttpError(429, code, '尝试过于频繁，请稍后再试', { retryAfterSeconds: seconds }, {
    'retry-after': String(seconds),
  })
}

/**
 * 限流总闸：先查 IP 全局，再查 `IP + 用户名`。
 *
 * 顺序有讲究：IP 全局先拦，才能挡住"换用户名绕过单账号限流"的密码喷洒。
 */
function assertNotRateLimited(req, username) {
  const timestamp = Date.now()
  maybeSweep(timestamp)

  // ① 同一 IP 的全局失败次数（跨用户名）
  const ipEntry = ipAttempts.get(ipRateLimitKey(req))
  if (ipEntry) {
    if (ipEntry.lockedUntil && ipEntry.lockedUntil > timestamp) {
      const seconds = Math.ceil((ipEntry.lockedUntil - timestamp) / 1000)
      throw new HttpError(429, 'ip_rate_limited', '该地址尝试过于频繁，请稍后再试', {
        retryAfterSeconds: seconds,
      }, { 'retry-after': String(seconds) })
    }
    if (timestamp - ipEntry.firstAt <= env.loginWindowMs && ipEntry.count >= env.loginIpMaxAttempts) {
      throw tooManyAttempts(ipEntry.firstAt + env.loginWindowMs - timestamp, 'ip_rate_limited')
    }
  }

  // ② 同一 IP + 用户名
  const key = rateLimitKey(req, username)
  const entry = loginAttempts.get(key)
  if (!entry) return

  if (entry.lockedUntil && entry.lockedUntil > timestamp) {
    const seconds = Math.ceil((entry.lockedUntil - timestamp) / 1000)
    throw new HttpError(423, 'locked', '尝试次数过多，账号已临时锁定', { retryAfterSeconds: seconds }, {
      'retry-after': String(seconds),
    })
  }

  if (timestamp - entry.firstAt > env.loginWindowMs) {
    loginAttempts.delete(key)
    return
  }

  if (entry.count >= env.loginMaxAttempts) {
    // 超限后**继续计数**：反复冲击窗口上限最终会升级成硬锁定。
    // 否则 429 会变成一个"永久的软墙"，锁定阈值永远到不了。
    recordLoginFailure(req, username)
    throw tooManyAttempts(entry.firstAt + env.loginWindowMs - timestamp)
  }
}

/** 记一次失败：同时记 `IP + 用户名` 与 IP 全局。 */function recordLoginFailure(req, username) {
  const timestamp = Date.now()
  const key = rateLimitKey(req, username)

  const entry = loginAttempts.get(key) ?? { count: 0, firstAt: timestamp, lockedUntil: 0 }
  if (timestamp - entry.firstAt > env.loginWindowMs) {
    entry.count = 0
    entry.firstAt = timestamp
    entry.lockedUntil = 0
  }
  entry.count += 1
  if (entry.count >= env.loginLockAfter) entry.lockedUntil = timestamp + env.loginLockMs
  loginAttempts.set(key, entry)

  const ipKey = ipRateLimitKey(req)
  const ipEntry = ipAttempts.get(ipKey) ?? { count: 0, firstAt: timestamp, lockedUntil: 0 }
  if (timestamp - ipEntry.firstAt > env.loginWindowMs) {
    ipEntry.count = 0
    ipEntry.firstAt = timestamp
    ipEntry.lockedUntil = 0
  }
  ipEntry.count += 1
  // IP 全局超限只做窗口内的 429，不做长时间硬锁 ——
  // 家庭/公司常在同一个 NAT 出口，硬锁会把所有人一起锁死。
  ipAttempts.set(ipKey, ipEntry)

  maybeSweep(timestamp)
}

/**
 * 当前请求是否**必须**带验证码。
 *
 * 判定依据是**服务端状态**（这个 IP 在窗口内的失败次数），不是客户端传的标志 ——
 * 否则攻击者只要说"我不需要验证码"就绕过去了。
 *
 * `SF_CAPTCHA_AFTER`：`0` = 每次都要；负数 = 完全关闭。
 */
export function isCaptchaRequired(req) {
  if (env.captchaAfter < 0) return false
  if (env.captchaAfter === 0) return true
  const entry = ipAttempts.get(ipRateLimitKey(req))
  if (!entry) return false
  if (Date.now() - entry.firstAt > env.loginWindowMs) return false
  return entry.count >= env.captchaAfter
}

/**
 * 签发验证码。**不需要登录**，但要过 CSRF 之外的两道闸：
 * 单 IP 发码频率 + 全表条目上限（都在 `captcha.mjs` 里）。
 */
export function handleCaptcha(_db, req, res) {
  const issued = createCaptcha(req)
  sendJson(res, 200, issued, { 'cache-control': 'no-store' })
}

export async function handleLogin(db, req, res) {
  assertTrustedRequest(req)

  if (requestProtocol(req) !== 'https' && !env.allowInsecure) {
    throw new HttpError(
      400,
      'insecure_transport',
      '必须通过 HTTPS 登录：HTTP 下浏览器会丢弃 Secure Cookie，表现为"登录成功但未登录"。',
    )
  }

  const body = await readJsonBody(req, {
    maxBytes: LOGIN_BODY_LIMIT,
    maxCompressedBytes: LOGIN_BODY_LIMIT,
  })

  const username = typeof body?.username === 'string' ? body.username.trim() : ''
  const password = typeof body?.password === 'string' ? body.password : ''
  if (!username || !password) throw new HttpError(400, 'bad_credentials', '请输入用户名与密码')

  // 超长用户名直接按"密码错误"处理：
  //   ① 不让它成为限流表里一个 8 KiB 的巨型键（内存放大）
  //   ② 响应与密码错误完全同形，不泄露任何信息
  const trackName = username.length > MAX_USERNAME_LENGTH
    ? username.slice(0, MAX_USERNAME_LENGTH)
    : username

  assertNotRateLimited(req, trackName)

  if (username.length > MAX_USERNAME_LENGTH) {
    recordLoginFailure(req, trackName)
    throw new HttpError(401, 'unauthorized', '用户名或密码不正确', {
      captchaRequired: isCaptchaRequired(req),
    })
  }

  // ── 验证码闸（在密码校验之前，便宜的检查先做）──
  // 判定用服务端状态，客户端传什么都不影响"要不要验证码"这件事。
  if (isCaptchaRequired(req)) {
    const captchaId = typeof body?.captchaId === 'string' ? body.captchaId : ''
    const captchaAnswer = typeof body?.captchaAnswer === 'string' ? body.captchaAnswer : ''

    if (!captchaId || !captchaAnswer) {
      throw new HttpError(400, 'captcha_required', '请先完成验证码', { captchaRequired: true })
    }

    try {
      verifyCaptcha(req, captchaId, captchaAnswer)
    } catch (error) {
      // 验证码错也要计数：否则攻击者可以拿"无限次免费试验证码"绕过整个限流。
      recordLoginFailure(req, trackName)
      if (error instanceof HttpError) {
        throw new HttpError(error.status, error.code, error.message, { captchaRequired: true })
      }
      throw error
    }
  }

  const row = db.prepare(
    'SELECT id, username, password_hash, role, disabled FROM users WHERE username = ?',
  ).get(username)

  // 账号不存在也跑一次哈希，避免按响应时间枚举账号。
  const matched = await verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH)

  if (!row || !matched || row.disabled) {
    recordLoginFailure(req, username)
    log.warn('auth.login.failed', { username: hashTag(username), ip: hashTag(requestIp(req)) })
    // 把"下一步要不要验证码"直接告诉前端，省掉一次失败往返。
    throw new HttpError(401, 'unauthorized', '用户名或密码不正确', {
      captchaRequired: isCaptchaRequired(req),
    })
  }

  loginAttempts.delete(rateLimitKey(req, username))
  // 登录成功不清 IP 全局计数：否则攻击者只要手里有一个自己的账号，
  // 就能用"错 4 次 + 成功 1 次"把喷洒额度无限续上。

  const { sid, expiresAt } = createSession(db, row.id, {
    ua: req.headers['user-agent'],
    ip: requestIp(req),
  })

  db.prepare(
    'INSERT INTO audit_log (at, user_id, action, project_uid, detail) VALUES (?, ?, ?, ?, ?)',
  ).run(Date.now(), row.id, 'login', null, null)

  log.info('auth.login.ok', { userId: row.id })

  sendNoContent(res, {
    'set-cookie': serializeCookie(SESSION_COOKIE, sid, {
      path: '/api',
      secure: requestProtocol(req) === 'https',
      maxAgeSeconds: Math.floor((expiresAt - Date.now()) / 1000),
    }),
  })
}

export async function handleLogout(db, req, res) {
  assertTrustedRequest(req)
  const sid = parseCookies(req.headers.cookie).get(SESSION_COOKIE)
  deleteSession(db, sid)
  sendNoContent(res, {
    'set-cookie': clearCookie(SESSION_COOKIE, {
      path: '/api',
      secure: requestProtocol(req) === 'https',
    }),
  })
}

export async function handleMe(db, req, res) {
  const session = requireSession(db, req)
  sendJson(res, 200, {
    user: session.user,
    expiresAt: session.expiresAt,
  })
}
