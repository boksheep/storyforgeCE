import { db } from '../db/schema'
import { log } from '../logging/logger'
import { REGISTRY_BY_NAME, PROJECT_TABLES } from '../registry/project-tables'
import { StepRestoreError, restoreRow, STEP_STORE_TABLES } from './step-restore'
import type { StepChange, StepJournalEntry } from '../types/step-journal'

/**
 * STEP-1 步骤记录器。
 *
 * 目的：AI 对项目数据的每一次写入都可「上一步 / 下一步」，覆盖主 Agent 采纳、
 * 卷纲生成、正文 AI 应用等入口。
 *
 * ## 记录粒度
 * 行级前后快照（`before`/`after`），撤回时按"本步改动过的字段"回写，不整表覆盖。
 *
 * ## 为什么写入点在 adopt() 内部
 * `adopt()` 是 AI 写回的唯一受治理入口（FIELD_REGISTRY + AdoptionSchema）。
 * 在它内部记录，等于**所有**已收口的 AI 写入自动获得撤回能力，不需要每个面板各自埋点。
 * 正文内容走编辑器/章节 store，因此由 `recordChapterContentStep()` 显式接入。
 *
 * ## 安全边界
 *   - 只记录 `STEP_STORE_TABLES`（PROJECT_TABLES 中登记过的作者数据表）；
 *   - 撤回前校验"当前行仍等于本步写入后的状态"，否则拒绝，避免覆盖作者之后的修改；
 *   - 撤回本身只能经 `step-restore.ts`（已在 ADOPTION_EXTENSIONS 登记的领域入口）；
 *   - 步骤历史是本机数据：不导出、不随导入迁移，上限由设置决定。
 */

export const STEP_HISTORY_LIMIT_KEY = 'storyforge-step-history-limit'
/** 默认保留 30 步：足够覆盖一轮"生成 → 调整 → 重生成"，又不会让本机历史无限膨胀。 */
export const DEFAULT_STEP_HISTORY_LIMIT = 30
export const MIN_STEP_HISTORY_LIMIT = 5
export const MAX_STEP_HISTORY_LIMIT = 200

export function clampStepHistoryLimit(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return DEFAULT_STEP_HISTORY_LIMIT
  return Math.min(MAX_STEP_HISTORY_LIMIT, Math.max(MIN_STEP_HISTORY_LIMIT, Math.floor(n)))
}

export function getStepHistoryLimit(): number {
  try {
    return clampStepHistoryLimit(localStorage.getItem(STEP_HISTORY_LIMIT_KEY))
  } catch {
    return DEFAULT_STEP_HISTORY_LIMIT
  }
}

export function setStepHistoryLimit(value: unknown): number {
  const limit = clampStepHistoryLimit(value)
  try {
    localStorage.setItem(STEP_HISTORY_LIMIT_KEY, String(limit))
  } catch {
    // 存储不可用时只影响持久化，不影响本次会话
  }
  log.info('StepRecorder', 'step.limit.changed', `步骤记录上限已设为 ${limit}`, { limit })
  notifyStepJournal()
  return limit
}

export interface RecordStepInput {
  projectId: number
  worldGroupId?: number | null
  label: string
  source: string
  changes: StepChange[]
}

function isRecordableTable(table: string): boolean {
  if (!STEP_STORE_TABLES.includes(table)) return false
  const spec = REGISTRY_BY_NAME.get(table)
  return !!spec && spec.owner !== 'global'
}

function sanitizeChanges(changes: readonly StepChange[]): StepChange[] {
  return changes.filter(change => (
    isRecordableTable(change.table)
    && Number.isInteger(change.recordId)
    && change.recordId > 0
    && change.fields.length > 0
    && (change.before !== null || change.after !== null)
  ))
}

