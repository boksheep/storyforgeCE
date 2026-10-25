/**
 * DB-SAFETY-1 · 库外恢复哨兵（Rescue Vault）
 *
 * ## 为什么需要它（真实事故的根因）
 *
 * 项目里已有三层"看起来能保命"的机制，但它们全部**住在主库里面**：
 *
 *   · `snapshots` 版本历史   → 与主库同库（`PROJECT_TABLES` 里 owner:'project'，exportable:false）
 *   · 5 分钟自动快照          → 写进 `snapshots`，同上
 *   · `navigator.storage.persist()` → 只防**浏览器驱逐**，不防**代码删除**
 *
 * 于是当程序逻辑走到 `Dexie.delete('storyforge')`（R-17b 真实事故：加一张表就在
 * 首次加载时删掉了作者全部手稿）时，快照与被删的数据**一起消失**——备份和原件放在
 * 同一个箱子里，箱子被扔掉，备份也没了。
 *
 * ## 本模块的解法
 *
 * 把"最后一层恢复副本"放进一个**物理独立的 IndexedDB 库**（`storyforge-rescue`），
 * 它不属于 Dexie 主库、不进三注册表——因为它是**基础设施**（像 FSA 句柄库
 * `storyforge-fsa` 一样），不是项目业务数据，既不参与导出也不参与项目生命周期。
 *
 * 关键性质（这是整个方案的成立前提，改动前请先读懂）：
 *   ✅ `Dexie.delete('storyforge')` 不会碰它
 *   ✅ `cascadeDeleteProject` / `deleteGroup` / 各类迁移都不会碰它
 *   ✅ 主库迁移写坏（schema 升级中途抛错）也不影响它
 *
 * 唯一的失效场景是用户清空**整个站点数据**——那时连主库带哨兵一起没，
 * 此时只能靠 Gist / 本地文件夹这类**浏览器之外**的冗余（UI 文案不得夸大保证）。
 *
 * ## 写入来源
 *
 * 只用既有的唯一导出入口 `exportProjectJSON()`（注册表派生），
 * **不新造平行导出路径**——否则又违反三注册表收口原则。
 */
import { exportProjectJSON, importProjectJSON } from '../export/json-export'
import { log } from '../logging/logger'

/**
 * ⚠️ 必须是**独立库名**，绝不能改成 'storyforge'。
 * 这里是整个数据安全方案的支点：库名一致 = 哨兵随主库一起被删 = 方案失效。
 */
const DB_NAME = 'storyforge-rescue'
const STORE = 'rescues'

/** 每个项目最多保留的哨兵份数（滚动淘汰最旧的）。 */
const MAX_PER_PROJECT = 5
/** 全局最多保留的哨兵份数（防止多项目把配额吃光）。 */
const MAX_TOTAL = 40

/** 存储记录：一份"库外"的项目完整副本。 */
export interface RescueRecord {
  id?: number
  projectId: number
  projectName: string
  /** 完整项目 JSON（与导出格式同一契约 ProjectExportData） */
  data: string
  size: number
  createdAt: number
  /** 写入原因，便于事后追溯是哪条路径救的命 */
  reason: RescueReason
}

export type RescueReason =
  | 'auto'            // 定时自动（跟随既有 5 分钟节拍）
  | 'project-switch'  // 切换项目
  | 'before-reset'    // 删库前最后一次落盘（最关键的一份）
  | 'manual'

/** 哨兵库是否可用（测试与不支持 IndexedDB 的环境需优雅降级）。 */
export function isRescueVaultSupported(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null
  } catch {
    return false
  }
}

/** 打开哨兵库（首次调用时按需建表；与主库版本号完全无关）。 */
function openVault(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      const database = req.result
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true })
        store.createIndex('projectId', 'projectId', { unique: false })
        store.createIndex('createdAt', 'createdAt', { unique: false })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('恢复哨兵库打开被阻塞'))
  })
}

/** 在一个事务里跑一段操作，结束后关闭连接。 */
async function withVault<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  const database = await openVault()
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = database.transaction(STORE, mode)
      const request = fn(tx.objectStore(STORE))
      let result: T
      request.onsuccess = () => { result = request.result as T }
      request.onerror = () => reject(request.error)
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    database.close()
  }
}

