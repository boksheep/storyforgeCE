/**
 * Phase 35-a — 词条系统的 AI 上下文构建（上游设定注入）
 *
 * 词条属「上游设定」：作者填写 → AI 写作时读取。本模块把词条按分类紧凑格式化，
 * 注入到写作/大纲/场景等生成链路，避免词条独立于 AI 生成体系之外。
 *
 * 架构约束：
 *  - 单世界且无任何词条时返回 ''（对现有写作链路零影响）。
 *  - 多世界按 worldGroupId 隔离（与 buildCurrentWorldContext 同源）；
 *    传 null/undefined 表示主世界/单世界，读取未归属世界组的词条。
 */
import { db } from '../db/schema'
import {
  codexEntryInWorld, parseEntryFields, parseFieldSchema,
  type CodexCategory, type CodexEntry,
} from '../types/codex'

interface BuildOptions {
  /**
   * 总长度预算（字符）。
   *
   * BUDGET-1：**不再有默认值**。此前固定 2500 字，且先于源 token 预算生效，
   * 导致「词条较多，已截断」在设置里怎么调预算都消不掉。现在不传 = 完整注入，
   * 由 `assembleContext` 按作者策略传入显式上限。
   */
  maxChars?: number
  /** 每个分类最多展示的词条数。不传 = 不限。 */
  maxPerCategory?: number
  /** 每条词条最多内联的专属字段数。默认 3（字段是摘录，不是主体）。 */
  maxFieldsPerEntry?: number
}

/**
 * 构建词条上下文。
 * @param worldGroupId 多世界：所属世界组；null/undefined = 主世界/单世界（未归属世界组的词条）
 */
export async function buildCodexContext(
  projectId: number,
  worldGroupId?: number | null,
  opts: BuildOptions = {},
): Promise<string> {
  const maxChars = opts.maxChars && opts.maxChars > 0 ? opts.maxChars : undefined
  const maxPerCategory = opts.maxPerCategory && opts.maxPerCategory > 0 ? opts.maxPerCategory : undefined
  const maxFields = opts.maxFieldsPerEntry && opts.maxFieldsPerEntry > 0 ? opts.maxFieldsPerEntry : 3

  const [allCats, allEntries] = await Promise.all([
    db.codexCategories.where('projectId').equals(projectId).toArray(),
    db.codexEntries.where('projectId').equals(projectId).toArray(),
  ])
  if (allEntries.length === 0) return ''

  const wg = worldGroupId ?? null
  // 分类 schema 项目级共享；词条严格按当前世界隔离。
  const cats = allCats
    .filter(c => !c.hidden)
    .sort((a, b) => a.order - b.order)
  const catById = new Map<number, CodexCategory>(cats.map(c => [c.id!, c]))

  const entriesByCat = new Map<number, CodexEntry[]>()
  for (const e of allEntries) {
    if (!codexEntryInWorld(e, wg)) continue
    if (!catById.has(e.categoryId)) continue
    const list = entriesByCat.get(e.categoryId) || []
    list.push(e)
    entriesByCat.set(e.categoryId, list)
  }
  if (entriesByCat.size === 0) return ''

  const blocks: string[] = ['【设定词条】（作者设定，写作时须遵守，勿自创冲突设定）']

  for (const cat of cats) {
    // 按重要度降序优先(高星地点等先占预算、截断时先保住),同星级再按 order
    const list = (entriesByCat.get(cat.id!) || [])
      .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || a.order - b.order)
    if (list.length === 0) continue

    const schema = parseFieldSchema(cat.fieldSchema)
    // 选取适合内联的字段（非 ref，有 label）
    const inlineDefs = schema.filter(d => d.type !== 'ref').slice(0, maxFields)

    const lines: string[] = [`[${cat.icon || ''} ${cat.name}]`]
    // maxPerCategory 未设 = 不限,注入该分类全部词条(BUDGET-1)。
    const visible = maxPerCategory === undefined ? list : list.slice(0, maxPerCategory)
    for (const entry of visible) {
      const fields = parseEntryFields(entry.fields)
      const attrs = inlineDefs
        .map(d => {
          const v = (fields[d.key] || '').trim()
          return v ? `${d.label}:${v.slice(0, 40)}` : ''
        })
        .filter(Boolean)
      const stars = (entry.importance ?? 0) > 0 ? '★'.repeat(Math.min(5, entry.importance!)) + ' ' : ''
      const head = `- ${stars}${entry.name}${entry.summary ? `：${entry.summary.slice(0, 60)}` : ''}`
      lines.push(attrs.length ? `${head}（${attrs.join('；')}）` : head)
    }
    if (maxPerCategory !== undefined && list.length > visible.length) {
      lines.push(`…（本分类另有 ${list.length - visible.length} 条按「每分类条数上限」省略）`)
    }
    blocks.push(lines.join('\n'))
  }

  if (blocks.length <= 1) return ''
  const text = blocks.join('\n')
  // 不设 maxChars = 完整注入;由 assembleContext 按作者预算策略决定是否截断。
  if (maxChars === undefined || text.length <= maxChars) return text
  return `${truncateAtLineBoundary(text, maxChars)}\n…（词条较多，已截断；可在「设置 → 上下文预算」调高或关闭截断）`
}

/**
 * 在行边界处截断,避免把某条词条或字段摘录切成半句。
 * 找不到可用行边界时退回硬切(极长的单行词条)。
 */
function truncateAtLineBoundary(text: string, maxChars: number): string {
  const head = text.slice(0, maxChars)
  const lastBreak = head.lastIndexOf('\n')
  return lastBreak > 0 ? head.slice(0, lastBreak) : head
}
