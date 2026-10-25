import type {
  Character,
  ImportantLocation,
  ItemLedgerEntry,
} from '../types'
import type { CodexCategory, CodexEntry } from '../types/codex'
import { codexEntryInWorld, parseEntryFields, parseFieldSchema } from '../types/codex'
import { aggregateInventory } from '../types/item-ledger'
import { entitySurfaceNames, matchSurfacesInText } from '../entities/surface-match'
import { log } from '../logging/logger'

export type EditorEntityKind = 'character' | 'item' | 'location' | 'codex'

export interface EditorEntityReference {
  id: string
  name: string
  kind: EditorEntityKind
  kindLabel: string
  summary: string
  details: Array<{ label: string; value: string }>
  /**
   * ALIAS-1：该实体的全部可匹配称呼（正名 + 别称）。
   * `name` 始终是规范正名（用于展示与 @ 插入）；`surfaces` 用于在正文里命中任一声称。
   */
  surfaces: string[]
}

/** 命中结果：`surface` 是正文里实际出现的那个称呼（可能是别称）。 */
export interface EditorEntityMatch {
  from: number
  to: number
  surface: string
  reference: EditorEntityReference
}

export interface BuildEditorEntityReferencesInput {
  characters: Character[]
  itemEntries: ItemLedgerEntry[]
  locations: ImportantLocation[]
  codexCategories: CodexCategory[]
  codexEntries: CodexEntry[]
  worldGroupId?: number | null
}

const KIND_PRIORITY: Record<EditorEntityKind, number> = {
  character: 0,
  item: 1,
  location: 2,
  codex: 3,
}

function clip(value: string | undefined, max = 160): string {
  const normalized = value?.trim().replace(/\s+/g, ' ') ?? ''
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized
}

export function buildEditorEntityReferences(
  input: BuildEditorEntityReferencesInput,
): EditorEntityReference[] {
  const references: EditorEntityReference[] = []
  const worldGroupId = input.worldGroupId

  for (const character of input.characters) {
    if (worldGroupId !== undefined
      && !character.isCrossWorld
      && (character.homeWorldGroupId ?? null) !== (worldGroupId ?? null)) continue
    if (!character.name.trim()) continue
    references.push({
      id: `character:${character.id ?? character.name}`,
      name: character.name.trim(),
      kind: 'character',
      kindLabel: '角色',
      summary: clip(character.shortDescription || character.identity || character.personality),
      details: [
        { label: '身份', value: clip(character.identity || character.shortDescription, 100) },
        { label: '性格', value: clip(character.personality, 100) },
        { label: '当前目标', value: clip(character.goals || character.motivation, 100) },
      ].filter(item => item.value),
      surfaces: entitySurfaceNames(character),
    })
  }

  for (const item of aggregateInventory(input.itemEntries)) {
    if (!item.itemName.trim()) continue
    const latest = item.entries[item.entries.length - 1]
    references.push({
      id: `item:${item.itemName.trim().toLocaleLowerCase()}`,
      name: item.itemName.trim(),
      kind: 'item',
      kindLabel: '物品',
      summary: item.quantity > 0 ? `当前持有 ${item.quantity}` : '当前未持有',
      details: [
        { label: '数量', value: String(item.quantity) },
        { label: '最近记录', value: clip(latest?.chapterTitle || latest?.note, 100) },
      ].filter(row => row.value),
      // 物品暂无独立别称字段（缺少稳定身份，见 EDITOR-5 的同一条边界），只按物品名匹配。
      surfaces: [item.itemName.trim()],
    })
  }

  for (const location of input.locations) {
    if (!location.name.trim()) continue
    let tags = ''
    try {
      const parsed = JSON.parse(location.tags || '[]')
      if (Array.isArray(parsed)) tags = parsed.filter(value => typeof value === 'string').slice(0, 6).join(' / ')
    } catch {
      // 以前是静默 `catch { /* invalid legacy tags stay hidden */ }`：
      // 地点的标签 JSON 损坏时，标签会无声消失，作者只看到"类型"一栏空了，
      // 无从判断是没填还是数据坏了。记下地点 id 与原始长度以便定位；
      // 地点名不写入日志（属用户手稿文本）。
      log.warn(
        'EntityMatch',
        'editor.location.tags.parse.failed',
        `地点标签 JSON 解析失败，标签未参与实体匹配`,
        {
          locationId: location.id ?? null,
          rawLength: typeof location.tags === 'string' ? location.tags.length : 0,
        },
      )
    }
    references.push({
      id: `location:${location.id ?? location.name}`,
      name: location.name.trim(),
      kind: 'location',
      kindLabel: '地点',
      summary: clip(location.description || location.significance),
      details: [
        { label: '类型', value: tags },
        { label: '剧情作用', value: clip(location.significance, 100) },
      ].filter(row => row.value),
      surfaces: entitySurfaceNames(location),
    })
  }

  const visibleCategories = input.codexCategories.filter(category => !category.hidden)
  const categoryById = new Map(visibleCategories.map(category => [category.id, category]))
  for (const entry of input.codexEntries) {
    if (!entry.name.trim() || !codexEntryInWorld(entry, worldGroupId)) continue
    const category = categoryById.get(entry.categoryId)
    if (!category) continue
    const fields = parseEntryFields(entry.fields)
    const details = parseFieldSchema(category.fieldSchema)
      .filter(field => field.type !== 'ref' && fields[field.key]?.trim())
      .slice(0, 3)
      .map(field => ({ label: field.label, value: clip(fields[field.key], 100) }))
    references.push({
      id: `codex:${entry.id ?? entry.name}`,
      name: entry.name.trim(),
      kind: 'codex',
      kindLabel: category.name,
      summary: clip(entry.summary || entry.description),
      details,
      surfaces: entitySurfaceNames(entry),
    })
  }

  // 正名去重（原有的"同名只留优先 kind"语义保留）；别称冲突不在这里裁决，
  // 交给命中侧按区间处理——一个别称同时属于两个实体时两边都能高亮，但身份解析会因歧义拒绝。
  const byName = new Map<string, EditorEntityReference>()
  for (const reference of references.sort((a, b) => {
    return KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]
      || b.name.length - a.name.length
      || a.name.localeCompare(b.name, 'zh-Hans-CN')
  })) {
    const key = reference.name.toLocaleLowerCase()
    if (!byName.has(key)) byName.set(key, reference)
  }
  return [...byName.values()]
}

