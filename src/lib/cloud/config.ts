/**
 * CLOUD-DB-1 · 云端模式判定（运行时三级，非编译期分支）
 *
 * 目标：**同一份 `dist-web` 产物既能纯本地运行，也能连私有云数据库**，
 * 且未配置时行为与今天逐字一致（零请求、零字节、零启动延迟）。
 *
 * 判定顺序（短路）：
 *   1. `window.__STORYFORGE_CLOUD__` —— 运维注入，可 `enabled:false` 强制关闭
 *   2. `localStorage['storyforge-cloud-config']` —— 用户上次保存
 *   3. `GET {apiBase}/config` —— 仅当运维注入 `enabled:'auto'` 时才探测
 *   4. 全部落空 → `{ enabled:false }`
 *
 * 注意第 3 步的门槛：`main.tsx` 只在"注入或本地已有配置"时才动态加载本模块，
 * 所以纯本地用户**永远不会**走到探测分支，也就不会产生任何网络请求。
 */
import {
  CLOUD_CONFIG_STORAGE_KEY,
  DEFAULT_API_BASE,
  DEFAULT_PROBE_TIMEOUT_MS,
  CloudError,
  type CloudConfig,
  type InjectedCloudConfig,
  type StoredCloudConfig,
} from './types'

/** 唯一允许 http 的主机（浏览器把 localhost 视为安全上下文）。 */
const INSECURE_ALLOWED_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * 规范化 API 基地址。
 *
 * - 空 → `/api`
 * - `'api'` / `'/api/'` → `'/api'`
 * - `'https://sf.example.com/api/'` → `'https://sf.example.com/api'`（去尾斜杠、丢 query/hash）
 *
 * 保留协议与 host，因此绝对地址可用于跨源部署。
 */
