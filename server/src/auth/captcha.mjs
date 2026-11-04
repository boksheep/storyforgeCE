/**
 * 图形验证码：服务端生成 SVG，客户端用 `<img src="data:image/svg+xml;base64,...">` 显示。
 *
 * ## 为什么用 SVG + data URI
 *
 * - **零依赖**：不引入 canvas / sharp / svg-captcha，保持"部署不需要 npm install"。
 * - **安全**：`<img>` 上下文里的 SVG **不会执行脚本**，也不会加载外部资源
 *   （浏览器对 SVG-as-image 有这条硬规则）。所以就算生成逻辑出错，也进不了 DOM。
 * - **字体由客户端解析**：SVG 是浏览器渲染的，容器里没有字体文件也没关系，
 *   `<text>` 会用浏览器自己的等宽字体。这点很关键 —— alpine 镜像里一个字体都没有。
 *
 * ## 防的是什么
 *
 * 限流挡的是"同一个 IP 高频尝试"，挡不住**分布式低速撞库**（每个 IP 每小时只试几次）。
 * 验证码把"每次尝试都需要一个真人动作"变成硬约束，让脚本的成本从"一次 HTTP 请求"
 * 变成"一次图像识别"。
 *
 * ## 已知强度边界（如实写下来）
 *
 * 这是**自制图形码**，不是 reCAPTCHA。字符做了旋转、抖动、噪点、干扰线，
 * 但对成熟的 OCR 模型不算强。它的定位是"抬高脚本成本 + 与限流叠加"，
 * 不是"唯一防线"。真要对外开放请在前面加 WAF / 商业验证码。
 *
 * ## 内存安全
 *
 * 挑战表与限流表是同一类风险：键由**客户端请求**决定。所以：
 *   - 每条挑战 5 分钟过期
 *   - 表有条目硬上限（`SF_CAPTCHA_STORE_MAX`），超出按最早过期时间淘汰
 *   - 每个 IP 的**发码频率**单独限流（`SF_CAPTCHA_ISSUE_MAX`），否则
 *     "疯狂拉验证码"本身就能把内存打满
 */
import crypto from 'node:crypto'
import { env, requestIp } from '../env.mjs'
import { HttpError } from '../http/respond.mjs'
import { hashTag } from './session.mjs'

/** 去掉易混字符（0/O、1/I/L），降低"看对了却打错"的挫败感。 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'
const CODE_LENGTH = 5
const WIDTH = 150
const HEIGHT = 46

/** 挑战表：id → { answer, ipHash, expiresAt }。 */
const challenges = new Map()
/** 发码频率：ipHash → { count, firstAt }。 */
const issueCounts = new Map()

let lastSweepAt = 0
const SWEEP_INTERVAL_MS = 10_000

export function __resetCaptchaForTest() {
  challenges.clear()
  issueCounts.clear()
  lastSweepAt = 0
}

/** 仅供测试：观察两张表的条目数（验证内存不会无界增长）。 */
export function __captchaSizesForTest() {
  return { challenges: challenges.size, issuers: issueCounts.size }
}

/**
 * 仅供测试：读出某个挑战的答案。
 *
 * 生产代码里没有任何路径能拿到明文答案 —— 它只存在于服务端内存，
 * 出题时就把字符画进了 SVG。测试需要它才能验证"答对能通过"这条正向路径。
 */
export function __captchaAnswerForTest(id) {
  return challenges.get(id)?.answer ?? null
}

function randomInt(max) {
  return crypto.randomInt(0, max)
}

function pick(list) {
  return list[randomInt(list.length)]
}

function randomCode() {
  let code = ''
  for (let index = 0; index < CODE_LENGTH; index += 1) code += ALPHABET[randomInt(ALPHABET.length)]
  return code
}

/** 按 `expiresAt` 淘汰最旧的条目，把表压回上限内。 */
function trimOldest(map, limit) {
  const overflow = map.size - limit
  if (overflow <= 0) return
  const entries = [...map.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt)
  for (let index = 0; index < overflow; index += 1) map.delete(entries[index][0])
}

function maybeSweep(timestamp) {
  const overLimit = challenges.size > env.captchaStoreMax || issueCounts.size > env.captchaStoreMax
  if (!overLimit && timestamp - lastSweepAt < SWEEP_INTERVAL_MS) return
  lastSweepAt = timestamp

  for (const [id, entry] of challenges) {
    if (entry.expiresAt <= timestamp) challenges.delete(id)
  }
  for (const [key, entry] of issueCounts) {
    if (timestamp - entry.firstAt > env.loginWindowMs) issueCounts.delete(key)
  }
  trimOldest(challenges, env.captchaStoreMax)
  trimOldest(issueCounts, env.captchaStoreMax)
}

/** 每个 IP 的发码频率闸。超了直接 429，不给生成。 */
function assertCanIssue(ipHash, timestamp) {
  const entry = issueCounts.get(ipHash)
  if (!entry || timestamp - entry.firstAt > env.loginWindowMs) return

  if (entry.count >= env.captchaIssueMax) {
    const seconds = Math.max(1, Math.ceil((entry.firstAt + env.loginWindowMs - timestamp) / 1000))
    throw new HttpError(429, 'rate_limited', '验证码获取过于频繁，请稍后再试', {
      retryAfterSeconds: seconds,
    }, { 'retry-after': String(seconds) })
  }
}