/** 待落库的步骤（由 adopt() 等在事务内同步入队，事务外统一落库）。 */
const pendingStepRecords: RecordStepInput[] = []
let drainTimer: ReturnType<typeof setTimeout> | null = null
/**
 * 串行化的 drain 链。
 *
 * 定时器 drain 与"采纳后立刻刷新撤回按钮"的手动 flush 可能并发；两个 drain 同时跑会
 * 各自读同一份游标、互相删除对方刚写入的行（真实缺陷：连续采纳会丢步骤）。
 * 所有 drain 都接到这条链尾，保证同一时刻只有一个在推进。
 */
let drainChain: Promise<unknown> = Promise.resolve()

/**
 * 把一步历史入队。
 *
 * adopt() 经常运行在领域事务里，**不能在事务内写 stepJournal**（Dexie zone 绑定），
 * 所以调用方只同步入队，落库由下一个宏任务统一完成。
 */
export function enqueueStepRecord(input: RecordStepInput): void {
  pendingStepRecords.push(input)
  // 队列上限：定时器被长时间阻塞（例如页面在后台）时也不无限涨。
  if (pendingStepRecords.length > PENDING_STEP_MAX) {
    const dropped = pendingStepRecords.splice(0, pendingStepRecords.length - PENDING_STEP_MAX)
    log.warn('StepRecorder', 'step.queue.overflow', `待落库步骤超过 ${PENDING_STEP_MAX} 条，已丢弃最旧 ${dropped.length} 条`, {
      dropped: dropped.length,
      limit: PENDING_STEP_MAX,
    })
  }
  if (drainTimer != null) return
  drainTimer = setTimeout(() => {
    drainTimer = null
    void flushStepRecords().catch(() => { /* 历史记录失败不影响主流程 */ })
  }, 0)
}

