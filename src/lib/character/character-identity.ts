/**
 * 角色身份层（ALIAS-1）· 世界归属 + 称呼索引 + 本章相关角色选择。
 *
 * 只做纯逻辑：不读数据库（调用方把已读到的角色数组传进来），不写任何表。
 *
 * 与既有的两处历史实现的区别：
 * - `context-builder.filterActiveCharacters` 用 **chapter id 大小**判断活跃/退场，而 chapter id
 *   与规范章序并不一致（删除、重排、跨卷都会错位）。本模块用**规范章序**判定，并已下线该函数。
 * - 旧策略是"该世界全部角色一次性灌进正文上下文"，本模块给出按本章相关度选入的确定性策略
 *   （细纲声明 > 正文/章纲提及 > main 兜底），其余角色只进名单。
 */
import type { Character } from '../types/character'
import {
  buildSurfaceOwnerIndex,
  entitySurfaceNames,
  findOwnersInText,
  resolveUniqueOwner,
  type SurfaceOwnerIndex,
} from '../entities/surface-match'

/**
 * 当前世界可见的角色。
 * 未指定 `worldGroupId`（undefined）= 不做世界过滤（单世界/全局查询）；
 * 显式 null = 主世界。跨世界角色在所有世界可见 —— 与 `readCharacters` 既有口径一致。
 */
export function worldVisibleCharacters(
  characters: readonly Character[],
  worldGroupId?: number | null,
): Character[] {
  if (worldGroupId === undefined) return [...characters]
  const target = worldGroupId ?? null
  return characters.filter(character => (
    character.isCrossWorld || (character.homeWorldGroupId ?? null) === target
  ))
}

export interface CharacterSurfaceIndex extends SurfaceOwnerIndex<Character> {
  /** 参与索引的角色（已按世界过滤、已剔除空名）。 */
  characters: Character[]
  /** 折叠后的正名 → 角色（用于"按正名精确点名"这类不涉及歧义的场景）。 */
  byCanonicalName: Map<string, Character>
}

export function buildCharacterSurfaceIndex(
  characters: readonly Character[],
  worldGroupId?: number | null,
): CharacterSurfaceIndex {
  const visible = worldVisibleCharacters(characters, worldGroupId)
    .filter(character => !!character.name?.trim())
  const index = buildSurfaceOwnerIndex(visible.map(character => ({
    owner: character,
    surfaces: entitySurfaceNames(character),
  })))
  const byCanonicalName = new Map<string, Character>()
  for (const character of visible) {
    const key = character.name.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
    if (!byCanonicalName.has(key)) byCanonicalName.set(key, character)
  }
  return { ...index, characters: visible, byCanonicalName }
}

/** 按任一声称解析唯一角色；称呼歧义（≥2 个角色共用）时返回 null —— 歧义不猜。 */
export function resolveCharacterBySurface(
  index: CharacterSurfaceIndex,
  surface: string,
): Character | null {
  return resolveUniqueOwner(index, surface)
}

/** 正文里出现的全部角色（按首次出现顺序，去重）。 */
export function findCharactersInText(
  text: string,
  index: CharacterSurfaceIndex,
): Character[] {
  return findOwnersInText(text, index)
}

/** 某角色在项目里受哪些称呼指代（正名 + 别称）。 */
export function characterSurfaces(character: Character): string[] {
  return entitySurfaceNames(character)
}

/**
 * 称呼（折叠后）→ 规范正名。供"AI 用别称点名"的落库路径归一（状态提取、物品归属等）。
 * 歧义称呼**不映射**：宁可让调用方看到未登记而拒绝，也不要把两张卡合并到错误的人。
 */
export function buildSurfaceToCanonicalMap(
  characters: readonly Character[],
  worldGroupId?: number | null,
): Map<string, string> {
  const index = buildCharacterSurfaceIndex(characters, worldGroupId)
  const map = new Map<string, string>()
  for (const [key, owners] of index.ownersBySurface) {
    if (index.ambiguous.has(key)) continue
    const owner = owners[0]
    if (owner) map.set(key, owner.name)
  }
  return map
}

/** 正文档：本章最多完整注入多少个角色档案（其余只进名单）。 */
export const FOCUS_MAX_CHARACTERS = 12
/** 名单档：其余角色最多列多少个名字。 */
export const FOCUS_ROSTER_MAX_NAMES = 60

