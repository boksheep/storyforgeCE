/**
 * 三注册表 · 共享类型定义(Phase 1.1a)
 *
 * 这里只定义类型,不含数据。数据在 project-tables.ts。
 * 设计依据:MASTER-BLUEPRINT.md §5.1(PROJECT_TABLES 强化版)。
 */
import type { Table } from 'dexie'
import type { AIProvider } from '../types/ai'
import type { ContextLayer, ContextSegment } from '../ai/context-budget'
import type { PreparedContinuityContext } from '../ai/chapter-memory/continuity-context'
import type { InspirationResultMode } from '../types/inspiration-workspace'
import type { RagSelectionTraceCollector } from '../types/rag-library'
import type { ContextBudgetPolicy } from './context-budget-policy'

/**
 * 表的归属方式 —— 决定删项目时如何定位该表的记录。
 */
export type TableOwner =
  | 'project'      // 直接有 projectId 字段(绝大多数)
  | 'direct-child' // 通过另一张表的 id 间接归属(如 referenceChunkAnalysis.referenceId)
  | 'indirect'     // 通过非直接外键间接归属(如 importLogs.sessionId → importSessions.projectId)
  | 'transient'    // 临时态(与项目同生命周期,但不导出)
  | 'blob'         // Blob 存储,特殊 owner(如 importFiles 复用为 master blob)
  | 'global'       // 全局(不绑项目,不参与 deleteProject 级联)

/** 简单外键引用(table[field] 形式) */
export interface SimpleRef {
  kind: 'simple'
  field: string
  /** 'tableName[fieldName]' —— 指向哪张表的哪个字段被本表引用 */
  target: string
  onDelete: 'cascade' | 'setNull' | 'keep'
}

/** JSON 字段内的引用(如 detailedOutlines.scenes 里嵌套的 characterIds) */
export interface JsonRef {
  kind: 'json'
  field: string      // 存 JSON 的字段名
  jsonPath: string   // 简化 path,如 '$.characterId' 或 '$[].characterIds[]'
  target: string     // 'tableName[fieldName]'
  onDelete: 'cascade' | 'setNull' | 'keep' | 'remap'
}

/** 数组字段内的多引用(字段本身就是 number[]) */
export interface ArrayRef {
  kind: 'array'
  field: string       // 数组字段名(或 JSON 数组字符串字段名)
  itemTarget: string  // 数组元素指向哪张表
  onDelete: 'removeItem' | 'setNullItem' | 'keep'
}

/** 间接归属(本表没有 projectId,通过另一张表的字段间接挂项目) */
export interface IndirectRef {
  kind: 'indirect'
  via: {
    /** 间接父表名 */
    table: string
    /** 本表用哪个字段关联父表主键 */
    field: string
    /** 父表用什么字段解析到 projectId(通常就是 'projectId') */
    resolveProject: string
  }
  onDelete: 'cascade'
}

/** Blob owner(blob 表用特殊 key 计算复用,如 importFiles 给 master 用 100000+workId) */
export interface BlobOwnerRef {
  kind: 'blob-owner'
  /** 拥有此 blob 的父表名 */
  ownerTable: string
  /** 由父表行计算出 blob 主键(如 row => 100000 + row.id) */
  keyResolver: (ownerRow: unknown) => number | string
  onDelete: 'cascade'
}

export type RefSpec = SimpleRef | JsonRef | ArrayRef | IndirectRef | BlobOwnerRef

/** 导出时的 ID 重映射声明 */
export interface ExportRemapField {
  /** 字段名(库内真实外键字段) */
  field: string
  /** 重映射到哪张表的导出序号(如 'worldGroups' / 'outlineNodes') */
  remapVia: string
  /** 是否树形自引用(parentId) */
  selfTree?: boolean
  /**
   * 导出后该字段在 JSON 里的名字(历史命名,毫无规律,必须逐字段声明以逐字节兼容旧备份)。
   * 例:worldGroupId → '_worldGroupExportId'、outlineNodeId → '_outlineExportId'、
   *     fromCharacterId → '_fromCharacterIndex'。
   */
  exportAs: string
  /**
   * 该外键找不到映射时:
   * - 'drop'    丢弃整行(孤儿,如 characterRelations 端点角色已删)
   * - 'require' 导入时抛错并整体回滚(必填外键完整性保护,如 chapters.outlineNodeId)
   * - 'null' / 省略  置空(可空外键 / worldGroupId / 树 parentId)
   */
  onUnmapped?: 'drop' | 'require' | 'null'
}

