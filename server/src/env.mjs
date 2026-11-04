/**
 * 运行配置：全部来自环境变量，带安全默认值。
 *
 * 原则：**默认值必须是"安全的那一侧"** —— 默认要求 HTTPS、默认 64 MiB 上限、
 * 默认 30 天会话、默认每项目保留 20 个历史版本。
 */
import path from 'node:path'

function int(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(value))
}

const dataDir = path.resolve(process.env.SF_DATA_DIR ?? './data')

export const env = {
  port: int(process.env.SF_PORT, 8787),
  host: process.env.SF_HOST ?? '0.0.0.0',

  /** SQLite 文件与版本快照目录（务必挂载为持久卷）。 */
  dataDir,
  dbFile: path.resolve(process.env.SF_DB_FILE ?? path.join(dataDir, 'storyforge-cloud.db')),
  versionsDir: path.resolve(process.env.SF_VERSIONS_DIR ?? path.join(dataDir, 'versions')),

  /** 解压后的请求体上限（手稿整包，默认 64 MiB）。 */
  maxPushBytes: int(process.env.SF_MAX_PUSH_BYTES, 64 * 1024 * 1024),
  /** 压缩后的请求体上限（防 gzip 炸弹的第一道闸）。 */
  maxCompressedBytes: int(process.env.SF_MAX_COMPRESSED_BYTES, 8 * 1024 * 1024),

  /**
   * 单份版本快照的上限（解压后）。
   *
   * 比整项目上限小得多：快照本身就是整包 JSON，正常几百 KB 到 2 MB；
   * 给 32 MiB 已经足够宽，同时挡住"把整库当快照反复上传"的滥用。
   */
  maxSnapshotBytes: int(process.env.SF_MAX_SNAPSHOT_BYTES, 32 * 1024 * 1024),
  maxSnapshotCompressedBytes: int(process.env.SF_MAX_SNAPSHOT_COMPRESSED_BYTES, 8 * 1024 * 1024),
  /** 每个项目最多保留多少份云端快照（超出删最旧）。 */
  snapshotKeep: int(process.env.SF_SNAPSHOT_KEEP, 40),

  /** 会话有效期（天），滑动续期。 */
  sessionTtlMs: int(process.env.SF_SESSION_TTL_DAYS, 30) * 86_400_000,
  /** 每项目保留的历史版本数。 */
  versionKeep: int(process.env.SF_VERSION_KEEP, 20),

  /** 允许在 HTTP 下登录（仅本机调试；生产必须关闭）。 */
  allowInsecure: bool(process.env.SF_ALLOW_INSECURE, false),
  /** 是否信任 `X-Forwarded-Proto`（在 nginx 反代后必须开启）。 */
  trustProxy: bool(process.env.SF_TRUST_PROXY, true),

  /** 登录限流：窗口内最多尝试次数（按 `IP + 用户名` 计）。 */
  loginWindowMs: int(process.env.SF_LOGIN_WINDOW_MINUTES, 15) * 60_000,
  loginMaxAttempts: int(process.env.SF_LOGIN_MAX_ATTEMPTS, 5),
  /** 连续失败锁定时长。 */
  loginLockMs: int(process.env.SF_LOGIN_LOCK_MINUTES, 15) * 60_000,
  loginLockAfter: int(process.env.SF_LOGIN_LOCK_AFTER, 10),

  /**
   * 同一 IP 的**全局**失败上限（跨用户名）。
   *
   * 没有它，攻击者换一个用户名就换一套独立计数 —— 也就是"密码喷洒"
   * （拿一份常见密码，对几百个用户名各试一次）完全不受限。
   */
  loginIpMaxAttempts: int(process.env.SF_LOGIN_IP_MAX_ATTEMPTS, 30),

  /**
   * 限流表的最大条目数。
   *
   * 限流表以 `IP + 用户名` 为键，攻击者用海量随机用户名可以让它无界增长到 OOM。
   * 必须有硬上限：超了就按最早时间淘汰。5000 条 ≈ 几百 KB，够用。
   */
  loginTrackMax: int(process.env.SF_LOGIN_TRACK_MAX, 5000),

  /** 允许的站点来源（CSRF 校验用）。留空则按请求 Host 推导。 */
  allowedOrigins: (process.env.SF_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map(item => item.trim())
    .filter(Boolean),

  /**
   * 站点对外地址（如 `https://sf.example.com`）。
   *
   * 设置后 CSRF 只认它，**不再按 `Host` 头推导** —— 否则伪造 `Host` 就能让
   * `Origin` 校验自己和自己对上。私有化单站点部署建议显式设置。
   */
  publicOrigin: (process.env.SF_PUBLIC_ORIGIN ?? '').trim().replace(/\/+$/, ''),

  // ── 图形验证码 ──────────────────────────────────────────────────────────
  /**
   * 同一 IP 失败多少次后开始要求验证码。
   *
   * - `3`（默认）：前几次不打扰，撞库脚本很快会撞上墙
   * - `0`：**每次登录都要求**（最严格，适合暴露在公网且不想被扫）
   * - 负数：**完全关闭**验证码
   */
  captchaAfter: int(process.env.SF_CAPTCHA_AFTER, 3),
  /** 单张验证码有效期（默认 5 分钟）。 */
  captchaTtlMs: int(process.env.SF_CAPTCHA_TTL_SECONDS, 300) * 1000,
  /**
   * 挑战表的条目硬上限。
   *
   * 键由客户端请求决定，不设上限就是一条"疯狂拉验证码把内存打满"的路径。
   */
  captchaStoreMax: int(process.env.SF_CAPTCHA_STORE_MAX, 2000),
  /** 单个 IP 在限流窗口内最多能拉多少张验证码。 */
  captchaIssueMax: int(process.env.SF_CAPTCHA_ISSUE_MAX, 60),
}

/** 协议：反代后读 `X-Forwarded-Proto`。 */
export function requestProtocol(req) {
  if (env.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim()
    if (forwarded === 'http' || forwarded === 'https') return forwarded
  }
  return req.socket?.encrypted ? 'https' : 'http'
}

/** 客户端地址（用于限流与审计；**不落明文**）。 */
export function requestIp(req) {
  if (env.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim()
    if (forwarded) return forwarded
  }
  return req.socket?.remoteAddress ?? 'unknown'
}
