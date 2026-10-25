/**
 * 实体名册（PROMPT-PLAN-1）。
 *
 * 为什么单独存在：生成前协商要让模型能**点名**"我需要谁的正文表现 / 哪条设定"，
 * 但把全量角色档案、全量词条塞进协商调用会把成本抬到接近正文生成本身。
 * 因此这里只给**名字**（按戏份/分类分层 + 数量上限），细节留给模型在申报里索要。
 *
 * 边界：
 * - 只出名，不出现任何描述/字段内容（体积可控，也让协商提示词保持窄）。
 * - 世界隔离与既有读取口径一致：角色 isCrossWorld||homeWorldGroupId===wg（未指定世界时不过滤）、
 *   词条 codexEntryInWorld、地点项目级（importantLocations 无世界字段）。
 * - ALIAS-1 落地时只需在 namesOf() 一处补上别称，本文件其余逻辑不变。
 */
import type { Character, ImportantLocation, MapFeature } from '../types'
import type { CodexCategory, CodexEntry } from '../types/codex'
import { codexEntryInWorld } from '../types/codex'
import { locationInWorld } from '../location/scope'

/** 各层名字上限：既保证"能点名"，又让整个名册稳定落在 entityRoster 源预算内。 */
export const ROSTER_MAX_MAIN = 30
export const ROSTER_MAX_SECONDARY = 40
export const ROSTER_MAX_OTHER = 40
export const ROSTER_MAX_CODEX_CATEGORIES = 8
export const ROSTER_MAX_CODEX_PER_CATEGORY = 10
export const ROSTER_MAX_LOCATIONS = 30

export interface EntityRosterInput {
  characters: readonly Character[]
  codexCategories: readonly CodexCategory[]
  codexEntries: readonly CodexEntry[]
  locations: readonly ImportantLocation[]
  mapFeatures?: readonly MapFeature[]
  multiWorld?: boolean
  /** 未指定（undefined）时不做世界过滤；null 表示主世界。 */
  worldGroupId?: number | null
}

/**
 * 角色的全部可引用称呼。
 * ALIAS-1 会在 Character.aliases 落地后把别称并进来——这是唯一需要改的一行。
 */
function namesOf(character: Character): string {
  return character.name.trim()
}

function visibleCharacters(input: EntityRosterInput): Character[] {
  const wg = input.worldGroupId
  return input.characters.filter(character => {
    if (!character.name.trim()) return false
    if (wg === undefined) return true
    return Boolean(character.isCrossWorld) || (character.homeWorldGroupId ?? null) === (wg ?? null)
  })
}

function joinNames(names: readonly string[], max: number): { text: string; rest: number } {
  const shown = names.slice(0, max)
  return { text: shown.join('、'), rest: Math.max(0, names.length - shown.length) }
}

/**
 * 生成名册文本。无任何实体时返回空串（assembleContext 会把它记为 omitted）。
 */
export function buildEntityRoster(input: EntityRosterInput): string {
  const lines: string[] = []

  const characters = visibleCharacters(input)
  const main = characters.filter(c => c.roleWeight === 'main')
  const secondary = characters.filter(c => c.roleWeight === 'secondary')
  const others = characters.filter(c => c.roleWeight === 'npc' || c.roleWeight === 'extra')

  if (main.length) {
    const { text, rest } = joinNames(main.map(namesOf), ROSTER_MAX_MAIN)
    lines.push(`角色·主要：${text}${rest ? `（另有 ${rest} 人未列名）` : ''}`)
  }
  if (secondary.length) {
    const { text, rest } = joinNames(secondary.map(namesOf), ROSTER_MAX_SECONDARY)
    lines.push(`角色·次要：${text}${rest ? `（另有 ${rest} 人未列名）` : ''}`)
  }
  if (others.length) {
    const { text, rest } = joinNames(others.map(namesOf), ROSTER_MAX_OTHER)
    lines.push(`角色·其他：${text}${rest ? `（另有 ${rest} 人未列名）` : ''}`)
  }

  const categories = [...input.codexCategories]
    .filter(category => !category.hidden)
    .sort((a, b) => a.order - b.order)
  const nameByCategory = new Map<number, string[]>()
  for (const entry of input.codexEntries) {
    if (!entry.name.trim()) continue
    if (!codexEntryInWorld(entry, input.worldGroupId === undefined ? undefined : (input.worldGroupId ?? null))) continue
    const list = nameByCategory.get(entry.categoryId) ?? []
    list.push(entry.name.trim())
    nameByCategory.set(entry.categoryId, list)
  }
  for (const category of categories.slice(0, ROSTER_MAX_CODEX_CATEGORIES)) {
    if (category.id == null) continue
    const names = nameByCategory.get(category.id)
    if (!names?.length) continue
    const { text, rest } = joinNames(names, ROSTER_MAX_CODEX_PER_CATEGORY)
    lines.push(`词条·${category.name}：${text}${rest ? `（另有 ${rest} 条未列名）` : ''}`)
  }

  const locations = [...input.locations]
    .filter(location => location.name.trim() && locationInWorld(location, Boolean(input.multiWorld), input.worldGroupId ?? null))
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
  if (locations.length) {
    const { text, rest } = joinNames(locations.map(location => location.name.trim()), ROSTER_MAX_LOCATIONS)
    lines.push(`重要地点：${text}${rest ? `（另有 ${rest} 处未列名）` : ''}`)
  }

  const mapNames = (input.mapFeatures ?? [])
    .filter(feature => feature.status === 'confirmed' && feature.name.trim()
      && (input.worldGroupId === undefined || (feature.worldGroupId ?? null) === (input.worldGroupId ?? null)))
    .map(feature => feature.name.trim())
  if (mapNames.length) {
    const { text, rest } = joinNames([...new Set(mapNames)], ROSTER_MAX_LOCATIONS)
    lines.push(`地图已确认：${text}${rest ? `（另有 ${rest} 处未列名）` : ''}`)
  }

  if (!lines.length) return ''
  return [
    '【实体名册（只列名，供你申报"我需要谁/哪条设定"）】',
    ...lines,
  ].join('\n')
}

/**
 * 从名册文本里取回角色名闭集（与 buildEntityRoster 同一文件，格式与解析不会各自漂移；
 * 回归测试锁住二者往返一致）。用途：申报校验只能从名册里出现的名字中选择。
 */
export function parseRosterCharacterNames(roster: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const line of roster.split('\n')) {
    if (!line.startsWith('角色')) continue
    const body = (line.split('：')[1] ?? '').replace(/（[^）]*）/g, '')
    for (const raw of body.split('、')) {
      const name = raw.trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }
  }
  return names
}
