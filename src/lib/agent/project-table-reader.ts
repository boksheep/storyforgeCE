import { db } from '../db/schema'
import { PROJECT_TABLES, REGISTRY_BY_NAME } from '../registry/project-tables'
import type { TableSpec } from '../registry/types'
import type { OutlineNode } from '../types'
import { walkOutlineChaptersInCanonicalOrder } from '../outline/canonical-outline-walk'
import { formatChapterNeighborEvidence } from './chapter-neighbor'

export const AGENT_PROJECT_TABLE_NAMES = PROJECT_TABLES
  .filter(spec => spec.owner !== 'global')
  .map(spec => spec.name)

export function projectTableCatalog(): string {
  return [
    '【项目表目录】以下为 PROJECT_TABLES 登记的项目数据；读取单表需指定 tableName，结果按项目全域分页。',
    ...PROJECT_TABLES.filter(spec => spec.owner !== 'global').map(spec =>
      `- ${spec.name}｜${spec.owner}${spec.worldScoped ? '｜世界字段' : ''}${spec.note ? `｜${spec.note.slice(0, 30)}` : ''}`),
  ].join('\n')
}

function displayRow(row: Record<string, unknown>, spec: TableSpec): string {
  const serialized = JSON.stringify(row, (key, value: unknown) => {
    if (spec.owner === 'blob' && key === 'blob') {
      return `[Blob ${Number(row.fileSize) || 0} bytes]`
    }
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
      return `[Blob ${value.size} bytes · ${value.type || 'unknown'}]`
    }
    if (value instanceof ArrayBuffer) return `[ArrayBuffer ${value.byteLength} bytes]`
    if (ArrayBuffer.isView(value)) return `[Binary ${value.byteLength} bytes]`
    return value
  })
  if (serialized.length <= 1800) return serialized
  return `${serialized.slice(0, 1800)}…（本条已截断，原始记录保留在项目中）`
}

function recordLocator(row: Record<string, unknown>, spec: TableSpec, projectId: number): string {
  return `【记录定位】${JSON.stringify({
    tableName: spec.name,
    recordId: Number.isInteger(row.id) ? row.id : spec.name === 'projects' ? projectId : null,
    projectId,
    worldGroupId: Number.isInteger(row.worldGroupId) ? row.worldGroupId : null,
    updatedAt: Number.isFinite(row.updatedAt) ? row.updatedAt : null,
  })}`
}

function tableRelationSummary(spec: TableSpec): string {
  const refs = (spec.refs ?? []).map(ref => {
    if (ref.kind === 'simple') return `${ref.field}→${ref.target}`
    if (ref.kind === 'indirect') return `${ref.via.field}→${ref.via.table}`
    if (ref.kind === 'array') return `${ref.field}[]→${ref.itemTarget}`
    if (ref.kind === 'json') return `${ref.field}${ref.jsonPath}→${ref.target}`
    return `blob→${ref.ownerTable}`
  })
  const remaps = (spec.exportRemap ?? []).map(ref => `${ref.field}→${ref.remapVia}`)
  return [
    `【表关系】${spec.name}｜归属 ${spec.owner}${spec.worldScoped ? '｜世界作用域' : ''}`,
    spec.tree ? `树父键 ${spec.tree.parentField}，order 仅在同父节点内排序` : '',
    spec.name === 'chapters' ? 'chapters.order 不表示叙事章序；章序来自大纲规范遍历' : '',
    refs.length ? `登记引用：${refs.slice(0, 12).join('；')}` : '',
    remaps.length ? `导入重映射：${remaps.slice(0, 12).join('；')}` : '',
  ].filter(Boolean).join('；')
}

