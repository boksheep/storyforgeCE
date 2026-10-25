/**
 * CONSISTENCY-5（随 ALIAS-1 交付）· 生成后跨世界实体泄漏检测（确定性、零 token）。
 *
 * 现状缺口（见 `docs/CONSISTENCY-COVERAGE-MAP.md` 的 `R-CANON-world-iso-1`）：
 * 世界隔离此前只在**检索期**硬过滤（召回只取当前世界的块），生成出来的正文没有人再查一遍，
 * 于是"世界 B 的章节里出现只属于世界 A 的专有名词"这种串台可以一路通过。
 *
 * 判定口径（刻意保守，只报"排他性"命中）：
 * - 只有**当前世界完全不可见**的实体名字才算外来；
 * - 某个称呼如果在当前世界也属于某个可见实体（两世界同名），一律**不报**（集合差天然排除）；
 * - 跨世界角色（`isCrossWorld`，如主角、系统精灵）从不视为外来；
 * - 词条按 `worldGroupId` 严格相等判断（注意 `null` = 主世界，**不是**全局，见 `codexEntryInWorld`）；
 * - 地点（importantLocations）是项目级、没有世界字段，不参与本检测。
 *
 * 只产出 advisory finding，不阻断生成、不自动改稿（与 `held-items` 等既有判决同等级）。
 */
import type { ConsistencyFinding } from '../ai/adapters/consistency-audit-adapter'
import { log } from '../logging/logger'

export type WorldScopedEntityKind = 'character' | 'codex' | 'location' | 'map'

export interface WorldScopedEntity {
  kind: WorldScopedEntityKind
  /** 用于证据回查的记录 id（角色/词条）。 */
  id?: number
  /** 规范正名（展示用）。 */
  name: string
  /** 全部可匹配称呼（正名 + 别称）。 */
  surfaces: readonly string[]
  /** null = 主世界（不是"全局"）。 */
  worldGroupId: number | null
  /** Explicitly shared record (cross-world character or location). */
  crossWorld?: boolean
}

function visibleInWorld(entity: WorldScopedEntity, targetWorldGroupId: number | null): boolean {
  if (entity.crossWorld) return true
  return (entity.worldGroupId ?? null) === (targetWorldGroupId ?? null)
}

/**
 * 当前世界**排他**的外来称呼 → 拥有它的实体。
 *
 * 返回 Map 而不是数组：一个称呼只保留首个外来实体，避免同一命中报多条。
 */
export function collectForeignWorldSurfaces(
  entities: readonly WorldScopedEntity[],
  targetWorldGroupId: number | null,
): Map<string, WorldScopedEntity> {
  const visibleSurfaces = new Set<string>()
  for (const entity of entities) {
    if (!visibleInWorld(entity, targetWorldGroupId)) continue
    for (const surface of entity.surfaces) visibleSurfaces.add(surface)
  }

  const foreign = new Map<string, WorldScopedEntity>()
  for (const entity of entities) {
    if (visibleInWorld(entity, targetWorldGroupId)) continue
    for (const surface of entity.surfaces) {
      if (surface.length < 2) continue
      if (visibleSurfaces.has(surface)) continue // 当前世界也有同名 → 无法判定串台
      if (!foreign.has(surface)) foreign.set(surface, entity)
    }
  }
  return foreign
}

/** 命中所在的整句（用于逐字引文）；找不到边界时退回命中附近的一段。 */
function sentenceAround(text: string, index: number, length: number): string {
  const boundary = /[。！？!?\n]/
  let start = index
  while (start > 0 && !boundary.test(text[start - 1])) start--
  let end = index + length
  while (end < text.length && !boundary.test(text[end])) end++
  return text.slice(start, end + 1).trim()
}

/**
 * 在正文里查外来世界实体。同一句只报一次（同句出现多个外来名时合并到一条证据）。
 */
export function checkForeignWorldEntities(
  chapterText: string,
  foreign: ReadonlyMap<string, WorldScopedEntity>,
): ConsistencyFinding[] {
  if (!chapterText || foreign.size === 0) return []
  const findings: ConsistencyFinding[] = []
  const seen = new Set<string>()

  for (const [surface, entity] of foreign) {
    let index = chapterText.indexOf(surface)
    while (index >= 0) {
      const quote = sentenceAround(chapterText, index, surface.length)
      const key = `${surface}\u0000${quote}`
      if (quote && !seen.has(key)) {
        seen.add(key)
        findings.push({
          category: '世界隔离',
          severity: 'risk',
          quote,
          evidence: [{
            sourceType: 'canon',
            sourceId: entity.id ?? 0,
            quote: `${entity.name}（${entity.kind === 'character' ? '角色' : '词条'}·仅属于另一个世界）`,
          }],
          reason: `「${surface}」只属于当前世界之外的记录，本世界检索与生成都不应引用它`,
          suggestion: '确认是否写错世界；若确需跨世界引用，请把该记录设为跨世界角色或移到当前世界。',
        })
      }
      index = chapterText.indexOf(surface, index + surface.length)
    }
  }
  log.info('Consistency', 'consistency.world-iso.checked', '跨世界实体泄漏检查已完成', {
    candidateSurfaceCount: foreign.size, findingCount: findings.length,
    chapterChars: chapterText.length,
  })
  return findings
}
