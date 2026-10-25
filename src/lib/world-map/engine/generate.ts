/**
 * 地图生成主管线
 * 按顺序执行所有生成步骤
 */

import type {
  MapGenConfig,
  VoronoiMapData,
  MapSpatialEntity,
  SpatialPlacement,
  River,
} from './types'
import { seedRandom } from './random'
import { generatePoints, buildVoronoi } from './grid'
import { generateHeightmap } from './heightmap'
import { detectFeatures } from './features'
import { calculateTemperature, calculatePrecipitation, assignBiomes, rankCells } from './climate'
import { generateRivers } from './rivers'
import { generateCultures, generateBurgs, generateStates, generateProvinces, generateRoads } from './nations'
import { setNamingStyle } from './name-pool'
import { solveSpatialLayout } from '../spatial-layout'
import { log } from '../../logging/logger'

/** 生成完整地图 */
export function generateMap(config: MapGenConfig = {}): VoronoiMapData {
  const {
    width = 1200,
    height = 800,
    seed = String(Math.floor(Math.random() * 1e10)),
    pointCount = 10000,
    landRatio = 0.45,
    continentCount = 2,
    stateCount: requestedStateCount = 8,
    burgDensity = 0.5,
    temperatureShift = 0,
    precipitationFactor = 1.0,
    mapName = 'Fantasy World',
    heightmapTemplate = 'continents',
    namingStyle = 'chinese',
    generateProvinces: doProvinces = true,
    generateRoads: doRoads = true,
    stateNames: configuredStateNames,
    burgNames: configuredBurgNames,
    riverNames: configuredRiverNames,
    spatialEntities = [],
    spatialRelations = [],
    mapWidthKm,
    kmPerPixel,
  } = config

  const {
    stateCount,
    stateNames,
    burgNames,
    riverNames,
  } = resolveGenerationNames(
    requestedStateCount,
    configuredStateNames,
    configuredBurgNames,
    configuredRiverNames,
    spatialEntities,
  )
  const solverInput = prepareSpatialSolverInput(spatialEntities, spatialRelations)
  const rawSpatialLayout = solveSpatialLayout({
    width,
    height,
    seed,
    entities: solverInput.entities,
    relations: solverInput.relations,
    mapWidthKm,
    kmPerPixel,
  })
  const spatialLayout = {
    ...rawSpatialLayout,
    placements: restoreStatePlacementAliases(rawSpatialLayout.placements, spatialEntities),
  }
  const burgPlacements = addCapitalPlacementAliases(spatialLayout.placements, spatialEntities)

  const rng = seedRandom(seed)

  // 设置命名风格
  setNamingStyle(namingStyle)

  const totalStartedAt = performance.now()

  // 1. 生成 Voronoi 网格
  const gridStartedAt = performance.now()
  const points = generatePoints(width, height, pointCount, rng)
  const { cells, vertices } = buildVoronoi(points, width, height)
  log.debug('MapEngine', 'mapengine', '[MapEngine] Grid: ' + Math.round(performance.now() - gridStartedAt) + 'ms')

  // 2. 生成高度图（支持模板）
  const heightmapStartedAt = performance.now()
  generateHeightmap(cells, width, height, rng, landRatio, continentCount, heightmapTemplate)
  log.debug('MapEngine', 'mapengine', '[MapEngine] Heightmap: ' + Math.round(performance.now() - heightmapStartedAt) + 'ms')

  // 3. 检测地理特征（岛屿、湖泊、海洋）
  const featuresStartedAt = performance.now()
  const features = detectFeatures(cells)
  log.debug('MapEngine', 'mapengine', '[MapEngine] Features: ' + Math.round(performance.now() - featuresStartedAt) + 'ms')

  // 4. 气候：温度、降水量
  const climateStartedAt = performance.now()
  calculateTemperature(cells, height, temperatureShift)
  calculatePrecipitation(cells, height, precipitationFactor, rng)
  log.debug('MapEngine', 'mapengine', '[MapEngine] Climate: ' + Math.round(performance.now() - climateStartedAt) + 'ms')

  // 5. 河流
  const riversStartedAt = performance.now()
  const rivers = generateRivers(cells, rng)
  alignNamedRivers(rivers, riverNames, spatialEntities, spatialLayout.placements)
  log.debug('MapEngine', 'mapengine', '[MapEngine] Rivers: ' + Math.round(performance.now() - riversStartedAt) + 'ms')

  // 6. 生态群落
  const biomesStartedAt = performance.now()
  assignBiomes(cells)
  log.debug('MapEngine', 'mapengine', '[MapEngine] Biomes: ' + Math.round(performance.now() - biomesStartedAt) + 'ms')

  // 7. 适宜度评分
  rankCells(cells)

  // 8. 人口分布
  for (let i = 0; i < cells.length; i++) {
    cells.pop[i] = cells.s[i] > 0 ? cells.s[i] * (0.5 + rng() * 0.5) : 0
  }

  // 9. 文化
  const culturesStartedAt = performance.now()
  const cultureCount = Math.max(3, Math.floor(stateCount * 0.8))
  const cultures = generateCultures(cells, cultureCount, rng)
  log.debug('MapEngine', 'mapengine', '[MapEngine] Cultures: ' + Math.round(performance.now() - culturesStartedAt) + 'ms')

  // 10. 城镇
  const burgsStartedAt = performance.now()
  const burgs = generateBurgs(
    cells,
    stateCount,
    burgDensity,
    width,
    height,
    rng,
    burgNames,
    spatialEntities,
    burgPlacements,
  )
  log.debug('MapEngine', 'mapengine', '[MapEngine] Burgs: ' + Math.round(performance.now() - burgsStartedAt) + 'ms')

  // 11. 国家
  const statesStartedAt = performance.now()
  const states = generateStates(cells, burgs, stateCount, rng, stateNames, spatialEntities)
  log.debug('MapEngine', 'mapengine', '[MapEngine] States: ' + Math.round(performance.now() - statesStartedAt) + 'ms')

  // 12. 省份
  let provinces = [{ i: 0, name: '', color: '#ccc', state: 0, capital: 0, cells: 0 }]
  if (doProvinces) {
    const provincesStartedAt = performance.now()
    provinces = generateProvinces(cells, states, burgs, rng)
    log.debug('MapEngine', 'mapengine', '[MapEngine] Provinces: ' + Math.round(performance.now() - provincesStartedAt) + 'ms')
  }

  // 13. 道路
  let roads: VoronoiMapData['roads'] = []
  if (doRoads) {
    const roadsStartedAt = performance.now()
    roads = generateRoads(cells, burgs, states, rng)
    log.debug('MapEngine', 'mapengine', '[MapEngine] Roads: ' + Math.round(performance.now() - roadsStartedAt) + 'ms')
  }

  log.debug('MapEngine', 'mapengine', '[MapEngine] Total generation: ' + Math.round(performance.now() - totalStartedAt) + 'ms')

  return {
    width,
    height,
    seed,
    cells,
    vertices,
    features,
    rivers,
    burgs,
    states,
    cultures,
    provinces,
    roads,
    name: mapName,
    spatialPlacements: alignPlacementsToGeneratedEntities(
      spatialLayout.placements,
      spatialEntities,
      burgs,
      states,
      rivers,
    ),
    scaleResolution: spatialLayout.scale,
    spatialDiagnostics: spatialLayout.diagnostics,
  }
}