async function recordRelationFormatter(spec: TableSpec, projectId: number): Promise<(row: Record<string, unknown>) => string> {
  if (spec.name !== 'chapters' && spec.name !== 'outlineNodes') return () => ''
  const [outlineNodes, chapters] = await Promise.all([
    db.outlineNodes.where('projectId').equals(projectId).toArray(),
    db.chapters.where('projectId').equals(projectId).toArray(),
  ])
  const walk = walkOutlineChaptersInCanonicalOrder(outlineNodes)
  const worldByNode = new Map(walk.chapters.map(item => [item.outlineNode.id!, item.worldGroupId]))
  const nodesById = new Map(outlineNodes.filter(node => node.id != null).map(node => [node.id!, node]))
  return row => {
    const nodeId = spec.name === 'chapters' ? Number(row.outlineNodeId) : Number(row.id)
    const node = nodesById.get(nodeId)
    if (!node) return spec.name === 'chapters' ? '【记录关系】关联的大纲节点不存在；不能推断章序。' : ''
    const ancestors: OutlineNode[] = []
    const visited = new Set<number>()
    let parent = node.parentId == null ? undefined : nodesById.get(node.parentId)
    while (parent?.id != null && !visited.has(parent.id)) {
      visited.add(parent.id)
      ancestors.unshift(parent)
      parent = parent.parentId == null ? undefined : nodesById.get(parent.parentId)
    }
    const path = [...ancestors, node].map(item => `#${item.id} ${String(item.title).replace(/\s+/g, ' ').replace(/【/g, '〔').replace(/】/g, '〕')}`).join(' / ')
    if (node.type !== 'chapter') return `【记录关系】大纲路径：${path}`
    return [
      `【记录关系】大纲路径：${path}`,
      formatChapterNeighborEvidence({ outlineNodes, chapters,
        worldGroupId: worldByNode.get(nodeId) ?? null,
        reference: node.title, anchorNodeId: nodeId }),
    ].join('\n')
  }
}

async function scopedRows(spec: TableSpec, projectId: number, offset: number, pageSize: number) {
  if (spec.name === 'projects') {
    const row = await db.projects.get(projectId)
    return { total: row ? 1 : 0, rows: row && offset === 0 ? [row] : [] }
  }
  if (spec.owner === 'project' || spec.owner === 'transient') {
    const collection = spec.table.where('projectId').equals(projectId)
    return {
      total: await collection.count(),
      rows: await collection.offset(offset).limit(pageSize).toArray(),
    }
  }
  if (spec.owner === 'direct-child' || spec.owner === 'indirect') {
    const reference = spec.refs?.find(ref => ref.kind === 'indirect')
    if (!reference || reference.kind !== 'indirect' || !spec.projectResolver) {
      throw new Error(`${spec.name} 缺少 PROJECT_TABLES 项目归属解析`)
    }
    const parentIds = await spec.projectResolver(projectId)
    if (!parentIds.length) return { total: 0, rows: [] }
    const collection = spec.table.where(reference.via.field).anyOf(parentIds)
    return {
      total: await collection.count(),
      rows: await collection.offset(offset).limit(pageSize).toArray(),
    }
  }
  if (spec.owner === 'blob') {
    const sessionIds = (await db.importSessions.where('projectId').equals(projectId).primaryKeys()) as number[]
    const ids = sessionIds.slice(offset, offset + pageSize)
    const rows = await spec.table.bulkGet(ids)
    return { total: sessionIds.length, rows: rows.filter((row): row is NonNullable<typeof row> => row != null) }
  }
  throw new Error(`${spec.name} 不是项目数据表`)
}

async function scopedRecord(spec: TableSpec, projectId: number, recordId: number): Promise<Record<string, unknown> | null> {
  if (spec.name === 'projects') {
    return recordId === projectId
      ? (await db.projects.get(projectId) as Record<string, unknown> | undefined) ?? null
      : null
  }
  const row = await spec.table.get(recordId) as Record<string, unknown> | undefined
  if (!row) return null
  if (spec.owner === 'project' || spec.owner === 'transient') {
    return row.projectId === projectId ? row : null
  }
  if (spec.owner === 'direct-child' || spec.owner === 'indirect') {
    const reference = spec.refs?.find(ref => ref.kind === 'indirect')
    if (!reference || reference.kind !== 'indirect' || !spec.projectResolver) return null
    const parentIds = await spec.projectResolver(projectId)
    return parentIds.includes(Number(row[reference.via.field])) ? row : null
  }
  if (spec.owner === 'blob') {
    const session = await db.importSessions.get(recordId)
    return session?.projectId === projectId ? row : null
  }
  return null
}

