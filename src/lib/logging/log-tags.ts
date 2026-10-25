/**
 * LOG-1 · 日志 tag 注册表（单一事实源）。
 *
 * 现状：149 处 `console.*` 用的是 48 个**各自起意**的方括号前缀，既没有清单也不好过滤。
 * 这里把既有前缀原样登记为正式 tag（保持既有 grep 习惯与可读性），并配一个分类，
 * 让"另存 txt"与将来的应用内过滤有稳定的枚举可用。
 *
 * 规则：
 * - **新代码必须用已登记 tag**；未登记的写进来会被归一成 `Unknown`（`logger` 侧）并由
 *   `tests/registry/R-LOG1-tags.test.ts` 反例锁住（源码里不允许出现未登记的 `log.*({ tag: … })`）。
 * - 不引入 `[` `]`：方括号只属于旧的 console 前缀；txt 里 tag 是独立一列。
 */

export const LOG_TAG_CATEGORIES = ['ai', 'data', 'editor', 'import', 'export', 'ui', 'safety', 'system'] as const
export type LogTagCategory = typeof LOG_TAG_CATEGORIES[number]

export interface LogTagSpec {
  tag: string
  label: string
  category: LogTagCategory
}

export const LOG_TAGS: readonly LogTagSpec[] = [
  // AI 调用与生成
  { tag: 'AI', label: 'AI 调用', category: 'ai' },
  { tag: 'AIConfig', label: 'AI 模型配置', category: 'ai' },
  { tag: 'AIUsage', label: 'AI 用量', category: 'ai' },
  { tag: 'UsageLog', label: '用量写入', category: 'ai' },
  { tag: 'ChapterMemory', label: '章节记忆', category: 'ai' },
  { tag: 'StateExtract', label: '状态提取', category: 'ai' },
  { tag: 'AutoPost', label: '采纳后自动流程', category: 'ai' },
  { tag: 'ConsistencyAgent', label: '一致性 Agent', category: 'ai' },
  { tag: 'EditImpact', label: '改动影响分析', category: 'ai' },
  { tag: 'StyleCalibration', label: '文风校准', category: 'ai' },
  { tag: 'StyleLearning', label: '文风学习', category: 'ai' },
  { tag: 'ComparePolish', label: '对照润色', category: 'ai' },
  { tag: 'master-agent', label: '主 Agent', category: 'ai' },
  { tag: 'master-copilot', label: '对话副驾', category: 'ai' },
  { tag: 'AgentRetrieval', label: 'Agent 数据检索', category: 'ai' },
  { tag: 'StepRecorder', label: '撤回/重做步骤', category: 'data' },
  { tag: 'TypingStats', label: '码字统计', category: 'editor' },
  { tag: 'prompt-engine', label: '提示词引擎', category: 'ai' },
  { tag: 'assembleContext', label: '上下文装配', category: 'ai' },
  { tag: 'NS-5', label: '混合检索', category: 'ai' },
  { tag: 'PromptPlan', label: '生成前协商', category: 'ai' },

  // 数据与存储
  { tag: 'Codex', label: '设定词条', category: 'data' },
  { tag: 'CodexRefs', label: '词条引用重映射', category: 'data' },
  { tag: 'OutlineStore', label: '大纲节点写库', category: 'data' },
  { tag: 'DetailedOutlineStore', label: '细纲写库', category: 'data' },
  { tag: 'WorldviewStore', label: '世界观写库', category: 'data' },
  { tag: 'WorldNodeStore', label: '世界节点写库', category: 'data' },
  { tag: 'WorldGroupStore', label: '世界分组写库', category: 'data' },
  { tag: 'WorldRulesStore', label: '世界规则写库', category: 'data' },
  { tag: 'ChapterStore', label: '章节写库', category: 'data' },
  { tag: 'CharacterStore', label: '角色写库', category: 'data' },
  { tag: 'RelationStore', label: '角色关系写库', category: 'data' },
  { tag: 'CultivationStore', label: '修炼体系写库', category: 'data' },
  { tag: 'CultivationProgress', label: '修炼进度', category: 'data' },
  { tag: 'FactLedgerStore', label: '事实账本写库', category: 'data' },
  { tag: 'KnowledgeLedgerStore', label: '认知账本写库', category: 'data' },
  { tag: 'ItemLedgerStore', label: '物品账本写库', category: 'data' },
  { tag: 'ForeshadowStore', label: '伏笔写库', category: 'data' },
  { tag: 'LocationStore', label: '地点写库', category: 'data' },
  { tag: 'NoteStore', label: '笔记写库', category: 'data' },
  { tag: 'PromptStore', label: '提示词模板写库', category: 'data' },
  { tag: 'WorkflowStore', label: '工作流写库', category: 'data' },
  { tag: 'NodeFlowStore', label: '节点流写库', category: 'data' },
  { tag: 'ReferenceStore', label: '参考书写库', category: 'data' },
  { tag: 'UserStyleStore', label: '文风档案写库', category: 'data' },
  { tag: 'BackupStore', label: '快照写库', category: 'data' },
  { tag: 'SimulationRuntime', label: '模拟运行写库', category: 'data' },
  { tag: 'StoryTimelineStore', label: '故事年表写库', category: 'data' },
  { tag: 'ReviewResult', label: '审阅结果', category: 'data' },
  { tag: 'PersistentTask', label: '持久任务', category: 'data' },
  { tag: 'ProjectStore', label: '项目写库', category: 'data' },
  { tag: 'ProjectSingletons', label: '项目单例表', category: 'data' },
  { tag: 'StateCard', label: '状态卡', category: 'data' },
  { tag: 'EmotionBeat', label: '情感节拍', category: 'data' },
  { tag: 'StoryArc', label: '故事线', category: 'data' },
  { tag: 'StorylineProgress', label: '故事线进度', category: 'data' },
  { tag: 'StoryTimeline', label: '故事年表', category: 'data' },
  { tag: 'HistoricalStore', label: '历史资料', category: 'data' },
  { tag: 'Inventory', label: '物品账本', category: 'data' },
  { tag: 'Character', label: '角色档案', category: 'data' },
  { tag: 'schema', label: '数据库结构', category: 'data' },
  { tag: 'restore', label: '本地恢复', category: 'data' },
  { tag: 'folder', label: '本地文件夹', category: 'data' },
  { tag: 'AutoBackup', label: '自动备份', category: 'data' },
  { tag: 'FolderAutoBackup', label: '文件夹自动备份', category: 'data' },
  { tag: 'GistAutoBackup', label: '云备份', category: 'data' },

  // 编辑器
  { tag: 'ChapterEditor', label: '章节编辑器', category: 'editor' },
  { tag: 'StateDiff', label: '状态差异', category: 'editor' },
  { tag: 'ScenePanel', label: '场景面板', category: 'editor' },
  { tag: 'DetailedOutline', label: '细纲', category: 'editor' },
  { tag: 'Outline', label: '大纲', category: 'editor' },
  { tag: 'OutlinePanel', label: '大纲面板', category: 'editor' },
  { tag: 'BatchOutline', label: '批量卷纲', category: 'editor' },
  { tag: 'BatchDetail', label: '批量细纲', category: 'editor' },
  { tag: 'BatchChapter', label: '批量正文', category: 'editor' },

  // 导入导出
  { tag: 'import', label: '文档导入', category: 'import' },
  { tag: 'ImportPipeline', label: '分块导入流水线', category: 'import' },
  { tag: 'ImportChunk', label: '导入单块', category: 'import' },
  { tag: 'CharacterMerge', label: '跨块角色合并', category: 'import' },
  { tag: 'ExportJSON', label: 'JSON 导出导入', category: 'export' },
  { tag: 'ExportSettings', label: '设置快照导出', category: 'export' },
  { tag: 'DbSnapshot', label: '库快照', category: 'export' },
  { tag: 'TextExport', label: '正文导出', category: 'export' },
  { tag: 'Migration', label: '数据迁移', category: 'data' },
  { tag: 'Consistency', label: '一致性检查', category: 'data' },
  { tag: 'FactLedger', label: '事实账本', category: 'data' },
  { tag: 'KnowledgeLedger', label: '认知账本', category: 'data' },
  { tag: 'Retrieval', label: '检索', category: 'data' },
  { tag: 'ReferenceAnalysis', label: '参考书分析', category: 'ai' },
  { tag: 'Storyline', label: '故事线进度', category: 'data' },
  { tag: 'StoryPlanning', label: '故事规划', category: 'data' },
  { tag: 'OutlineDomain', label: '大纲领域逻辑', category: 'data' },
  { tag: 'EntityMatch', label: '实体称呼匹配', category: 'data' },
  { tag: 'EditorOps', label: '编辑器操作', category: 'editor' },
  { tag: 'AutoSave', label: '自动保存', category: 'editor' },
  { tag: 'Inspiration', label: '灵感工作台', category: 'data' },
  { tag: 'Evals', label: '长程一致性评测', category: 'ai' },
  { tag: 'CharacterDrivenPlan', label: '角色驱动剧情计划', category: 'data' },
  { tag: 'StoreFactory', label: '通用 store 工厂', category: 'data' },
  { tag: 'Diagnostics', label: '诊断报告', category: 'system' },
  { tag: 'Deploy', label: '部署与基础路径', category: 'system' },
  { tag: 'Utils', label: '通用工具', category: 'system' },
  { tag: 'HistoryAI', label: '历史生成', category: 'import' },
  { tag: 'WorldMapVoronoi', label: '世界地图', category: 'export' },
  { tag: 'MapEngine', label: '地图引擎', category: 'export' },
  { tag: 'MapImage', label: '原图识别与标注', category: 'data' },

  // 界面与引导
  { tag: 'Workspace', label: '工作区', category: 'ui' },
  { tag: 'WelcomeGuide', label: '新手引导', category: 'ui' },
  { tag: 'pwa', label: 'PWA', category: 'ui' },

  // 安全
  { tag: 'Safety', label: '高危操作保护', category: 'safety' },
  { tag: 'RescueVault', label: '库外恢复哨兵', category: 'safety' },

  // 系统与日志自身
  { tag: 'bootstrap', label: '启动', category: 'system' },
  { tag: 'Registry', label: '注册表校验', category: 'system' },
  { tag: 'ErrorBoundary', label: '错误边界', category: 'system' },
  { tag: 'Logging', label: '日志系统', category: 'system' },
  { tag: 'Unknown', label: '未登记 tag 兜底', category: 'system' },
]

const TAG_SET = new Set(LOG_TAGS.map(spec => spec.tag))

export type LogTag = string

export function isLogTag(value: string): boolean {
  return TAG_SET.has(value)
}

export function logTagSpec(tag: string): LogTagSpec | undefined {
  return LOG_TAGS.find(spec => spec.tag === tag)
}