/**
 * JSON 字段内引用的导出重映射(区别于 refs:refs 管删除级联,这里管导出/导入重映射)。
 * exportAs 是新增的便携影子字段；保留原字段保证旧版导出契约可读，新版导入优先用影子字段重映射。
 */
export type ExportRefRemap = {
  field: string
  remapVia: string
  kind: 'portals'
} | {
  field: string
  remapVia: string
  kind: 'id-array'
  exportAs: string
  storage?: 'array' | 'json-string'
} | {
  field: string
  remapVia: string
  kind: 'scene-character-ids'
  exportAs: string
} | {
  /** CharacterDrivenPlan.arcs JSON 内逐项 characterId 的便携影子数组。 */
  field: string
  remapVia: string
  kind: 'character-plan-arcs'
  exportAs: string
}

/**
 * 单张表的元信息。
 */
export interface TableSpec<T = any> {
  /** Dexie 表对象(可直接操作) */
  table: Table<T, number>
  /** 表名(与 db 实例属性名一致) */
  name: string
  /** 归属方式 */
  owner: TableOwner
  /** owner!=='project' 时如何解析到 projectId(可选,删项目用) */
  projectResolver?: (projectId: number) => Promise<number[]>
  /** 是否带 worldGroupId(参与多世界隔离/盖章/删世界级联) */
  worldScoped?: boolean
  /** Disable automatic primary-world stamping for unassigned/shared legacy records. */
  stampPrimaryWorld?: boolean
  /**
   * 导入后必须改写为本行新主键的嵌套字段路径。
   * 例：chapters.continuityHandoff.chapterId。
   */
  selfIdPaths?: string[]
  /** worldGroupId 的字段名(默认 'worldGroupId') */
  worldGroupField?: string
  /** 是否带 homeWorldGroupId(仅 characters) */
  homeWorldScoped?: boolean
  /** 树形(parentId 字段名) */
  tree?: { parentField: string }
  /** 外键/引用关系(删除级联用) */
  refs?: RefSpec[]
  /** 是否纳入 JSON 备份导出 */
  exportable: boolean
  /** 导出时需要的 ID 重映射 */
  exportRemap?: ExportRemapField[]
  /**
   * 导出时是否写显式 `_exportId` 字段(= 该行在导出数组里的下标)。
   * 被别的表用「_exportId 命名」引用的表要 true(worldGroups/outlineNodes/worldNodes/
   * references/importantLocations/codexCategories);用「数组下标隐式索引」的表(characters/
   * chapters)留空。
   */
  exportIdField?: boolean
  /** 导出查询排序字段(仅 worldGroups: 'order',保证导出序稳定 = 世界组重映射依据) */
  exportOrderBy?: string
  /** JSON 字段内引用的导出/导入重映射(仅 worldNodes.portalsJSON) */
  exportRefRemap?: ExportRefRemap[]
  /**
   * 导入兜底默认值：声明该表"非可选字段"在缺失时的默认值。
   * 导入引擎写入前做 `{ ...defaults, ...row }`,保证老数据/跨版本导入的 JSON
   * 即使缺某个非可选字段,落库时也满足类型不变量(如 outlineNodes.summary 恒为 string)。
   * 这是「数据进入边界统一兜底」的单一来源,避免在每个读取处散补 `?.`。
   */
  defaults?: Record<string, unknown>
  /** 备注(说明为什么这样配) */
  note?: string
}

/**
 * FIELD_REGISTRY 字段定义(Phase 1.2a)。
 *
 * 只描述 AI/结构化采纳允许写入的字段。调用方给出的别名字段会在 adopt()
 * 里归一成这里登记的 canonical field。
 */
export interface FieldSpec {
  /** 目标表名,必须存在于 PROJECT_TABLES */
  target: string
  /** canonical 字段名 */
  field: string
  type: 'string' | 'longtext' | 'json' | 'object' | 'number' | 'boolean' | 'enum' | 'array'
  enums?: string[]
  worldScoped?: boolean
  aliases?: string[]
  sanitize?: (val: unknown) => unknown
  label?: string
  /** 中文/别名枚举归一,如 主角 -> protagonist */
  enumAliasMap?: Record<string, string>
}

export interface CompositeIdentity {
  kind: 'composite'
  fields: string[]
}