function resolveGenerationNames(
  requestedStateCount: number,
  configuredStateNames: string[] | undefined,
  configuredBurgNames: string[] | undefined,
  configuredRiverNames: string[] | undefined,
  entities: MapSpatialEntity[],
): {
  stateCount: number
  stateNames?: string[]
  burgNames?: string[]
  riverNames?: string[]
} {
  if (entities.length === 0) {
    return {
      stateCount: requestedStateCount,
      stateNames: configuredStateNames,
      burgNames: configuredBurgNames,
      riverNames: configuredRiverNames,
    }
  }

  const stateEntities = entities.filter(entity => entity.kind === 'state')
  const stateNames = uniqueNames([...(configuredStateNames ?? []), ...stateEntities.map(entity => entity.name)])
  const stateCount = Math.max(requestedStateCount, stateNames.length)
  const configuredBurgs = configuredBurgNames ?? []
  const capitalNames = Array.from({ length: stateCount }, (_, index) => {
    const stateName = stateNames[index]
    return stateEntities.find(entity => entity.name === stateName)?.capitalName
      || configuredBurgs[index]
  })
  const namedPlaces = entities
    .filter(entity => entity.kind === 'settlement' || entity.kind === 'fortress')
    .map(entity => entity.name)
  const burgNames = uniqueNames([
    ...capitalNames.filter((name): name is string => !!name),
    ...configuredBurgs.filter(name => !capitalNames.includes(name)),
    ...namedPlaces,
  ])
  const riverNames = uniqueNames([
    ...entities.filter(entity => entity.kind === 'river').map(entity => entity.name),
    ...(configuredRiverNames ?? []),
  ])
  return {
    stateCount,
    stateNames: stateNames.length > 0 ? stateNames : configuredStateNames,
    burgNames: burgNames.length > 0 ? burgNames : configuredBurgNames,
    riverNames: riverNames.length > 0 ? riverNames : configuredRiverNames,
  }
}

