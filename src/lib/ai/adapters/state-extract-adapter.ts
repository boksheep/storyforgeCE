/**
 * 状态提取适配器 — 章节完成后提取实体状态变更
 * 输入：当前状态表 + 章节正文
 * 输出：JSON 格式的 StateDiffItem[]
 */
import type { ChatMessage } from '../../types'
import { log } from '../../logging/logger'

/**
 * 构建状态提取 prompt
 * @param stateContext 由 assembleContext 装配的当前事实或旧状态卡兼容文本
 * @param chapterTitle 章节标题
 * @param chapterText 章节正文（纯文本）
 * @param maxChars 章节文本最大截取长度
 */
export function buildStateExtractPrompt(
  stateContext: string,
  chapterTitle: string,
  chapterText: string,
  characterNames: string[] = [],
  maxChars = 6000,
): ChatMessage[] {
  const trimmedText = chapterText.length > maxChars
    ? chapterText.slice(0, maxChars) + '\n…（后文省略）'
    : chapterText

  const systemPrompt = `你是一个小说角色状态追踪器。你的任务是阅读章节内容，对比当前状态表，只提取已登记角色发生的状态变化。

规则：
1. 只提取本章中**明确发生变化**的状态，不要重复已有状态
2. entityName 必须严格取自“已登记角色名单”；地点、物品、文件夹、组织、事件都不能作为角色
3. category 必须固定为 character
4. field 用简短中文词汇，如：位置、身体状态、境界、目标、所属势力、持有物、关系
5. oldValue 填变化前的值（从状态表中读取），新实体填 null
6. 如果本章没有任何状态变化，返回空数组 []

输出格式：严格 JSON 数组，不要加 markdown 代码块，不要加任何解释文字。
示例：
[{"entityName":"李明远","category":"character","field":"位置","oldValue":"长安","newValue":"洛阳"},{"entityName":"残破令牌","category":"item","field":"持有者","oldValue":"李明远","newValue":"萧寒"}]`

  const userPrompt = `【已登记角色名单】
${characterNames.join('、') || '无（返回空数组）'}

${stateContext ? stateContext + '\n\n' : '（当前没有角色状态记录）\n\n'}【章节标题】${chapterTitle}\n\n【章节内容】\n${trimmedText}\n\n请只提取名单内角色的状态变更：`

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ]
}

/**
 * 从 AI 输出中解析 StateDiffItem[]
 * 容错处理：尝试多种格式
 */
export function parseStateDiffs(
  raw: string,
  allowedCharacterNames: string[] = [],
  /**
   * ALIAS-1：称呼（含别称）→ 规范正名。正文/抽取里用别称点名角色时，
   * 既不该被当成"未登记角色"丢掉，也不该让状态卡建在别称下（那会把一个人拆成两张卡）。
   */
  surfaceToCanonical: ReadonlyMap<string, string> = new Map(),
): {
  diffs: Array<{
    entityName: string
    category: string
    field: string
    oldValue: string | null
    newValue: string
  }>
  error: string | null
} {
  const trimmed = raw.trim()

  // 去除可能的 markdown 代码块
  let jsonStr = trimmed
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim()
  }

  // 尝试找到 JSON 数组
  const arrStart = jsonStr.indexOf('[')
  const arrEnd = jsonStr.lastIndexOf(']')
  if (arrStart === -1 || arrEnd === -1 || arrEnd <= arrStart) {
    log.warn('StateExtract', 'stateextract', '[StateExtract] 未找到 JSON 数组:', { snippet: jsonStr.slice(0, 200) })
    return { diffs: [], error: '未能从 AI 输出中解析到 JSON 数组' }
  }

  jsonStr = jsonStr.slice(arrStart, arrEnd + 1)

  try {
    const parsed = JSON.parse(jsonStr)
    if (!Array.isArray(parsed)) {
      log.error('StateExtract', 'stateextract', '[StateExtract] 解析结果不是数组:', { type: typeof parsed })
      return { diffs: [], error: '解析结果不是数组' }
    }

    // 验证每个 item 的必要字段
    const allowed = new Set(allowedCharacterNames.map(name => name.trim().toLocaleLowerCase()).filter(Boolean))
    const valid = parsed.filter((item: Record<string, unknown>) => {
      if (!item.entityName || !item.category || !item.field || item.newValue === undefined) {
        log.warn('StateExtract', 'stateextract', '[StateExtract] 跳过不完整的 diff item:')
        return false
      }
      if (item.category !== 'character') {
        log.warn('StateExtract', 'stateextract', '[StateExtract] 无效的 category:', { category: String(item.category) })
        return false
      }
      const rawName = String(item.entityName).trim()
      // ALIAS-1: 别称先归一到正名，再按正名白名单校验（顺序不能反，否则别名会被误判未登记）。
      const canonical = surfaceToCanonical.get(rawName.toLocaleLowerCase())
      if (canonical) item.entityName = canonical
      const checkName = (canonical ?? rawName).toLocaleLowerCase()
      if (allowed.size > 0 && !allowed.has(checkName)) {
        log.warn('StateExtract', 'stateextract', '[StateExtract] 跳过未登记角色:', { entityName: String(item.entityName) })
        return false
      }
      return true
    })

    log.info('StateExtract', 'stateextract', `[StateExtract] 解析成功：${valid.length}/${parsed.length} 条有效`)
    return { diffs: valid, error: null }
  } catch (err) {
    log.error('StateExtract', 'stateextract', '[StateExtract] JSON 解析失败:', { snippet: jsonStr.slice(0, 300) }, err)
    // 尝试修复截断的 JSON
    try {
      const repaired = jsonStr.slice(0, jsonStr.lastIndexOf('}') + 1) + ']'
      const parsed = JSON.parse(repaired)
      if (Array.isArray(parsed)) {
        log.info('StateExtract', 'stateextract', '[StateExtract] JSON 修复成功，解析到', { count: parsed.length, unit: '条' })
        return { diffs: parsed, error: null }
      }
    } catch {
      // 修复也失败了
    }
    return { diffs: [], error: `JSON 解析失败：${(err as Error).message}` }
  }
}
