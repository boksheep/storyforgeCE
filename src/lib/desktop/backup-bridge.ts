/**
 * 桌面版自动快照桥（L2）。
 *
 * 为什么需要它：手稿存在渲染进程的 IndexedDB 里，主进程读不到。
 * 主进程按周期、窗口关闭前、以及 Windows 注销/关机时，通过 IPC 请求一份
 * 「当前所有项目的 JSON 导出」，由主进程原子写入 `%APPDATA%/storyforge/backups/`。
 *
 * 为什么按周期而不是只在退出时导出：
 *   任务管理器结束进程、崩溃、断电都不会触发任何退出事件，
 *   只有周期性落盘才能覆盖这些情况；关闭窗口时再补一次，拿到最新内容。
 *
 * 导出的就是应用内「导出项目 JSON」的同一份格式，恢复时直接用「数据管理 → 导入」。
 * 网页版没有 window.__sfBackup，本模块整体 no-op。
 */
import { db } from '../db/schema'
import { exportProjectJSON } from '../export/json-export'
import { log } from '../logging/logger'

export interface DesktopSnapshotFile {
  /** 文件名主体（不含时间戳与扩展名），主进程会补时间戳 */
  name: string
  content: string
}

type SnapshotPayload = { files: DesktopSnapshotFile[] } | { error: string }

interface BackupBridge {
  onRequest(handler: (requestId: string) => void): void
  respond(requestId: string, payload: SnapshotPayload): void
}

declare global {
  interface Window {
    __sfBackup?: BackupBridge
  }
}

/** 文件名里不能出现的字符统一替换，避免主进程写文件失败。 */
function safeFileStem(project: { id?: number; name: string }): string {
  const name = (project.name || '未命名').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40)
  return `${project.id ?? 'x'}-${name}`
}

/**
 * 导出全部项目。单个项目失败不影响其它项目：
 * 快照是兜底手段，宁可少一份，也不能因为一个坏项目让整次备份失败。
 */
export async function collectDesktopSnapshots(): Promise<DesktopSnapshotFile[]> {
  const projects = await db.projects.toArray()
  const files: DesktopSnapshotFile[] = []
  for (const project of projects) {
    if (typeof project.id !== 'number') continue
    try {
      const data = await exportProjectJSON(project.id)
      files.push({ name: safeFileStem(project), content: JSON.stringify(data) })
    } catch (error) {
      log.error('AutoBackup', 'desktop.snapshot.export-failed', '导出项目快照失败', { projectId: project.id }, error)
    }
  }
  return files
}

let installed = false

/** 在应用启动时调用一次；重复调用与网页环境都会安全返回。 */
export function installDesktopBackupBridge(): void {
  const bridge = window.__sfBackup
  if (!bridge || installed) return
  installed = true

  bridge.onRequest(async requestId => {
    try {
      const files = await collectDesktopSnapshots()
      bridge.respond(requestId, { files })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      log.error('AutoBackup', 'desktop.snapshot.failed', '桌面快照失败', { fileCount: 0 }, error)
      bridge.respond(requestId, { error: message })
    }
  })

  log.info('AutoBackup', 'desktop.snapshot.ready', '桌面自动快照桥已就绪')
}
