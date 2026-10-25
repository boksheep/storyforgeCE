import { db } from '../db/schema'
import type { AssembleContextInput } from '../registry/types'
import type { OutlineNode } from '../types'
import { countWords, htmlToPlainText } from '../utils/html'
import { resolveCanonicalChapterSequence } from '../ai/chapter-memory/canonical-chapter-sequence'
import { locationInWorld } from '../location/scope'

export const AGENT_SEARCH_KINDS = [
  'chapter',
  'character',
  'outline',
  'codex',
  'location',
  'map',
] as const

export type AgentSearchKind = typeof AGENT_SEARCH_KINDS[number]

const MAX_OUTLINE_NODES = 240
const MAX_SEARCH_HITS = 10
const MAX_SEARCH_QUERY_CHARS = 100
const MAX_SEARCH_EXCERPT_CHARS = 180

function normalizeWorldGroupId(value: number | null | undefined): number | null {
  return value ?? null
}

function effectiveOutlineWorld(
  node: OutlineNode,
  byId: ReadonlyMap<number, OutlineNode>,
): number | null {
  let current: OutlineNode | undefined = node
  const visited = new Set<number>()
  while (current) {
    if (current.worldGroupId != null) return current.worldGroupId
    if (current.parentId == null || visited.has(current.parentId)) return null
    visited.add(current.parentId)
    current = byId.get(current.parentId)
  }
  return null
}

function excerptAround(text: string, query: string): string {
  const plain = htmlToPlainText(text).replace(/\s+/g, ' ').trim()
  if (!plain) return ''
  const lower = plain.toLocaleLowerCase()
  const at = lower.indexOf(query.toLocaleLowerCase())
  if (at < 0) return plain.slice(0, MAX_SEARCH_EXCERPT_CHARS)
  const half = Math.floor(MAX_SEARCH_EXCERPT_CHARS / 2)
  const start = Math.max(0, at - half)
  const end = Math.min(plain.length, start + MAX_SEARCH_EXCERPT_CHARS)
  return `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
}

function matches(text: string, query: string): boolean {
  return text.toLocaleLowerCase().includes(query.toLocaleLowerCase())
}

export async function readAgentProjectStatus(input: AssembleContextInput): Promise<string> {
  const project = await db.projects.get(input.projectId)
  if (!project) return ''

  const [
    worldGroups,
    worldviews,
    storyCores,
    characters,
    outlineNodes,
    chapters,
    foreshadows,
    references,
  ] = await Promise.all([
    db.worldGroups.where('projectId').equals(input.projectId).count(),
    db.worldviews.where('projectId').equals(input.projectId).count(),
    db.storyCores.where('projectId').equals(input.projectId).count(),
    db.characters.where('projectId').equals(input.projectId).count(),
    db.outlineNodes.where('projectId').equals(input.projectId).count(),
    db.chapters.where('projectId').equals(input.projectId).toArray(),
    db.foreshadows.where('projectId').equals(input.projectId).count(),
    db.references.where('projectId').equals(input.projectId).count(),
  ])
  const writtenChapters = chapters.filter(chapter => htmlToPlainText(chapter.content || '').trim())
  const totalWords = chapters.reduce((sum, chapter) => (
    sum + (chapter.wordCount || countWords(htmlToPlainText(chapter.content || '')))
  ), 0)

  return [
    '【项目概况】',
    `项目：${project.name}`,
    `状态：${project.status ?? 'drafting'}；模式：${project.enableMultiWorld ? '多世界' : '单世界'}`,
    `字数：${totalWords}/${project.targetWordCount || 0}`,
    `章节：${chapters.length}（已有正文 ${writtenChapters.length}）`,
    `世界组：${worldGroups}；世界观：${worldviews}；故事核心：${storyCores}`,
    `角色：${characters}；大纲节点：${outlineNodes}；伏笔：${foreshadows}；参考资料：${references}`,
  ].join('\n')
}

/** 文章评价的有界正文证据：按请求的卷章作用域取开头、中段和结尾。 */
export async function readAgentProseSamples(input: AssembleContextInput): Promise<string> {
  const [chapters, nodes] = await Promise.all([
    db.chapters.where('projectId').equals(input.projectId).toArray(),
    db.outlineNodes.where('projectId').equals(input.projectId).toArray(),
  ])
  const { sequence } = resolveCanonicalChapterSequence(nodes, chapters)
  const nodeById = new Map(nodes.flatMap(node => node.id == null ? [] : [[node.id, node] as const]))
  const inRequestedOutline = (nodeId: number): boolean => {
    if (input.outlineNodeId == null) return true
    const visited = new Set<number>()
    let current: OutlineNode | undefined = nodeById.get(nodeId)
    while (current?.id != null && !visited.has(current.id)) {
      if (current.id === input.outlineNodeId) return true
      visited.add(current.id)
      current = current.parentId == null ? undefined : nodeById.get(current.parentId)
    }
    return false
  }
  const worldChapters = sequence.filter(entry => entry.worldGroupId === normalizeWorldGroupId(input.worldGroupId)
    && inRequestedOutline(entry.chapter.outlineNodeId))
  const scope = input.outlineNodeId == null ? '当前世界' : `大纲节点 #${input.outlineNodeId} 及其后代`
  const requested = input.chapterId == null ? null
    : worldChapters.find(entry => entry.chapter.id === input.chapterId)
  if (requested && !htmlToPlainText(requested.chapter.content || '').trim()) {
    return `【文章正文抽样】作者指定章节 #${input.chapterId} 正文为空；可评价样本 0，不能评价该章质量。`
  }
  const visible = worldChapters.filter(entry => htmlToPlainText(entry.chapter.content || '').trim())
  if (!visible.length) return `【文章正文抽样】可评价样本 0；${scope}没有已写正文，不能评价文章质量。`
  const selectedIndexes = [0, Math.floor((visible.length - 1) / 2), visible.length - 1]
  const requestedIndex = input.chapterId == null
    ? -1
    : visible.findIndex(entry => entry.chapter.id === input.chapterId)
  if (requestedIndex >= 0) selectedIndexes.push(requestedIndex)
  const selected = [...new Set(selectedIndexes)].sort((left, right) => left - right)
  const requestedNote = input.chapterId == null
    ? ''
    : requestedIndex >= 0
      ? `已包含作者指定章节 #${input.chapterId}；`
      : `作者指定章节 #${input.chapterId} 不属于当前世界正文；`
  return [
    `【文章正文抽样】${scope}已有正文 ${visible.length} 章；${requestedNote}可评价样本 ${selected.length} 章。样本只支持局部评价，不能代表全文。`,
    ...selected.map(index => {
      const { chapter, outlineNode } = visible[index]
      const text = htmlToPlainText(chapter.content || '').trim()
      const requested = chapter.id === input.chapterId ? '｜作者指定章节' : ''
      const excerpt = text.length <= 2200
        ? text
        : `${text.slice(0, 1200)}\n…〔省略 ${text.length - 2200} 字〕…\n${text.slice(-1000)}`
      return `【样本 ${index + 1}/${visible.length}${requested}｜章节 #${chapter.id ?? '?'} ${outlineNode?.title ?? chapter.title}｜正文 ${text.length} 字】\n${excerpt}`
    }),
  ].join('\n\n')
}

