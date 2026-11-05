/**
 * CLOUD-DB-1 · 云端模式的共享类型。
 *
 * 本文件只放**类型与纯常量**，不放逻辑，避免被 `capture-hook` 那条零依赖路径牵连。
 */

/** 云端配置的三种来源。 */
export type CloudConfigSource = 'injected' | 'stored' | 'probed' | 'none'

export interface CloudConfig {
  /** 是否启用云数据库同步。`false` 时应用行为与纯本地版逐字一致。 */
  enabled: boolean
  /** API 基地址：同源相对路径（`/api`）或绝对 `https://` 地址。 */
  apiBase: string
  source: CloudConfigSource
}

/** 运维通过 `window.__STORYFORGE_CLOUD__` 注入的配置。 */
export interface InjectedCloudConfig {
  /**
   * - `true`  ：强制启用（必须给 `apiBase`）
   * - `false` ：强制关闭，优先级最高
   * - `'auto'`：允许探测 `GET {apiBase}/config` 自行判定
   */
  enabled: boolean | 'auto'
  apiBase?: string
  /** 探测超时（毫秒），默认 1500。 */
  probeTimeoutMs?: number
}

/** 落 localStorage 的用户配置（不含任何凭据）。 */
export interface StoredCloudConfig {
  enabled: boolean
  apiBase: string
}

/** 云端错误的统一形状，便于 UI 映射文案。 */
export type CloudErrorCode =
  | 'not_configured'
  | 'insecure_transport'
  | 'invalid_api_base'
  | 'probe_failed'
  | 'unauthorized'
  | 'conflict'
  | 'too_large'
  | 'network'
  | 'server'
  /** 服务端要求先完成图形验证码（失败次数达到阈值）。 */
  | 'captcha_required'
  /** 验证码答错或已失效，需要刷新一张重试。 */
  | 'captcha_invalid'

export class CloudError extends Error {
  readonly code: CloudErrorCode
  readonly status?: number
  /**
   * 服务端明确告知"下一步必须带验证码"。
   *
   * 之所以单独存一个布尔而不是只看 `code`：登录失败返回的是 401 `unauthorized`，
   * 但它同时可能带 `captchaRequired: true` —— 那种情况下 UI 既要显示"密码错误"，
   * 又要立刻把验证码输入框弹出来。
   */
  readonly captchaRequired: boolean

  constructor(code: CloudErrorCode, message: string, status?: number, captchaRequired = false) {
    super(message)
    this.name = 'CloudError'
    this.code = code
    this.status = status
    this.captchaRequired = captchaRequired
  }
}

/** 服务端签发的验证码（`image` 可直接放进 `<img src>`）。 */
export interface CloudCaptcha {
  id: string
  image: string
  expiresInSec: number
}

/** localStorage 键：用户保存的云端配置。 */
export const CLOUD_CONFIG_STORAGE_KEY = 'storyforge-cloud-config'

/** 默认探测超时。必须足够短，不能让首屏等待网络。 */
export const DEFAULT_PROBE_TIMEOUT_MS = 1500

/** 同源默认基地址。 */
export const DEFAULT_API_BASE = '/api'

// ────────────────────────────────────────────────────────────────────────────
// 同步协议（与服务端 `server/src/sync/*` 对应）
// ────────────────────────────────────────────────────────────────────────────

/** 推送协议版本，必须与服务端 `PUSH_PROTOCOL` 一致。 */
export const CLOUD_PUSH_PROTOCOL = 1

/** 服务端返回的项目元数据（**不含载荷**）。 */
export interface RemoteProjectSummary {
  projectUid: string
  name: string
  rev: number
  updatedAt: number
  contentSha256: string | null
  sizeBytes: number
  tableCount: number
}

/** 推送信封。`opId` 必须跨重试稳定（见 `sync-engine`）。 */
export interface PushEnvelope {
  protocol: number
  opId: string
  projectUid: string
  baseRev: number
  clientId: string
  export: unknown
}

/** 409 时服务端给的远端摘要，客户端据此让用户做选择。 */
export interface RemoteConflictSummary {
  rev: number
  name: string
  updatedAt: number
  contentSha256: string | null
  sizeBytes: number
}

/** 拉取响应。 */
export interface PullResponse {
  projectUid: string
  rev: number
  name?: string
  updatedAt?: number
  contentSha256?: string | null
  sizeBytes?: number
  tables?: Array<{ name: string; sha256: string; rowCount: number }>
  historical?: boolean
  export: unknown
}

// ────────────────────────────────────────────────────────────────────────────
// 脏集（outbox）
// ────────────────────────────────────────────────────────────────────────────

/**
 * 精确归因：知道是哪个项目脏了。
 *
 * `opId` **必须持久化在这里**：推送成功但响应丢失时，重试要用同一个 opId，
 * 否则服务端会因 `baseRev` 过期返回 409，用户会误以为冲突并选择"覆盖云端"。
 */
export interface DirtyProjectEntry {
  kind: 'project'
  projectId: number
  tables: string[]
  opId: string | null
  firstAt: number
  lastAt: number
  /** Internal localStorage record IDs captured by one sync pass. */
  entryIds?: string[]
}

/**
 * 全库对账：拿不到 `projectId` 时的降级（`delete` / `deleteRange` / `projects` 表）。
 *
 * 宁可多算一次导出，也不能为了精确归因在 Dexie 事务里 `await` 读取
 * ——那会让窄事务失效，导致用户写入失败。
 */
export interface DirtyScanEntry {
  kind: 'scan'
  at: number
}

export type DirtyEntry = DirtyProjectEntry | DirtyScanEntry

export interface OutboxState {
  version: 1
  entries: DirtyEntry[]
}

/** 同步引擎对外暴露的阶段。 */
export type CloudSyncPhase =
  | 'disabled'
  | 'idle'
  | 'syncing'
  | 'offline'
  | 'error'
  | 'conflict'

