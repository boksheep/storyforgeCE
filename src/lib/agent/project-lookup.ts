import type { OutlineNode } from '../types'
import { foldSurface, matchSurfacesInText } from '../entities/surface-match'

/**
 * 大纲引用解析（AGENT-2 检索修复）。
 *
 * 背景（真实事故）：作者问“序篇里艾里昂出场了几次”，而项目里那一卷叫「序卷-阳光与阴云」。
 * 旧检索只有纯子串匹配：`search_text("序篇")` 永远命不中「序卷」，模型于是回答
 * “我的上下文里没有序篇”，把一个可回答的问题说成不存在。
 *
 * 这里把「作者口中的叫法」翻译成「项目里的真实标题」：
 *   1. 序/序卷/序篇/序章/楔子/引子/前传 视为同一族；
 *   2. 第N卷/第N章 支持中文数字与阿拉伯数字互转；
 *   3. 先精确、再包含、再同族、最后按卷序定位，并给出候选让模型自己判断。
 *
 * 纯函数、零写入，便于单测。
 */

const CJK_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}

/** 中文数字（支持 十/十五/二十/二十三/百 以内的常见写法）→ 数字；无法解析返回 null。 */
export function chineseNumeralToNumber(value: string): number | null {
  const text = value.trim()
  if (!text) return null
  if (/^\d+$/.test(text)) return Number(text)
  if (text === '十') return 10
  if (text.startsWith('十')) return 10 + (CJK_DIGITS[text.slice(1)] ?? 0)
  if (text.includes('十')) {
    const [tens, ones] = text.split('十')
    const tensValue = tens ? CJK_DIGITS[tens] : 1
    if (tensValue == null) return null
    return tensValue * 10 + (ones ? (CJK_DIGITS[ones] ?? 0) : 0)
  }
  if (text.length === 1) return CJK_DIGITS[text] ?? null
  // 多位数（如 二三）不常见，但按位拼出来比猜错更安全
  let digits = ''
  for (const char of text) {
    const digit = CJK_DIGITS[char]
    if (digit == null) return null
    digits += String(digit)
  }
  return digits ? Number(digits) : null
}

const CN_DIGIT_TEXT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']

/** 数字 → 中文写法（覆盖 1-99，够用于卷/章序号）。 */
export function numberToChineseNumeral(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 99) return String(value)
  if (value < 10) return CN_DIGIT_TEXT[value]
  const tens = Math.floor(value / 10)
  const ones = value % 10
  const head = tens === 1 ? '十' : `${CN_DIGIT_TEXT[tens]}十`
  return ones === 0 ? head : `${head}${CN_DIGIT_TEXT[ones]}`
}

/** 前言/序章一族：作者可能用其中任意一个词指代同一卷。 */
export const PROLOGUE_REFERENCE_WORDS = ['序', '序卷', '序篇', '序章', '序幕', '楔子', '引子', '前传', '前言'] as const
/** 尾声一族。 */
export const EPILOGUE_REFERENCE_WORDS = ['终章', '尾声', '尾卷', '后记', '番外', '结局'] as const

const STRUCTURE_UNIT = /第\s*([零〇一二两三四五六七八九十百\d]+)\s*(卷|部|章|篇|节|回)/