export async function readAgentWorldGroups(input: AssembleContextInput): Promise<string> {
  const [groups, links] = await Promise.all([
    db.worldGroups.where('projectId').equals(input.projectId).sortBy('order'),
    db.worldGroupLinks.where('projectId').equals(input.projectId).toArray(),
  ])
  if (!groups.length) return '【世界组】\n单世界项目：默认主世界（worldGroupId=null）'
  const names = new Map(groups.flatMap(group => group.id == null ? [] : [[group.id, group.name] as const]))
  const lines = groups.map(group => (
    `- #${group.id ?? '?'} ${group.name}｜${group.type}${group.description ? `：${group.description.slice(0, 180)}` : ''}`
  ))
  if (links.length) {
    lines.push(
      '【世界连接】',
      ...links.slice(0, 80).map(link => (
        `- ${names.get(link.fromGroupId) ?? `#${link.fromGroupId}`} → ${names.get(link.toGroupId) ?? `#${link.toGroupId}`}｜${link.linkType}${link.name ? `：${link.name}` : ''}`
      )),
    )
  }
  return ['【世界组】', ...lines].join('\n')
}

export async function readAgentOutlineTree(input: AssembleContextInput): Promise<string> {
  const rows = await db.outlineNodes.where('projectId').equals(input.projectId).toArray()
  if (!rows.length) return ''
  const byId = new Map(rows.flatMap(node => node.id == null ? [] : [[node.id, node] as const]))
  const targetWorld = normalizeWorldGroupId(input.worldGroupId)
  const visibleIds = new Set<number>()
  for (const node of rows) {
    if (node.id == null || effectiveOutlineWorld(node, byId) !== targetWorld) continue
    let current: OutlineNode | undefined = node
    const visited = new Set<number>()
    while (current?.id != null && !visited.has(current.id)) {
      if (effectiveOutlineWorld(current, byId) !== targetWorld) break
      visibleIds.add(current.id)
      visited.add(current.id)
      current = current.parentId == null ? undefined : byId.get(current.parentId)
    }
  }
  const visible = rows
    .filter(node => node.id != null && visibleIds.has(node.id))
    .sort((a, b) => a.order - b.order || (a.id ?? 0) - (b.id ?? 0))
  const children = new Map<number | null, OutlineNode[]>()
  for (const node of visible) {
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node)
    children.set(node.parentId, siblings)
  }
  const lines: string[] = ['【大纲树】']
  const seen = new Set<number>()
  const walk = (parentId: number | null, depth: number) => {
    for (const node of children.get(parentId) ?? []) {
      if (node.id == null || seen.has(node.id) || lines.length > MAX_OUTLINE_NODES) continue
      seen.add(node.id)
      const summary = node.summary.trim()
      lines.push(`${'  '.repeat(Math.min(depth, 8))}- #${node.id} [${node.type}] ${node.title}${summary ? `：${summary.slice(0, 220)}` : ''}`)
      walk(node.id, depth + 1)
    }
  }
  walk(null, 0)
  if (visible.length > seen.size) {
    for (const node of visible) {
      if (node.id == null || seen.has(node.id) || lines.length > MAX_OUTLINE_NODES) continue
      lines.push(`- #${node.id} [${node.type}] ${node.title}（父节点缺失或成环）`)
    }
  }
  if (lines.length > MAX_OUTLINE_NODES) lines.push('…（大纲树已按节点上限截断）')
  return lines.join('\n')
}