/** 立即落库所有待记录步骤；与定时器 drain 串行，可安全并发调用。 */
export function flushStepRecords(): Promise<number> {
  const run = drainChain.then(async () => {
    let written = 0
    while (pendingStepRecords.length) {
      const next = pendingStepRecords.shift()!
      try {
        if (await recordStep(next)) written += 1
      } catch (error) {
        // 单条失败不阻塞其余步骤；但必须留痕，否则"某一步没进历史"无迹可查
        log.warn('StepRecorder', 'step.flush.failed', `步骤落库失败：${next.label}`, {
          projectId: next.projectId,
          label: next.label,
          source: next.source,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return written
  })
  drainChain = run.catch(() => {})
  return run
}

/** 供诊断/测试：还有多少步未落库。 */
export function pendingStepRecordCount(): number {
  return pendingStepRecords.length
}

/** 待落库队列上限（僵尸定时器的保险丝）。 */
export const PENDING_STEP_MAX = 200

/** 步骤历史变化的订阅者（工作区顶栏的撤回/重做按钮靠它实时刷新可用状态）。 */
const stepListeners = new Set<() => void>()

/**
 * 订阅步骤历史变化。
 *
 * 为什么必须有它：历史是**异步**落库的（`enqueueStepRecord` → 下一个宏任务 flush），
 * 若界面只在挂载时读一次状态，"采纳候选后上一步仍然灰着"就只能靠刷新页面解决
 * （真实缺陷：撤回按钮在本会话内恒为禁用，而 1270 个测试全绿也没发现，
 * 因为它们只断言 store 层函数、不断言按钮可用性）。
 */
export function subscribeStepJournal(listener: () => void): () => void {
  stepListeners.add(listener)
  return () => { stepListeners.delete(listener) }
}

function notifyStepJournal(): void {
  for (const listener of [...stepListeners]) {
    try {
      listener()
    } catch {
      // 监听器自身出错不应影响历史写入
    }
  }
}

/** 记录一步。没有可记录内容时返回 null（调用方无需判断）。 */
export async function recordStep(input: RecordStepInput): Promise<StepJournalEntry | null> {
  const changes = sanitizeChanges(input.changes)
  if (!changes.length) return null
  // 撤回之后又发生新写入时，"下一步"分支作废（标准 undo/redo 语义）。
  await dropRedoBranch(input.projectId)
  const entry: StepJournalEntry = {
    projectId: input.projectId,
    worldGroupId: input.worldGroupId ?? null,
    label: input.label.slice(0, 120),
    source: input.source.slice(0, 80),
    createdAt: Date.now(),
    changes: JSON.stringify(changes),
  }
  const id = await db.stepJournal.add(entry as never) as number
  await trimStepJournal(input.projectId)
  // 写入后游标指向末尾（全部步骤已应用）
  writeCursor(input.projectId, (await readEntries(input.projectId)).length)
  log.info('StepRecorder', 'step.recorded', `已记录步骤「${entry.label}」`, {
    projectId: input.projectId,
    source: entry.source,
    label: entry.label,
    rows: changes.length,
    tables: [...new Set(changes.map(change => change.table))].join(','),
  })
  notifyStepJournal()
  return { ...entry, id }
}

/** 超过上限时从最旧开始丢弃。 */
export async function trimStepJournal(projectId: number): Promise<number> {
  const limit = getStepHistoryLimit()
  const rows = await readEntries(projectId)
  const excess = rows.length - limit
  if (excess <= 0) return 0
  const ids = rows.slice(0, excess)
    .map(row => row.id)
    .filter((id): id is number => typeof id === 'number')
  if (ids.length) await db.stepJournal.bulkDelete(ids)
  if (ids.length) {
    log.debug('StepRecorder', 'step.trimmed', `步骤历史超过上限，已丢弃最旧 ${ids.length} 步`, {
      projectId,
      limit,
      kept: rows.length - ids.length,
    })
    notifyStepJournal()
  }
  return ids.length
}

export interface StepStatus {
  canUndo: boolean
  canRedo: boolean
  undoLabel: string | null
  redoLabel: string | null
  /** 已记录的步骤总数（含"下一步"分支）。 */
  stepCount: number
}

const CURSOR_PREFIX = 'storyforge-step-cursor-'

function cursorKey(projectId: number): string {
  return `${CURSOR_PREFIX}${projectId}`
}

function readCursor(projectId: number, total: number): number {
  let raw: number | null = null
  try {
    const stored = localStorage.getItem(cursorKey(projectId))
    raw = stored == null ? null : Number(stored)
  } catch {
    raw = null
  }
  if (raw == null || !Number.isFinite(raw)) return total
  return Math.max(0, Math.min(total, Math.floor(raw)))
}

function writeCursor(projectId: number, value: number): void {
  try {
    localStorage.setItem(cursorKey(projectId), String(value))
  } catch {
    // 存储不可用时退化为"总是当作全部已应用"
  }
}

/** 按时间（同毫秒按 id）排序，保证撤回顺序稳定。 */
async function readEntries(projectId: number): Promise<StepJournalEntry[]> {
  const rows = await db.stepJournal.where('projectId').equals(projectId).toArray()
  return rows.sort((left, right) => (
    left.createdAt - right.createdAt || (left.id ?? 0) - (right.id ?? 0)
  ))
}

export async function readStepStatus(projectId: number): Promise<StepStatus> {
  const rows = await readEntries(projectId)
  const cursor = readCursor(projectId, rows.length)
  const canUndo = cursor > 0
  const canRedo = cursor < rows.length
  return {
    canUndo,
    canRedo,
    undoLabel: canUndo ? rows[cursor - 1].label : null,
    redoLabel: canRedo ? rows[cursor].label : null,
    stepCount: rows.length,
  }
}

/** 丢弃游标之后的"下一步"分支。 */
export async function dropRedoBranch(projectId: number): Promise<number> {
  const rows = await readEntries(projectId)
  const cursor = readCursor(projectId, rows.length)
  if (cursor >= rows.length) return 0
  const ids = rows.slice(cursor)
    .map(row => row.id)
    .filter((id): id is number => typeof id === 'number')
  if (ids.length) await db.stepJournal.bulkDelete(ids)
  writeCursor(projectId, cursor)
  return ids.length
}

export interface StepApplyResult {
  ok: boolean
  label: string | null
  /** 应用后的新游标。 */
  cursor: number
  message: string
}

function parseChanges(entry: StepJournalEntry): StepChange[] {
  try {
    const parsed = JSON.parse(entry.changes) as StepChange[]
    return Array.isArray(parsed) ? sanitizeChanges(parsed) : []
  } catch {
    return []
  }
}

/**
 * 撤回一步。
 *
 * 行处理顺序与记录顺序相反：先还原被覆盖的行，再删除本步新建的行，
 * 这样即使中途失败也不会留下"新建的行还在、但内容已改"的半状态。
 */
export async function undoStep(projectId: number): Promise<StepApplyResult> {
  const rows = await readEntries(projectId)
  const index = readCursor(projectId, rows.length)
  if (index <= 0) return { ok: false, label: null, cursor: index, message: '没有可撤回的步骤。' }
  const entry = rows[index - 1]
  const changes = parseChanges(entry)
  if (!changes.length) {
    await db.stepJournal.delete(entry.id!)
    writeCursor(projectId, index - 1)
    return { ok: false, label: entry.label, cursor: index - 1, message: '该步骤没有可还原的记录，已跳过。' }
  }
  const applied: StepChange[] = []
  try {
    for (const change of [...changes].reverse()) {
      await restoreRow({
        projectId,
        table: change.table,
        recordId: change.recordId,
        fields: change.fields,
        expectedCurrent: change.after,
        target: change.before,
      })
      applied.push(change)
    }
  } catch (error) {
    // 部分失败：把已经还原的再推回原状，保证"撤回"不会留下半状态。
    for (const change of [...applied].reverse()) {
      await restoreRow({
        projectId,
        table: change.table,
        recordId: change.recordId,
        fields: change.fields,
        expectedCurrent: change.before,
        target: change.after,
      }).catch(() => { /* 回滚尽力而为，错误在下面统一报告 */ })
    }
    const reason = error instanceof StepRestoreError ? error.message : '还原失败'
    log.warn('StepRecorder', 'step.undo.refused', `撤回「${entry.label}」被拒绝：${reason}`, {
      projectId,
      label: entry.label,
      rows: changes.length,
    })
    notifyStepJournal()
    return { ok: false, label: entry.label, cursor: index, message: `撤回「${entry.label}」失败：${reason}` }
  }
  writeCursor(projectId, index - 1)
  log.info('StepRecorder', 'step.undo.ok', `已撤回：${entry.label}`, { projectId, label: entry.label, rows: changes.length })
  notifyStepJournal()
  return { ok: true, label: entry.label, cursor: index - 1, message: `已撤回：${entry.label}` }
}

/** 重做一步（撤回的逆操作）。 */
export async function redoStep(projectId: number): Promise<StepApplyResult> {
  const rows = await readEntries(projectId)
  const index = readCursor(projectId, rows.length)
  if (index >= rows.length) return { ok: false, label: null, cursor: index, message: '没有可重做的步骤。' }
  const entry = rows[index]
  const changes = parseChanges(entry)
  if (!changes.length) {
    writeCursor(projectId, index + 1)
    return { ok: false, label: entry.label, cursor: index + 1, message: '该步骤没有可重做的记录，已跳过。' }
  }
  try {
    for (const change of changes) {
      await restoreRow({
        projectId,
        table: change.table,
        recordId: change.recordId,
        fields: change.fields,
        expectedCurrent: change.before,
        target: change.after,
      })
    }
  } catch (error) {
    const reason = error instanceof StepRestoreError ? error.message : '重做失败'
    log.warn('StepRecorder', 'step.redo.refused', `重做「${entry.label}」被拒绝：${reason}`, {
      projectId,
      label: entry.label,
    })
    notifyStepJournal()
    return { ok: false, label: entry.label, cursor: index, message: `重做「${entry.label}」失败：${reason}` }
  }
  writeCursor(projectId, index + 1)
  log.info('StepRecorder', 'step.redo.ok', `已重做：${entry.label}`, { projectId, label: entry.label, rows: changes.length })
  notifyStepJournal()
  return { ok: true, label: entry.label, cursor: index + 1, message: `已重做：${entry.label}` }
}

// ───────────────────────── 快照辅助 ─────────────────────────

/** 读取一行快照（表未登记/行不存在时返回 null）。 */
export async function snapshotRow(table: string, recordId: number): Promise<Record<string, unknown> | null> {
  if (!isRecordableTable(table)) return null
  const spec = REGISTRY_BY_NAME.get(table)!
  const row = await spec.table.get(recordId) as Record<string, unknown> | undefined
  return row ? JSON.parse(JSON.stringify(row)) as Record<string, unknown> : null
}

/**
 * 由"写入前快照"与"写入后补丁"构造一条变更记录。
 * `after` 用写入后的真实快照（而不是拼出来的预期值），保证并发校验基于事实。
 */
export function buildChange(input: {
  table: string
  recordId: number
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  fields: readonly string[]
}): StepChange {
  return {
    table: input.table,
    recordId: input.recordId,
    fields: [...new Set(input.fields)],
    before: input.before,
    after: input.after,
  }
}

/** 正文（章节内容）AI 应用的显式入口：内容不是通过 adopt() 写入的。 */
export async function recordChapterContentStep(input: {
  projectId: number
  chapterId: number
  label: string
  source: string
  beforeContent: string
  beforeWordCount: number
  afterContent: string
  afterWordCount: number
}): Promise<StepJournalEntry | null> {
  if (input.beforeContent === input.afterContent) return null
  const spec = REGISTRY_BY_NAME.get('chapters')
  if (!spec) return null
  const row = await spec.table.get(input.chapterId) as Record<string, unknown> | undefined
  if (!row || row.projectId !== input.projectId) return null
  // 注意：写入方可能还没把新正文落库（编辑器自动保存有延迟），
  // 因此 after 必须用调用方给出的"应用后内容"，不能读库里的旧值。
  const after = {
    ...(JSON.parse(JSON.stringify(row)) as Record<string, unknown>),
    content: input.afterContent,
    wordCount: input.afterWordCount,
  }
  const before = { ...after, content: input.beforeContent, wordCount: input.beforeWordCount }
  return recordStep({
    projectId: input.projectId,
    worldGroupId: (row.worldGroupId as number | null | undefined) ?? null,
    label: input.label,
    source: input.source,
    changes: [buildChange({
      table: 'chapters',
      recordId: input.chapterId,
      before,
      after,
      fields: ['content', 'wordCount'],
    })],
  })
}

/** 新增/删除项目时清理本机步骤历史（与 PROJECT_TABLES 生命周期一致）。 */
export async function clearProjectStepJournal(projectId: number): Promise<number> {
  const ids = (await db.stepJournal.where('projectId').equals(projectId).primaryKeys()) as number[]
  if (ids.length) await db.stepJournal.bulkDelete(ids)
  if (ids.length) {
    log.info('StepRecorder', 'step.journal.cleared', `已清理 ${ids.length} 条步骤历史`, { projectId, cleared: ids.length })
    notifyStepJournal()
  }
  return ids.length
}

/** 供诊断/测试：本机历史涉及的表是否都在 PROJECT_TABLES 内。 */
export function stepRecorderTablesAreRegistered(): boolean {
  const names = new Set(PROJECT_TABLES.map(spec => spec.name))
  return STEP_STORE_TABLES.every(table => names.has(table))
}