export interface FocusSelectionInput {
  characters: readonly Character[]
  worldGroupId?: number | null
  /** 本章细纲声明的出场角色 id（`detailedOutlines.appearingCharacterIds`）。 */
  declaredCharacterIds?: readonly number[]
  /** 用于判断"提及"的参考文本：章纲标题/摘要 + 已有正文尾部（由调用方拼好）。 */
  referenceText?: string
  /** 规范章序下本章的位置；用于退场/未出场判定。缺省则不做活跃判定。 */
  chapterOrder?: number | null
  orderOfChapter?: ReadonlyMap<number, number>
}

export interface FocusSelection {
  /** 完整档案角色（优先级：细纲声明 > 提及 > main）。 */
  focus: Character[]
  /** 其余角色（只给名字）。 */
  roster: Character[]
  /** 判定证据，供上下文证据与调试使用。 */
  evidence: {
    declared: string[]
    mentioned: string[]
    mainFallback: string[]
    excludedExited: string[]
    ambiguousSurfaces: string[]
  }
}

/**
 * 选角：确定性、无随机、可解释。
 *
 * 顺序：
 * 1. 细纲显式声明的出场角色（作者/工坊已经确认过，最高优先）；
 * 2. 参考文本里被称呼命中的角色（正名或别称都能命中），按命中次数降序；
 * 3. `roleWeight === 'main'` 的主角兜底（长篇里主角几乎总在场）；
 * 4. 已退场（`exitChapterId` 早于本章规范章序）且既未声明也未被提及的角色排除出 focus；
 * 5. 截断到 `FOCUS_MAX_CHARACTERS`，其余进名单。
 */
export function selectFocusCharacters(input: FocusSelectionInput): FocusSelection {
  const visible = worldVisibleCharacters(input.characters, input.worldGroupId)
    .filter(character => !!character.name?.trim())
  const index = buildCharacterSurfaceIndex(visible, input.worldGroupId)
  const declaredIds = new Set((input.declaredCharacterIds ?? []).filter(id => typeof id === 'number'))
  const declared: Character[] = []
  const mentioned: Character[] = []
  const mainFallback: Character[] = []

  for (const character of visible) {
    if (character.id != null && declaredIds.has(character.id)) {
      declared.push(character)
      continue
    }
  }

  const referenceText = input.referenceText?.trim()
  if (referenceText) {
    for (const character of findCharactersInText(referenceText, index)) {
      if (declared.includes(character)) continue
      mentioned.push(character)
    }
  }
  mentioned.sort((a, b) => (
    mentionCount(referenceText ?? '', b) - mentionCount(referenceText ?? '', a)
    || (a.id ?? 0) - (b.id ?? 0)
  ))

  const chosen = new Set<Character>([...declared, ...mentioned])
  for (const character of visible) {
    if (chosen.has(character)) continue
    if (character.roleWeight === 'main') {
      mainFallback.push(character)
      chosen.add(character)
    }
  }

  const excludedExited: string[] = []
  const active = (character: Character): boolean => {
    if (input.chapterOrder == null || character.exitChapterId == null) return true
    const exitOrder = input.orderOfChapter?.get(character.exitChapterId)
    if (exitOrder == null) return true // 退场章无法定位时不猜，保留
    if (exitOrder >= input.chapterOrder) return true
    // 已退场：只有"被显式声明/提及"才允许继续注入（可能是回忆、转述或作者有意复用）。
    return declared.includes(character) || mentioned.includes(character)
  }

  const ordered = [...declared, ...mentioned, ...mainFallback]
  const kept: Character[] = []
  for (const character of ordered) {
    if (active(character)) kept.push(character)
    else excludedExited.push(character.name)
  }

  const focus = kept.slice(0, FOCUS_MAX_CHARACTERS)
  const focusSet = new Set(focus)
  const roster = visible.filter(character => !focusSet.has(character)).slice(0, FOCUS_ROSTER_MAX_NAMES)

  return {
    focus,
    roster,
    evidence: {
      declared: declared.map(character => character.name),
      mentioned: mentioned.map(character => character.name),
      mainFallback: mainFallback.map(character => character.name),
      excludedExited,
      ambiguousSurfaces: [...index.ambiguous].map(key => index.displayBySurface.get(key) ?? key),
    },
  }
}

function mentionCount(text: string, character: Character): number {
  if (!text) return 0
  let count = 0
  for (const surface of characterSurfaces(character)) {
    if (surface.length < 2) continue
    let index = text.indexOf(surface)
    while (index >= 0) {
      count++
      index = text.indexOf(surface, index + surface.length)
    }
  }
  return count
}
