import type { MapGenConfig, MapSpatialEntity, MapSpatialRelation, SpatialEntityKind, SpatialScaleTier } from './engine'
import { listWorldMap, mapRevision } from './map-data'
import { canonicalMapCategory } from './map-categories'

function mapKind(kind: string): SpatialEntityKind {
  const normalized = kind.trim().toLowerCase()
  if (['country', 'empire', 'kingdom', 'state'].includes(normalized)) return 'state'
  if (['city', 'town', 'village', 'settlement', 'port'].includes(normalized)) return 'settlement'
  if (['fort', 'fortress', 'castle'].includes(normalized)) return 'fortress'
  if (['mountain', 'range', 'peak'].includes(normalized)) return 'mountain'
  if (['river', 'stream'].includes(normalized)) return 'river'
  if (['region', 'continent', 'province', 'sea', 'lake'].includes(normalized)) return 'region'
  return 'landmark'
}

function scaleFor(kind: SpatialEntityKind): SpatialScaleTier {
  if (kind === 'state') return 'kingdom'
  if (kind === 'settlement') return 'city'
  if (kind === 'fortress') return 'fortress'
  return 'landmark'
}

/** Converts author-confirmed IDs into the legacy name-only solver contract. */
export async function mergeConfirmedMapConstraints(
  projectId: number, worldNodeId: number, parsed: MapGenConfig, previous?: Partial<MapGenConfig>,
): Promise<MapGenConfig> {
  const data = await listWorldMap(projectId, worldNodeId)
  // This view has no selected era. A dated fact must not become an all-time map constraint.
  const datedNames = new Set(data.features.filter(feature => feature.validFrom || feature.validTo).map(feature => feature.name))
  const confirmed = data.features.filter(feature => feature.status === 'confirmed'
    && !feature.validFrom && !feature.validTo)
    .sort((a, b) => a.featureKey.localeCompare(b.featureKey))
  const activeAsset = data.assets[data.assets.length - 1]
  const seenNames = new Map<string, number>()
  const displayName = new Map<string, string>()
  const entities: MapSpatialEntity[] = confirmed.map(feature => {
    const count = (seenNames.get(feature.name) ?? 0) + 1
    seenNames.set(feature.name, count)
    const name = count === 1 ? feature.name : `${feature.name}（地图 ${count}）`
    displayName.set(feature.featureKey, name)
    const kind = mapKind(canonicalMapCategory(feature.kind))
    const observation = data.observations.find(row => row.featureKey === feature.featureKey
      && row.status === 'confirmed' && row.assetKey === activeAsset?.assetKey
      && (row.geometry.kind === 'point' || row.geometry.kind === 'polygon'))
    // A polygon's vertex average is only a layout anchor; the original outline stays in MapObservation.
    const point = observation?.geometry.kind === 'polygon'
      ? observation.geometry.points.reduce<[number, number]>((sum, vertex) =>
        [sum[0] + vertex[0] / observation.geometry.points.length,
          sum[1] + vertex[1] / observation.geometry.points.length], [0, 0])
      : observation?.geometry.points[0]
    return { name, featureKey: feature.featureKey, kind, scaleTier: scaleFor(kind), source: 'explicit',
      evidenceQuote: feature.name,
      ...(point ? { imageAnchor: { x: point[0], y: point[1] } } : {}),
    }
  })
  const relationKind: Record<string, MapSpatialRelation['direction']> = {
    'north-of': 'north', 'south-of': 'south', 'east-of': 'east', 'west-of': 'west',
  }
  const relations: MapSpatialRelation[] = data.relations
    .filter(relation => relation.status === 'confirmed' && !relation.validFrom && !relation.validTo
      && (relationKind[relation.kind] || ['adjacent', 'land-border', 'route', 'distance'].includes(relation.kind))
      && displayName.has(relation.fromFeatureKey) && displayName.has(relation.toFeatureKey))
    .map(relation => ({
      from: displayName.get(relation.fromFeatureKey)!, to: displayName.get(relation.toFeatureKey)!,
      ...(relationKind[relation.kind] ? { direction: relationKind[relation.kind] } : {}),
      ...(['adjacent', 'land-border', 'route'].includes(relation.kind) ? { distanceTier: 'adjacent' as const } : {}),
      ...(relation.kind === 'distance' && relation.value != null && ['km', 'li', 'day', 'month'].includes(relation.unit ?? '')
        ? { distanceValue: relation.value, distanceUnit: relation.unit as MapSpatialRelation['distanceUnit'] } : {}),
      source: 'explicit' as const,
      evidenceQuote: relation.description,
    }))
  const names = new Set(entities.map(entity => entity.name))
  const extras = (parsed.spatialEntities ?? []).filter(entity => !names.has(entity.name) && !datedNames.has(entity.name))
  const mergedNames = new Set([...names, ...extras.map(entity => entity.name)])
  return {
    ...parsed,
    // User calibration, seed and appearance choices remain stable across model regeneration.
    ...(previous?.kmPerPixel != null ? { kmPerPixel: previous.kmPerPixel } : {}),
    ...(previous?.seed ? { seed: previous.seed } : {}),
    ...(previous?.stylePreset ? { stylePreset: previous.stylePreset } : {}),
    ...(previous?.layers ? { layers: previous.layers } : {}),
    spatialEntities: [...entities, ...extras],
    spatialRelations: [...relations, ...(parsed.spatialRelations ?? []).filter(relation =>
      mergedNames.has(relation.from) && mergedNames.has(relation.to))],
    mapFactsRevision: await mapRevision(projectId, worldNodeId),
  }
}
