/**
 * CLOUD-DB-1 · 同步状态（供 UI 读取）
 *
 * 只放**状态**，不放动作逻辑：真正的推送在 `src/lib/cloud/sync-engine.ts`。
 * 这样组件不必把引擎拉进入口包，引擎也不必反向依赖 store 的行为。
 */
import { create } from 'zustand'
import type { CloudSyncPhase, RemoteConflictSummary } from '../lib/cloud/types'

export interface CloudConflict {
  projectId: number
  projectName: string
  projectUid: string
  remote: RemoteConflictSummary
}

interface CloudSyncState {
  phase: CloudSyncPhase
  /** 最近一次成功推送的时间戳。 */
  lastPushAt: number | null
  /** 最近一次失败的可读原因（成功时清空）。 */
  lastError: string | null
  /** 待推送的脏记录条数。 */
  dirtyCount: number
  /** 本次运行累计推送成功的项目数（会话内）。 */
  pushedCount: number
  /** 当前阻塞推送的冲突（同一时刻只处理一个）。 */
  conflict: CloudConflict | null

  setPhase: (phase: CloudSyncPhase) => void
  setError: (message: string | null) => void
  setDirtyCount: (count: number) => void
  markPushed: (at: number) => void
  setConflict: (conflict: CloudConflict | null) => void
  reset: () => void
}

const INITIAL = {
  phase: 'disabled' as CloudSyncPhase,
  lastPushAt: null as number | null,
  lastError: null as string | null,
  dirtyCount: 0,
  pushedCount: 0,
  conflict: null as CloudConflict | null,
}

export const useCloudSync = create<CloudSyncState>((set) => ({
  ...INITIAL,

  setPhase: (phase) => set({ phase }),
  setError: (lastError) => set({ lastError }),
  setDirtyCount: (dirtyCount) => set({ dirtyCount }),
  markPushed: (at) => set(state => ({
    lastPushAt: at,
    pushedCount: state.pushedCount + 1,
    lastError: null,
  })),
  setConflict: (conflict) => set({ conflict, phase: conflict ? 'conflict' : 'idle' }),
  reset: () => set({ ...INITIAL }),
}))
