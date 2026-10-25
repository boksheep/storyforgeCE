/**
 * 实体「称呼」层（ALIAS-1）· 纯文本逻辑，不碰数据库、不碰注册表。
 *
 * 名词约定：
 * - **称呼（surface）** = 角色/词条/地点在正文里可能被写成的字面字符串，即「正名 + 别称」。
 * - 别称是**字面称呼**，不是正则、不是模式；比对方式与既有实现一致（CJK 用子串包含）。
 *
 * 为什么单独一层：正文高亮、检索召回、事实/认知绑定、跨世界泄漏检测、需求协商名册都要用
 * 同一套"谁可能被这样称呼"的判定与匹配。写两遍必然漂移（本仓库已经在 RichEditor 里
 * 有过一份内联重复实现）。这里只做文本匹配；世界归属与选角策略在各自领域模块里。
 */

/** 一个称呼至少要两个字：单字在中文正文里误命中率过高（既有实现同样是 `>= 2`）。 */
export const MIN_SURFACE_LENGTH = 2

/** 单个实体最多登记多少个别称（防止索引与提示词被无穷称呼撑爆）。 */
export const MAX_ENTITY_ALIASES = 8

/** 归一化用于比较的形式：去空白、NFKC、转小写（CJK 不受影响，拉丁字母大小写无关）。 */
export function foldSurface(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
}

/**
 * 归一化单个别称。返回 null 表示"这个值不该被当成称呼"：
 * 空、非字符串、过短、或与正名折叠后相同。
 */
export function normalizeAlias(raw: unknown, canonicalName?: string): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.normalize('NFKC').replace(/\s+/g, ' ').trim()
  if (value.length < MIN_SURFACE_LENGTH) return null
  if (canonicalName && foldSurface(value) === foldSurface(canonicalName)) return null
  return value
}

/**
 * 归一化别称数组，供 `arr()` 字段的 sanitize 使用（AI 输出与作者输入共用一条规则）。
 *
 * 接受：数组 / JSON 字符串 / 顿号或逗号分隔的字符串。
 * 返回：规范化后的数组；**无法解释的输入返回 undefined**，让 `adopt()` 记成类型错误，
 * 而不是静默写一个空数组把作者已有的别称抹掉。
 */
export function normalizeAliases(raw: unknown, canonicalName?: string): string[] | undefined {
  const items = toRawList(raw)
  if (!items) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of items) {
    const alias = normalizeAlias(item, canonicalName)
    if (!alias) continue
    const key = foldSurface(alias)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(alias)
    if (out.length >= MAX_ENTITY_ALIASES) break
  }
  return out
}

function toRawList(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const parsed = JSON.parse(text) as unknown
      if (Array.isArray(parsed)) return parsed
      return null
    } catch {
      return null
    }
  }
  return text.split(/[、,，;；\n]/)
}

export interface SurfaceBearer {
  /** 正名（唯一标识该实体的那个名字）。 */
  name: string
  /** 别称列表；缺失视为空。 */
  aliases?: readonly string[]
}

/**
 * 实体的全部可匹配称呼：正名 + 别称，去重（按折叠形式），正名排在最前。
 * 不过滤长度——正名即使只有一个字也仍然可用；匹配侧统一按 MIN_SURFACE_LENGTH 过滤。
 */
export function entitySurfaceNames(entity: SurfaceBearer): string[] {
  const name = (entity.name ?? '').normalize('NFKC').trim()
  const seen = new Set<string>()
  const out: string[] = []
  const push = (value: string) => {
    const folded = foldSurface(value)
    if (!folded || seen.has(folded)) return
    seen.add(folded)
    out.push(value)
  }
  if (name) push(name)
  for (const alias of entity.aliases ?? []) {
    const normalized = normalizeAlias(alias)
    if (normalized) push(normalized)
  }
  return out
}

export interface SurfaceMatch {
  from: number
  to: number
  surface: string
}

/**
 * 在文本里找出所有称呼命中：**最长优先 + 区间不重叠 + 至少两个字**。
 *
 * 与 `findEditorEntityMatches` 的既有语义一致（长名优先、命中区间互不覆盖），
 * 只是这里只认字符串，不关心实体种类。
 */