export interface CollectionAdoptionSpec {
  /** 集合目标表名 */
  target: string
  /** 唯一键策略(去重定位) */
  identity: 'id' | 'name' | CompositeIdentity
  /** 只允许通过 recordId 定点更新，禁止 AI 新增集合行。 */
  recordOnly?: boolean
  duplicatePolicy: 'skip' | 'update' | 'merge' | 'error'
  /** 必填字段;缺失则跳过该条 */
  required: string[]
  /** 自动盖章字段 */
  autoStamps: ('projectId' | 'worldGroupId' | 'homeWorldGroupId' | 'createdAt' | 'updatedAt')[]
  /** FK 校验:写入前检查字段引用是否存在 */
  fkChecks?: { field: string; target: string }[]
  /** 数组成员校验:过滤不存在的成员,并记录 fkErrors */
  arrayMemberChecks?: { field: string; itemTarget: string }[]
  mergeStrategy?: 'overwrite-non-empty' | 'append-text' | 'union-array'
  /** 允许统一写回入口按这些字段清空旧集合，再写入新结果。 */
  replaceScope?: string[]
}

/**
 * 不适合通用 FIELD_REGISTRY/adopt() 语义的领域写回扩展。
 * 扩展必须声明自己的策略注册表和唯一入口，禁止演变成平行通用写回层。
 */
export interface AdoptionExtensionSpec {
  id: string
  target: string
  entrypoints: string[]
  policyRegistry: string
  reason: string
  /** 到期后 CI 必须重新审查，而不是让例外永久沉积。ISO 日期。 */
  reviewAfter: string
}

export interface AdoptInput {
  projectId: number
  worldGroupId?: number | null
  /** 集合表中定点更新既有记录；AI 补全空卷/空章等场景使用。 */
  recordId?: number
  /**
   * NS-1: chapters 派生记忆的原子 compare-and-set。
   * adopt() 必须在写 summary/handoff 的同一事务中重算当前正文 hash。
   */
  compareAndSet?: {
    kind: 'chapter-source-text-hash'
    expectedHash: string
    textNormalizationVersion: string
  }
  target: string
  data: Record<string, unknown> | Record<string, unknown>[]
  mode: 'replace' | 'append' | 'add' | 'add-many' | 'merge-diffs'
  /** STEP-1：本步在撤回历史里的名字；缺省按目标表生成。 */
  historyLabel?: string
  /** STEP-1：写入来源标识（面板/流水线名），便于排查步骤来源。 */
  historySource?: string
  /** STEP-1：置 false 表示这一步不进入撤回历史（如整批替换的内层调用）。 */
  history?: boolean
}

export interface AdoptResult {
  written: { id: number; fields: string[] }[]
  aliasMapped: { from: string; to: string }[]
  unknown: string[]
  typeErrors: { field: string; expected: string; got: string }[]
  fkErrors: { field: string; refValue: unknown }[]
  skipped: { reason: string; data: unknown }[]
}

export type ContextSourceScope = 'project' | 'world' | 'node' | 'chapter' | 'manual'