function recordIssue(ipHash, timestamp) {
  const entry = issueCounts.get(ipHash)
  if (!entry || timestamp - entry.firstAt > env.loginWindowMs) {
    issueCounts.set(ipHash, { count: 1, firstAt: timestamp })
    return
  }
  entry.count += 1
}

const INK_COLORS = ['#1f2937', '#111827', '#1e3a8a', '#3f2d1f', '#233b2f']

/**
 * 生成一张 SVG 验证码图。
 *
 * 结构：浅色底 + 5 个随机旋转/位移的字符 + 3 条贝塞尔干扰线 + 一圈噪点。
 * 底色固定为浅色，**不跟随主题** —— 这样深色/浅色界面下都能看清，
 * 也避免"主题色导致字符与背景对比度不足"。
 */
function renderSvg(code) {
  const parts = []
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" `
    + `viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="验证码">`,
  )
  parts.push(`<rect width="${WIDTH}" height="${HEIGHT}" fill="#f3f4f6"/>`)

  // 干扰线：先画在字符下面，避免盖住笔画影响辨认
  for (let index = 0; index < 3; index += 1) {
    const y1 = 6 + randomInt(HEIGHT - 12)
    const y2 = 6 + randomInt(HEIGHT - 12)
    parts.push(
      `<path d="M0 ${y1} Q ${WIDTH / 3} ${randomInt(HEIGHT)} ${WIDTH / 1.6} ${y2} `
      + `T ${WIDTH} ${randomInt(HEIGHT)}" fill="none" stroke="#9ca3af" stroke-width="1" opacity="0.7"/>`,
    )
  }

  // 字符：每个独立旋转 + 上下抖动 + 轻微字号差异
  const slot = WIDTH / (CODE_LENGTH + 1)
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    const char = code[index]
    const x = Math.round(slot * index + slot * 0.6)
    const y = 32 + randomInt(7) - 3
    const rotate = randomInt(35) - 17
    const size = 24 + randomInt(6)
    const color = pick(INK_COLORS)
    parts.push(
      `<text x="${x}" y="${y}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" `
      + `font-size="${size}" font-weight="700" fill="${color}" `
      + `transform="rotate(${rotate} ${x + 8} ${y - 8})">${char}</text>`,
    )
  }

  // 噪点
  for (let index = 0; index < 26; index += 1) {
    const cx = randomInt(WIDTH)
    const cy = randomInt(HEIGHT)
    const r = 1 + randomInt(2)
    parts.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="#6b7280" opacity="0.45"/>`)
  }

  parts.push('</svg>')
  return parts.join('')
}

/**
 * 签发一张新验证码。
 *
 * 挑战**绑定 IP**：从 A 处拿到的题不能拿到 B 处用，避免"一人取题、多人刷题"。
 *
 * @returns {{ id: string, image: string, expiresInSec: number }}
 *   `image` 是可直接放进 `<img src>` 的 data URI。
 */
export function createCaptcha(req) {
  const timestamp = Date.now()
  const ipHash = hashTag(requestIp(req))
  maybeSweep(timestamp)
  assertCanIssue(ipHash, timestamp)

  const code = randomCode()
  const id = crypto.randomBytes(18).toString('base64url')
  challenges.set(id, { answer: code, ipHash, expiresAt: timestamp + env.captchaTtlMs })
  recordIssue(ipHash, timestamp)
  maybeSweep(timestamp)

  const svg = renderSvg(code)
  return {
    id,
    image: `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`,
    expiresInSec: Math.floor(env.captchaTtlMs / 1000),
  }
}

/**
 * 校验并**立即作废**该挑战。
 *
 * 无论成功失败都删除：否则攻击者可以拿同一张图反复试答案
 * （5 位 × 32 字母表 = 3355 万，虽然大，但没有理由给他这个额度）。
 */
export function verifyCaptcha(req, id, answer) {
  const timestamp = Date.now()
  const entry = challenges.get(id)

  if (!entry) {
    throw new HttpError(400, 'captcha_expired', '验证码已失效，请刷新后重试')
  }

  challenges.delete(id)

  if (entry.expiresAt <= timestamp) {
    throw new HttpError(400, 'captcha_expired', '验证码已过期，请刷新后重试')
  }
  if (entry.ipHash !== hashTag(requestIp(req))) {
    throw new HttpError(400, 'captcha_invalid', '验证码与当前网络不匹配，请刷新后重试')
  }

  const given = String(answer ?? '').trim().toUpperCase()
  // 长度先比一次，避免 timingSafeEqual 抛错；内容比较用定时安全比较。
  if (given.length !== entry.answer.length) {
    throw new HttpError(400, 'captcha_invalid', '验证码不正确')
  }
  const a = Buffer.from(given, 'utf8')
  const b = Buffer.from(entry.answer, 'utf8')
  if (!crypto.timingSafeEqual(a, b)) {
    throw new HttpError(400, 'captcha_invalid', '验证码不正确')
  }
}
