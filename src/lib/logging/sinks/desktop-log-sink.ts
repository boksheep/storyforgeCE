/**
 * LOG-1 · 桌面 sink：把日志交给 Electron 主进程写进应用目录的 `log/`。
 *
 * 渲染进程是 `sandbox: true` + `contextIsolation: true` + 无 Node 的，碰不到文件系统；
 * 因此由 `desktop/preload.mjs` 通过 `contextBridge` 暴露**极小**的一段 API：
 * 只有"追加若干行"、"报告位置"和"按天清理"，路径完全由主进程计算（调用方不能传路径）。
 *
 * 浏览器里 `window.__sfLog` 不存在 → 本 sink 不可用，由 `resolveLogSink()` 回落到 FSA。
 */
import type { LogSink, LogSinkDescription } from '../log-sink'

export interface DesktopLogBridge {
  append(lines: readonly string[]): Promise<boolean>
  describe(): Promise<{ dir: string; writable: boolean; reason?: string }>
  prune(keepDays: number): Promise<number>
}

declare global {
  interface Window {
    __sfLog?: DesktopLogBridge
  }
}

export function getDesktopLogBridge(): DesktopLogBridge | null {
  if (typeof window === 'undefined') return null
  const bridge = (window as Window).__sfLog
  return bridge && typeof bridge.append === 'function' ? bridge : null
}

export function hasDesktopLogBridge(): boolean {
  return getDesktopLogBridge() !== null
}

export const desktopLogSink: LogSink = {
  id: 'desktop',
  async describe(): Promise<LogSinkDescription> {
    const bridge = getDesktopLogBridge()
    if (!bridge) {
      return { id: 'desktop', label: '桌面日志桥不可用', writable: false, reason: 'window.__sfLog 不存在' }
    }
    try {
      const info = await bridge.describe()
      return {
        id: 'desktop',
        label: `应用目录 ${info.dir}`,
        path: info.dir,
        writable: info.writable,
        reason: info.reason,
      }
    } catch (error) {
      return {
        id: 'desktop',
        label: '应用目录（读取位置失败）',
        writable: false,
        reason: error instanceof Error ? error.name : 'unknown',
      }
    }
  },
  async append(lines) {
    const bridge = getDesktopLogBridge()
    if (!bridge || lines.length === 0) return false
    try {
      return await bridge.append(lines)
    } catch {
      return false
    }
  },
  async prune(keepDays) {
    const bridge = getDesktopLogBridge()
    if (!bridge) return 0
    try {
      return await bridge.prune(keepDays)
    } catch {
      return 0
    }
  },
}
