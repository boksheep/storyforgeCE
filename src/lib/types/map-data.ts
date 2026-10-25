/** WORLD-1: portable map facts and image-space evidence. */
export type MapReviewStatus = 'candidate' | 'confirmed' | 'rejected'
export type MapGeometry =
  | { version: 1; space: 'image'; kind: 'point'; points: [[number, number]] }
  | { version: 1; space: 'image'; kind: 'polyline' | 'polygon' | 'text-box'; points: [number, number][] }

interface MapRow {
  id?: number
  projectId: number
  worldGroupId: number | null
  worldNodeId: number
  createdAt: number
  updatedAt: number
}

/** Author-created category: an immutable code lets labels change without rewriting facts. */
export interface MapCategoryDefinition extends MapRow {
  code: string
  label: string
  baseKind: string
  shape: 'point' | 'polyline' | 'polygon'
  active: boolean
}

export interface MapAsset extends MapRow {
  assetKey: string
  parentAssetKey?: string
  role: 'original' | 'revision'
  name: string
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  width: number
  height: number
  byteLength: number
  sha256: string
}

/** Raw bytes survive IndexedDB structured cloning; export codec converts to base64. */
export interface MapAssetBlob extends MapRow {
  assetKey: string
  bytes: Uint8Array
  mimeType: MapAsset['mimeType']
  sha256: string
}

/** Durable image-only work queue. Scan state never enters creative context. */
export interface MapScanTask extends MapRow {
  taskKey: string
  assetKey: string
  sourceHash: string
  sourceRevision: string
  planVersion: 1
  parentTaskKey?: string
  round: number
  mission: 'overview' | 'borders' | 'cities' | 'railways' | 'roads' | 'waters'
  featurePage: number
  region: { x: number; y: number; width: number; height: number }
  reason: string
  status: 'pending' | 'running' | 'completed' | 'failed' | 'budget-exhausted'
  candidateCount: number
  saturated?: boolean
  error?: string
}

export interface MapFeature extends MapRow {
  featureKey: string
  name: string
  kind: string
  description: string
  aliases: string[]
  status: MapReviewStatus
  locked: boolean
  source: 'manual' | 'vision' | 'import'
  sourceAssetKey?: string
  sourceHash?: string
  sourceRevision?: string
  possibleDuplicateFeatureKeys?: string[]
  previousStatus?: MapReviewStatus
  reviewedAt?: number
  validFrom?: string
  validTo?: string
  /** Explicit author binding; names alone never merge separate systems. */
  codexEntryId?: number | null
  importantLocationId?: number | null
}

export interface MapObservation extends MapRow {
  observationKey: string
  assetKey: string
  featureKey?: string
  observationKind?: 'feature' | 'coverage'
  geometry: MapGeometry
  description: string
  source: 'manual' | 'vision' | 'import'
  status: MapReviewStatus
  sourceHash: string
  sourceRevision?: string
  checkedFeatureKeys?: string[]
  expectedFeatureKeys?: string[]
  model?: string
}

export interface MapRelation extends MapRow {
  relationKey: string
  fromFeatureKey: string
  toFeatureKey: string
  kind: 'north-of' | 'south-of' | 'east-of' | 'west-of' | 'adjacent' | 'land-border' | 'across-water' | 'coast-of' | 'route' | 'distance'
  value?: number
  unit?: string
  description: string
  source: 'manual' | 'vision' | 'import'
  status: MapReviewStatus
  sourceAssetKey?: string
  sourceHash?: string
  sourceRevision?: string
  previousStatus?: MapReviewStatus
  reviewedAt?: number
  validFrom?: string
  validTo?: string
}

/** A reviewed visual convention or author example, never a geographic entity by itself. */
export interface MapLegendEntry extends MapRow {
  legendKey: string
  assetKey?: string
  sourceHash?: string
  sourceRevision?: string
  label: string
  featureKind: string
  description: string
  sampleKind: 'color' | 'line' | 'symbol' | 'text'
  sampleOrigin: 'printed-legend' | 'map-example' | 'manual'
  sampleColor?: string
  sampleRegion?: { x: number; y: number; width: number; height: number }
  source: 'manual' | 'vision'
  status: MapReviewStatus
  locked: boolean
  reviewedAt?: number
}