/** 读全部记录（按时间升序）。 */
async function readAll(): Promise<RescueRecord[]> {
  const rows = await withVault<RescueRecord[]>('readonly', store => store.getAll())
  return (rows ?? []).sort((a, b) => a.createdAt - b.createdAt)
}

/** 淘汰超额记录：先按项目内保留最新 N 份，再按全局上限滚动淘汰。 */
async function pruneVault(): Promise<void> {
  const all = await readAll()
  if (all.length === 0) return

  const doomed: number[] = []

  // (1) 项目内保留最新 MAX_PER_PROJECT 份
  const byProject = new Map<number, RescueRecord[]>()
  for (const row of all) {
    const list = byProject.get(row.projectId) ?? []
    list.push(row)
    byProject.set(row.projectId, list)
  }
  for (const list of byProject.values()) {
    for (const row of list.slice(0, Math.max(0, list.length - MAX_PER_PROJECT))) {
      if (row.id != null) doomed.push(row.id)
    }
  }

  // (2) 全局上限：最旧的先走
  const survivors = all.filter(row => row.id == null || !doomed.includes(row.id))
  if (survivors.length > MAX_TOTAL) {
    for (const row of survivors.slice(0, survivors.length - MAX_TOTAL)) {
      if (row.id != null && !doomed.includes(row.id)) doomed.push(row.id)
    }
  }

  for (const id of doomed) {
    await withVault('readwrite', store => store.delete(id))
  }
}

/**
 * 把某项目的一份完整副本写进哨兵库。
 *
 * 返回是否成功；**任何失败都只记日志、不抛错**——哨兵是纵深防御，
 * 不能因为写不进去（配额满 / 隐私模式）就把主流程带崩。
 */
export async function writeRescue(projectId: number, reason: RescueReason): Promise<boolean> {
  if (!isRescueVaultSupported()) return false
  try {
    const data = await exportProjectJSON(projectId)
    const json = JSON.stringify(data)
    const record: RescueRecord = {
      projectId,
      projectName: data.project?.name ?? `项目 ${projectId}`,
      data: json,
      size: new Blob([json]).size,
      createdAt: Date.now(),
      reason,
    }
    await withVault<IDBValidKey>('readwrite', store => store.add(record))
    await pruneVault()
    log.info('RescueVault', 'rescue.write',
      `[rescue] 已落库外副本(${reason}): ${record.projectName}`,
      { projectId, size: record.size, reason })
    return true
  } catch (err) {
    log.error('RescueVault', 'rescue.write', '[rescue] 写入库外副本失败(不影响主流程)', undefined, err)
    return false
  }
}

/** 列出全部哨兵（按时间倒序，最新在前）。 */
export async function listRescue(): Promise<RescueRecord[]> {
  if (!isRescueVaultSupported()) return []
  try {
    const all = await readAll()
    return all.reverse()
  } catch (err) {
    log.error('RescueVault', 'rescue.read', '[rescue] 读取哨兵列表失败', undefined, err)
    return []
  }
}

/** 列某项目的哨兵（按时间倒序）。 */
export async function listRescueForProject(projectId: number): Promise<RescueRecord[]> {
  const all = await listRescue()
  return all.filter(row => row.projectId === projectId)
}

/**
 * 取最新的一份可恢复副本。
 *
 * 传入 projectId 则限定该项目；不传则在全局取最新的一份
 * （用于「主库被整体清空」后连项目 ID 都无从谈起的场景）。
 */
export async function readLatestRescue(projectId?: number): Promise<RescueRecord | null> {
  const all = await listRescue() // 已按时间倒序
  if (all.length === 0) return null
  if (projectId == null) return all[0]
  return all.find(row => row.projectId === projectId) ?? null
}

/**
 * 把一份哨兵恢复成**新项目**（走既有 `importProjectJSON` 入口）。
 *
 * 刻意不覆盖任何现有项目：`importProjectJSON` 会给导入的项目改名，
 * 因此自愈是"新增一个项目"，而不是破坏性写回——即使误判也不会二次伤数据。
 */
