import type {
  MapGenConfig,
  MapScaleResolution,
  MapSpatialEntity,
  MapSpatialRelation,
  SpatialDirection,
  SpatialDistanceTier,
  SpatialDistanceUnit,
  SpatialLayoutDiagnostics,
  SpatialPlacement,
  SpatialScaleTier,
} from './engine/types'

const DIRECTION_VECTORS: Record<SpatialDirection, readonly [number, number]> = {
  north: [0, -1],
  'north-east': [Math.SQRT1_2, -Math.SQRT1_2],
  east: [1, 0],
  'south-east': [Math.SQRT1_2, Math.SQRT1_2],
  south: [0, 1],
  'south-west': [-Math.SQRT1_2, Math.SQRT1_2],
  west: [-1, 0],
  'north-west': [-Math.SQRT1_2, -Math.SQRT1_2],
}

const DISTANCE_FRACTIONS: Record<SpatialDistanceTier, number> = {
  adjacent: 0.08,
  near: 0.16,
  medium: 0.3,
  far: 0.5,
  'very-far': 0.7,
}

const SCALE_RADII: Record<SpatialScaleTier, number> = {
  supercontinent: 32,
  empire: 25,
  kingdom: 21,
  province: 18,
  metropolis: 15,
  city: 12,
  town: 10,
  village: 8,
  fortress: 10,
  landmark: 8,
}

interface MutablePlacement extends SpatialPlacement {
  radius: number
  anchored: boolean
}

export interface SpatialLayoutResult {
  placements: SpatialPlacement[]
  scale: MapScaleResolution
  diagnostics: SpatialLayoutDiagnostics
}

export interface SpatialLayoutInput {
  width: number
  height: number
  seed?: string
  entities?: MapSpatialEntity[]
  relations?: MapSpatialRelation[]
  mapWidthKm?: number
  kmPerPixel?: number
}

/** 将用户原始距离换算为公里；旅行单位的结果仅表示地图布局估算。 */
export function distanceToKm(value: number, unit: SpatialDistanceUnit): number {
  if (!Number.isFinite(value) || value <= 0) return 0
  switch (unit) {
    case 'km': return value
    case 'li': return value * 0.5
    case 'day': return value * 30
    case 'month': return value * 900
  }
}

/** 解析比例尺的可信来源，优先级：手动 > 地图宽度 > 显式距离 > 估算。 */
export function resolveMapScale(input: SpatialLayoutInput): MapScaleResolution {
  const width = positiveOr(input.width, 1200)
  if (isPositive(input.kmPerPixel)) {
    return {
      kmPerPixel: input.kmPerPixel,
      source: 'manual',
      travelEstimate: false,
      anchorCount: 1,
    }
  }
  if (isPositive(input.mapWidthKm)) {
    return {
      kmPerPixel: input.mapWidthKm / width,
      source: 'map-width',
      travelEstimate: false,
      anchorCount: 1,
    }
  }

  const shortestSide = Math.min(width, positiveOr(input.height, 800))
  const anchors = (input.relations ?? []).flatMap(relation => {
    if (!isPositive(relation.distanceValue) || !relation.distanceUnit) return []
    const km = distanceToKm(relation.distanceValue, relation.distanceUnit)
    if (!isPositive(km)) return []
    const targetPixels = shortestSide * distanceFraction(relation.distanceTier)
    return [{
      kmPerPixel: km / Math.max(targetPixels, 1),
      travelEstimate: relation.distanceUnit === 'day' || relation.distanceUnit === 'month',
    }]
  }).sort((a, b) => a.kmPerPixel - b.kmPerPixel)

  if (anchors.length > 0) {
    const middle = Math.floor(anchors.length / 2)
    const kmPerPixel = anchors.length % 2 === 1
      ? anchors[middle].kmPerPixel
      : (anchors[middle - 1].kmPerPixel + anchors[middle].kmPerPixel) / 2
    return {
      kmPerPixel,
      source: 'explicit-distance',
      travelEstimate: anchors.some(anchor => anchor.travelEstimate),
      anchorCount: anchors.length,
    }
  }

  return {
    kmPerPixel: 1,
    source: 'estimated',
    travelEstimate: false,
    anchorCount: 0,
  }
}

