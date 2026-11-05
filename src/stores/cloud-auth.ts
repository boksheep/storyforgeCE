/**
 * CLOUD-DB-1 · 云端账号状态
 *
 * 职责边界：
 *   - 本 store 只管"谁登录了、服务器地址是什么、上一次错误是什么"
 *   - 真正的推送在 `src/lib/cloud/sync-engine.ts`，写入捕获在 `change-capture.ts`
 *   - 两者由 `boot.ts` 通过 `registerCloudLifecycle()` 挂进来，
 *     避免 store ↔ engine 互相 import 形成环
 */
import { create } from 'zustand'
import * as api from '../lib/cloud/client'
import {
  assertSecureApiBase,
  clearStoredConfig,
  normalizeApiBase,
  writeStoredConfig,
} from '../lib/cloud/config'
import { CloudError, type CloudCaptcha, type CloudConfig } from '../lib/cloud/types'

export type CloudAuthStatus = 'unknown' | 'anon' | 'authed' | 'offline'

interface CloudUser {
  id: number
  username: string
  role: string
}

interface CloudAuthState {
  status: CloudAuthStatus
  enabled: boolean
  apiBase: string
  source: CloudConfig['source']
  user: CloudUser | null
  expiresAt: number | null
  busy: boolean
  error: string | null
  /**
   * 服务端是否要求验证码。
   *
   * **这个值只由服务端决定**：客户端传不传、传什么都不影响判定
   * （服务端看的是"这个 IP 在窗口内的失败次数"）。这里存它只是为了
   * 决定"要不要把验证码输入框显示出来"。
   */
  captchaRequired: boolean
  captcha: CloudCaptcha | null
  /** 验证码图片本身加载失败时的提示（不影响登录流程）。 */
  captchaError: string | null

  applyConfig: (config: CloudConfig) => void
  saveServer: (apiBase: string) => Promise<boolean>
  disableCloud: () => void
  refresh: () => Promise<void>
  login: (username: string, password: string, captchaAnswer?: string) => Promise<boolean>
  refreshCaptcha: () => Promise<void>
  clearCaptcha: () => void
  logout: () => Promise<void>
  markExpired: () => void
  clearError: () => void
}

interface LifecycleHooks {
  onAuthed?: () => void | Promise<void>
  onLoggedOut?: () => void | Promise<void>
}

let hooks: LifecycleHooks = {}

/** 由 `boot.ts` 注册（捕获安装、引擎启停都挂在登录生命周期上）。 */
export function registerCloudLifecycle(next: LifecycleHooks): void {
  hooks = next
}

function messageOf(error: unknown): string {
  if (error instanceof CloudError) return error.message
  return (error as Error)?.message ?? '未知错误'
}

export const useCloudAuth = create<CloudAuthState>((set, get) => ({
  status: 'unknown',
  enabled: false,
  apiBase: '/api',
  source: 'none',
  user: null,
  expiresAt: null,
  busy: false,
  error: null,
  captchaRequired: false,
  captcha: null,
  captchaError: null,

  applyConfig: (config) => {
    api.setActiveConfig(config)
    set({
      enabled: config.enabled,
      apiBase: config.apiBase,
      source: config.source,
      status: config.enabled ? 'unknown' : 'anon',
    })
  },

  /**
   * 保存服务器地址并立即校验一次。
   *
   * 地址校验在**输入时**做（而不是等同步失败），因为 HTTPS 页面请求 `http://`
   * 会被浏览器以 mixed content 静默拦截，错误信息极难理解。
   */
  saveServer: async (rawApiBase) => {
    const apiBase = normalizeApiBase(rawApiBase)
    set({ busy: true, error: null })
    try {
      assertSecureApiBase(apiBase)
      writeStoredConfig({ enabled: true, apiBase })
      const config: CloudConfig = { enabled: true, apiBase, source: 'stored' }
      get().applyConfig(config)
      await get().refresh()
      return true
    } catch (error) {
      set({ busy: false, error: messageOf(error) })
      return false
    } finally {
      set({ busy: false })
    }
  },

  disableCloud: () => {
    clearStoredConfig()
    api.setActiveConfig(null)
    set({
      enabled: false,
      status: 'anon',
      user: null,
      expiresAt: null,
      source: 'none',
      error: null,
      captchaRequired: false,
      captcha: null,
      captchaError: null,
    })
    void hooks.onLoggedOut?.()
  },

  refresh: async () => {
    if (!get().enabled) {
      set({ status: 'anon', user: null })
      return
    }
    try {
      const result = await api.me()
      set({
        status: 'authed',
        user: result.user,
        expiresAt: result.expiresAt,
        error: null,
      })
      await hooks.onAuthed?.()
    } catch (error) {
      if (error instanceof CloudError && error.code === 'unauthorized') {
        set({ status: 'anon', user: null, expiresAt: null })
        return
      }
      // 网络不通：保留"上次登录过"的乐观状态，避免离线时把用户踢出登录态
      set({ status: 'offline', error: messageOf(error) })
    }
  },

  login: async (username, password, captchaAnswer) => {
    set({ busy: true, error: null })
    const current = get().captcha
    // 只有"服务端要验证码 + 用户填了答案 + 手里有未用过的题"时才带上去。
    // 服务端不看这个字段决定"要不要验证码"，所以这里少传不会造成漏洞，只会被拒。
    const payload = current && captchaAnswer?.trim()
      ? { id: current.id, answer: captchaAnswer.trim() }
      : null
    try {
      await api.login(username, password, payload)
      const result = await api.me()
      set({
        status: 'authed',
        user: result.user,
        expiresAt: result.expiresAt,
        busy: false,
        captchaRequired: false,
        captcha: null,
        captchaError: null,
      })
      await hooks.onAuthed?.()
      return true
    } catch (error) {
      const needsCaptcha = error instanceof CloudError && error.captchaRequired
      set({ busy: false, error: messageOf(error), captchaRequired: needsCaptcha })
      // 挑战是**一次性**的：无论答错还是过期，服务端都已作废，必须换一张。
      if (needsCaptcha) await get().refreshCaptcha()
      return false
    }
  },

  refreshCaptcha: async () => {
    if (!get().enabled) return
    try {
      const captcha = await api.fetchCaptcha()
      set({ captcha, captchaError: null })
    } catch (error) {
      set({ captcha: null, captchaError: messageOf(error) })
    }
  },

  clearCaptcha: () => set({ captchaRequired: false, captcha: null, captchaError: null }),

  logout: async () => {
    set({ busy: true })
    try {
      await api.logout()
    } catch {
      // 服务端不可达也要让本地退出，避免"退不出去"
    }
    set({
      status: 'anon',
      user: null,
      expiresAt: null,
      busy: false,
      error: null,
      captchaRequired: false,
      captcha: null,
      captchaError: null,
    })
    await hooks.onLoggedOut?.()
  },

  markExpired: () => set({
    status: 'anon',
    user: null,
    expiresAt: null,
    error: '登录已失效，请重新登录',
    captchaRequired: false,
    captcha: null,
  }),

  clearError: () => set({ error: null }),
}))