export function matchSurfacesInText(text: string, surfaces: readonly string[]): SurfaceMatch[] {
  // 共用不区分大小写的文本匹配规则；只小写、不去空白/NFKC，确保返回偏移仍指向原文。
  const foldedText = text.toLocaleLowerCase()
  const usable = surfaces
    .filter(surface => typeof surface === 'string' && surface.length >= MIN_SURFACE_LENGTH)
    .map(surface => ({ surface, folded: surface.toLocaleLowerCase() }))
    .filter(item => item.folded.length >= MIN_SURFACE_LENGTH)
    .sort((a, b) => b.folded.length - a.folded.length)
  const matches: SurfaceMatch[] = []
  const occupied = new Set<number>()
  for (const { surface, folded } of usable) {
    let index = foldedText.indexOf(folded)
    while (index >= 0) {
      const end = index + folded.length
      let overlaps = false
      for (let position = index; position < end; position++) {
        if (occupied.has(position)) { overlaps = true; break }
      }
      if (!overlaps) {
        matches.push({ from: index, to: end, surface })
        for (let position = index; position < end; position++) occupied.add(position)
      }
      index = foldedText.indexOf(folded, end)
    }
  }
  return matches.sort((a, b) => a.from - b.from)
}

export interface SurfaceOwnerInput<T> {
  owner: T
  surfaces: readonly string[]
}

export interface SurfaceOwnerIndex<T> {
  /** 折叠后的称呼 → 拥有它的实体（可能多个）。 */
  ownersBySurface: Map<string, T[]>
  /** 原始写法（未折叠）→ 用于展示与提示词，取首次出现的写法。 */
  displayBySurface: Map<string, string>
  /** 被 ≥2 个实体共用的称呼（**歧义不猜**：解析时一律不返回）。 */
  ambiguous: Set<string>
}

/**
 * 建立"称呼 → 实体"索引。同一称呼被多个实体占用时记入 `ambiguous`，
 * 调用方（身份解析、正文高亮）必须显式决定怎么处理，而不是按遍历顺序随便挑一个。
 */
export function buildSurfaceOwnerIndex<T>(items: readonly SurfaceOwnerInput<T>[]): SurfaceOwnerIndex<T> {
  const ownersBySurface = new Map<string, T[]>()
  const displayBySurface = new Map<string, string>()
  for (const item of items) {
    for (const surface of item.surfaces) {
      if (surface.length < MIN_SURFACE_LENGTH) continue
      const key = foldSurface(surface)
      const bucket = ownersBySurface.get(key) ?? []
      bucket.push(item.owner)
      ownersBySurface.set(key, bucket)
      if (!displayBySurface.has(key)) displayBySurface.set(key, surface)
    }
  }
  const ambiguous = new Set<string>()
  for (const [key, owners] of ownersBySurface) {
    if (owners.length > 1) ambiguous.add(key)
  }
  return { ownersBySurface, displayBySurface, ambiguous }
}

/** 唯一命中才返回实体；歧义或无命中返回 null。 */
export function resolveUniqueOwner<T>(index: SurfaceOwnerIndex<T>, surface: string): T | null {
  const key = foldSurface(surface)
  if (index.ambiguous.has(key)) return null
  const owners = index.ownersBySurface.get(key)
  return owners && owners.length === 1 ? owners[0] : null
}

/** 文本里命中的全部实体（去重、保持首次出现的顺序）。 */
export function findOwnersInText<T>(text: string, index: SurfaceOwnerIndex<T>): T[] {
  const surfaces = [...index.ownersBySurface.keys()]
  const foldedText = foldSurface(text)
  const out: T[] = []
  const seen = new Set<T>()
  for (const match of matchSurfacesInText(foldedText, surfaces)) {
    const owners = index.ownersBySurface.get(match.surface)
    if (!owners) continue
    for (const owner of owners) {
      if (seen.has(owner)) continue
      seen.add(owner)
      out.push(owner)
    }
  }
  return out
}
