/**
 * CLOUD-DB-1 · HTTP 客户端
 *
 * 全项目**只有这里**允许发云端请求（架构守卫建议的第⑩条）。集中在一处的好处：
 * 超时、错误码映射、凭据、gzip、`no-store` 只需正确一次。
 *
 * 约定：
 *   - 一律 `credentials: 'include'`（会话是 HttpOnly Cookie）
 *   - 变更类请求带 `X-SF-Client: storyforge`（服务端 CSRF 第二层）
 *   - 请求体在浏览器支持时用 `CompressionStream('gzip')` 压缩
 *   - 任何失败都转成 `CloudError`，UI 只按 `code` 映射文案
 */
import {
  CLOUD_PUSH_PROTOCOL,
  CloudError,
  type CloudCaptcha,
  type CloudConfig,
  type PullResponse,
  type PushEnvelope,
  type RemoteConflictSummary,
  type RemoteProjectSummary,
} from './types'

const CLIENT_ID_KEY = 'storyforge-cloud-client-id'
const DEFAULT_TIMEOUT_MS = 20_000
const PUSH_TIMEOUT_MS = 120_000
/** 小于这个体积不值得压缩（gzip 头开销反而更大）。 */
const GZIP_THRESHOLD = 1024

let activeConfig: CloudConfig | null = null

export function setActiveConfig(config: CloudConfig | null): void {
  activeConfig = config
}

export function getActiveConfig(): CloudConfig | null {
  return activeConfig
}

function requireConfig(): CloudConfig {
  if (!activeConfig?.enabled) {
    throw new CloudError('not_configured', '云端未启用')
  }
  return activeConfig
}

/** 稳定的客户端标识（只用于服务端日志区分设备，不含任何隐私）。 */
export function getClientId(): string {
  try {
    const existing = globalThis.localStorage?.getItem(CLIENT_ID_KEY)
    if (existing) return existing
    const created = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2)
    globalThis.localStorage?.setItem(CLIENT_ID_KEY, created)
    return created
  } catch {
    return 'anonymous'
  }
}

