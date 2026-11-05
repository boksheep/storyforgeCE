/**
 * CLOUD-DB-1 · 同步引擎
 *
 * ## 推送单元是"整个项目"
 *
 * 前端导出的外键是**表内下标**（`exportRemap` → `_exportId`），任一张表行序变化都会
 * 让别的表的下标失效。所以"只传变化的表"是错误协议；正确形态是整包一致传输 +
 * 服务端按表落盘 + 表级哈希跳过未变表。
 *
 * ## 三个必须守住的细节
 *
 * 1. **`opId` 必须先落盘再发请求**：推送成功但响应丢失时，重试要用同一个 opId；
 *    否则服务端因 `baseRev` 过期返回 409，用户会误以为冲突并选择"覆盖云端"。
 * 2. **内容哈希必须剔除 `exportedAt`**：否则"没变就跳过"永不命中，退化成定时全量上传。
 * 3. **导出完整性闸门**：本地行数 ≠ 导出行数时**拒绝推送**，不把残缺数据当权威。
 */
import { db } from '../db/schema'
import { deriveExportProjectJSON } from '../export/registry-export'
import { log } from '../logging/logger'
import { useCloudSync } from '../../stores/cloud-sync'
import { buildEnvelope, forcePush, getActiveConfig, listStatus, push } from './client'
import { checkExportIntegrity, contentSha256, describeIntegrityIssues } from './integrity'
import {
  clearProject,
  clearProjectByOpId,
  clearProjectEntries,
  clearScan,
  readOutbox,
  stampOpId,
  subscribeOutbox,
  tryRunAsSyncLeader,
} from './outbox'
import { ensureSyncUid, listBoundProjects } from './project-identity'
import { pullProject } from './pull-apply'
import { CloudError, type DirtyProjectEntry, type RemoteConflictSummary, type RemoteProjectSummary } from './types'

/** 空闲多久后推送。太短会打断连续编辑，太长会让"刚写完就换设备"拿不到最新。 */
const DEBOUNCE_MS = 45_000
const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 300_000
/** 登录成功后的首次推送延迟（让首屏先渲染完）。 */
const FIRST_FLUSH_MS = 2_000

type Outcome = 'ok' | 'conflict' | 'unauthorized' | 'integrity' | 'error'

let started = false
let running = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let backoffMs = RETRY_BASE_MS
let unsubscribeOutbox: (() => void) | null = null
let onUnauthorized: (() => void) | null = null

const store = () => useCloudSync.getState()

function generateOpId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function refreshDirtyCount(): void {
  store().setDirtyCount(readOutbox().entries.length)
}

function scheduleFlush(delayMs: number): void {
  if (!started) return
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void flushNow()
  }, delayMs)
}

/** 请求一次推送（合并到防抖窗口里）。 */
export function requestFlush(delayMs = DEBOUNCE_MS): void {
  scheduleFlush(delayMs)
}

function scheduleRetry(): void {
  if (!started) return
  if (retryTimer) clearTimeout(retryTimer)
  const delay = Math.min(backoffMs, RETRY_MAX_MS)
  backoffMs = Math.min(backoffMs * 3, RETRY_MAX_MS)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushNow()
  }, delay)
}

