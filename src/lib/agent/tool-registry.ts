import { db } from '../db/schema'
import { parseInspirationFragments } from '../inspiration/workspace'
import { assembleContext } from '../registry/assemble-context'
import { CONTEXT_SOURCE_BY_KEY } from '../registry/context-sources'
import type { AssembleContextInput } from '../registry/types'
import { AGENT_SEARCH_KINDS } from './read-sources'
import { AGENT_PROJECT_TABLE_NAMES } from './project-table-reader'
import type {
  AgentToolDefinition,
  AgentToolExecutionContext,
  AgentToolJsonSchema,
  AgentToolResult,
} from './types'

type ArgRules = {
  allowed: readonly string[]
  required?: readonly string[]
}

type ReadToolSpec = Omit<AgentToolDefinition, 'execute' | 'risk'> & {
  argRules: ArgRules
  requiresWorldScope?: boolean
}

const EMPTY_SCHEMA: AgentToolJsonSchema = {
  type: 'object',
  properties: {},
  additionalProperties: false,
}

const OPTIONAL_BOUNDARY_SCHEMA: AgentToolJsonSchema = {
  type: 'object',
  properties: {
    chapterId: { type: 'integer', minimum: 1, description: '章节 ID' },
    outlineNodeId: { type: 'integer', minimum: 1, description: '大纲节点 ID' },
    characterId: { type: 'integer', minimum: 1, description: '角色 ID' },
  },
  additionalProperties: false,
}

