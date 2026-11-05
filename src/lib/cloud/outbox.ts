/**
 * CLOUD-DB-1 · 脏集（outbox）
 *
 * 存放"哪些项目/表可能变了"。刻意用 `localStorage` 而不是新建 IndexedDB 表或新库：
 *
 *  1. `setItem` 是**同步**的 —— 写入捕获发生在 Dexie 的 `mutate()` 里，只能同步记账
 *  2. `storage` 事件天然跨标签页，不需要额外的广播机制
 *  3. 不动 `PROJECT_TABLES`，保住"67 张表"的硬断言
 *
 * 语义是**只增不减（过近似）**：多记一条最多多推一次；少记一条就会丢数据。
 * 因此合并时永远取并集，绝不因为"看起来重复"就删条目。
 */
import type { DirtyEntry, DirtyProjectEntry, OutboxState } from './types'

const STORAGE_KEY = 'storyforge-cloud-outbox'
const OP_KEY_PREFIX = `${STORAGE_KEY}:op:`
const SCAN_KEY = `${STORAGE_KEY}:scan`
const LOCK_NAME = 'sf-cloud-outbox'
/** 单项目脏表上限：防止极端情况下数组无限增长。 */
const MAX_TABLES = 60

const EMPTY: OutboxState = { version: 1, entries: [] }

function safeParse(raw: string | null): OutboxState {
  if (!raw) return { ...EMPTY, entries: [] }
  try {
    const parsed = JSON.parse(raw) as OutboxState
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return { ...EMPTY, entries: [] }
    }
    return parsed
  } catch {
    return { ...EMPTY, entries: [] }
  }
}

function writeEntry(key: string, entry: DirtyEntry | null): void {
  try {
    if (!entry) globalThis.localStorage?.removeItem(key)
    else globalThis.localStorage?.setItem(key, JSON.stringify(entry))
  } catch {
    // 配额满 / 隐私模式：本次会话的内存态仍然可用，漏记由每日对账兜底
  }
}

function createEntryId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function writeLegacy(state: OutboxState): void {
  try {
    if (state.entries.length === 0) globalThis.localStorage?.removeItem(STORAGE_KEY)
    else globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch { /* quota/private mode */ }
}

function removeProjectEntries(projectId: number, capturedEntryIds?: Set<string>): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    const prefix = `${OP_KEY_PREFIX}${projectId}:`
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (!key?.startsWith(prefix)) continue
      if (capturedEntryIds && !capturedEntryIds.has(key.slice(prefix.length))) continue
      storage.removeItem(key)
    }
  } catch { /* storage unavailable */ }
}


function readEntries(): DirtyEntry[] {
  try {
    const storage = globalThis.localStorage
    if (!storage) return []
    const entries: DirtyEntry[] = []
    const legacy = safeParse(storage.getItem(STORAGE_KEY))
    entries.push(...legacy.entries)
    const scan = safeParseEntry(storage.getItem(SCAN_KEY))
    if (scan?.kind === 'scan') entries.push(scan)
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(OP_KEY_PREFIX)) continue
      const entry = safeParseEntry(storage.getItem(key))
      if (entry?.kind === 'project') {
        entry.entryIds = [key.slice(OP_KEY_PREFIX.length + String(entry.projectId).length + 1)]
        entries.push(entry)
      }
    }
    const projects = new Map<number, DirtyProjectEntry>()
    let scanEntry: DirtyEntry | undefined
    for (const entry of entries) {
      if (entry.kind === 'scan') scanEntry = entry
      else {
        const previous = projects.get(entry.projectId)
        if (!previous) projects.set(entry.projectId, entry)
        else {
          const opId = previous.opId ?? entry.opId
          const previousIds = previous.opId === opId ? (previous.entryIds ?? []) : []
          const currentIds = entry.opId === opId ? (entry.entryIds ?? []) : []
          projects.set(entry.projectId, {
            ...previous,
            tables: [...new Set([...previous.tables, ...entry.tables])].slice(0, MAX_TABLES),
            opId,
            firstAt: Math.min(previous.firstAt, entry.firstAt),
            lastAt: Math.max(previous.lastAt, entry.lastAt),
            entryIds: [...new Set([...previousIds, ...currentIds])],
          })
        }
      }
    }
    return [...projects.values(), ...(scanEntry ? [scanEntry] : [])]
  } catch {
    return []
  }
}