function resetBackoff(): void {
  backoffMs = RETRY_BASE_MS
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/**
 * 推送一个项目。
 *
 * 返回 `conflict` / `unauthorized` / `integrity` 时调用方应**停止整轮**
 * ——继续推其他项目只会让冲突状态更难解释。
 */
async function pushOne(
  projectId: number,
  entry: DirtyProjectEntry | null,
  remoteByUid: Map<string, RemoteProjectSummary>,
): Promise<Outcome> {
  const project = await db.projects.get(projectId)
  if (!project) {
    // 本地已删除：不推空项目，直接丢弃脏记录
    clearProject(projectId)
    return 'ok'
  }

  const projectUid = await ensureSyncUid(projectId)
  if (!projectUid) {
    clearProject(projectId)
    return 'ok'
  }

  let exportData: Record<string, unknown>
  try {
    exportData = await deriveExportProjectJSON(projectId) as unknown as Record<string, unknown>
  } catch (error) {
    store().setError(`「${project.name}」导出失败：${(error as Error)?.message ?? '未知错误'}`)
    return 'error'
  }

  // ── 导出完整性闸门：宁可不同步，也不上传残缺权威 ──
  const issues = await checkExportIntegrity(projectId, exportData)
  if (issues.length > 0) {
    store().setError(`「${project.name}」暂不推送：${describeIntegrityIssues(issues)}`)
    log.warn('Cloud', 'cloud.push.integrity_blocked', '导出完整性闸门拦截', {
      projectId,
      issues: issues.length,
    })
    return 'integrity'
  }

  const hash = await contentSha256(exportData)
  const remote = remoteByUid.get(projectUid)

  // 远端已与本地一致 → 清脏即可，不发请求
  if (remote && remote.contentSha256 === hash) {
    clearProjectEntries(projectId, entry?.entryIds ?? [])
    return 'ok'
  }

  // opId 必须先落盘：崩溃/超时后重试要复用它
  const opId = entry?.opId ?? generateOpId()
  if (!entry?.opId) stampOpId(projectId, opId, entry?.entryIds)

  try {
    const result = await push(buildEnvelope({
      opId,
      projectUid,
      baseRev: remote?.rev ?? 0,
      exportData,
    }))

    clearProjectByOpId(projectId, opId)
    remoteByUid.set(projectUid, {
      projectUid,
      name: project.name,
      rev: result.rev,
      updatedAt: Date.now(),
      contentSha256: result.contentSha256 ?? hash,
      sizeBytes: result.sizeBytes ?? 0,
      tableCount: result.changedTables?.length ?? 0,
    })
    store().markPushed(Date.now())
    log.info('Cloud', 'cloud.push.ok', '项目已同步到云端', {
      projectId,
      rev: result.rev,
      unchanged: result.unchanged === true,
    })
    return 'ok'
  } catch (error) {
    if (error instanceof CloudError) {
      if (error.code === 'conflict') {
        const summary = (error as CloudError & { remote?: RemoteConflictSummary }).remote
        store().setConflict({
          projectId,
          projectName: project.name,
          projectUid,
          remote: summary ?? {
            rev: remote?.rev ?? 0,
            name: remote?.name ?? project.name,
            updatedAt: remote?.updatedAt ?? Date.now(),
            contentSha256: remote?.contentSha256 ?? null,
            sizeBytes: remote?.sizeBytes ?? 0,
          },
        })
        log.warn('Cloud', 'cloud.push.conflict', '云端已有更新', { projectId })
        return 'conflict'
      }
      if (error.code === 'unauthorized') {
        store().setError('登录已失效，请重新登录')
        onUnauthorized?.()
        return 'unauthorized'
      }
      if (error.code === 'too_large') {
        store().setError(`「${project.name}」超过服务器单次上限，请改用「导出 JSON」备份`)
        return 'error'
      }
      store().setError(error.message)
      return 'error'
    }
    store().setError((error as Error)?.message ?? '未知错误')
    return 'error'
  }
}

/** 立即推送一轮。并发调用会直接返回（单飞）。 */
export async function flushNow(): Promise<void> {
  if (!started || running) return
  if (!getActiveConfig()?.enabled) return
  if (globalThis.navigator?.onLine === false) {
    store().setPhase('offline')
    return
  }
  if (store().conflict) return

  running = true
  store().setPhase('syncing')

  try {
    // 多标签页只让一个推：拿不到锁说明别的标签页在处理同一份脏集
    const leader = await tryRunAsSyncLeader(async () => {
      const state = readOutbox()
      store().setDirtyCount(state.entries.length)
      if (state.entries.length === 0) {
        store().setPhase('idle')
        return 'empty'
      }

      const remoteList = await listStatus()
      const remoteByUid = new Map(remoteList.map(item => [item.projectUid, item]))

      const targets: Array<{ projectId: number; entry: DirtyProjectEntry | null }> = []
      for (const item of state.entries) {
        if (item.kind === 'project') targets.push({ projectId: item.projectId, entry: item })
      }

      const needsScan = state.entries.some(item => item.kind === 'scan')
      if (needsScan) {
        const bound = await listBoundProjects()
        for (const project of bound) {
          if (project.id == null) continue
          if (!targets.some(target => target.projectId === project.id)) {
            targets.push({ projectId: project.id, entry: null })
          }
        }
      }

      let blocked = false
      for (const target of targets) {
        const outcome = await pushOne(target.projectId, target.entry, remoteByUid)
        if (outcome !== 'ok') {
          blocked = true
          break
        }
      }

      // 全库对账只有在整轮走完时才算清账
      if (needsScan && !blocked) clearScan()

      refreshDirtyCount()
      if (!blocked) store().setPhase('idle')
      return blocked ? 'blocked' : 'done'
    })

    if (leader === null) {
      // 别的标签页正在同步；它会把共享脏集处理掉
      store().setPhase('idle')
      return
    }

    if (leader === 'blocked') {
      if (store().conflict) return
      scheduleRetry()
      return
    }

    resetBackoff()
    if (store().phase === 'syncing') store().setPhase('idle')
  } catch (error) {
    if (error instanceof CloudError && error.code === 'unauthorized') {
      store().setError('登录已失效，请重新登录')
      onUnauthorized?.()
      return
    }
    store().setError((error as Error)?.message ?? '同步失败')
    store().setPhase('error')
    log.warn('Cloud', 'cloud.flush.failed', '同步失败，稍后重试', {
      message: (error as Error)?.message,
    })
    scheduleRetry()
  } finally {
    running = false
  }
}

// ── 冲突处理 ────────────────────────────────────────────────────────────────

export type ConflictChoice = 'pull' | 'push' | 'keep-both'

export interface ConflictResolution {
  ok: boolean
  /** 拉取/另存时新建的项目 id（供 UI 跳转）。 */
  projectId?: number
}

/**
 * 处理当前冲突。
 *
 * - `pull`       ：用云端版本覆盖本地。新副本接管云端身份，原项目**解绑**后留作本地备份。
 * - `push`       ：用本地覆盖云端。服务端先留 `pre-force` 快照，可回滚。
 * - `keep-both`  ：云端版本落成游离副本，本地继续持有绑定（下次推送会覆盖云端，
 *                  但你手上已经有那份远端内容）。
 */
export async function resolveConflict(choice: ConflictChoice): Promise<ConflictResolution> {
  const conflict = store().conflict
  if (!conflict) return { ok: false }

  store().setPhase('syncing')
  try {
    if (choice === 'push') {
      const exportData = await deriveExportProjectJSON(conflict.projectId) as unknown as Record<string, unknown>
      const issues = await checkExportIntegrity(conflict.projectId, exportData)
      if (issues.length > 0) {
        store().setError(describeIntegrityIssues(issues))
        store().setPhase('conflict')
        return { ok: false }
      }
      const opId = generateOpId()
      const result = await forcePush(buildEnvelope({
        opId,
        projectUid: conflict.projectUid,
        baseRev: conflict.remote.rev,
        exportData,
      }))
      clearProject(conflict.projectId)
      store().setConflict(null)
      store().markPushed(Date.now())
      log.warn('Cloud', 'cloud.conflict.force', '已用本地覆盖云端', { rev: result.rev })
      return { ok: true }
    }

    // pull 与 keep-both 都是"把云端版本落成新项目"
    const applied = await pullProject(conflict.projectUid, { rebind: choice === 'pull' })
    if (!applied) {
      store().setPhase('conflict')
      return { ok: false }
    }

    if (choice === 'pull') clearProject(conflict.projectId)
    store().setConflict(null)
    log.info('Cloud', 'cloud.conflict.pull', '已把云端版本拉成本地副本', {
      created: applied.projectId,
      bound: applied.bound,
    })
    return { ok: true, projectId: applied.projectId }
  } catch (error) {
    store().setError((error as Error)?.message ?? '冲突处理失败')
    store().setPhase('conflict')
    return { ok: false }
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────────────

interface StartOptions {
  /** 服务端返回 401 时回调（由 `boot.ts` 接回账号 store）。 */
  onUnauthorized?: () => void
}

export function startSyncEngine(options: StartOptions = {}): void {
  if (started) return
  started = true
  onUnauthorized = options.onUnauthorized ?? null
  store().setPhase('idle')
  refreshDirtyCount()

  const flushSoon = () => scheduleFlush(1_000)
  const flushNowOnHide = () => {
    if (globalThis.document?.visibilityState === 'hidden') void flushNow()
  }

  globalThis.document?.addEventListener('visibilitychange', flushNowOnHide)
  globalThis.addEventListener?.('pagehide', () => void flushNow())
  globalThis.addEventListener?.('online', () => {
    resetBackoff()
    flushSoon()
  })
  globalThis.addEventListener?.('offline', () => store().setPhase('offline'))
  unsubscribeOutbox = subscribeOutbox(() => {
    refreshDirtyCount()
    scheduleFlush(DEBOUNCE_MS)
  })

  scheduleFlush(FIRST_FLUSH_MS)
  log.info('Cloud', 'cloud.engine.started', '同步引擎已启动')
}

export function stopSyncEngine(): void {
  if (!started) return
  started = false
  running = false
  onUnauthorized = null
  if (debounceTimer) clearTimeout(debounceTimer)
  if (retryTimer) clearTimeout(retryTimer)
  debounceTimer = null
  retryTimer = null
  unsubscribeOutbox?.()
  unsubscribeOutbox = null
  resetBackoff()
  store().reset()
  log.info('Cloud', 'cloud.engine.stopped', '同步引擎已停止')
}

export function isSyncEngineRunning(): boolean {
  return started
}