/**
 * 国家与其显式登记的首都代表同一地理锚点。若首都也在实体闭集中，求解前把国家关系
 * 重写到首都，避免同一国家被解成两个互不相干的坐标。
 */
function prepareSpatialSolverInput(
  entities: MapSpatialEntity[],
  relations: MapGenConfig['spatialRelations'] = [],
): {
  entities: MapSpatialEntity[]
  relations: NonNullable<MapGenConfig['spatialRelations']>
} {
  const entityNames = new Set(entities.map(entity => entity.name))
  const aliases = new Map<string, string>()
  for (const entity of entities) {
    if (entity.kind === 'state' && entity.capitalName && entityNames.has(entity.capitalName)) {
      aliases.set(entity.name, entity.capitalName)
    }
  }
  if (aliases.size === 0) return { entities, relations }
  return {
    entities: entities.filter(entity => !aliases.has(entity.name)),
    relations: relations.map(relation => ({
      ...relation,
      from: aliases.get(relation.from) ?? relation.from,
      to: aliases.get(relation.to) ?? relation.to,
    })),
  }
}

function restoreStatePlacementAliases(
  placements: SpatialPlacement[],
  entities: MapSpatialEntity[],
): SpatialPlacement[] {
  const result = [...placements]
  const placementByName = new Map(placements.map(placement => [placement.name, placement]))
  const existing = new Set(placementByName.keys())
  for (const entity of entities) {
    if (entity.kind !== 'state' || !entity.capitalName || existing.has(entity.name)) continue
    const capital = placementByName.get(entity.capitalName)
    if (!capital) continue
    result.push({
      ...capital,
      name: entity.name,
      kind: 'state',
      scaleTier: entity.scaleTier,
    })
    existing.add(entity.name)
  }
  return result
}

function addCapitalPlacementAliases(
  placements: SpatialPlacement[],
  entities: MapSpatialEntity[],
): SpatialPlacement[] {
  const result = [...placements]
  const existing = new Set(result.map(placement => placement.name))
  const placementByName = new Map(placements.map(placement => [placement.name, placement]))
  for (const entity of entities) {
    if (entity.kind !== 'state' || !entity.capitalName || existing.has(entity.capitalName)) continue
    const statePlacement = placementByName.get(entity.name)
    if (!statePlacement) continue
    result.push({
      ...statePlacement,
      name: entity.capitalName,
      kind: 'settlement',
      scaleTier: entity.scaleTier === 'empire' ? 'metropolis' : 'city',
    })
    existing.add(entity.capitalName)
  }
  return result
}