export async function restoreRescue(record: RescueRecord): Promise<number | null> {
  try {
    const parsed = JSON.parse(record.data)
    const newProjectId = await importProjectJSON(parsed)
    log.info('RescueVault', 'rescue.restore',
      `[rescue] 已从库外副本恢复项目: ${record.projectName}`, { newProjectId, from: record.projectId })
    return newProjectId
  } catch (err) {
    log.error('RescueVault', 'rescue.restore', '[rescue] 从哨兵恢复失败', undefined, err)
    return null
  }
}

// ─────────────────────────────────────────────────────────────
// 删库前落盘（给 ensureSchema 用）
// ─────────────────────────────────────────────────────────────

/**
 * 删库前把**所有**项目各存一份哨兵。
 *
 * ⚠️ 这个函数在 `ensureSchema` 判定"要删库"之后、`Dexie.delete` 之前被调用，
 * 它本身就是最后一道防线——所以它内部**绝不允许**依赖任何可能在此时已经坏掉的
 * 主库查询（如 `db.projects.toArray()`）：主库结构异常时 Dexie 可能直接抛错，
 * 那样最需要备份的时刻反而备不了。
 *
 * 因此这里直接用**原生 indexedDB** 读主库的 projects 表（不经过 Dexie），
 * 读不到就退化为"不做任何事"，绝不抛错。
 *
 * @returns 成功落盘的项目数
 */
export async function captureAllProjectsBeforeReset(): Promise<number> {
  if (!isRescueVaultSupported()) return 0
  let projectIds: number[] = []
  try {
    projectIds = await readProjectIdsNatively()
  } catch (err) {
    log.warn('RescueVault', 'rescue.capture',
      '[rescue] 删库前无法枚举项目(主库可能已异常)，跳过落盘', { error: String(err) })
    return 0
  }

  let saved = 0
  for (const id of projectIds) {
    // 注意：此处的 exportProjectJSON 走 Dexie，主库正在被判定为"要删"，
    // 但仍能打开（保证是"结构异常"而非"完全打不开"）。失败的项目逐个跳过。
    if (await writeRescue(id, 'before-reset')) saved += 1
  }
  if (saved > 0) {
    log.info('RescueVault', 'rescue.capture',
      `[rescue] 删库前已抢救 ${saved}/${projectIds.length} 个项目到库外副本`)
  }
  return saved
}

/** 用原生 indexedDB 只读枚举主库 projects 表的主键（不依赖 Dexie）。 */
function readProjectIdsNatively(): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('storyforge')
    let createdEmpty = false
    req.onupgradeneeded = () => { createdEmpty = true }
    req.onsuccess = () => {
      const database = req.result
      try {
        if (createdEmpty || !database.objectStoreNames.contains('projects')) {
          database.close()
          resolve([])
          return
        }
        const tx = database.transaction('projects', 'readonly')
        const keysReq = tx.objectStore('projects').getAllKeys()
        keysReq.onsuccess = () => {
          const keys = (keysReq.result ?? []) as IDBValidKey[]
          resolve(keys.filter((k): k is number => typeof k === 'number'))
        }
        keysReq.onerror = () => reject(keysReq.error)
        tx.oncomplete = () => database.close()
        tx.onerror = () => reject(tx.error)
      } catch (err) {
        try { database.close() } catch { /* 关闭失败无所谓 */ }
        reject(err)
      }
    }
    req.onerror = () => reject(req.error)
    req.onblocked = () => reject(new Error('主库打开被阻塞'))
  })
}

/** 清空哨兵库（仅供测试与"用户显式清理"使用）。 */
export async function clearRescueVault(): Promise<void> {
  if (!isRescueVaultSupported()) return
  try {
    await withVault('readwrite', store => store.clear())
  } catch (err) {
    log.error('RescueVault', 'rescue.clear', '[rescue] 清空哨兵库失败', undefined, err)
  }
}

/** 删除某项目的全部哨兵（项目被用户**主动**删除时调用，避免哨兵无限堆积）。 */
export async function clearRescueForProject(projectId: number): Promise<void> {
  if (!isRescueVaultSupported()) return
  try {
    const rows = await listRescueForProject(projectId)
    for (const row of rows) {
      if (row.id != null) await withVault('readwrite', store => store.delete(row.id!))
    }
  } catch (err) {
    log.error('RescueVault', 'rescue.clear', '[rescue] 清理项目哨兵失败', undefined, err)
  }
}