/** 归一化：去掉空白、书名号与常见标点，便于包含匹配。 */
export function normalizeReference(text: string): string {
  return text
    .replace(/[《》〈〉「」『』【】\s]/g, '')
    .replace(/[·・:：,，.。;；!！?？'"“”‘’\-—_/\\|]/g, '')
    .toLowerCase()
}

/**
 * 把作者的叫法展开成一组可匹配的写法。
 *
 * 例：`序篇` → [序篇, 序, 序卷, 序章, 序幕, 楔子, 引子, 前传, 前言]
 *     `第一卷` → [第一卷, 第1卷, 1卷, 一卷]
 */
export function outlineReferenceAliases(reference: string): string[] {
  const text = reference.trim()
  if (!text) return []
  const out = new Set<string>([text])
  if (PROLOGUE_REFERENCE_WORDS.some(word => text.includes(word))) {
    for (const word of PROLOGUE_REFERENCE_WORDS) out.add(word)
  }
  if (EPILOGUE_REFERENCE_WORDS.some(word => text.includes(word))) {
    for (const word of EPILOGUE_REFERENCE_WORDS) out.add(word)
  }
  const structure = STRUCTURE_UNIT.exec(text)
  if (structure) {
    const ordinal = chineseNumeralToNumber(structure[1])
    if (ordinal != null && ordinal > 0) {
      const unit = structure[2]
      for (const written of [String(ordinal), numberToChineseNumeral(ordinal)]) {
        out.add(`第${written}${unit}`)
        out.add(`${written}${unit}`)
      }
    }
  }
  return [...out].filter(Boolean)
}

export interface OutlineReferenceMatch {
  node: OutlineNode
  score: number
  reason: string
}

/**
 * 在大纲节点里找出作者所指的节点。
 *
 * 评分优先级：标题精确 > 标题包含 > 同族词命中 > 摘要包含 > 按卷序定位。
 * 返回按分数降序的有界候选，由调用方（模型）决定最终采用哪一个。
 */
export function matchOutlineNodes(input: {
  nodes: OutlineNode[]
  reference: string
  limit?: number
}): OutlineReferenceMatch[] {
  const reference = input.reference.trim()
  if (!reference) return []
  const limit = Math.max(1, Math.min(8, input.limit ?? 5))
  const normalizedReference = normalizeReference(reference)
  const aliases = outlineReferenceAliases(reference)
    .map(alias => ({ raw: alias, normalized: normalizeReference(alias) }))
    .filter(alias => alias.normalized.length > 0)
  const structure = STRUCTURE_UNIT.exec(reference)
  const ordinal = structure ? chineseNumeralToNumber(structure[1]) : null
  const unitType = structure?.[2] === '章' || structure?.[2] === '节' || structure?.[2] === '回' ? 'chapter' : 'volume'

  const scored: OutlineReferenceMatch[] = []
  for (const node of input.nodes) {
    const title = normalizeReference(node.title)
    const summary = normalizeReference(node.summary ?? '')
    let score = 0
    let reason = ''
    if (title === normalizedReference) {
      score = 1000
      reason = '标题完全一致'
    } else if (normalizedReference.length >= 2 && title.includes(normalizedReference)) {
      score = 900
      reason = `标题包含“${reference}”`
    } else {
      // 同族词命中：取最长的命中词，长度越长越可信
      const hit = aliases
        .filter(alias => alias.normalized.length >= 1 && title.includes(alias.normalized))
        .sort((left, right) => right.normalized.length - left.normalized.length)[0]
      if (hit && hit.normalized !== normalizedReference) {
        score = 700 + Math.min(99, hit.normalized.length * 10)
        reason = `标题含同义写法“${hit.raw}”`
      } else if (summary && normalizedReference.length >= 2 && summary.includes(normalizedReference)) {
        score = 400
        reason = '卷纲摘要提到该说法'
      }
    }
    if (score > 0) scored.push({ node, score, reason })
  }

  // 按卷序定位（第N卷 → 第 N 个同类型节点）
  if (ordinal != null && ordinal > 0) {
    const sameType = input.nodes
      .filter(node => node.type === unitType)
      .sort((left, right) => left.order - right.order || (left.id ?? 0) - (right.id ?? 0))
    const byOrdinal = sameType[ordinal - 1]
    if (byOrdinal?.id != null && !scored.some(item => item.node.id === byOrdinal.id)) {
      scored.push({ node: byOrdinal, score: 600, reason: `按${unitType === 'volume' ? '卷' : '章'}序第 ${ordinal} 个` })
    }
  }

  return scored
    .sort((left, right) => right.score - left.score || (left.node.order - right.node.order))
    .slice(0, limit)
}

// ───────────────────────── 作用域与出场计数 ─────────────────────────

/** 收集 scopeNodeId 的子树节点 id（含自身）；未指定作用域时返回 null 表示“整个项目”。 */
export function subtreeNodeIds(nodes: OutlineNode[], scopeNodeId: number | null): Set<number> | null {
  if (scopeNodeId == null) return null
  if (!nodes.some(node => node.id === scopeNodeId)) return new Set()
  const children = new Map<number, number[]>()
  for (const node of nodes) {
    if (node.id == null || node.parentId == null) continue
    const siblings = children.get(node.parentId) ?? []
    siblings.push(node.id)
    children.set(node.parentId, siblings)
  }
  const collected = new Set<number>()
  const queue = [scopeNodeId]
  while (queue.length) {
    const current = queue.shift()!
    if (collected.has(current)) continue
    collected.add(current)
    for (const child of children.get(current) ?? []) queue.push(child)
  }
  return collected
}

/** 去重包含关系表面形式，避免长称呼中的短别称重复计数。 */
export function dedupeSurfaceForms(forms: readonly string[]): string[] {
  const byFolded = new Map<string, string>()
  for (const raw of forms) {
    const form = raw.trim()
    const folded = foldSurface(form)
    if (folded.length >= 2 && !byFolded.has(folded)) byFolded.set(folded, form)
  }
  const cleaned = [...byFolded.values()]
  return cleaned
    .filter(form => !cleaned.some(other => other !== form && foldSurface(other).includes(foldSurface(form))))
    .sort((left, right) => foldSurface(right).length - foldSurface(left).length)
}

export interface MentionCount {
  count: number
  /** 该章内首次出现的位置（纯文本字符偏移），未出现为 null。 */
  firstOffset: number | null
}

/** 统计一段正文里称呼命中总数与首次位置，复用 surface-match 的折叠及最长优先规则。 */
export function countMentions(text: string, surfaceForms: readonly string[]): MentionCount {
  if (!text || !surfaceForms.length) return { count: 0, firstOffset: null }
  const matches = matchSurfacesInText(text, surfaceForms)
  return {
    count: matches.length,
    firstOffset: matches[0]?.from ?? null,
  }
}
