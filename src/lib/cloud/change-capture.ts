/**
 * CLOUD-DB-1 · 写入捕获实现（挂在 `captureSlot` 上）
 *
 * 中间件本体在 `capture-hook.ts`（零依赖、随 `schema.ts` 静态加载）。
 * 这里只负责"收到一次写入后怎么记账"，因此可以依赖注册表与 outbox。
 *
 * ## 两条硬规则
 *
 * 1. **同步、零 `await`**。中间件在 Dexie 的 `mutate()` 里执行，那里 `await`
 *    会让窄事务失效（`TransactionInactiveError`），后果是用户写入失败、丢稿。
 * 2. **拿不到归属就降级为全库对账**。宁可多算一次导出，也不为了精确归因去异步读库。
 */
import { PROJECT_TABLES } from '../registry/project-tables'
import { captureSlot, deactivateCapture, type CaptureRequest } from './capture-hook'
import { markProjectDirty, markScan } from './outbox'

/** 参与同步的表（55 张，含 projects）。 */
const SYNC_TABLES = new Set(
  PROJECT_TABLES.filter(spec => spec.exportable).map(spec => spec.name),
)

/**
 * 抑制计数。> 0 时捕获不记账。
 *
 * 用于"把云端数据写进本地"（拉取）—— 否则导入 55 张表会被当成用户编辑，
 * 立刻产生一次回推风暴。
 */
let suppressDepth = 0

function numericProjectIds(request: CaptureRequest): number[] {
  const values = request.values ?? []
  const ids = new Set<number>()
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const projectId = (value as { projectId?: unknown }).projectId
    if (typeof projectId === 'number' && Number.isFinite(projectId) && projectId > 0) {
      ids.add(projectId)
    }
  }
  return [...ids]
}

/** `projects` 表没有 `projectId` 字段，主键就是项目 id。 */
function projectRowIds(request: CaptureRequest): number[] {
  const values = request.values ?? []
  const ids = new Set<number>()
  for (const value of values) {
    if (!value || typeof value !== 'object') continue
    const id = (value as { id?: unknown }).id
    if (typeof id === 'number' && Number.isFinite(id) && id > 0) ids.add(id)
  }
  return [...ids]
}

function capture(table: string, request: CaptureRequest): void {
  if (suppressDepth > 0) return
  if (!SYNC_TABLES.has(table)) return

  // 新增 / 覆盖：`values` 里有完整行，可以同步拿到归属
  if (request.type === 'add' || request.type === 'put') {
    if (table === 'projects') {
      const ids = projectRowIds(request)
      // 新增项目时主键由 Dexie 生成（此时拿不到），降级为全库对账
      if (ids.length === 0) markScan()
      else for (const id of ids) markProjectDirty(id, [table])
      return
    }

    const ids = numericProjectIds(request)
    if (ids.length === 0) markScan()
    else for (const id of ids) markProjectDirty(id, [table])
    return
  }

  // 删除 / 按查询删除：行已不在或拿不到键，无法同步归因
  markScan()
}

/** 启用捕获（登录成功后由 `boot.ts` 调用）。 */
export function startCapture(): void {
  captureSlot.fn = capture
  captureSlot.active = true
}

/** 停用捕获（登出 / 关闭云端）。 */
export function stopCapture(): void {
  deactivateCapture()
  captureSlot.fn = null
}

export function isCaptureActive(): boolean {
  return captureSlot.active
}

/**
 * 在"不记账"的前提下执行一段写入。
 *
 * **必须与收尾的全库对账配对**：抑制期间若有用户并发编辑，那些写入不会被记账，
 * 只能靠随后的一次 `scan` 兜住。所以 `finally` 里无条件 `markScan()`
 * —— 多扫一次是成本，漏一次就是丢数据。
 */
export async function withCaptureSuppressed<T>(fn: () => Promise<T>): Promise<T> {
  suppressDepth += 1
  try {
    return await fn()
  } finally {
    suppressDepth -= 1
    if (suppressDepth === 0) markScan()
  }
}

/** 仅测试使用：重置抑制计数（异常路径残留时兜底）。 */
export function __resetSuppressionForTest(): void {
  suppressDepth = 0
}