/**
 * 在不依赖 AI 坐标的前提下，把命名实体关系求解为稳定画布坐标。
 * 相同输入与 seed 始终返回相同结果。
 */
export function solveSpatialLayout(input: SpatialLayoutInput): SpatialLayoutResult {
  const width = positiveOr(input.width, 1200)
  const height = positiveOr(input.height, 800)
  const entities = uniqueEntities(input.entities ?? [])
  const names = new Set(entities.map(entity => entity.name))
  const relations = (input.relations ?? []).filter(
    relation => names.has(relation.from) && names.has(relation.to) && relation.from !== relation.to,
  )
  const scale = resolveMapScale({ ...input, width, height, relations })
  const shortestSide = Math.min(width, height)
  const margin = Math.min(48, Math.max(16, shortestSide * 0.04))
  const seed = input.seed ?? 'storyforge'

  const placements = entities.map((entity, index): MutablePlacement => {
    const hash = stableHash(`${seed}\0${entity.name}\0${index}`)
    const angle = ((hash % 3600) / 3600) * Math.PI * 2
    const orbit = 0.12 + (((hash >>> 12) % 1000) / 1000) * 0.28
    const anchor = entity.imageAnchor
    const anchored = Boolean(anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
      && anchor.x >= 0 && anchor.x <= 1 && anchor.y >= 0 && anchor.y <= 1)
    return {
      name: entity.name,
      kind: entity.kind,
      scaleTier: entity.scaleTier,
      x: anchored ? margin + scaleRadius(entity.scaleTier) + anchor!.x * (width - 2 * (margin + scaleRadius(entity.scaleTier))) : width / 2 + Math.cos(angle) * width * orbit,
      y: anchored ? margin + scaleRadius(entity.scaleTier) + anchor!.y * (height - 2 * (margin + scaleRadius(entity.scaleTier))) : height / 2 + Math.sin(angle) * height * orbit,
      radius: scaleRadius(entity.scaleTier),
      anchored,
    }
  })
  const byName = new Map(placements.map(placement => [placement.name, placement]))
  const iterations = entities.length > 1 && relations.length > 0 ? 420 : 0

  for (let iteration = 0; iteration < iterations; iteration++) {
    const cooling = 0.2 * (1 - iteration / iterations) + 0.025
    for (const relation of relations) {
      const from = byName.get(relation.from)
      const to = byName.get(relation.to)
      if (!from || !to) continue

      const deltaX = from.x - to.x
      const deltaY = from.y - to.y
      const currentDistance = Math.hypot(deltaX, deltaY) || 0.001
      const direction = relation.direction
        ? DIRECTION_VECTORS[relation.direction]
        : ([deltaX / currentDistance, deltaY / currentDistance] as const)
      const targetDistance = relationTargetPixels(relation, scale, shortestSide)
      const targetX = direction[0] * targetDistance
      const targetY = direction[1] * targetDistance
      const weight = relation.source === 'explicit' ? 1 : 0.55
      const correctionX = (targetX - deltaX) * cooling * weight
      const correctionY = (targetY - deltaY) * cooling * weight
      const movable = Number(!from.anchored) + Number(!to.anchored)
      if (!from.anchored && movable) { from.x += correctionX / movable; from.y += correctionY / movable }
      if (!to.anchored && movable) { to.x -= correctionX / movable; to.y -= correctionY / movable }
    }

    for (let a = 0; a < placements.length; a++) {
      for (let b = a + 1; b < placements.length; b++) {
        const first = placements[a]
        const second = placements[b]
        let dx = first.x - second.x
        let dy = first.y - second.y
        let distance = Math.hypot(dx, dy)
        const minimumDistance = first.radius + second.radius + 8
        if (distance >= minimumDistance) continue
        if (distance < 0.001) {
          const angle = (stableHash(`${first.name}\0${second.name}`) % 360) * Math.PI / 180
          dx = Math.cos(angle)
          dy = Math.sin(angle)
          distance = 1
        }
        const push = (minimumDistance - distance) * 0.12
        if (!first.anchored) { first.x += dx / distance * push; first.y += dy / distance * push }
        if (!second.anchored) { second.x -= dx / distance * push; second.y -= dy / distance * push }
      }
    }

    for (const placement of placements) {
      placement.x = clamp(placement.x, margin + placement.radius, width - margin - placement.radius)
      placement.y = clamp(placement.y, margin + placement.radius, height - margin - placement.radius)
    }
  }

  const diagnostics = diagnoseRelations(relations, byName, scale, shortestSide, iterations)
  return {
    placements: placements.map(placement => ({
      name: placement.name,
      kind: placement.kind,
      scaleTier: placement.scaleTier,
      x: round(placement.x),
      y: round(placement.y),
    })),
    scale,
    diagnostics,
  }
}

