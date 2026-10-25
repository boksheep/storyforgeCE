/**
 * 步骤记录器（STEP-1）· 本地撤回/重做日志。
 *
 * 这是**本机历史**，不是项目数据：与 `snapshots` 一样不参与项目 JSON 导出，
 * 删项目时随之清理（PROJECT_TABLES owner: 'project'）。
 *
 * 每条记录保存一次 AI 写入（或正文应用）影响到的行级前后快照，用于撤回/重做：
 *   - `before === null` 表示这一步**新建**了该行；
 *   - `after === null` 表示这一步**删除**了该行（当前实现不产生这种记录）；
 *   - 其余情况是字段更新，撤回时把 `before` 里被改动的字段写回。
 */

export interface StepRowSnapshot {
  /** 完整行快照（含 id / projectId），用于一致性校验与字段还原。 */
  row: Record<string, unknown>
}

export interface StepChange {
  /** PROJECT_TABLES 登记的表名。 */
  table: string
  recordId: number
  /** 本步实际改动的字段名（撤回/重做的粒度）。 */
  fields: string[]
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
}

export interface StepJournalEntry {
  id?: number
  projectId: number
  worldGroupId?: number | null
  /** 面向作者的步骤名，如「AI 润色正文」「采纳大纲候选」。 */
  label: string
  /** 写入来源标识，用于排查是哪个入口产生的步骤。 */
  source: string
  createdAt: number
  /** StepChange[] 的 JSON 序列化（Dexie 不索引嵌套结构）。 */
  changes: string
}