/** 项目级 Agent 的注册表驱动只读入口；二进制仅返回元信息，不把大文件送进模型。 */
export async function readProjectTablePage(input: {
  projectId: number
  tableName: string
  offset?: number
  pageSize?: number
  query?: string
}): Promise<string> {
  const spec = REGISTRY_BY_NAME.get(input.tableName)
  if (!spec || spec.owner === 'global') throw new Error('表未在项目 PROJECT_TABLES 中登记')
  const project = await db.projects.get(input.projectId)
  if (!project) throw new Error('项目不存在')
  const offset = input.offset ?? 0
  const pageSize = input.pageSize ?? 5
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new Error('offset 必须为 0-100000 的整数')
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 10) throw new Error('pageSize 必须为 1-10 的整数')
  const query = input.query?.trim().normalize('NFKC').toLocaleLowerCase('zh-CN')
  if (query && (query.length < 2 || query.length > 100)) throw new Error('query 必须为 2-100 字')
  const renderRows = async (rows: Record<string, unknown>[]) => {
    if (!rows.length) return []
    const recordRelation = await recordRelationFormatter(spec, input.projectId)
    return rows.map(row => [recordLocator(row, spec, input.projectId),
      recordRelation(row), displayRow(row, spec)].filter(Boolean).join('\n'))
  }
  if (query) {
    if (spec.owner === 'blob') throw new Error('二进制表不支持文本筛选，请按页读取元信息')
    const total = (await scopedRows(spec, input.projectId, 0, 1)).total
    const matches: Record<string, unknown>[] = []
    let scanned = 0
    const maxScan = 5000
    while (offset + scanned < total && scanned < maxScan && matches.length < pageSize) {
      const batchSize = Math.min(100, total - offset - scanned, maxScan - scanned)
      const batch = await scopedRows(spec, input.projectId, offset + scanned, batchSize)
      for (let index = 0; index < batchSize; index++) {
        const row = batch.rows[index] as Record<string, unknown> | undefined
        scanned++
        if (!row) continue
        const found = Object.values(row).some(value => typeof value === 'string'
          && value.slice(0, 1000).normalize('NFKC').toLocaleLowerCase('zh-CN').includes(query))
        if (found) matches.push(row)
        if (matches.length >= pageSize) break
      }
    }
    const nextOffset = offset + scanned
    const rendered = await renderRows(matches)
    return [
      `【项目表 ${spec.name} 筛选】关键词“${input.query!.trim()}”；共 ${total} 条；从 offset=${offset} 扫描 ${scanned} 条，命中 ${matches.length} 条；${nextOffset < total ? `继续查询可用 offset=${nextOffset}` : '已扫描到表尾'}`,
      tableRelationSummary(spec),
      ...(nextOffset < total && scanned >= maxScan ? ['本次扫描达到 5000 条上限，结果尚不完整。'] : []),
      ...rendered,
    ].join('\n')
  }
  const page = await scopedRows(spec, input.projectId, offset, pageSize)
  const rendered = await renderRows(page.rows as Record<string, unknown>[])
  return [
    `【项目表 ${spec.name}】共 ${page.total} 条；当前 offset=${offset}，返回 ${page.rows.length} 条`,
    tableRelationSummary(spec),
    ...rendered,
  ].join('\n')
}