/**
 * 在文本里找出实体命中：最长称呼优先、区间不重叠、至少两个字。
 *
 * 与 `surface-match.matchSurfacesInText` 同一套匹配规则（这里只是把结果映射回 reference），
 * 因此正文高亮、@ 补全与检索召回不会各自漂移。`surface` 是正文里出现的那个称呼，
 * 用于告诉作者"这里命中的是别名 X"。
 */
export function findEditorEntityMatches(
  text: string,
  references: readonly EditorEntityReference[],
): EditorEntityMatch[] {
  const surfaceOwner = new Map<string, EditorEntityReference[]>()
  for (const reference of references) {
    // 容错：老调用方/测试字面量可能没带 surfaces，退回正名（不因缺字段直接抛错）。
    for (const surface of reference.surfaces ?? [reference.name]) {
      if (surface.length < 2) continue
      const bucket = surfaceOwner.get(surface) ?? []
      bucket.push(reference)
      surfaceOwner.set(surface, bucket)
    }
  }
  const matches: EditorEntityMatch[] = []
  for (const hit of matchSurfacesInText(text, [...surfaceOwner.keys()])) {
    const owners = [...(surfaceOwner.get(hit.surface) ?? [])].sort((a, b) => (
      KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || b.name.length - a.name.length
    ))
    const owner = owners[0]
    if (!owner) continue
    matches.push({ from: hit.from, to: hit.to, surface: hit.surface, reference: owner })
  }
  return matches
}

export function filterEditorEntityReferences(
  references: readonly EditorEntityReference[],
  query: string,
  limit = 8,
): EditorEntityReference[] {
  const normalized = query.trim().toLocaleLowerCase()
  return references
    // ALIAS-1: 输入别称也能搜到该实体（作者记得住"禾姐"却记不住正名时不该搜不到）。
    .filter(reference => !normalized
      || reference.surfaces.some(surface => surface.toLocaleLowerCase().includes(normalized)))
    .sort((a, b) => {
      const aStarts = a.name.toLocaleLowerCase().startsWith(normalized) ? 0 : 1
      const bStarts = b.name.toLocaleLowerCase().startsWith(normalized) ? 0 : 1
      return aStarts - bStarts || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind] || a.name.localeCompare(b.name, 'zh-Hans-CN')
    })
    .slice(0, limit)
}