export function normalizeApiBase(raw?: string | null): string {
  const value = (raw ?? '').trim()
  if (!value) return DEFAULT_API_BASE

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      const url = new URL(value)
      const path = url.pathname.replace(/\/+$/, '')
      return `${url.protocol}//${url.host}${path}`
    } catch {
      return DEFAULT_API_BASE
    }
  }

  const path = (value.split(/[?#]/)[0] ?? value).trim()
  const withLeadingSlash = path.startsWith('/') ? path : `/${path}`
  const trimmed = withLeadingSlash.replace(/\/+$/, '')
  return trimmed || DEFAULT_API_BASE
}

/** 是否为同源相对基地址。 */
export function isSameOriginApiBase(apiBase: string): boolean {
  return apiBase.startsWith('/')
}

/**
 * 传输层硬约束：只接受 https，或同源相对路径，或 localhost 调试。
 *
 * 与 `docs/IP-BACKUP-DESIGN.md` §3 同一口径：HTTPS 页面请求 `http://<IP>` 会被浏览器
 * 以 mixed content 直接拦截且错误信息不明确，所以要在**输入时**就明确拒绝，
 * 不做静默失败。唯一豁免是 `localhost` / `127.0.0.1` / `[::1]`。
 */
export function assertSecureApiBase(apiBase: string, pageProtocol?: string): void {
  if (isSameOriginApiBase(apiBase)) {
    // 同源相对路径：协议由页面决定，不存在 mixed content。
    return
  }

  let url: URL
  try {
    url = new URL(apiBase)
  } catch {
    throw new CloudError('invalid_api_base', `服务器地址无效：${apiBase}`)
  }

  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && INSECURE_ALLOWED_HOSTS.has(url.hostname)) return

  const protocol = pageProtocol ?? globalThis.location?.protocol ?? ''
  if (url.protocol === 'http:' && protocol === 'https:') {
    throw new CloudError(
      'insecure_transport',
      'HTTPS 站点不能连接 http:// 服务器（浏览器会拦截混合内容）。请改用 https:// 地址。',
    )
  }
  throw new CloudError('insecure_transport', '云端服务器必须使用 https://（localhost 调试除外）。')
}

/** 读取运维注入配置。形状不合法时视为未注入。 */
export function readInjectedConfig(): InjectedCloudConfig | null {
  const raw = (globalThis as { __STORYFORGE_CLOUD__?: unknown }).__STORYFORGE_CLOUD__
  if (!raw || typeof raw !== 'object') return null
  const candidate = raw as Record<string, unknown>
  const enabled = candidate.enabled
  if (enabled !== true && enabled !== false && enabled !== 'auto') return null
  const apiBase = typeof candidate.apiBase === 'string' ? candidate.apiBase : undefined
  const probeTimeoutMs = typeof candidate.probeTimeoutMs === 'number' && candidate.probeTimeoutMs > 0
    ? candidate.probeTimeoutMs
    : undefined
  return { enabled, apiBase, probeTimeoutMs }
}

/** 读取本地保存的配置。损坏的 JSON 视为没有。 */
export function readStoredConfig(): StoredCloudConfig | null {
  try {
    const raw = globalThis.localStorage?.getItem(CLOUD_CONFIG_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (typeof parsed?.enabled !== 'boolean') return null
    if (typeof parsed?.apiBase !== 'string') return null
    return { enabled: parsed.enabled, apiBase: parsed.apiBase }
  } catch {
    return null
  }
}

/** 保存配置（只存地址与开关，**不存任何凭据**）。 */
export function writeStoredConfig(config: StoredCloudConfig): void {
  try {
    globalThis.localStorage?.setItem(CLOUD_CONFIG_STORAGE_KEY, JSON.stringify(config))
  } catch {
    // 隐私模式 / 配额满：忽略，本次会话仍然可用。
  }
}

/** 清除配置（回到纯本地模式）。 */
export function clearStoredConfig(): void {
  try {
    globalThis.localStorage?.removeItem(CLOUD_CONFIG_STORAGE_KEY)
  } catch {
    // ignore
  }
}

/**
 * 探测服务器是否为 StoryForge 云端。
 *
 * **绝不抛错**：任何失败（超时、网络、非 JSON、字段不符）都返回 `false`，
 * 由调用方降级为纯本地模式。超时用 `AbortController` 显式控制，
 * 不依赖 `AbortSignal.timeout`（部分浏览器版本缺失）。
 */
export async function probeCloudConfig(
  apiBase: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${apiBase}/config`, {
      method: 'GET',
      signal: controller.signal,
      credentials: 'include',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    })
    if (!response.ok) return false
    const body = await response.json().catch(() => null) as Record<string, unknown> | null
    return body?.app === 'storyforge' && body?.cloud === true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 解析最终生效的云端配置。**绝不抛错** —— 任何异常都降级为 `enabled:false`。
 *
 * @param injected 显式传入以便测试；缺省读取 `window.__STORYFORGE_CLOUD__`
 * @param stored   显式传入以便测试；缺省读取 localStorage
 */
export async function resolveCloudConfig(
  injected: InjectedCloudConfig | null = readInjectedConfig(),
  stored: StoredCloudConfig | null = readStoredConfig(),
): Promise<CloudConfig> {
  const disabled = (source: CloudConfig['source']): CloudConfig => ({
    enabled: false,
    apiBase: DEFAULT_API_BASE,
    source,
  })

  try {
    // 1. 运维注入优先级最高
    if (injected) {
      if (injected.enabled === false) return disabled('injected')

      const apiBase = normalizeApiBase(injected.apiBase ?? stored?.apiBase ?? DEFAULT_API_BASE)
      assertSecureApiBase(apiBase)

      if (injected.enabled === true) return { enabled: true, apiBase, source: 'injected' }

      // enabled === 'auto'：允许探测
      const probed = await probeCloudConfig(apiBase, injected.probeTimeoutMs)
      return probed ? { enabled: true, apiBase, source: 'probed' } : disabled('none')
    }

    // 2. 用户保存的配置
    if (stored?.enabled) {
      const apiBase = normalizeApiBase(stored.apiBase)
      assertSecureApiBase(apiBase)
      return { enabled: true, apiBase, source: 'stored' }
    }

    // 3. 什么都没配 → 纯本地
    return disabled('none')
  } catch {
    // 地址不安全 / 非法 → 静默降级为纯本地（设置页会单独报错）
    return disabled('none')
  }
}

/** 是否存在"值得加载云端模块"的线索（供 `main.tsx` 决定是否动态 import）。 */
export function hasCloudConfigHint(): boolean {
  if (readInjectedConfig()) return true
  try {
    return Boolean(globalThis.localStorage?.getItem(CLOUD_CONFIG_STORAGE_KEY))
  } catch {
    return false
  }
}