export function solveMapConfigSpatialLayout(config: MapGenConfig): SpatialLayoutResult {
  return solveSpatialLayout({
    width: config.width ?? 1200,
    height: config.height ?? 800,
    seed: config.seed,
    entities: config.spatialEntities,
    relations: config.spatialRelations,
    mapWidthKm: config.mapWidthKm,
    kmPerPixel: config.kmPerPixel,
  })
}

function diagnoseRelations(
  relations: MapSpatialRelation[],
  byName: Map<string, MutablePlacement>,
  scale: MapScaleResolution,
  shortestSide: number,
  iterations: number,
): SpatialLayoutDiagnostics {
  const violations = relations.flatMap((relation, relationIndex) => {
    const from = byName.get(relation.from)
    const to = byName.get(relation.to)
    if (!from || !to) return []
    const dx = from.x - to.x
    const dy = from.y - to.y
    const actualDistance = Math.hypot(dx, dy) || 0.001
    const directionError = relation.direction
      ? Math.max(0, 1 - (
        dx / actualDistance * DIRECTION_VECTORS[relation.direction][0]
        + dy / actualDistance * DIRECTION_VECTORS[relation.direction][1]
      ))
      : 0
    const targetDistance = relationTargetPixels(relation, scale, shortestSide)
    const distanceError = Math.abs(actualDistance - targetDistance) / Math.max(targetDistance, 1)
    if (directionError < 0.28 && distanceError < 0.42) return []
    return [{
      relationIndex,
      from: relation.from,
      to: relation.to,
      directionError: round(directionError),
      distanceError: round(distanceError),
      severity: directionError > 0.75 || distanceError > 0.85 ? 'conflict' as const : 'warning' as const,
    }]
  })
  return { iterations, violations }
}

function relationTargetPixels(
  relation: MapSpatialRelation,
  scale: MapScaleResolution,
  shortestSide: number,
): number {
  if (isPositive(relation.distanceValue) && relation.distanceUnit) {
    return Math.max(12, distanceToKm(relation.distanceValue, relation.distanceUnit) / scale.kmPerPixel)
  }
  return shortestSide * distanceFraction(relation.distanceTier)
}

function distanceFraction(tier?: SpatialDistanceTier): number {
  return DISTANCE_FRACTIONS[tier ?? 'medium']
}

function scaleRadius(tier?: SpatialScaleTier): number {
  return SCALE_RADII[tier ?? 'landmark']
}

function uniqueEntities(entities: MapSpatialEntity[]): MapSpatialEntity[] {
  const seen = new Set<string>()
  return entities.filter(entity => {
    const name = entity.name.trim()
    if (!name || seen.has(name)) return false
    seen.add(name)
    return true
  }).map(entity => ({ ...entity, name: entity.name.trim() }))
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function positiveOr(value: number, fallback: number): number {
  return isPositive(value) ? value : fallback
}

function isPositive(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (minimum > maximum) return (minimum + maximum) / 2
  return Math.min(maximum, Math.max(minimum, value))
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}