async function gzipBody(text: string): Promise<{ body: BodyInit; encoding: string | null }> {
  const canGzip = typeof (globalThis as { CompressionStream?: unknown }).CompressionStream === 'function'
  if (!canGzip || text.length < GZIP_THRESHOLD) return { body: text, encoding: null }
  try {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
    const compressed = await new Response(stream).arrayBuffer()
    return { body: compressed, encoding: 'gzip' }
  } catch {
    return { body: text, encoding: null }
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: unknown
  timeoutMs?: number
  /** 允许 304 这类"无内容"的成功状态。 */
  allowNoContent?: boolean
}

interface ParsedResponse {
  status: number
  json: unknown
}

function toCloudError(status: number, payload: unknown): CloudError {
  const body = payload as {
    error?: { code?: string; message?: string }
    remote?: RemoteConflictSummary
    captchaRequired?: boolean
  } | null
  const code = body?.error?.code
  const message = body?.error?.message ?? `请求失败（HTTP ${status}）`
  const captchaRequired = body?.captchaRequired === true

  // 验证码相关先判：它们都是 400，但语义完全不同，UI 要分别处理
  if (code === 'captcha_required') {
    return new CloudError('captcha_required', message, status, true)
  }
  if (code === 'captcha_invalid' || code === 'captcha_expired') {
    return new CloudError('captcha_invalid', message, status, true)
  }

  if (status === 401) return new CloudError('unauthorized', message, status, captchaRequired)
  if (status === 409) {
    const error = new CloudError('conflict', message, status)
    ;(error as CloudError & { remote?: RemoteConflictSummary }).remote = body?.remote
    return error
  }
  if (status === 413) return new CloudError('too_large', message, status)
  // 429 / 423 也归到 server：文案由服务端给，UI 只需要"失败原因"这一档
  if (status === 429 || status === 423 || code === 'locked' || code === 'rate_limited') {
    return new CloudError('server', message, status, captchaRequired)
  }
  if (status >= 500) return new CloudError('server', message, status)
  return new CloudError('server', message, status, captchaRequired)
}

async function request(path: string, options: RequestOptions = {}): Promise<ParsedResponse> {
  const config = requireConfig()
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-sf-client': 'storyforge',
    }

    let body: BodyInit | undefined
    if (options.body !== undefined) {
      const text = JSON.stringify(options.body)
      const packed = await gzipBody(text)
      body = packed.body
      headers['content-type'] = 'application/json'
      if (packed.encoding) headers['content-encoding'] = packed.encoding
    }

    const response = await fetch(`${config.apiBase}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
      credentials: 'include',
      signal: controller.signal,
      cache: 'no-store',
    })

    if (response.status === 204) return { status: 204, json: null }
    if (response.status === 304) return { status: 304, json: null }

    const text = await response.text()
    let json: unknown = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }

    if (!response.ok) throw toCloudError(response.status, json)
    return { status: response.status, json }
  } catch (error) {
    if (error instanceof CloudError) throw error
    if ((error as Error)?.name === 'AbortError') {
      throw new CloudError('network', '请求超时，请检查网络或服务器状态')
    }
    throw new CloudError('network', '无法连接云端服务器')
  } finally {
    clearTimeout(timer)
  }
}

// ── 具体接口 ────────────────────────────────────────────────────────────────

/** 服务端是否要求验证码时的登录入参。 */
export interface LoginCaptcha {
  id: string
  answer: string
}

export async function login(
  username: string,
  password: string,
  captcha?: LoginCaptcha | null,
): Promise<void> {
  await request('/auth/login', {
    method: 'POST',
    body: {
      username,
      password,
      ...(captcha ? { captchaId: captcha.id, captchaAnswer: captcha.answer } : {}),
    },
  })
}

/**
 * 取一张验证码。
 *
 * `image` 是 `data:image/svg+xml;base64,...`，直接放进 `<img src>`。
 * **不要**用 `dangerouslySetInnerHTML` 渲染 —— `<img>` 上下文里的 SVG
 * 不会执行脚本，而内联进 DOM 就会。
 */
export async function fetchCaptcha(): Promise<CloudCaptcha> {
  const { json } = await request('/auth/captcha')
  return json as CloudCaptcha
}

export async function logout(): Promise<void> {
  await request('/auth/logout', { method: 'POST', body: {} })
}

export interface MeResponse {
  user: { id: number; username: string; role: string }
  expiresAt: number
}

export async function me(): Promise<MeResponse> {
  const { json } = await request('/auth/me')
  return json as MeResponse
}

export async function listStatus(): Promise<RemoteProjectSummary[]> {
  const { json } = await request('/sync/status')
  const body = json as { projects?: RemoteProjectSummary[] } | null
  return body?.projects ?? []
}

export interface PushResult {
  ok: boolean
  projectUid: string
  rev: number
  contentSha256?: string
  sizeBytes?: number
  changedTables?: string[]
  unchanged?: boolean
  idempotent?: boolean
  created?: boolean
}

export async function push(envelope: PushEnvelope): Promise<PushResult> {
  const { json } = await request('/sync/push', {
    method: 'POST',
    body: envelope,
    timeoutMs: PUSH_TIMEOUT_MS,
  })
  return json as PushResult
}

export async function forcePush(envelope: PushEnvelope): Promise<PushResult> {
  const { json } = await request('/sync/force', {
    method: 'POST',
    body: envelope,
    timeoutMs: PUSH_TIMEOUT_MS,
  })
  return json as PushResult
}

export async function pull(projectUid: string, options: { rev?: number; sinceRev?: number } = {}): Promise<PullResponse | null> {
  const params = new URLSearchParams({ uid: projectUid })
  if (options.rev != null) params.set('rev', String(options.rev))
  if (options.sinceRev != null) params.set('sinceRev', String(options.sinceRev))

  const { status, json } = await request(`/sync/pull?${params.toString()}`)
  if (status === 304) return null
  return json as PullResponse
}

export async function deleteProject(projectUid: string): Promise<void> {
  await request(`/projects/${projectUid}`, { method: 'DELETE' })
}

export interface VersionMeta {
  rev: number
  reason: string
  sizeBytes: number
  createdAt: number
}

export async function listVersions(projectUid: string): Promise<VersionMeta[]> {
  const { json } = await request(`/sync/versions?uid=${encodeURIComponent(projectUid)}`)
  const body = json as { versions?: VersionMeta[] } | null
  return body?.versions ?? []
}

/** 构造推送信封（`opId` 由调用方负责稳定性）。 */
export function buildEnvelope(input: {
  opId: string
  projectUid: string
  baseRev: number
  exportData: unknown
}): PushEnvelope {
  return {
    protocol: CLOUD_PUSH_PROTOCOL,
    opId: input.opId,
    projectUid: input.projectUid,
    baseRev: input.baseRev,
    clientId: getClientId(),
    export: input.exportData,
  }
}

// ── 版本快照 ────────────────────────────────────────────────────────────────

export interface CloudSnapshotMeta {
  snapshotUid: string
  label: string
  type: 'auto' | 'manual'
  sizeBytes: number
  createdAt: number
  uploadedAt: number
}

export interface CloudSnapshotPayload extends CloudSnapshotMeta {
  projectUid: string
  /** 序列化后的 `ProjectExportData`（字符串，原样回传）。 */
  data: string
}

export interface UploadSnapshotInput {
  projectUid: string
  snapshotUid: string
  label: string
  type: 'auto' | 'manual'
  createdAt: number
  data: string
}

/**
 * 上传一份快照。
 *
 * `data` 是**已序列化**的字符串：保持"客户端负责序列化"这一契约，
 * 服务端只做大小与 JSON 合法性校验，不重新序列化（否则字节会变，sha256 对不上）。
 */
export async function uploadSnapshot(input: UploadSnapshotInput): Promise<{
  snapshotUid: string
  sizeBytes: number
  sha256: string
  uploadedAt: number
}> {
  const { json } = await request('/snapshots', {
    method: 'POST',
    body: input,
    timeoutMs: PUSH_TIMEOUT_MS,
  })
  return json as { snapshotUid: string; sizeBytes: number; sha256: string; uploadedAt: number }
}

/** 列出某项目的云端快照（**只有元数据**，不含内容）。 */
export async function listCloudSnapshots(projectUid: string): Promise<CloudSnapshotMeta[]> {
  const { json } = await request(`/snapshots?uid=${encodeURIComponent(projectUid)}`)
  const body = json as { snapshots?: CloudSnapshotMeta[] } | null
  return body?.snapshots ?? []
}

/** 取回单份快照的完整内容（用于恢复）。 */
export async function fetchCloudSnapshot(snapshotUid: string): Promise<CloudSnapshotPayload> {
  const { json } = await request(`/snapshots/${encodeURIComponent(snapshotUid)}`, {
    timeoutMs: PUSH_TIMEOUT_MS,
  })
  return json as CloudSnapshotPayload
}

export async function deleteCloudSnapshot(snapshotUid: string): Promise<void> {
  await request(`/snapshots/${encodeURIComponent(snapshotUid)}`, { method: 'DELETE' })
}
