/** 人工导出旧状态卡：逐张保留全部字段，不受 AI 上下文预算影响。 */
import type { StateCard, StateCategory } from '../types'
import { parseFields } from '../types/state-card'

const LABELS: Record<StateCategory, string> = {
  character: '角色', location: '地点', item: '物品', faction: '势力', event: '事件',
}

export function exportStateCardsText(cards: readonly StateCard[]): string {
  if (!cards.length) return ''
  const grouped = new Map<StateCategory, StateCard[]>()
  for (const card of cards) grouped.set(card.category, [...(grouped.get(card.category) ?? []), card])
  const lines = ['【当前状态表】']
  for (const [category, rows] of grouped) {
    lines.push(`\n[${LABELS[category]}]`)
    for (const card of rows) {
      const fields = parseFields(card.fields).map(field => `${field.key}：${field.value}`).join(' | ')
      lines.push(`- ${card.entityName} | ${fields}`)
    }
  }
  return lines.join('\n')
}
