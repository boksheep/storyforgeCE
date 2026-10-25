/**
 * LOG-1 · 浏览器 sink：用户绑定文件夹下的 `log/` 子目录。
 *
 * 复用既有的 File System Access 基础设施（`folder-backup.ts` 的选目录/授权判断 +
 * `folder-handle-store.ts` 的句柄持久化），因此：
 * - 绑定一次就记住（句柄存独立 IndexedDB，刷新/更新都不丢）；
 * - 授权失效时**静默跳过但如实报告不可写**（不弹窗打扰，这也是既有自动备份的策略）；
 * - 与项目备份互不干扰：备份扫的是根目录 `storyforge-*.json`，我们只写 `log/*.txt`。
 *
 * ⚠️ FSA 没有 append：续写靠 `createWritable({ keepExistingData: true })` + 定位到文件末尾写入。
 * 这是本模块唯一非显然的地方，也是"日志文件不会每次都被覆盖"的关键。
 */
import {
  ensureFolderPermission,
  folderPermissionGranted,
  pickFolder,
} from '../../storage/folder-backup'
import { loadFolderHandle, LOG_FOLDER_KEY, saveFolderHandle } from '../../storage/folder-handle-store'
import {
  LOG_DIR_NAME,
  LOG_FILE_MAX_BYTES,
  buildLogFilename,
  estimateLinesBytes,
  isExpiredLogFile,
  noneLogSink,
  parseLogFilename,
  type LogSink,
  type LogSinkDescription,
} from '../log-sink'

/**
 * 目录句柄的最小结构面。
 * 不 `extends FileSystemDirectoryHandle`：`entries` / `removeEntry` 在 TS 的 DOM 类型里
 * 并非所有目标都有（且可空性不同），继承会直接报不兼容；这里按"我们用到的能力"描述，
 * 用 `as unknown as` 从真实句柄转过来。
 */
interface LogDirectoryHandle {
  entries?: () => AsyncIterableIterator<[string, { kind: string }]>
  removeEntry?: (name: string, options?: { recursive?: boolean }) => Promise<void>
  getFileHandle: (name: string, options?: { create?: boolean }) => Promise<FileSystemFileHandle>
}

function asLogDirectory(handle: FileSystemDirectoryHandle | null): LogDirectoryHandle | null {
  return handle ? handle as unknown as LogDirectoryHandle : null
}

async function logDirectory(create: boolean): Promise<LogDirectoryHandle | null> {
  const root = await loadFolderHandle(LOG_FOLDER_KEY)
  if (!root) return null
  if (!(await folderPermissionGranted(root))) return null
  try {
    return asLogDirectory(await root.getDirectoryHandle(LOG_DIR_NAME, { create }))
  } catch {
    return null
  }
}

/** 当前是否可用（静态判断，不弹授权窗）。 */
export async function isFsaLogSinkAvailable(): Promise<boolean> {
  const root = await loadFolderHandle(LOG_FOLDER_KEY)
  if (!root) return false
  return await folderPermissionGranted(root)
}

export const fsaLogSink: LogSink = {
  id: 'fsa',
  async describe(): Promise<LogSinkDescription> {
    const root = await loadFolderHandle(LOG_FOLDER_KEY)
    if (!root) {
      return {
        id: 'fsa',
        label: '未绑定日志文件夹',
        writable: false,
        reason: '尚未选择本地文件夹（浏览器无法自行创建目录）',
      }
    }
    const granted = await folderPermissionGranted(root)
    return {
      id: 'fsa',
      label: `绑定文件夹 /${LOG_DIR_NAME}`,
      writable: granted,
      reason: granted ? undefined : '文件夹授权已失效，需在数据管理面板重新授权',
    }
  },
  async append(lines) {
    if (lines.length === 0) return false
    const dir = await logDirectory(true)
    if (!dir) return false
    const now = new Date()
    // 轮转：当日文件超过上限就写 -2、-3…
    let index = 1
    let handle: FileSystemFileHandle
    let existingBytes = 0
    for (;;) {
      handle = await dir.getFileHandle(buildLogFilename(now, index), { create: true })
      const file = await handle.getFile()
      existingBytes = file.size
      if (existingBytes + estimateLinesBytes(lines) <= LOG_FILE_MAX_BYTES || index >= 20) break
      index++
    }
    try {
      const writable = await (handle as FileSystemFileHandle & {
        createWritable: (options?: { keepExistingData?: boolean }) => Promise<FileSystemWritableFileStream>
      }).createWritable({ keepExistingData: true })
      // FSA 没有 append：定位到已有内容末尾再写，等价于追加。
      await writable.write({ type: 'write', position: existingBytes, data: `${lines.join('\n')}\n` })
      await writable.close()
      return true
    } catch {
      return false
    }
  },
  async prune(keepDays) {
    const dir = await logDirectory(false)
    if (!dir?.entries || !dir.removeEntry) return 0
    const now = new Date()
    let removed = 0
    for await (const [name, entry] of dir.entries()) {
      if (entry.kind !== 'file') continue
      if (!parseLogFilename(name)) continue          // 不是我们的文件：绝不动
      if (!isExpiredLogFile(name, now, keepDays)) continue
      try {
        await dir.removeEntry(name)
        removed++
      } catch {
        // 单个文件删不掉不影响其它文件与主流程
      }
    }
    return removed
  },
}

/**
 * 让用户挑一个文件夹作为日志目录（必须由用户手势触发）。返回是否绑定成功。
 */
export async function bindLogFolder(): Promise<boolean> {
  const handle = await pickFolder()
  if (!handle) return false
  if (!(await ensureFolderPermission(handle))) return false
  await saveFolderHandle(LOG_FOLDER_KEY, handle)
  return true
}

/** 绑定文件夹里已有的日志文件（供 UI 展示与测试断言）。 */
export async function listLogFiles(): Promise<Array<{ name: string; size: number }>> {
  const dir = await logDirectory(false)
  if (!dir?.entries) return []
  const files: Array<{ name: string; size: number }> = []
  for await (const [name, entry] of dir.entries()) {
    if (entry.kind !== 'file' || !parseLogFilename(name)) continue
    try {
      const fileHandle = await dir.getFileHandle(name)
      const file = await fileHandle.getFile()
      files.push({ name, size: file.size })
    } catch {
      // 读不到就跳过
    }
  }
  return files.sort((a, b) => a.name.localeCompare(b.name))
}

/** 供测试/诊断：日志目录下当前应当写入的文件名。 */
export function currentLogFilename(now = new Date()): string {
  return buildLogFilename(now, 1)
}

/** 未绑定时的兜底（保持导出集中，避免调用方各自 import noneLogSink）。 */
export { noneLogSink }