export async function readProjectRecordField(input: {
  projectId: number
  tableName: string
  recordId: number
  fieldName: string
  charOffset?: number
  charLimit?: number
}): Promise<string> {
  const spec = REGISTRY_BY_NAME.get(input.tableName)
  if (!spec || spec.owner === 'global') throw new Error('表未在项目 PROJECT_TABLES 中登记')
  if (!Number.isInteger(input.recordId) || input.recordId < 1) throw new Error('recordId 必须是正整数')
  if (!input.fieldName || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(input.fieldName)) throw new Error('fieldName 无效')
  const offset = input.charOffset ?? 0
  const limit = input.charLimit ?? 4000
  if (!Number.isInteger(offset) || offset < 0 || offset > 2_000_000) throw new Error('charOffset 越界')
  if (!Number.isInteger(limit) || limit < 1 || limit > 6000) throw new Error('charLimit 必须是 1-6000')
  const row = await scopedRecord(spec, input.projectId, input.recordId)
  if (!row) throw new Error('记录不存在或不属于当前项目')
  if (!Object.prototype.hasOwnProperty.call(row, input.fieldName)) throw new Error('记录没有指定字段')
  const raw = row[input.fieldName]
  const value = spec.owner === 'blob' && input.fieldName === 'blob'
    ? `[Blob ${Number(row.fileSize) || 0} bytes]`
    : ArrayBuffer.isView(raw)
    ? `[Binary ${raw.byteLength} bytes]`
    : raw instanceof ArrayBuffer
    ? `[ArrayBuffer ${raw.byteLength} bytes]`
    : typeof Blob !== 'undefined' && raw instanceof Blob
    ? `[Blob ${raw.size} bytes · ${raw.type || 'unknown'}]`
    : typeof raw === 'string' ? raw : JSON.stringify(raw)
  const content = value ?? 'null'
  return [
    `【${spec.name}#${input.recordId}.${input.fieldName}】总字符 ${content.length}；区间 ${offset}-${Math.min(content.length, offset + limit)}`,
    content.slice(offset, offset + limit),
  ].join('\n')
}

/** 跨登记表搜索完整文本字段；游标表示扫描进度，不把“本页未命中”冒充全项目无结果。 */
export async function searchProjectRecordText(input: {
  projectId: number
  query: string
  cursor?: string
  limit?: number
  tableName?: string
}): Promise<string> {
  const project = await db.projects.get(input.projectId)
  if (!project) throw new Error('项目不存在')
  const query = input.query.trim()
  if (query.length < 2 || query.length > 100) throw new Error('query 必须为 2-100 字')
  const limit = input.limit ?? 5
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit 必须为 1-10')
  const specs = PROJECT_TABLES.filter(spec => spec.owner !== 'global' && spec.owner !== 'blob'
    && (!input.tableName || spec.name === input.tableName))
  if (!specs.length) throw new Error('搜索表未在项目 PROJECT_TABLES 中登记，或不支持文本搜索')
  const cursor = input.cursor ?? '0:0'
  if (!/^\d+:\d+$/.test(cursor)) throw new Error('cursor 无效')
  let [tableIndex, offset] = cursor.split(':').map(Number)
  if (tableIndex > specs.length || offset > 100_000) throw new Error('cursor 越界')
  const matches: string[] = []
  let scanned = 0
  const maxScan = 200
  const needle = query.toLocaleLowerCase('zh-CN')
  while (tableIndex < specs.length && scanned < maxScan && matches.length < limit) {
    const spec = specs[tableIndex]
    const page = await scopedRows(spec, input.projectId, offset, Math.min(50, maxScan - scanned))
    if (offset >= page.total || !page.rows.length) {
      tableIndex++
      offset = 0
      continue
    }
    for (const row of page.rows as Record<string, unknown>[]) {
      offset++
      scanned++
      for (const [field, value] of Object.entries(row)) {
        if (typeof value !== 'string') continue
        const position = value.toLocaleLowerCase('zh-CN').indexOf(needle)
        if (position < 0) continue
        const start = Math.max(0, position - 45)
        const end = Math.min(value.length, position + query.length + 65)
        const snippet = value.slice(start, end).replace(/\s+/g, ' ')
        matches.push(`${spec.name}#${String(row.id ?? input.projectId)}.${field} @${position}：${snippet}`)
        // 游标只按记录推进；一条记录的所有命中字段必须完整返回，避免续页漏结果。
      }
      if (matches.length >= limit || scanned >= maxScan) break
    }
    if (offset >= page.total) {
      tableIndex++
      offset = 0
    }
  }
  const nextCursor = tableIndex < specs.length ? `${tableIndex}:${offset}` : null
  return [
    `【项目跨表全文搜索】关键词“${query}”；本页扫描 ${scanned} 条，命中 ${matches.length} 处；${nextCursor ? `尚未搜完，继续使用 cursor=${nextCursor}` : '已搜索到所有登记表末尾'}`,
    ...matches,
  ].join('\n')
}
