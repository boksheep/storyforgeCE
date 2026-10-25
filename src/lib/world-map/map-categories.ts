import type { MapCategoryDefinition } from '../types'

/** WORLD-1: display vocabulary for the persisted MapFeature.kind string. */
export const MAP_CATEGORIES = [
  { code: 'place', label: '地点（通用）', shape: 'point' },
  { code: 'city', label: '城市／聚落', shape: 'point' },
  { code: 'capital', label: '首都／首府', shape: 'point' },
  { code: 'port', label: '港口', shape: 'point' },
  { code: 'country', label: '国家／政权', shape: 'polygon' },
  { code: 'region', label: '陆地区域', shape: 'polygon' },
  { code: 'sea', label: '海域', shape: 'polygon' },
  { code: 'lake', label: '湖泊', shape: 'polygon' },
  { code: 'river', label: '河流', shape: 'polyline' },
  { code: 'route', label: '道路／路线', shape: 'polyline' },
  { code: 'railway', label: '铁路', shape: 'polyline' },
  { code: 'coastline', label: '海岸线', shape: 'polyline' },
  { code: 'border', label: '疆界', shape: 'polyline' },
  { code: 'mountain', label: '山脉', shape: 'polyline' },
] as const

export type MapDrawingShape = 'point' | 'polyline' | 'polygon'

export function canonicalMapCategory(code: string): string {
  const prefix = code.split(':', 1)[0]
  return MAP_CATEGORIES.find(category => category.code === prefix)?.code ?? code
}

export function mapCategoryLabel(code: string, custom: readonly MapCategoryDefinition[] = []): string {
  return custom.find(category => category.code === code)?.label
    ?? MAP_CATEGORIES.find(category => category.code === code)?.label ?? code
}

export function mapCategoryShape(code: string): MapDrawingShape | null {
  return MAP_CATEGORIES.find(category => category.code === canonicalMapCategory(code))?.shape ?? null
}