function safeParseEntry(raw: string | null): DirtyEntry | null {
  if (!raw) return null
  try {
    const entry = JSON.parse(raw) as DirtyEntry
    if (entry?.kind === 'scan' && Number.isFinite(entry.at)) return entry
    if (entry?.kind === 'project' && Number.isFinite(entry.projectId) && Array.isArray(entry.tables)) return entry
  } catch { /* corrupted entry */ }
  return null
}

/** 读取当前脏集（返回副本，调用方可随意修改）。 */
export function readOutbox(): OutboxState {
  return { ...EMPTY, entries: readEntries() }
}

/**
 * 标记"某个项目的某几张表脏了"。**同步、不抛错**，可在 Dexie 中间件里直接调用。
 */
export function markProjectDirty(projectId: number, tables: string[]): void {
  try {
    if (!Number.isFinite(projectId) || projectId <= 0) {
      markScan()
      return
    }
    const now = Date.now()
    const entry: DirtyProjectEntry = {
      kind: 'project', projectId, tables: [...new Set(tables)].slice(0, MAX_TABLES),
      opId: null, firstAt: now, lastAt: now,
    }
    writeEntry(`${OP_KEY_PREFIX}${projectId}:${createEntryId()}`, entry)
  } catch {
    // 捕获路径绝不能让用户写入失败
  }
}

/** 标记"需要全库对账"。保留已有项目条目（它们的 `opId` 必须留着）。 */
export function markScan(): void {
  try {
    const existing = safeParseEntry(globalThis.localStorage?.getItem(SCAN_KEY) ?? null)
    if (existing?.kind === 'scan') return
    writeEntry(SCAN_KEY, { kind: 'scan', at: Date.now() })
  } catch {
    // 同上
  }
}

/** 为某个项目持久化 `opId`（**必须在发请求之前**调用）。 */
export function stampOpId(projectId: number, opId: string, capturedEntryIds?: string[]): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    const prefix = `${OP_KEY_PREFIX}${projectId}:`
    let stamped = false
    const keysToStamp: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(prefix)) continue
      if (!capturedEntryIds || capturedEntryIds.includes(key.slice(prefix.length))) keysToStamp.push(key)
    }
    for (const key of keysToStamp) {
      const entry = safeParseEntry(storage.getItem(key))
      if (entry?.kind === 'project' && entry.opId == null) {
        entry.opId = opId
        writeEntry(key, entry)
        stamped = true
      }
    }
    if (stamped) return
    // Migrate the matching legacy entry into an independently stored record.
    const legacy = safeParse(storage.getItem(STORAGE_KEY))
    const index = legacy.entries.findIndex(entry => entry.kind === 'project'
      && entry.projectId === projectId && entry.opId == null
      && (!capturedEntryIds || capturedEntryIds.length === 0))
    if (index >= 0 && (!capturedEntryIds || capturedEntryIds.length === 0)) {
      const entry = legacy.entries[index] as DirtyProjectEntry
      entry.opId = opId
      writeEntry(`${OP_KEY_PREFIX}${projectId}:${createEntryId()}`, entry)
      legacy.entries.splice(index, 1)
      writeLegacy(legacy)
    }
  } catch {
    // ignore
  }
}

/** 清除某次推送已覆盖的记录，保留请求期间追加的无 opId 记录。 */
export function clearProjectByOpId(projectId: number, opId: string): void {
  try {
    const storage = globalThis.localStorage
    if (!storage) return
    const prefix = `${OP_KEY_PREFIX}${projectId}:`
    const keysToRemove: string[] = []
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(prefix)) continue
      const entry = safeParseEntry(storage.getItem(key))
      if (entry?.kind === 'project' && entry.opId === opId) keysToRemove.push(key)
    }
    for (const key of keysToRemove) storage.removeItem(key)
    const legacy = safeParse(storage.getItem(STORAGE_KEY))
    legacy.entries = legacy.entries.filter(entry => !(entry.kind === 'project' && entry.projectId === projectId && entry.opId === opId))
    writeLegacy(legacy)
  } catch { /* ignore */ }
}