const READ_TOOL_SPECS: readonly ReadToolSpec[] = [
  {
    name: 'read_project_status',
    description: '读取当前项目的紧凑填写概况、字数和模块数量，不返回整表原文。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['projectStatus'],
    inputBudgetTokens: 1400,
    argRules: { allowed: [] },
  },
  {
    name: 'sample_project_prose',
    description: '评价文章质量时必读：抽取有界正文及覆盖范围；点名卷/篇时先解析大纲并传 outlineNodeId，点名章节时传 chapterId。',
    parameters: {
      type: 'object',
      properties: {
        chapterId: { type: 'integer', minimum: 1, description: '作者点名时要重点评价的章节 ID' },
        outlineNodeId: { type: 'integer', minimum: 1, description: '作者点名卷/篇时解析得到的大纲节点 ID（含后代）' },
      },
      additionalProperties: false,
    },
    sourceKeys: ['proseSamples'],
    inputBudgetTokens: 9500,
    argRules: { allowed: ['chapterId', 'outlineNodeId'] },
    requiresWorldScope: true,
  },
  {
    name: 'list_project_tables',
    description: '列出 PROJECT_TABLES 登记的所有项目数据表，供项目级查询定位。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['projectTableCatalog'],
    inputBudgetTokens: 4300,
    argRules: { allowed: [] },
  },
  {
    name: 'read_project_table',
    description: '按项目全域分页读取登记表；可用 query 在名称等短字段中筛选靠后的记录，返回继续扫描 offset。每条先给记录 ID、版本和作用域，再给 PROJECT_TABLES 引用/树关系；章节与大纲节点附规范章序、卷内序号及相邻章。长字段可另行分段读取。',
    parameters: {
      type: 'object',
      properties: {
        tableName: { type: 'string', enum: AGENT_PROJECT_TABLE_NAMES, description: '从项目表目录选择的表名' },
        offset: { type: 'integer', minimum: 0, maximum: 100000, description: '从 0 开始的偏移' },
        pageSize: { type: 'integer', minimum: 1, maximum: 10, description: '每页 1-10 条' },
        query: { type: 'string', description: '可选，按记录短文本字段筛选，2-100 字' },
      },
      required: ['tableName'],
      additionalProperties: false,
    },
    sourceKeys: ['projectTableRecords'],
    inputBudgetTokens: 9000,
    argRules: { allowed: ['tableName', 'offset', 'pageSize', 'query'], required: ['tableName'] },
  },
  {
    name: 'read_project_record_field',
    description: '按项目归属读取指定记录的一个长字段；用 charOffset 分段继续读取，二进制仅返回元信息。',
    parameters: {
      type: 'object',
      properties: {
        tableName: { type: 'string', enum: AGENT_PROJECT_TABLE_NAMES, description: '已登记的项目表名' },
        recordId: { type: 'integer', minimum: 1, description: '表记录 ID' },
        fieldName: { type: 'string', description: '要读取的字段名' },
        charOffset: { type: 'integer', minimum: 0, maximum: 2000000, description: '字符偏移' },
        charLimit: { type: 'integer', minimum: 1, maximum: 6000, description: '本次最多读取字符数' },
      },
      required: ['tableName', 'recordId', 'fieldName'],
      additionalProperties: false,
    },
    sourceKeys: ['projectRecordField'],
    inputBudgetTokens: 8000,
    argRules: {
      allowed: ['tableName', 'recordId', 'fieldName', 'charOffset', 'charLimit'],
      required: ['tableName', 'recordId', 'fieldName'],
    },
  },
  {
    name: 'search_project_records',
    description: '跨 PROJECT_TABLES 登记表搜索完整字符串字段，含长正文和长备注。每次只扫描一页并返回续查 cursor；未到表尾不得回答“全项目没有”。命中给出表、记录、字段、字符偏移和短摘，再用 read_project_record_field 读取上下文。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 100 },
        cursor: { type: 'string', description: '上一页返回的续查 cursor' },
        limit: { type: 'integer', minimum: 1, maximum: 10 },
        tableName: { type: 'string', enum: AGENT_PROJECT_TABLE_NAMES },
      },
      required: ['query'],
      additionalProperties: false,
    },
    sourceKeys: ['projectTableSearch'],
    inputBudgetTokens: 5000,
    argRules: { allowed: ['query', 'cursor', 'limit', 'tableName'], required: ['query'] },
  },
  {
    name: 'preview_chapter_deletion',
    description: '只读计算某章节正文与关联记录的真实删除影响；不会删除。整章删除必须另走专用确认候选。',
    parameters: {
      type: 'object',
      properties: { recordId: { type: 'integer', minimum: 1, description: '章节记录 ID' } },
      required: ['recordId'],
      additionalProperties: false,
    },
    sourceKeys: ['chapterDeletionImpact'],
    inputBudgetTokens: 1500,
    argRules: { allowed: ['recordId'], required: ['recordId'] },
  },
  {
    name: 'read_worldview',
    description: '读取当前世界的世界观、力量体系和设定词条。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['worldview', 'powerSystem', 'codex'],
    inputBudgetTokens: 18_000,
    argRules: { allowed: [] },
  },
  {
    name: 'read_map_facts',
    description: '读取当前世界作者确认的地图实体与关系摘要；不读取原图或未审核 AI 猜测。完整条目可继续分页读取 mapFeatures、mapRelations。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['mapFacts'],
    inputBudgetTokens: 3000,
    argRules: { allowed: [] },
    requiresWorldScope: true,
  },
  {
    name: 'read_story_core',
    description: '读取项目级故事核心和作者明确激活的角色驱动方案。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['storyCore', 'characterDrivenPlan'],
    inputBudgetTokens: 8000,
    argRules: { allowed: [] },
  },
  {
    name: 'read_characters',
    description: '读取当前世界可见的角色档案和项目角色关系。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['characters', 'characterRelations'],
    inputBudgetTokens: 10_500,
    argRules: { allowed: [] },
  },
  {
    name: 'read_outline',
    description: '读取当前世界的大纲树；可附带一个节点或章节以读取当前章纲。',
    parameters: {
      type: 'object',
      properties: {
        outlineNodeId: { type: 'integer', minimum: 1, description: '可选的大纲节点 ID' },
        chapterId: { type: 'integer', minimum: 1, description: '可选的章节 ID' },
      },
      additionalProperties: false,
    },
    sourceKeys: ['outlineTree', 'chapterOutline'],
    inputBudgetTokens: 7000,
    argRules: { allowed: ['outlineNodeId', 'chapterId'] },
  },
  {
    name: 'read_chapter',
    description: '读取当前项目指定章节的正文。',
    parameters: {
      type: 'object',
      properties: {
        chapterId: { type: 'integer', minimum: 1, description: '要读取的章节 ID' },
      },
      required: ['chapterId'],
      additionalProperties: false,
    },
    sourceKeys: ['chapterContent'],
    inputBudgetTokens: 24_000,
    argRules: { allowed: ['chapterId'], required: ['chapterId'] },
    requiresWorldScope: true,
  },
  {
    name: 'read_history',
    description: '读取当前世界的历史时间线和历史关键词上下文。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['historical'],
    inputBudgetTokens: 2200,
    argRules: { allowed: [] },
  },
  {
    name: 'read_world_rules',
    description: '读取当前世界作者确认的 Canon 断言与真实/幻想规则。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['canonAssertions', 'worldRules'],
    inputBudgetTokens: 3500,
    argRules: { allowed: [] },
  },
  {
    name: 'read_foreshadows',
    description: '读取伏笔状态；给出章节时按该章边界组织上下文。',
    parameters: {
      type: 'object',
      properties: {
        chapterId: { type: 'integer', minimum: 1, description: '可选的当前章节 ID' },
      },
      additionalProperties: false,
    },
    sourceKeys: ['foreshadows'],
    inputBudgetTokens: 1800,
    argRules: { allowed: ['chapterId'] },
  },
  {
    name: 'read_inventory',
    description: '读取物品流水；提供章节或大纲边界时同时返回已确认的当前持有投影。',
    parameters: OPTIONAL_BOUNDARY_SCHEMA,
    sourceKeys: ['itemLedger', 'heldItems'],
    inputBudgetTokens: 4200,
    argRules: { allowed: ['chapterId', 'outlineNodeId', 'characterId'] },
  },
  {
    name: 'read_story_timeline',
    description: '读取故事进程年表和作者确认的故事线进度。',
    parameters: {
      type: 'object',
      properties: {
        chapterId: { type: 'integer', minimum: 1, description: '可选的当前章节 ID' },
      },
      additionalProperties: false,
    },
    sourceKeys: ['storyTimeline', 'storylineProgress'],
    inputBudgetTokens: 4800,
    argRules: { allowed: ['chapterId'] },
  },
  {
    name: 'read_world_groups',
    description: '读取项目世界组目录和世界连接关系。',
    parameters: EMPTY_SCHEMA,
    sourceKeys: ['worldGroups'],
    inputBudgetTokens: 1800,
    argRules: { allowed: [] },
  },
  {
    name: 'read_inspiration_workspace',
    description: '只读取作者本次明确勾选的灵感碎片和同模式最近确认版本。',
    parameters: {
      type: 'object',
      properties: {
        fragmentIds: {
          type: 'array',
          description: '本次参与反推的灵感碎片 ID，最多 24 个',
          items: { type: 'string' },
        },
        mode: {
          type: 'string',
          enum: ['single', 'multiworld'],
          description: '与当前项目一致的反推结果模式',
        },
      },
      required: ['fragmentIds', 'mode'],
      additionalProperties: false,
    },
    sourceKeys: ['inspirationWorkspace'],
    inputBudgetTokens: 11_000,
    argRules: { allowed: ['fragmentIds', 'mode'], required: ['fragmentIds', 'mode'] },
  },
  {
    name: 'search_text',
    description: '在当前项目与世界作用域内搜索五类范围：章节正文(chapter)、角色(character)、大纲(outline)、设定词条(codex)、重要地点(location)。只返回有界短摘；搜索其他登记表或长字段全文请用 search_project_records。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 100, description: '搜索关键词' },
        limit: { type: 'integer', minimum: 1, maximum: 10, description: '最多返回条数' },
        kinds: {
          type: 'array',
          description: '可选的数据类型过滤',
          items: { type: 'string', enum: AGENT_SEARCH_KINDS },
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    sourceKeys: ['searchResults'],
    inputBudgetTokens: 2600,
    argRules: { allowed: ['query', 'limit', 'kinds'], required: ['query'] },
  },
  {
    // AGENT-2 检索修复：作者用“序篇/第一卷/第3章”这类口语引用时，先落到真实大纲节点。
    name: 'resolve_outline_reference',
    description: '把作者口中的卷/章叫法（序篇、序卷、楔子、第一卷、第3章…）解析到真实大纲节点，返回候选、节点 id、含章节数与已写正文章数。问“某一卷/某一章”的问题前先用它定位，不要因为名称对不上就回答“项目里没有”。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 60, description: '作者的原始叫法，如“序篇”“第一卷”“第3章”' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    sourceKeys: ['outlineReferenceLookup'],
    inputBudgetTokens: 3000,
    argRules: { allowed: ['query'], required: ['query'] },
  },
  {
    // AGENT-2 检索修复：“出场几次”必须由确定性计数回答，而不是模型翻几页正文心算。
    name: 'count_character_appearances',
    description: '按登记名与别称，确定性统计某角色在指定大纲作用域（或整个项目）内逐章的正文出现次数与合计。回答“出场/出现/提到几次”这类计数问题必须用它，不要用心算或只凭搜索结果推断。作用域可先用 resolve_outline_reference 得到节点 id。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 2, maxLength: 60, description: '角色登记名或别称' },
        outlineNodeId: { type: 'integer', minimum: 1, description: '限定作用域的大纲节点 id（含其子节点）；省略则统计整个项目' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    sourceKeys: ['characterMentionCounts'],
    inputBudgetTokens: 4500,
    argRules: { allowed: ['query', 'outlineNodeId'], required: ['query'] },
  },
] as const

function emptyMeta(toolName: string, sourceKeys: readonly string[], budget: number): AgentToolResult['meta'] {
  return {
    toolName,
    sourceKeys,
    included: [],
    omitted: [],
    trimmed: [],
    totalInputTokens: 0,
    inputBudget: budget,
    overBudgetBeforeTrim: false,
    overBudgetAfterTrim: false,
  }
}

function failure(spec: ReadToolSpec, error: string): AgentToolResult {
  return {
    ok: false,
    content: '',
    error,
    meta: emptyMeta(spec.name, spec.sourceKeys, spec.inputBudgetTokens),
  }
}

function positiveInteger(value: unknown, name: string): number | undefined {
  if (value == null) return undefined
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${name} 必须是正整数`)
  return Number(value)
}

function validateArgs(spec: ReadToolSpec, raw: Record<string, unknown>): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('工具参数必须是对象')
  const keys = Object.keys(raw)
  const unknown = keys.filter(key => !spec.argRules.allowed.includes(key))
  if (unknown.length) throw new Error(`不允许的参数：${unknown.join(', ')}`)
  const missing = (spec.argRules.required ?? []).filter(key => raw[key] == null)
  if (missing.length) throw new Error(`缺少必填参数：${missing.join(', ')}`)

  const args = { ...raw }
  for (const key of ['chapterId', 'outlineNodeId', 'characterId', 'recordId']) {
    if (key in args) args[key] = positiveInteger(args[key], key)
  }
  if ('query' in args) {
    if (typeof args.query !== 'string') throw new Error('query 必须是字符串')
    const query = args.query.trim()
    if (query.length < 2 || query.length > 100) throw new Error('query 长度必须为 2-100')
    args.query = query
  }
  if ('limit' in args) {
    const limit = positiveInteger(args.limit, 'limit')
    if (limit != null && limit > 10) throw new Error('limit 不能大于 10')
    args.limit = limit
  }
  if ('kinds' in args) {
    if (!Array.isArray(args.kinds) || args.kinds.some(kind => (
      typeof kind !== 'string' || !AGENT_SEARCH_KINDS.includes(kind as typeof AGENT_SEARCH_KINDS[number])
    ))) throw new Error('kinds 含有不支持的数据类型')
  }
  if ('fragmentIds' in args) {
    if (
      !Array.isArray(args.fragmentIds)
      || args.fragmentIds.length === 0
      || args.fragmentIds.length > 24
      || args.fragmentIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 120)
    ) throw new Error('fragmentIds 必须包含 1-24 个有效碎片 ID')
    args.fragmentIds = [...new Set(args.fragmentIds.map(id => String(id).trim()))]
  }
  if ('mode' in args && args.mode !== 'single' && args.mode !== 'multiworld') {
    throw new Error('mode 必须是 single 或 multiworld')
  }
  if ('tableName' in args && (
    typeof args.tableName !== 'string'
    || !AGENT_PROJECT_TABLE_NAMES.includes(args.tableName)
  )) throw new Error('tableName 必须是已登记的项目表')
  if ('offset' in args && (
    !Number.isInteger(args.offset) || Number(args.offset) < 0 || Number(args.offset) > 100_000
  )) throw new Error('offset 必须是 0-100000 的整数')
  if ('pageSize' in args && (
    !Number.isInteger(args.pageSize) || Number(args.pageSize) < 1 || Number(args.pageSize) > 10
  )) throw new Error('pageSize 必须是 1-10 的整数')
  if ('fieldName' in args && (
    typeof args.fieldName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(args.fieldName)
  )) throw new Error('fieldName 无效')
  if ('cursor' in args && (
    typeof args.cursor !== 'string' || !/^\d+:\d+$/.test(args.cursor)
  )) throw new Error('cursor 无效')
  if ('charOffset' in args && (
    !Number.isInteger(args.charOffset) || Number(args.charOffset) < 0 || Number(args.charOffset) > 2_000_000
  )) throw new Error('charOffset 必须是 0-2000000 的整数')
  if ('charLimit' in args && (
    !Number.isInteger(args.charLimit) || Number(args.charLimit) < 1 || Number(args.charLimit) > 6000
  )) throw new Error('charLimit 必须是 1-6000 的整数')
  return args
}

async function resolveScope(
  spec: ReadToolSpec,
  context: AgentToolExecutionContext,
  args: Record<string, unknown>,
): Promise<AssembleContextInput> {
  const projectId = positiveInteger(context.projectId, 'projectId')!
  const project = await db.projects.get(projectId)
  if (!project) throw new Error('项目不存在')
  const fragmentIds = args.fragmentIds as string[] | undefined
  const inspirationMode = args.mode as 'single' | 'multiworld' | undefined
  if (
    inspirationMode
    && inspirationMode !== (project.enableMultiWorld ? 'multiworld' : 'single')
  ) throw new Error('灵感反推模式与当前项目不一致')
  if (fragmentIds) {
    const workspace = await db.inspirationWorkspaces.where('projectId').equals(projectId).first()
    const available = new Set(parseInspirationFragments(workspace?.fragments).map(item => item.id))
    if (fragmentIds.some(fragmentId => !available.has(fragmentId))) {
      throw new Error('灵感碎片不存在或不属于当前项目')
    }
  }

  const needsWorld = spec.requiresWorldScope
    || spec.sourceKeys.some(key => CONTEXT_SOURCE_BY_KEY.get(key)?.requiresWorldGroupId)
  const explicitWorld = Object.prototype.hasOwnProperty.call(context, 'worldGroupId')
    && context.worldGroupId !== undefined
  let worldGroupId = context.worldGroupId
  if (needsWorld && !explicitWorld) {
    if (project.enableMultiWorld) throw new Error('多世界项目必须先选择世界组')
    worldGroupId = null
  }
  if (worldGroupId != null) {
    const group = await db.worldGroups.get(worldGroupId)
    if (!group || group.projectId !== projectId) throw new Error('世界组不属于当前项目')
  }

  const chapterId = args.chapterId as number | undefined
  const outlineNodeId = args.outlineNodeId as number | undefined
  const characterId = args.characterId as number | undefined
  let chapterOutlineNodeId: number | undefined
  const assertOutlineWorld = async (nodeId: number) => {
    let node = await db.outlineNodes.get(nodeId)
    const visited = new Set<number>()
    let effectiveWorld: number | null = null
    while (node) {
      if (node.projectId !== projectId) throw new Error('大纲节点不属于当前项目')
      if (node.worldGroupId != null) {
        effectiveWorld = node.worldGroupId
        break
      }
      if (node.parentId == null || visited.has(node.parentId)) break
      visited.add(node.parentId)
      node = await db.outlineNodes.get(node.parentId)
    }
    if (needsWorld && effectiveWorld !== (worldGroupId ?? null)) {
      throw new Error('大纲或章节不属于当前世界作用域')
    }
  }
  if (chapterId != null) {
    const chapter = await db.chapters.get(chapterId)
    if (!chapter || chapter.projectId !== projectId) throw new Error('章节不属于当前项目')
    chapterOutlineNodeId = chapter.outlineNodeId
    await assertOutlineWorld(chapter.outlineNodeId)
  }
  if (outlineNodeId != null) {
    const node = await db.outlineNodes.get(outlineNodeId)
    if (!node || node.projectId !== projectId) throw new Error('大纲节点不属于当前项目')
    await assertOutlineWorld(outlineNodeId)
  }
  if (chapterOutlineNodeId != null && outlineNodeId != null && chapterOutlineNodeId !== outlineNodeId) {
    throw new Error('章节与大纲节点边界不一致')
  }
  if (characterId != null) {
    const character = await db.characters.get(characterId)
    if (!character || character.projectId !== projectId) throw new Error('角色不属于当前项目')
    if (
      needsWorld
      && !character.isCrossWorld
      && (character.homeWorldGroupId ?? null) !== (worldGroupId ?? null)
    ) throw new Error('角色不属于当前世界作用域')
  }

  return {
    projectId,
    ...(needsWorld || explicitWorld ? { worldGroupId: worldGroupId ?? null } : {}),
    chapterId,
    outlineNodeId,
    characterId,
    searchQuery: args.query as string | undefined,
    searchLimit: args.limit as number | undefined,
    searchKinds: args.kinds as string[] | undefined,
    inspirationFragmentIds: fragmentIds,
    inspirationMode,
    projectTableName: args.tableName as string | undefined,
    projectTableOffset: args.offset as number | undefined,
    projectTablePageSize: args.pageSize as number | undefined,
    projectTableQuery: args.query as string | undefined,
    projectSearchCursor: args.cursor as string | undefined,
    projectSearchTableName: spec.name === 'search_project_records'
      ? args.tableName as string | undefined : undefined,
    projectTableRecordId: args.recordId as number | undefined,
    projectTableFieldName: args.fieldName as string | undefined,
    projectTableCharOffset: args.charOffset as number | undefined,
    projectTableCharLimit: args.charLimit as number | undefined,
    provider: context.provider,
    model: context.model,
    sourceKeys: [...spec.sourceKeys],
    inputBudgetMaxTokens: Math.min(
      spec.inputBudgetTokens,
      context.contextPolicy?.maxInputTokens ?? spec.inputBudgetTokens,
    ),
    sourceBudgetScale: context.contextPolicy?.sourceBudgetScale,
  }
}

async function executeReadTool(
  spec: ReadToolSpec,
  context: AgentToolExecutionContext,
  rawArgs: Record<string, unknown>,
): Promise<AgentToolResult> {
  try {
    const args = validateArgs(spec, rawArgs)
    const assembled = await assembleContext(await resolveScope(spec, context, args))
    return {
      ok: true,
      content: assembled.text || '当前作用域内没有可用数据。',
      meta: {
        toolName: spec.name,
        sourceKeys: spec.sourceKeys,
        included: assembled.included,
        omitted: assembled.omitted,
        trimmed: assembled.trimmed,
        totalInputTokens: assembled.totalInputTokens,
        inputBudget: assembled.inputBudget,
        overBudgetBeforeTrim: assembled.overBudgetBeforeTrim,
        overBudgetAfterTrim: assembled.overBudgetAfterTrim,
      },
    }
  } catch (error) {
    return failure(spec, error instanceof Error ? error.message : '工具执行失败')
  }
}

export const AGENT_READ_TOOLS: readonly AgentToolDefinition[] = READ_TOOL_SPECS.map(spec => {
  for (const sourceKey of spec.sourceKeys) {
    if (!CONTEXT_SOURCE_BY_KEY.has(sourceKey)) {
      throw new Error(`Agent 工具 ${spec.name} 引用了未注册上下文源：${sourceKey}`)
    }
  }
  return {
    name: spec.name,
    description: spec.description,
    risk: 'read',
    parameters: spec.parameters,
    sourceKeys: spec.sourceKeys,
    inputBudgetTokens: spec.inputBudgetTokens,
    execute: (context, args) => executeReadTool(spec, context, args),
  }
})

export const AGENT_TOOL_BY_NAME: ReadonlyMap<string, AgentToolDefinition> = new Map(
  AGENT_READ_TOOLS.map(tool => [tool.name, tool] as const),
)

export async function executeAgentTool(
  name: string,
  context: AgentToolExecutionContext,
  args: Record<string, unknown> = {},
): Promise<AgentToolResult> {
  const tool = AGENT_TOOL_BY_NAME.get(name)
  if (!tool) {
    return {
      ok: false,
      content: '',
      error: `未知工具：${name}`,
      meta: emptyMeta(name, [], 0),
    }
  }
  return tool.execute(context, args)
}