export async function readAgentSearchResults(input: AssembleContextInput): Promise<string> {
  const query = input.searchQuery?.trim().slice(0, MAX_SEARCH_QUERY_CHARS) ?? ''
  if (query.length < 2) return ''
  const requestedKinds = input.searchKinds?.filter((kind): kind is AgentSearchKind => (
    AGENT_SEARCH_KINDS.includes(kind as AgentSearchKind)
  ))
  const kinds = new Set<AgentSearchKind>(requestedKinds?.length ? requestedKinds : AGENT_SEARCH_KINDS)
  const limit = Math.max(1, Math.min(MAX_SEARCH_HITS, Math.floor(input.searchLimit ?? 5)))
  const [chapters, characters, outlineNodes, codexEntries, locations, mapFeatures, project] = await Promise.all([
    kinds.has('chapter') ? db.chapters.where('projectId').equals(input.projectId).toArray() : [],
    kinds.has('character') ? db.characters.where('projectId').equals(input.projectId).toArray() : [],
    kinds.has('outline') ? db.outlineNodes.where('projectId').equals(input.projectId).toArray() : [],
    kinds.has('codex') ? db.codexEntries.where('projectId').equals(input.projectId).toArray() : [],
    kinds.has('location') ? db.importantLocations.where('projectId').equals(input.projectId).toArray() : [],
    kinds.has('map') ? db.mapFeatures.where('projectId').equals(input.projectId).toArray() : [],
    db.projects.get(input.projectId),
  ])
  const nodeById = new Map(outlineNodes.flatMap(node => node.id == null ? [] : [[node.id, node] as const]))
  if (!outlineNodes.length && chapters.length) {
    const projectNodes = await db.outlineNodes.where('projectId').equals(input.projectId).toArray()
    for (const node of projectNodes) if (node.id != null) nodeById.set(node.id, node)
  }
  const targetWorld = normalizeWorldGroupId(input.worldGroupId)
  const hits: Array<{ kind: AgentSearchKind; id: number; title: string; excerpt: string }> = []
  const add = (kind: AgentSearchKind, id: number | undefined, title: string, body: string) => {
    if (id == null || hits.length >= limit || !matches(`${title}\n${body}`, query)) return
    hits.push({ kind, id, title, excerpt: excerptAround(body || title, query) })
  }

  for (const chapter of chapters) {
    const node = nodeById.get(chapter.outlineNodeId)
    if (!node || effectiveOutlineWorld(node, nodeById) !== targetWorld) continue
    add('chapter', chapter.id, chapter.title, chapter.content)
  }
  for (const character of characters) {
    if (!character.isCrossWorld && normalizeWorldGroupId(character.homeWorldGroupId) !== targetWorld) continue
    add('character', character.id, character.name, [
      character.shortDescription,
      character.identity,
      character.personality,
      character.background,
      character.motivation,
      character.arc,
    ].filter(Boolean).join('\n'))
  }
  for (const node of outlineNodes) {
    if (effectiveOutlineWorld(node, nodeById) !== targetWorld) continue
    add('outline', node.id, node.title, node.summary)
  }
  for (const entry of codexEntries) {
    if (entry.worldGroupId != null && entry.worldGroupId !== targetWorld) continue
    add('codex', entry.id, entry.name, `${entry.summary}\n${entry.description}`)
  }
  for (const location of locations) {
    if (!locationInWorld(location, Boolean(project?.enableMultiWorld), targetWorld)) continue
    add('location', location.id, location.name, `${location.description}\n${location.significance}`)
  }
  for (const feature of mapFeatures) {
    if (feature.status !== 'confirmed' || (feature.worldGroupId ?? null) !== targetWorld) continue
    add('map', feature.id, feature.name, `${feature.kind}\n${feature.description}`)
  }

  if (!hits.length) return `【项目内搜索】\n未找到“${query}”`
  return [
    `【项目内搜索】“${query}”（最多 ${limit} 条）`,
    ...hits.map(hit => `- [${hit.kind}#${hit.id}] ${hit.title}${hit.excerpt ? `：${hit.excerpt}` : ''}`),
  ].join('\n')
}
