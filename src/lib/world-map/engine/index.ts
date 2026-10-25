/**
 * Voronoi 地图引擎 — 入口
 */
export { generateMap } from './generate'
export { renderMap } from './renderer'
export type { RenderOptions } from './renderer'
export type {
  MapGenConfig, VoronoiMapData,
  HeightmapTemplate, NamingStyle, MapStylePreset,
  LayerVisibility, BiomeOverride,
  MapSpatialEntity, MapSpatialRelation, SpatialPlacement,
  SpatialEntityKind, SpatialScaleTier, SpatialDirection,
  SpatialDistanceTier, SpatialDistanceUnit,
  MapScaleResolution, MapScaleSource,
  SpatialLayoutDiagnostics, SpatialConstraintViolation,
} from './types'
export {
  distanceToKm, resolveMapScale, solveSpatialLayout, solveMapConfigSpatialLayout,
} from '../spatial-layout'
export type { SpatialLayoutInput, SpatialLayoutResult } from '../spatial-layout'
export { STYLE_PRESET_LABELS } from './style-presets'