export interface AssembleContextInput {
  projectId: number
  /** Explicit world target. null is a valid explicit single-world/global target. */
  worldGroupId?: number | null
  outlineNodeId?: number | null
  chapterId?: number | null
  currentChapterOrder?: number
  sourceKeys?: string[]
  provider?: AIProvider
  model?: string
  /** Test/override hook. When set, this is the real input budget used for trimming. */
  inputBudgetTokens?: number
  /** 调用方的领域级输入上限；与模型窗口取较小值，不覆盖测试用精确预算。 */
  inputBudgetMaxTokens?: number
  /**
   * 当前生效的模型上下文窗口（token）。
   * 设置页手填或服务端 `/v1/models` 报告并自动应用的值；缺省时回退到配置 store 的生效值，
   * 再回退到名称族/服务商预设。让上下文预算与底栏、消息裁剪用同一个数字。
   */
  contextWindowOverride?: number
  /** 调用方只能按比例收窄每个登记源的软上限，不能放大或绕过注册表。 */
  sourceBudgetScale?: number
  citedReferenceIds?: number[]
  previousChapterEnding?: string
  stateReferenceText?: string
  extraStateIds?: number[]
  /** 手动输入/当前字段内容，供“内容反推结构化设定”类动作走注册表。 */
  manualSourceText?: string
  /** C2 反向哺喂：以某角色为主体，召回剧情里关于 TA 的事实/正文证据（characterFacts/characterPassages 源用）。 */
  subjectCharacterName?: string
  /** INV-1: 按角色过滤物品流水/持有投影。 */
  characterId?: number | null
  /** CM-1: 本次明确参与增量融合的碎片；由 inspirationWorkspace source 读取。 */
  inspirationFragmentIds?: string[]
  /** CM-1: 单世界与多世界各自维护最近确认版本。 */
  inspirationMode?: InspirationResultMode
  /** AGENT-1: 本地确定性项目搜索；只由 searchResults 上下文源消费。 */
  searchQuery?: string
  /** AGENT-1: 搜索最多返回 10 条短摘。 */
  searchLimit?: number
  /** AGENT-1: 搜索限定的数据类型。 */
  searchKinds?: string[]
  /** 主 Agent 当前会话的受控历史读取；只由 agentConversation 源消费。 */
  agentConversationId?: number
  /** 排除本轮刚写入的用户消息，防止当前指令重复进入历史。 */
  agentHistoryBeforeSequence?: number
  /** 主 Agent 的 PROJECT_TABLES 项目全域分页读取参数，仅由登记表记录源消费。 */
  projectTableName?: string
  projectTableOffset?: number
  projectTablePageSize?: number
  projectTableQuery?: string
  projectSearchCursor?: string
  projectSearchTableName?: string
  projectTableRecordId?: number
  projectTableFieldName?: string
  projectTableCharOffset?: number
  projectTableCharLimit?: number
  /** RAG-1: 节点/Agent 明确选择的稳定资料字段键。 */
  ragEntryKeys?: string[]
  /** RAG-1 内部执行证据收集器；调用结束后由节点运行快照冻结。 */
  ragSelectionTrace?: RagSelectionTraceCollector
  /**
   * BUDGET-1: 作者可调的上下文预算策略。缺省时由 assembleContext 读取本机策略
   * （localStorage）；测试与节点运行时快照可显式传入以冻结一轮的真实预算。
   */
  budgetPolicy?: ContextBudgetPolicy
  /**
   * BUDGET-1 内部透传：`acceptsCharLimits` 源的字符上限。
   * 只由 assemble-context 从预算策略写入，调用方不应手填。
   */
  sourceMaxChars?: number
  sourceMaxPerCategory?: number
  sourceMaxFieldsPerEntry?: number
  /** BUDGET-1 内部透传：「全书截至本章」段字数上限（retrievedPassages 用）。 */
  sourceMaxTotalChars?: number
  /** BUDGET-1 内部透传：「本卷截至本章」段字数上限（retrievedPassages 用）。 */
  sourceMaxVolumeChars?: number
  /** BUDGET-1 内部透传：「本卷截至本章」取本卷内本章之前的头多少章。 */
  sourceMaxVolumeChapters?: number
  /** assembleContext 内部批量预取；调用方无需传。 */
  continuitySnapshot?: PreparedContinuityContext
}

export interface ContextSource {
  key: string
  label: string
  scope: ContextSourceScope
  layer: ContextLayer
  /** Approximate per-source soft cap. Adapters can still return less. */
  budgetTokens: number
  /**
   * BUDGET-1: 该源的读取器接受字数级上限（`maxChars` / `maxPerCategory` /
   * `maxFieldsPerEntry`），由 `assembleContext` 从预算策略透传。
   *
   * 声明它等于承诺：`read()` 在**没有**收到这些选项时不得自行截断
   * （否则作者的「不截断」会被源内部常量悄悄推翻——这正是「词条较多，已截断」的成因）。
   */
  acceptsCharLimits?: boolean
  /** NS-1: assembleContext 总预算裁剪时不得整段删除。 */
  protectedFromTrim?: boolean
  requiresWorldGroupId?: boolean
  requiresOutlineNodeId?: boolean
  requiresChapterId?: boolean
  /** 规划尚未创建正文 Chapter 时，允许用 outlineNodeId 作为规范章序边界。 */
  acceptsOutlineNodeAsChapterBoundary?: boolean
  enabled?: (input: AssembleContextInput) => boolean | Promise<boolean>
  read: (input: AssembleContextInput) => Promise<string>
}

export interface AssembleContextResult {
  text: string
  segments: ContextSegment[]
  included: string[]
  omitted: string[]
  trimmed: string[]
  /**
   * 调用方传入但**未在 CONTEXT_SOURCES 登记**的 sourceKeys。
   *
   * 原实现用 `.filter(Boolean)` 静默丢弃这些 key，既不报错也不进 `omitted`，
   * 拼错/已下线的 key 只能表现为"这个源怎么没进来"（PROMPT-PLAN-1 依赖它做可信报告：
   * AI 申报的源必须能被判"未登记"，而不是被悄悄忽略）。
   */
  unknownSourceKeys: string[]
  totalInputTokens: number
  inputBudget: number
  overBudgetBeforeTrim: boolean
  overBudgetAfterTrim: boolean
}