function alignNamedRivers(
  rivers: River[],
  riverNames: string[] | undefined,
  entities: MapSpatialEntity[],
  placements: SpatialPlacement[],
): void {
  const riverEntities = entities.filter(entity => entity.kind === 'river')
  if (riverEntities.length === 0) {
    for (let index = 0; index < Math.min(rivers.length, riverNames?.length ?? 0); index++) {
      rivers[index].name = riverNames![index]
    }
    return
  }

  const placementByName = new Map(placements.map(placement => [placement.name, placement]))
  const used = new Set<number>()
  for (const entity of riverEntities) {
    const target = placementByName.get(entity.name)
    const candidate = target
      ? nearestRiverIndex(rivers, used, target)
      : rivers.findIndex((_river, index) => !used.has(index))
    if (candidate < 0) break
    rivers[candidate].name = entity.name
    rivers[candidate].scaleTier = entity.scaleTier
    used.add(candidate)
  }

  const fallbackNames = (riverNames ?? []).filter(
    name => !riverEntities.some(entity => entity.name === name),
  )
  let fallbackIndex = 0
  for (let index = 0; index < rivers.length && fallbackIndex < fallbackNames.length; index++) {
    if (used.has(index)) continue
    rivers[index].name = fallbackNames[fallbackIndex++]
  }
}

function nearestRiverIndex(
  rivers: River[],
  used: Set<number>,
  target: SpatialPlacement,
): number {
  let bestIndex = -1
  let bestDistance = Infinity
  for (let index = 0; index < rivers.length; index++) {
    if (used.has(index) || rivers[index].points.length === 0) continue
    const midpoint = rivers[index].points[Math.floor(rivers[index].points.length / 2)]
    const distance = (midpoint[0] - target.x) ** 2 + (midpoint[1] - target.y) ** 2
    if (distance < bestDistance) {
      bestDistance = distance
      bestIndex = index
    }
  }
  return bestIndex
}

function alignPlacementsToGeneratedEntities(
  placements: SpatialPlacement[],
  entities: MapSpatialEntity[],
  burgs: VoronoiMapData['burgs'],
  states: VoronoiMapData['states'],
  rivers: VoronoiMapData['rivers'],
): SpatialPlacement[] {
  const stateCapitalByName = new Map(states.slice(1).map(state => {
    const capital = burgs[state.capital]
    return [state.name, capital ? { x: capital.x, y: capital.y } : undefined]
  }))
  const burgByName = new Map(burgs.slice(1).map(burg => [burg.name, burg]))
  const riverByName = new Map(rivers.map(river => [
    river.name,
    river.points[Math.floor(river.points.length / 2)],
  ]))
  const entityByName = new Map(entities.map(entity => [entity.name, entity]))

  return placements.map(placement => {
    const entity = entityByName.get(placement.name)
    if (entity?.kind === 'state') {
      const capital = stateCapitalByName.get(placement.name)
      if (capital) return { ...placement, ...capital }
    }
    if (entity?.kind === 'settlement' || entity?.kind === 'fortress') {
      const burg = burgByName.get(placement.name)
      if (burg) return { ...placement, x: burg.x, y: burg.y }
    }
    if (entity?.kind === 'river') {
      const midpoint = riverByName.get(placement.name)
      if (midpoint) return { ...placement, x: midpoint[0], y: midpoint[1] }
    }
    return placement
  })
}

function uniqueNames(names: string[]): string[] {
  const seen = new Set<string>()
  return names.map(name => name.trim()).filter(name => {
    if (!name || seen.has(name)) return false
    seen.add(name)
    return true
  })
}
