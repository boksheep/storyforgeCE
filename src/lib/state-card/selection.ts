/** UI 高亮和注册表读取共用的状态卡文本匹配规则。 */
import type { StateCard } from '../types'
import { parseFields } from '../types/state-card'

export function matchesStateCardReference(
  card: StateCard,
  referenceText: string,
  aliases: readonly string[] = [],
): boolean {
  const haystack = referenceText.toLocaleLowerCase()
  const names = [card.entityName, ...aliases]
  if (names.some(name => name.length >= 2 && haystack.includes(name.toLocaleLowerCase()))) return true
  return parseFields(card.fields).some(field => (
    field.value.length >= 2 && haystack.includes(field.value.toLocaleLowerCase())
  ))
}
