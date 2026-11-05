/**
 * CLOUD-DB-1 · 写入捕获挂载点（**零依赖**，随 `schema.ts` 静态加载）
 *
 * ## 为什么必须放在 `schema.ts` 单例之后（而不是登录成功后）
 *
 * Dexie 的中间件栈在 `open()` 时被一次性构建并写死到 `db.core` 与每个 `table.core`
 * （`dexie.mjs` 的 `generateMiddlewareStacks()` 只在 open/upgrade 路径里被调用）。
 * 之后再调 `db.use()` 只会改 `_middlewares` 数组，**不会重建栈** —— 也就是说，
 * 在 `db.open()` 之后注册的中间件会静默失效，且没有任何报错。
 *
 * 因此本模块必须由 `schema.ts` 在 `export const db = new StoryForgeDB()` 之后立即调用。
 *
 * ## 为什么中间件里不能 await
 *
 * Dexie 事务是 zone 绑定的。在 `db.transaction('rw', db.chapters, ...)` 这类窄事务里
 * 等待非 Dexie promise 会让事务失效（`TransactionInactiveError`），
 * 后果是**用户写入失败、丢稿**。所以这里只做同步记账：
 * 读 `req.type` / `req.values` / `req.keys`，拿不到归属就交给上层降级为全库对账。
 *
 * ## 为什么始终挂载而不是按需挂载
 *
 * 无法卸载（栈已冻结），所以只能"始终挂载 + 布尔开关"。
 * 未启用云端时每个写入只多一次 `captureSlot.active` 判断，
 * 不分配对象、不碰 IO、不产生 Promise，行为等价于中间件不存在。
 */

/** Dexie `core.mutate()` 的请求形状（只列本模块用到的字段）。 */
export interface CaptureRequest {
  type: 'add' | 'put' | 'delete' | 'deleteRange'
  /** `add` / `put` 时为待写入的整行对象（hooks 修正后的最终值）。 */
  values?: unknown[]
  /** `delete` 时为待删除主键；`deleteRange` 时缺省。 */
  keys?: unknown[]
}

/**
 * 捕获回调。
 *
 * **必须是同步函数**：返回 `void`，不得返回 Promise。
 * 实现方只允许做内存/`localStorage` 记账，绝不允许发网络请求或 await Dexie 读。
 */
export type CaptureFn = (table: string, req: CaptureRequest) => void

/** 挂载点。`active === false` 时中间件是纯直通。 */
export const captureSlot: { active: boolean; fn: CaptureFn | null } = {
  active: false,
  fn: null,
}

/** 最小化的 Dexie 实例形状，避免本模块 import 整个 dexie 类型。 */
export interface MiddlewareHost {
  use(middleware: {
    stack: 'dbcore'
    level: number
    name: string
    create: (down: any) => any
  }): unknown
}

/**
 * 安装捕获中间件。**必须在任何 `db.open()` 之前调用**（见文件头）。
 *
 * 幂等：Dexie 的 `use()` 遇到同名中间件会先 `unuse` 再注册。
 */
export function installCaptureMiddleware(db: MiddlewareHost): void {
  db.use({
    stack: 'dbcore',
    level: 1,
    name: 'sf-cloud-capture',
    create: (down: any) => ({
      ...down,
      table(name: string) {
        const core = down.table(name)
        return {
          ...core,
          // 注意：这里不是 async 函数，直接返回 core.mutate(req) 的 Promise，
          // 不额外插入微任务，避免影响 Dexie 的事务 zone。
          mutate(req: CaptureRequest) {
            if (captureSlot.active && captureSlot.fn) {
              try {
                captureSlot.fn(name, req)
              } catch {
                // 捕获是纯旁路：任何异常都不得让用户的写入失败。
                // 漏记由「每日全库对账」兜底，代价远小于丢稿。
              }
            }
            return core.mutate(req)
          },
        }
      },
    }),
  })
}

/** 启用捕获（登录成功且云端已配置时由 `boot.ts` 调用）。 */
export function activateCapture(fn: CaptureFn): void {
  captureSlot.fn = fn
  captureSlot.active = true
}

/** 停用捕获（登出、断网降级、测试收尾）。保留 `fn` 以便快速恢复。 */
export function deactivateCapture(): void {
  captureSlot.active = false
}
