import { db } from '../db/schema'
import { log } from '../logging/logger'
import { htmlToPlainText } from '../utils/html'
import {
  dedupeSurfaceForms,
  matchOutlineNodes,
  countMentions,
  subtreeNodeIds,
} from './project-lookup'
import type { OutlineNode } from '../types'
import { buildSurfaceOwnerIndex, entitySurfaceNames, resolveUniqueOwner } from '../entities/surface-match'
import { walkOutlineChaptersInCanonicalOrder } from '../outline/canonical-outline-walk'

/**
 * 主 Agent 检索读取源（AGENT-2 检索修复）。
 *
 * 两个都是**只读、有界、确定性**的：
 *  1. 大纲引用解析：把作者口中的“序篇/第一卷/第3章”落到真实大纲节点上；
 *  2. 角色出场统计：在指定作用域内逐章数字符串出现次数，直接回答问题，不靠模型心算。
 *
 * 与 CONTEXT_SOURCES 的关系：这两个函数只被注册为上下文源读取器，
 * 不绕过 assembleContext 被工具直接调用。
 */

const MAX_CANDIDATES = 5
const MAX_COUNT_CHAPTERS = 200
const MAX_REPORTED_CHAPTERS = 40

function outlineScope(nodes: OutlineNode[], worldGroupId: number | null): OutlineNode[] {
  // 与 readAgentOutlineTree 相同的世界归属规则：节点自身或最近祖先声明了世界。
  const byId = new Map(nodes.flatMap(node => node.id == null ? [] : [[node.id, node] as const]))
  const effectiveWorld = (node: OutlineNode): number | null => {
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
  return nodes.filter(node => effectiveWorld(node) === (worldGroupId ?? null))
}

async function loadOutlineNodes(projectId: number): Promise<OutlineNode[]> {
  return db.outlineNodes.where('projectId').equals(projectId).toArray()
}

/** 把作者的卷/章叫法解析到真实大纲节点，并附上章节与正文字数，供模型直接使用。 */
export async function lookupOutlineReference(input: {
  projectId: number
  worldGroupId: number | null
  reference: string
}): Promise<string> {
  const reference = input.reference.trim().slice(0, 60)
  if (!reference) return ''
  const all = await loadOutlineNodes(input.projectId)
  if (!all.length) return `【大纲引用解析】项目还没有任何大纲节点，无法定位“${reference}”。`
  const scoped = outlineScope(all, input.worldGroupId)
  if (!scoped.length) {
    return `【大纲引用解析】当前世界没有大纲节点；项目共 ${all.length} 个节点但都属于其他世界。`
  }
  const matches = matchOutlineNodes({ nodes: scoped, reference, limit: MAX_CANDIDATES })
  if (!matches.length) {
    const titles = scoped
      .filter(node => node.type === 'volume')
      .sort((left, right) => left.order - right.order)
      .slice(0, 12)
      .map(node => `#${node.id} ${node.title}`)
    // 未命中是最需要留痕的一类：作者常问"为什么说项目里没有"，
    // 日志里要能看到查询词、作用域规模与候选卷名。
    log.info('AgentRetrieval', 'retrieval.outline.reference.miss', `大纲引用未命中：${reference}`, {
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      reference,
      scopedNodes: scoped.length,
      totalNodes: all.length,
      volumeTitles: titles.join('；'),
    })
    return [
      `【大纲引用解析】没有节点匹配“${reference}”。`,
      titles.length ? `当前世界的卷（供你改用准确名称）：${titles.join('；')}` : '当前世界没有卷级节点。',
      `可用 list_project_tables + read_project_table(outlineNodes) 查看完整节点清单。`,
    ].join('\n')
  }
  log.info('AgentRetrieval', 'retrieval.outline.reference.hit', `大纲引用命中：${reference}`, {
    projectId: input.projectId,
    worldGroupId: input.worldGroupId,
    reference,
    matched: matches.length,
    topNodeId: matches[0].node.id,
    topTitle: matches[0].node.title,
    reason: matches[0].reason,
  })

  const chapterNodes = scoped.filter(node => node.type === 'chapter')
  const chapters = await db.chapters.where('projectId').equals(input.projectId).toArray()
  const writtenByNode = new Map<number, number>()
  for (const chapter of chapters) {
    if (!htmlToPlainText(chapter.content || '').trim()) continue
    writtenByNode.set(chapter.outlineNodeId, (writtenByNode.get(chapter.outlineNodeId) ?? 0) + 1)
  }

  const ambiguousTop = matches.length > 1 && matches[0].score === matches[1].score
  const lines = matches.map((match, index) => {
    const subtree = subtreeNodeIds(scoped, match.node.id ?? null)
    const ownChapters = chapterNodes.filter(node => node.id != null
      && (subtree?.has(node.id) ?? true))
    const written = ownChapters.reduce((sum, node) => sum + (writtenByNode.get(node.id!) ?? 0), 0)
    const summary = match.node.summary?.trim()
    return [
      `${index === 0 ? '最可能命中' : `候选${index + 1}`}：#${match.node.id} [${match.node.type}] ${match.node.title}`,
      `（${match.reason}；含章节节点 ${ownChapters.length} 个，已有正文 ${written} 章）`,
      summary ? `卷纲/摘要：${summary.slice(0, 160)}` : '',
    ].filter(Boolean).join(' ')
  })
  return [
    `【大纲引用解析】“${reference}”→ 命中 ${matches.length} 个候选：`,
    ...(ambiguousTop ? ['前两项评分相同，当前引用有歧义；这是候选预览，不要自动选取或改动父节点，请先让作者确认。'] : []),
    ...lines,
    '确认后再用该节点 id 作为作用域统计角色出场；节点 id 与章号是两套编号，不要混用。',
  ].join('\n')
}

/** 角色出场统计：在指定大纲作用域内逐章统计登记名与别称的出现次数。 */
export async function countCharacterAppearances(input: {
  projectId: number
  worldGroupId: number | null
  characterName: string
  scopeNodeId: number | null
}): Promise<string> {
  const name = input.characterName.trim().slice(0, 60)
  if (!name) return ''
  const [characters, allNodes, chapters] = await Promise.all([
    db.characters.where('projectId').equals(input.projectId).toArray(),
    loadOutlineNodes(input.projectId),
    db.chapters.where('projectId').equals(input.projectId).toArray(),
  ])
  const scopedNodes = outlineScope(allNodes, input.worldGroupId)
  const ownerIndex = buildSurfaceOwnerIndex(characters.map(character => ({
    owner: character,
    surfaces: entitySurfaceNames(character),
  })))
  const uniqueSurface = resolveUniqueOwner(ownerIndex, name)
  const closeOwners = characters.filter(character => entitySurfaceNames(character).some(surface => {
    const left = surface.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
    const right = name.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
    return left.includes(right) || right.includes(left)
  }))
  const resolved = uniqueSurface ?? (closeOwners.length === 1 ? closeOwners[0] : null)
  if (!resolved) {
    const close = closeOwners
      .slice(0, 8)
      .map(character => character.name)
    const ambiguous = ownerIndex.ambiguous.has(name.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase())
    log.info('AgentRetrieval', 'retrieval.character.unregistered', `没有登记名为“${name}”的角色`, {
      projectId: input.projectId,
      query: name,
      registered: characters.length,
      closeMatches: close.join('、'),
    })
    return [
      ambiguous ? `【角色出场统计】“${name}”对应多个登记角色，存在歧义，未自动选择。` : `【角色出场统计】项目里没有名为“${name}”的角色登记。`,
      close.length ? `名称相近的登记角色：${close.join('、')}` : '',
      '若该名字只是正文里的称呼，请先用 search_text 确认角色登记名；本工具只按登记名与别称计数。',
    ].filter(Boolean).join('\n')
  }

  const scope = subtreeNodeIds(scopedNodes, input.scopeNodeId)
  let scopeLabel = '整个项目（当前世界）'
  if (input.scopeNodeId != null) {
    const scopeNode = allNodes.find(node => node.id === input.scopeNodeId)
    scopeLabel = scopeNode ? `#${scopeNode.id} ${scopeNode.title}（含其子节点）` : `节点 #${input.scopeNodeId}`
  }
  const chapterNodes = new Map(scopedNodes.flatMap(node => node.id == null ? [] : [[node.id, node] as const]))
  const canonical = walkOutlineChaptersInCanonicalOrder(scopedNodes)
  const canonicalOrder = new Map(canonical.chapters.map(chapter => [chapter.outlineNode.id!, chapter.ordinal]))
  const targetChapters = chapters
    .filter(chapter => scope == null || scope.has(chapter.outlineNodeId))
    .sort((left, right) => (canonicalOrder.get(left.outlineNodeId) ?? Number.MAX_SAFE_INTEGER) - (canonicalOrder.get(right.outlineNodeId) ?? Number.MAX_SAFE_INTEGER))
    .slice(0, MAX_COUNT_CHAPTERS)

  const surfaceForms = dedupeSurfaceForms([resolved.name, ...(resolved.aliases ?? [])])
  const rows: Array<{ label: string; chapterId: number; count: number; written: boolean }> = []
  let total = 0
  let chaptersWithMentions = 0
  let writtenChapters = 0
  for (const chapter of targetChapters) {
    const plain = htmlToPlainText(chapter.content || '')
    const written = plain.trim().length > 0
    if (written) writtenChapters += 1
    const { count } = countMentions(plain, surfaceForms)
    const node = chapterNodes.get(chapter.outlineNodeId)
    const label = `[chapter#${chapter.id}] ${node?.title ?? chapter.title}`
    rows.push({ label, chapterId: chapter.id ?? 0, count, written })
    total += count
    if (count > 0) chaptersWithMentions += 1
  }

  const hitRows = rows.filter(row => row.count > 0).slice(0, MAX_REPORTED_CHAPTERS)
  const missed = rows.filter(row => row.count === 0 && row.written)
  const truncated = targetChapters.length >= MAX_COUNT_CHAPTERS
  log.info('AgentRetrieval', 'retrieval.character.count', `角色出场统计：${resolved.name} 共 ${total} 次`, {
    projectId: input.projectId,
    worldGroupId: input.worldGroupId,
    character: resolved.name,
    surfaceForms: surfaceForms.join('、'),
    scopeNodeId: input.scopeNodeId,
    scopeLabel,
    chapters: targetChapters.length,
    writtenChapters,
    total,
    chaptersWithMentions,
    truncated,
  })
  return [
    `【角色出场统计】${resolved.name}（统计写法：${surfaceForms.join('、')}）`,
    `作用域：${scopeLabel}；纳入章节 ${targetChapters.length} 个（已有正文 ${writtenChapters} 个）${truncated ? '，已达统计上限，结果可能不完整' : ''}`,
    hitRows.length
      ? '逐章命中：\n' + hitRows.map(row => `- ${row.label}：${row.count} 次`).join('\n')
      : '逐章命中：没有任何一章提到该角色的登记名或别称。',
    `合计：${total} 次，出现在 ${chaptersWithMentions}/${targetChapters.length} 个章节中。`,
    missed.length
      ? `未命中的已写章节：${missed.slice(0, 12).map(row => row.label.replace(/^\[chapter#\d+\]\s*/, '')).join('、')}${missed.length > 12 ? ' 等' : ''}`
      : '',
    '说明：本统计是正文纯文本里的字面出现次数（含对白与旁白），不等于“出场场景数”；如需逐条上下文请用 search_text 或 read_project_record_field。',
  ].filter(Boolean).join('\n')
}