/** 移除指定项目的脏记录（推送成功后调用）。 */
export function clearProject(projectId: number): void {
  try {
    removeProjectEntries(projectId)
    const legacy = safeParse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null)
    legacy.entries = legacy.entries.filter(entry => !(entry.kind === 'project' && entry.projectId === projectId))
    writeLegacy(legacy)
  } catch {
    // ignore
  }
}

/** 仅当项目脏记录仍是推送时捕获的版本才清除，保留请求期间的新编辑。 */
export function clearProjectEntries(projectId: number, capturedEntryIds: string[]): void {
  removeProjectEntries(projectId, new Set(capturedEntryIds))
  if (capturedEntryIds.length === 0) {
    const legacy = safeParse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null)
    legacy.entries = legacy.entries.filter(entry => !(entry.kind === 'project' && entry.projectId === projectId))
    writeLegacy(legacy)
  }
}

export function getProjectEntryIds(projectId: number): string[] {
  const ids: string[] = []
  try {
    const storage = globalThis.localStorage
    if (!storage) return ids
    const prefix = `${OP_KEY_PREFIX}${projectId}:`
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index)
      if (!key?.startsWith(prefix)) continue
      const entry = safeParseEntry(storage.getItem(key))
      if (entry?.kind === 'project' && entry.projectId === projectId) ids.push(key.slice(prefix.length))
    }
  } catch { /* storage unavailable */ }
  return ids
}

/** 移除 scan 标记（全库对账完成后调用）。 */
export function clearScan(): void {
  try {
    writeEntry(SCAN_KEY, null)
    const legacy = safeParse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? null)
    legacy.entries = legacy.entries.filter(entry => entry.kind !== 'scan')
    writeLegacy(legacy)
  } catch {
    // ignore
  }
}

/** 清空整个脏集（登出 / 关闭云端时调用）。 */
export function clearOutbox(): void {
  try {
    const storage = globalThis.localStorage
    storage?.removeItem(STORAGE_KEY)
    storage?.removeItem(SCAN_KEY)
    if (!storage) return
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index)
      if (key?.startsWith(OP_KEY_PREFIX)) storage.removeItem(key)
    }
  } catch { /* ignore */ }
}

/** 当前脏记录条数（UI 展示用）。 */
export function outboxCount(): number {
  return readOutbox().entries.length
}

/**
 * 在跨标签页互斥锁里执行。
 *
 * 两个标签页同时读改写 localStorage 会互相覆盖。用 Web Locks 把
 * "读 → 处理 → 清"整段串起来；浏览器不支持时退化为直接执行（单标签页场景无差别）。
 */
export async function withOutboxLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (globalThis.navigator as Navigator & { locks?: LockManager })?.locks
  if (!locks?.request) return fn()
  return locks.request(LOCK_NAME, { mode: 'exclusive' }, fn) as Promise<T>
}

/** 尝试获取"同步主"锁；拿不到说明别的标签页正在推。 */
export async function tryRunAsSyncLeader<T>(fn: () => Promise<T>): Promise<T | null> {
  const locks = (globalThis.navigator as Navigator & { locks?: LockManager })?.locks
  if (!locks?.request) return fn()

  return locks.request('sf-cloud-sync', { mode: 'exclusive', ifAvailable: true }, async (lock) => {
    if (!lock) return null
    return fn()
  }) as Promise<T | null>
}

/** 订阅脏集变化（含其他标签页的写入）。返回取消订阅函数。 */
export function subscribeOutbox(listener: () => void): () => void {
  const handler = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY || event.key === SCAN_KEY || event.key?.startsWith(OP_KEY_PREFIX) || event.key === null) listener()
  }
  globalThis.addEventListener?.('storage', handler)
  return () => globalThis.removeEventListener?.('storage', handler)
}

/** 读取一条项目脏记录（不存在返回 null）。 */
export function findProjectEntry(projectId: number): DirtyProjectEntry | null {
  const found = readOutbox().entries.find(
    (entry): entry is DirtyProjectEntry => entry.kind === 'project' && entry.projectId === projectId,
  )
  return found ?? null
}

/** 是否存在 scan 标记。 */
export function hasScan(): boolean {
  return readOutbox().entries.some(entry => entry.kind === 'scan')
}

export type { DirtyEntry }
