/**
 * CLOUD-DB-1 · 云端占用与在线状态
 *
 * 为什么单独一个 store，而不是让按钮和弹窗各查一次：
 *   - 顶栏按钮（首页 / 工作区）和账号弹窗要显示**同一份**数字，
 *     各查一次会出现"按钮说 12.3 MB、弹窗说 12.1 MB"的不一致
 *   - 顶栏按钮在多个页面同时挂载，逐组件 useEffect 会产生重复请求
 *
 * 数据来源只有一个：`GET /api/sync/status`（只返回元数据，不含载荷）。
 * 这个接口能通 = 服务器在线；失败 = 离线。不需要额外的健康探测。
 */
import { create } from 'zustand'
import { listStatus } from '../lib/cloud/client'
import { useCloudAuth } from './cloud-auth'

interface CloudUsageState {
  /** 服务端所有项目 `size_bytes` 之和。 */
  usedBytes: number
  projectCount: number
  /** `null` = 还没探测过（不要当成"离线"渲染）。 */
  online: boolean | null
  loading: boolean
  lastCheckedAt: number | null
  error: string | null

  refresh: () => Promise<void>
  reset: () => void
}

let inFlight: Promise<void> | null = null

export const useCloudUsage = create<CloudUsageState>((set) => ({
  usedBytes: 0,
  projectCount: 0,
  online: null,
  loading: false,
  lastCheckedAt: null,
  error: null,

  refresh: async () => {
    // 已有一轮在跑就复用它：两个顶栏按钮 + 弹窗同时打开时只发一个请求
    if (inFlight) return inFlight

    const auth = useCloudAuth.getState()
    if (!auth.enabled || auth.status !== 'authed') {
      set({ usedBytes: 0, projectCount: 0, online: null, loading: false, error: null })
      return
    }

    set({ loading: true, error: null })
    inFlight = (async () => {
      try {
        const projects = await listStatus()
        const usedBytes = projects.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)
        set({
          usedBytes,
          projectCount: projects.length,
          online: true,
          loading: false,
          lastCheckedAt: Date.now(),
          error: null,
        })
      } catch (error) {
        // 离线是**正常状态**（本地优先），不当成错误弹提示，只标记状态
        set({
          online: false,
          loading: false,
          lastCheckedAt: Date.now(),
          error: (error as Error)?.message ?? '无法连接服务器',
        })
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  },

  reset: () => set({
    usedBytes: 0,
    projectCount: 0,
    online: null,
    loading: false,
    lastCheckedAt: null,
    error: null,
  }),
}))
