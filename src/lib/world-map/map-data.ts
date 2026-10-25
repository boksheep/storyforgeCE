import { db } from '../db/schema'
import { blobFromMapBytes, sha256Blob } from '../export/map-blob-codec'
import { locationInWorld } from '../location/scope'
import { logEvent } from '../logging/logger'
import type { MapAsset, MapCategoryDefinition, MapFeature, MapGeometry, MapLegendEntry, MapObservation, MapRelation, MapReviewStatus, MapScanTask, WorldNode } from '../types'
import { MAP_CATEGORIES, canonicalMapCategory, mapCategoryShape } from './map-categories'

const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_PIXELS = 36_000_000
const WATER_KINDS = new Set(['sea', 'ocean', 'lake', 'bay', 'strait'])

function validateRelationEndpoints(kind: MapRelation['kind'], from: MapFeature, to: MapFeature): void {
  const fromWater = WATER_KINDS.has(canonicalMapCategory(from.kind).toLowerCase())
  const toWater = WATER_KINDS.has(canonicalMapCategory(to.kind).toLowerCase())
  if (kind === 'coast-of' && (fromWater || !toWater)) {
    throw new Error('濒临海域关系应从陆地实体指向海域或水体')
  }
  if ((kind === 'land-border' || kind === 'across-water') && (fromWater || toWater)) {
    throw new Error('陆上接壤或隔水相望关系两端应为陆地实体')
  }
}

async function requireWorld(projectId: number, worldNodeId: number): Promise<WorldNode> {
  const node = await db.worldNodes.get(worldNodeId)
  if (!node || node.projectId !== projectId) throw new Error('地图世界节点不存在或不属于当前项目')
  return node
}

function inWorld(row: { worldGroupId: number | null; worldNodeId: number }, node: WorldNode): boolean {
  return row.worldNodeId === node.id && row.worldGroupId === (node.worldGroupId ?? null)
}

function imageMime(bytes: Uint8Array): MapAsset['mimeType'] | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF'
    && String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') return 'image/webp'
  return null
}

/** Upload keeps the immutable original and its metadata in one transaction. */
export async function uploadMapImage(projectId: number, worldNodeId: number, file: File): Promise<MapAsset> {
  const node = await requireWorld(projectId, worldNodeId)
  if (!file.size || file.size > MAX_IMAGE_BYTES) throw new Error('地图原图需小于 12 MB')
  const mimeType = imageMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()))
  if (!mimeType) throw new Error('仅支持真实的 PNG、JPEG 或 WebP 图片')
  const image = await createImageBitmap(file)
  const { width, height } = image
  image.close()
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('地图图片尺寸无效或超过 3600 万像素')
  const hash = await sha256Blob(file)
  const bytes = new Uint8Array(await file.arrayBuffer())
  const now = Date.now()
  const asset: MapAsset = {
    projectId, worldGroupId: node.worldGroupId ?? null, worldNodeId,
    assetKey: crypto.randomUUID(), role: 'original', name: file.name.slice(0, 160),
    mimeType, width, height, byteLength: file.size, sha256: hash,
    createdAt: now, updatedAt: now,
  }
  await db.transaction('rw', db.worldNodes, db.mapAssets, db.mapAssetBlobs, async () => {
    const currentNode = await db.worldNodes.get(worldNodeId)
    if (!currentNode || currentNode.projectId !== projectId
      || (currentNode.worldGroupId ?? null) !== asset.worldGroupId) {
      throw new Error('上传期间世界节点已改变，请重新选择地图')
    }
    asset.id = await db.mapAssets.add(asset)
    await db.mapAssetBlobs.add({
      projectId, worldGroupId: asset.worldGroupId, worldNodeId, assetKey: asset.assetKey,
      bytes, mimeType, sha256: hash, createdAt: now, updatedAt: now,
    })
  })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.image.uploaded', projectId,
    meta: { worldNodeId, assetKey: asset.assetKey, hash: asset.sha256.slice(0, 12), width, height, bytes: file.size } })
  return asset
}

export async function listWorldMap(projectId: number, worldNodeId: number) {
  const node = await requireWorld(projectId, worldNodeId)
  const [assets, features, observations, relations, legends, categories, scanTasks] = await Promise.all([
    db.mapAssets.where('worldNodeId').equals(worldNodeId).toArray(),
    db.mapFeatures.where('worldNodeId').equals(worldNodeId).toArray(),
    db.mapObservations.where('worldNodeId').equals(worldNodeId).toArray(),
    db.mapRelations.where('worldNodeId').equals(worldNodeId).toArray(),
    db.mapLegendEntries.where('worldNodeId').equals(worldNodeId).toArray(),
    db.mapCategoryDefinitions.where('worldNodeId').equals(worldNodeId).toArray(),
    db.mapScanTasks.where('worldNodeId').equals(worldNodeId).toArray(),
  ])
  return {
    assets: assets.filter(row => row.projectId === projectId && inWorld(row, node)),
    features: features.filter(row => row.projectId === projectId && inWorld(row, node)),
    observations: observations.filter(row => row.projectId === projectId && inWorld(row, node)),
    relations: relations.filter(row => row.projectId === projectId && inWorld(row, node)),
    legends: legends.filter(row => row.projectId === projectId && inWorld(row, node)),
    categories: categories.filter(row => row.projectId === projectId && inWorld(row, node)),
    scanTasks: scanTasks.filter(row => row.projectId === projectId && inWorld(row, node)),
  }
}

function validScanRegion(region: MapScanTask['region']): boolean {
  return !!region && [region.x, region.y, region.width, region.height].every(Number.isFinite)
    && region.x >= 0 && region.y >= 0 && region.width > 0 && region.height > 0
    && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001
}

/** Register bounded tasks before sending pixels, so reloads can skip completed requests. */
export async function ensureMapScanTasks(input: {
  projectId: number; worldNodeId: number; assetKey: string; sourceHash: string; sourceRevision: string;
  tasks: Array<Pick<MapScanTask, 'taskKey' | 'parentTaskKey' | 'round' | 'mission' | 'featurePage' | 'region' | 'reason'>>
}): Promise<MapScanTask[]> {
  const node = await requireWorld(input.projectId, input.worldNodeId)
  const asset = await db.mapAssets.where('[projectId+assetKey]').equals([input.projectId, input.assetKey]).first()
  if (!asset || !inWorld(asset, node) || asset.sha256 !== input.sourceHash
    || await mapRevision(input.projectId, input.worldNodeId) !== input.sourceRevision) {
    throw new Error('地图扫描计划对应的原图或已确认事实已改变')
  }
  if (input.tasks.length > 256 || new Set(input.tasks.map(task => task.taskKey)).size !== input.tasks.length) {
    throw new Error('地图扫描计划重复或超出任务上限')
  }
  for (const task of input.tasks) {
    if (!task.taskKey || !validScanRegion(task.region) || !Number.isInteger(task.round) || task.round < 0 || task.round > 8
      || !Number.isInteger(task.featurePage) || task.featurePage < 0
      || !task.reason || task.reason.length > 300
      || !['overview', 'borders', 'cities', 'railways', 'roads', 'waters'].includes(task.mission)) {
      throw new Error('地图扫描任务范围、轮次或类别无效')
    }
  }
  const now = Date.now()
  await db.transaction('rw', db.mapAssets, db.mapScanTasks, async () => {
    const currentAsset = await db.mapAssets.get(asset.id!)
    if (!currentAsset || currentAsset.sha256 !== input.sourceHash) throw new Error('扫描计划保存期间原图已改变')
    const existing = await db.mapScanTasks.where('assetKey').equals(input.assetKey).toArray()
    const known = new Map(existing.filter(row => row.projectId === input.projectId).map(row => [row.taskKey, row]))
    for (const task of input.tasks) {
      const prior = known.get(task.taskKey)
      if (prior) {
        if (prior.sourceHash !== input.sourceHash || prior.sourceRevision !== input.sourceRevision
          || prior.worldNodeId !== input.worldNodeId || JSON.stringify(prior.region) !== JSON.stringify(task.region)
          || prior.mission !== task.mission || prior.featurePage !== task.featurePage) {
          throw new Error('地图扫描任务键与原有任务不一致')
        }
        continue
      }
      const parent = task.parentTaskKey ? known.get(task.parentTaskKey) : null
      if (task.parentTaskKey && (!parent || parent.round >= task.round || parent.assetKey !== input.assetKey
        || parent.sourceRevision !== input.sourceRevision)) throw new Error('地图细分任务缺少同版本父区域')
      const row: MapScanTask = { projectId: input.projectId, worldGroupId: node.worldGroupId ?? null,
        worldNodeId: input.worldNodeId, assetKey: input.assetKey, sourceHash: input.sourceHash,
        sourceRevision: input.sourceRevision, planVersion: 1, status: 'pending', candidateCount: 0,
        createdAt: now, updatedAt: now, ...task }
      row.id = await db.mapScanTasks.add(row)
      known.set(row.taskKey, row)
    }
  })
  const keys = new Set(input.tasks.map(task => task.taskKey))
  return (await db.mapScanTasks.where('assetKey').equals(input.assetKey).toArray())
    .filter(row => row.projectId === input.projectId && keys.has(row.taskKey))
}

export async function setMapScanTaskStatus(projectId: number, taskKey: string,
  status: 'running' | 'failed' | 'budget-exhausted', error?: string): Promise<void> {
  const task = await db.mapScanTasks.where('[projectId+taskKey]').equals([projectId, taskKey]).first()
  if (!task || task.status === 'completed') throw new Error('地图扫描任务不存在或已完成')
  const asset = await db.mapAssets.where('[projectId+assetKey]').equals([projectId, task.assetKey]).first()
  if (!asset || asset.sha256 !== task.sourceHash) throw new Error('地图扫描任务的原图已失效')
  await db.mapScanTasks.update(task.id!, { status, error: error?.slice(0, 300), updatedAt: Date.now() })
}

function validCategoryLabel(label: string): string {
  const cleaned = label.trim()
  if (!cleaned || cleaned.length > 60 || /[\r\n]/.test(cleaned)) throw new Error('地图类别名称需为 1 至 60 字')
  return cleaned
}

async function requireOwnedCustomCategory(projectId: number, worldNodeId: number, kind: string): Promise<void> {
  if (!/^[a-z]+:[0-9a-f-]{36}$/.test(kind)) return // legacy free-text kinds remain readable/editable
  const category = await db.mapCategoryDefinitions.where('[projectId+code]').equals([projectId, kind]).first()
  if (!category || category.worldNodeId !== worldNodeId || !category.active) {
    throw new Error('自建地图类别不存在或不属于当前世界')
  }
}

/** An author category has a stable code and a preset semantic base for map validation. */
export async function addMapCategoryDefinition(input: {
  projectId: number; worldNodeId: number; label: string; baseKind: string
}): Promise<MapCategoryDefinition> {
  const node = await requireWorld(input.projectId, input.worldNodeId)
  const label = validCategoryLabel(input.label)
  const baseKind = canonicalMapCategory(input.baseKind)
  const shape = mapCategoryShape(baseKind)
  if (!shape || !MAP_CATEGORIES.some(category => category.code === baseKind)) throw new Error('请选择已有基础类别')
  const now = Date.now()
  const category: MapCategoryDefinition = { projectId: input.projectId,
    worldGroupId: node.worldGroupId ?? null, worldNodeId: input.worldNodeId,
    code: `${baseKind}:${crypto.randomUUID()}`, label, baseKind, shape, active: true,
    createdAt: now, updatedAt: now }
  await db.transaction('rw', db.worldNodes, db.mapCategoryDefinitions, async () => {
    const currentNode = await db.worldNodes.get(input.worldNodeId)
    if (!currentNode || currentNode.projectId !== input.projectId || !inWorld(category, currentNode)) {
      throw new Error('类别保存期间世界节点已改变')
    }
    const existing = await db.mapCategoryDefinitions.where('worldNodeId').equals(input.worldNodeId).toArray()
    if (MAP_CATEGORIES.some(item => item.label === label)
      || existing.some(item => item.projectId === input.projectId && item.label === label && item.active)) {
      throw new Error('该类别名称已存在')
    }
    category.id = await db.mapCategoryDefinitions.add(category)
  })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.category.added', projectId: input.projectId,
    meta: { worldNodeId: input.worldNodeId, code: category.code, baseKind } })
  return category
}

export async function renameMapCategoryDefinition(projectId: number, code: string, nextLabel: string): Promise<void> {
  const category = await db.mapCategoryDefinitions.where('[projectId+code]').equals([projectId, code]).first()
  if (!category) throw new Error('自建地图类别不存在')
  const node = await requireWorld(projectId, category.worldNodeId)
  if (!inWorld(category, node)) throw new Error('地图类别所属世界已改变')
  const label = validCategoryLabel(nextLabel)
  await db.transaction('rw', db.worldNodes, db.mapCategoryDefinitions, async () => {
    const currentNode = await db.worldNodes.get(category.worldNodeId)
    if (!currentNode || !inWorld(category, currentNode)) throw new Error('类别修改期间世界节点已改变')
    const existing = await db.mapCategoryDefinitions.where('worldNodeId').equals(category.worldNodeId).toArray()
    if (MAP_CATEGORIES.some(item => item.label === label)
      || existing.some(item => item.id !== category.id && item.projectId === projectId && item.label === label && item.active)) {
      throw new Error('该类别名称已存在')
    }
    await db.mapCategoryDefinitions.update(category.id!, { label, updatedAt: Date.now() })
  })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.category.renamed', projectId,
    meta: { worldNodeId: category.worldNodeId, code } })
}

function validateLegendRegion(region: MapLegendEntry['sampleRegion']): void {
  if (!region) return
  if ([region.x, region.y, region.width, region.height].some(value => !Number.isFinite(value))
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || region.x + region.width > 1.000001 || region.y + region.height > 1.000001) {
    throw new Error('图例样例区域无效')
  }
}

/** Manual entries are confirmed by their author; model entries remain candidates. */
export async function addMapLegendEntry(input: {
  projectId: number; worldNodeId: number; assetKey?: string; label: string; featureKind: string;
  description?: string; sampleKind: MapLegendEntry['sampleKind']; sampleOrigin: MapLegendEntry['sampleOrigin'];
  sampleColor?: string; sampleRegion?: MapLegendEntry['sampleRegion']; source: MapLegendEntry['source'];
  sourceRevision?: string
}): Promise<MapLegendEntry> {
  const node = await requireWorld(input.projectId, input.worldNodeId)
  const asset = input.assetKey ? await db.mapAssets.where('[projectId+assetKey]').equals([input.projectId, input.assetKey]).first() : null
  if (input.assetKey && (!asset || !inWorld(asset, node))) throw new Error('图例样例原图不属于当前世界')
  validateLegendRegion(input.sampleRegion)
  if (input.sampleRegion && !asset) throw new Error('图上样例必须关联原图')
  const label = input.label.trim()
  const featureKind = input.featureKind.trim()
  if (!label || label.length > 120 || !featureKind || featureKind.length > 60) throw new Error('图例名称或类别无效')
  await requireOwnedCustomCategory(input.projectId, input.worldNodeId, featureKind)
  if (input.sampleColor && !/^#[0-9a-fA-F]{6}$/.test(input.sampleColor)) throw new Error('图例颜色应为六位十六进制色值')
  if (input.source === 'vision' && (!asset || !input.sourceRevision)) throw new Error('自动图例缺少原图和识别版本')
  if (input.source === 'vision' && await mapRevision(input.projectId, input.worldNodeId) !== input.sourceRevision) {
    throw new Error('图例识别期间地图事实已改变，请重新分析')
  }
  const now = Date.now()
  const entry: MapLegendEntry = {
    projectId: input.projectId, worldGroupId: node.worldGroupId ?? null, worldNodeId: input.worldNodeId,
    legendKey: crypto.randomUUID(), assetKey: asset?.assetKey, sourceHash: asset?.sha256,
    sourceRevision: input.sourceRevision, label, featureKind,
    description: input.description?.trim().slice(0, 1000) ?? '', sampleKind: input.sampleKind,
    sampleOrigin: input.sampleOrigin, sampleColor: input.sampleColor, sampleRegion: input.sampleRegion,
    source: input.source, status: input.source === 'manual' ? 'confirmed' : 'candidate',
    locked: input.source === 'manual', reviewedAt: input.source === 'manual' ? now : undefined,
    createdAt: now, updatedAt: now,
  }
  await db.transaction('rw', db.worldNodes, db.mapAssets, db.mapLegendEntries, async () => {
    const currentNode = await db.worldNodes.get(input.worldNodeId)
    const currentAsset = asset && await db.mapAssets.get(asset.id!)
    if (!currentNode || currentNode.projectId !== input.projectId || !inWorld(entry, currentNode)
      || asset && (!currentAsset || !inWorld(currentAsset, currentNode) || currentAsset.sha256 !== asset.sha256)) {
      throw new Error('图例保存期间原图或世界节点已改变')
    }
    entry.id = await db.mapLegendEntries.add(entry)
  })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.legend.added', projectId: input.projectId,
    meta: { worldNodeId: input.worldNodeId, legendKey: entry.legendKey, source: entry.source,
      status: entry.status, hasSampleRegion: !!entry.sampleRegion } })
  return entry
}

export async function reviewMapLegendEntry(projectId: number, legendKey: string,
  status: 'confirmed' | 'rejected'): Promise<void> {
  const entry = await db.mapLegendEntries.where('[projectId+legendKey]').equals([projectId, legendKey]).first()
  if (!entry) throw new Error('图例条目不存在')
  const node = await requireWorld(projectId, entry.worldNodeId)
  if (!inWorld(entry, node)) throw new Error('图例条目所属世界已改变')
  if (status === 'confirmed' && entry.assetKey) {
    const asset = entry.assetKey ? await db.mapAssets.where('[projectId+assetKey]').equals([projectId, entry.assetKey]).first() : null
    if (!asset || !inWorld(asset, node) || asset.sha256 !== entry.sourceHash) throw new Error('图例候选原图已失效')
    // A confirmed sibling legend changes mapRevision; the same OCR batch must remain reviewable.
    // The immutable image hash is the relevant freshness boundary for a visual legend sample.
  }
  await db.mapLegendEntries.update(entry.id!, { status, locked: entry.source === 'manual' && status === 'confirmed',
    reviewedAt: Date.now(), updatedAt: Date.now() })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.legend.reviewed', projectId,
    meta: { worldNodeId: entry.worldNodeId, legendKey, status, source: entry.source } })
}

export async function updateMapLegendEntry(projectId: number, legendKey: string, changes: {
  label: string; featureKind: string; description: string; sampleColor?: string
  sampleKind?: MapLegendEntry['sampleKind']
}): Promise<void> {
  const entry = await db.mapLegendEntries.where('[projectId+legendKey]').equals([projectId, legendKey]).first()
  if (!entry) throw new Error('图例条目不存在')
  const node = await requireWorld(projectId, entry.worldNodeId)
  if (!inWorld(entry, node)) throw new Error('图例条目所属世界已改变')
  const label = changes.label.trim()
  const featureKind = changes.featureKind.trim()
  if (!label || label.length > 120 || !featureKind || featureKind.length > 60) throw new Error('图例名称或类别无效')
  await requireOwnedCustomCategory(projectId, entry.worldNodeId, featureKind)
  if (changes.sampleColor && !/^#[0-9a-fA-F]{6}$/.test(changes.sampleColor)) throw new Error('图例颜色无效')
  if (changes.sampleKind && !['color', 'line', 'symbol', 'text'].includes(changes.sampleKind)) {
    throw new Error('图例样式无效')
  }
  if (entry.assetKey) {
    const asset = await db.mapAssets.where('[projectId+assetKey]').equals([projectId, entry.assetKey]).first()
    if (!asset || !inWorld(asset, node) || asset.sha256 !== entry.sourceHash) {
      throw new Error('图例样例原图已失效，请重新框选当前原图')
    }
  }
  await db.mapLegendEntries.update(entry.id!, { label, featureKind,
    description: changes.description.trim().slice(0, 1000), sampleColor: changes.sampleColor,
    ...(changes.sampleKind ? { sampleKind: changes.sampleKind } : {}),
    source: 'manual', status: 'confirmed', locked: true, reviewedAt: Date.now(), updatedAt: Date.now() })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.legend.edited', projectId,
    meta: { worldNodeId: entry.worldNodeId, legendKey } })
}

/** Existing world-node portals are shown as declared links, never guessed from a map label. */
export async function listDeclaredMapPortals(projectId: number, worldNodeId: number): Promise<Array<{
  name: string; targetWorldId: number; targetName: string | null; linked: boolean
}>> {
  const node = await requireWorld(projectId, worldNodeId)
  let parsed: unknown
  try { parsed = JSON.parse(node.portalsJSON || '[]') } catch { return [] }
  if (!Array.isArray(parsed)) return []
  const [nodes, links] = await Promise.all([
    db.worldNodes.where('projectId').equals(projectId).toArray(),
    db.worldGroupLinks.where('projectId').equals(projectId).toArray(),
  ])
  return parsed.filter((item): item is { name: string; targetWorldId: number } =>
    !!item && typeof item === 'object' && typeof item.name === 'string' && Number.isInteger(item.targetWorldId))
    .map(item => {
      const target = nodes.find(other => other.id === item.targetWorldId)
      const sourceGroup = node.worldGroupId ?? null
      const targetGroup = target?.worldGroupId ?? null
      const linked = !!target && (sourceGroup === targetGroup || links.some(link => link.linkType === 'portal'
        && ((link.fromGroupId === sourceGroup && link.toGroupId === targetGroup)
          || (link.bidirectional && link.fromGroupId === targetGroup && link.toGroupId === sourceGroup))))
      return { name: item.name, targetWorldId: item.targetWorldId,
        targetName: target?.name ?? null, linked }
    })
}

export async function listMapLinkOptions(projectId: number, worldNodeId: number): Promise<{
  codex: Array<{ id: number; name: string }>; locations: Array<{ id: number; name: string }>
}> {
  const node = await requireWorld(projectId, worldNodeId)
  const [project, entries, locations] = await Promise.all([
    db.projects.get(projectId), db.codexEntries.where('projectId').equals(projectId).toArray(),
    db.importantLocations.where('projectId').equals(projectId).toArray(),
  ])
  const worldGroupId = node.worldGroupId ?? null
  return {
    codex: entries.filter(row => (row.worldGroupId ?? null) === worldGroupId && row.id != null)
      .map(row => ({ id: row.id!, name: row.name })),
    locations: locations.filter(row => row.id != null && locationInWorld(row, Boolean(project?.enableMultiWorld), worldGroupId))
      .map(row => ({ id: row.id!, name: row.name })),
  }
}

/** A link is an explicit author choice and does not copy or overwrite either record. */
export async function setMapFeatureBinding(projectId: number, featureKey: string,
  target: { kind: 'codex' | 'importantLocation'; id: number } | null): Promise<void> {
  const feature = await db.mapFeatures.where('[projectId+featureKey]').equals([projectId, featureKey]).first()
  if (!feature || feature.status !== 'confirmed') throw new Error('只能关联当前项目已确认的地图事实')
  const node = await requireWorld(projectId, feature.worldNodeId)
  if (!inWorld(feature, node)) throw new Error('地图事实所属世界已改变')
  if (target) {
    const options = await listMapLinkOptions(projectId, feature.worldNodeId)
    const allowed = target.kind === 'codex' ? options.codex : options.locations
    if (!allowed.some(row => row.id === target.id)) throw new Error('关联目标不属于当前世界或不存在')
  }
  await db.mapFeatures.update(feature.id!, {
    codexEntryId: target?.kind === 'codex' ? target.id : null,
    importantLocationId: target?.kind === 'importantLocation' ? target.id : null,
    updatedAt: Date.now(),
  })
}

export async function readMapImage(projectId: number, assetKey: string): Promise<Blob> {
  const record = await db.mapAssetBlobs.where('[projectId+assetKey]').equals([projectId, assetKey]).first()
  if (!record?.bytes) throw new Error('原图已缺失，请从完整备份恢复')
  return blobFromMapBytes(record.bytes, record.mimeType)
}

export function validateMapGeometry(geometry: MapGeometry): void {
  if (!geometry || geometry.version !== 1 || geometry.space !== 'image'
    || !['point', 'polyline', 'polygon', 'text-box'].includes(geometry.kind)
    || !Array.isArray(geometry.points)) throw new Error('地图标注坐标格式不支持')
  const count = geometry.points.length
  const minimum = geometry.kind === 'point' ? 1 : geometry.kind === 'polyline' ? 2 : geometry.kind === 'polygon' ? 3 : 2
  if (count < minimum || count > 500 || (geometry.kind === 'point' && count !== 1) || (geometry.kind === 'text-box' && count !== 2)) {
    throw new Error('地图标注点数不合法')
  }
  for (const point of geometry.points) {
    if (!Array.isArray(point) || point.length !== 2 || point.some(n => !Number.isFinite(n) || n < 0 || n > 1)) {
      throw new Error('地图标注坐标必须在图片范围内')
    }
  }
  for (let i = 1; i < count; i++) {
    if (geometry.points[i][0] === geometry.points[i - 1][0]
      && geometry.points[i][1] === geometry.points[i - 1][1]) throw new Error('地图标注包含零长度线段')
  }
  if (geometry.kind === 'text-box' && (geometry.points[1][0] <= geometry.points[0][0]
    || geometry.points[1][1] <= geometry.points[0][1])) throw new Error('地图文字框范围无效')
  if (geometry.kind === 'polygon') {
    const distinct = new Set(geometry.points.map(point => point.join(',')))
    if (distinct.size < 3) throw new Error('地图区域需要三个不同顶点')
    if (distinct.size !== count) throw new Error('地图区域含重复顶点')
    const doubleArea = geometry.points.reduce((sum, point, index) => {
      const next = geometry.points[(index + 1) % count]
      return sum + point[0] * next[1] - next[0] * point[1]
    }, 0)
    if (Math.abs(doubleArea) < 0.000001) throw new Error('地图区域面积为零或边界自交')
    const cross = (a: [number, number], b: [number, number], c: [number, number]) =>
      (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
    const intersects = (a: [number, number], b: [number, number], c: [number, number], d: [number, number]) => {
      const first = cross(a, b, c) * cross(a, b, d)
      const second = cross(c, d, a) * cross(c, d, b)
      return first < 0 && second < 0
    }
    for (let i = 0; i < count; i++) {
      for (let j = i + 1; j < count; j++) {
        if (j === i + 1 || (i === 0 && j === count - 1)) continue
        if (intersects(geometry.points[i], geometry.points[(i + 1) % count],
          geometry.points[j], geometry.points[(j + 1) % count])) throw new Error('地图区域边界自交')
      }
    }
  }
}

export async function addMapAnnotation(input: {
  projectId: number; worldNodeId: number; assetKey: string; geometry: MapGeometry;
  name: string; kind: string; description?: string
}): Promise<{ feature: MapFeature; observation: MapObservation }> {
  validateMapGeometry(input.geometry)
  const node = await requireWorld(input.projectId, input.worldNodeId)
  const asset = await db.mapAssets.where('[projectId+assetKey]').equals([input.projectId, input.assetKey]).first()
  if (!asset || asset.projectId !== input.projectId || !inWorld(asset, node)) throw new Error('原图与当前世界不匹配')
  const name = input.name.trim()
  if (!name || name.length > 120) throw new Error('请填写 1 至 120 字的标注名称')
  await requireOwnedCustomCategory(input.projectId, input.worldNodeId, input.kind)
  const now = Date.now()
  const common = { projectId: input.projectId, worldGroupId: node.worldGroupId ?? null, worldNodeId: input.worldNodeId, createdAt: now, updatedAt: now }
  const feature: MapFeature = { ...common, featureKey: crypto.randomUUID(), name, kind: input.kind.trim() || 'place',
    description: input.description?.trim() ?? '', aliases: [], status: 'confirmed', locked: true, source: 'manual',
    sourceAssetKey: asset.assetKey, sourceHash: asset.sha256 }
  const observation: MapObservation = { ...common, observationKey: crypto.randomUUID(), assetKey: asset.assetKey,
    featureKey: feature.featureKey, geometry: input.geometry, description: '', source: 'manual', status: 'confirmed', sourceHash: asset.sha256 }
  await db.transaction('rw', db.worldNodes, db.mapAssets, db.mapFeatures, db.mapObservations, async () => {
    const currentNode = await db.worldNodes.get(input.worldNodeId)
    const currentAsset = await db.mapAssets.get(asset.id!)
    if (!currentNode || currentNode.projectId !== input.projectId || !currentAsset
      || !inWorld(currentAsset, currentNode) || currentAsset.sha256 !== asset.sha256) {
      throw new Error('标注保存前原图或世界节点已改变')
    }
    feature.id = await db.mapFeatures.add(feature)
    observation.id = await db.mapObservations.add(observation)
  })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.annotation.added', projectId: input.projectId,
    meta: { worldNodeId: input.worldNodeId, assetKey: input.assetKey,
      featureKey: feature.featureKey, kind: feature.kind, shape: input.geometry.kind } })
  return { feature, observation }
}

/** An author may attach another disconnected territory to the same locked map fact. */
export async function addMapObservationToFeature(input: {
  projectId: number; worldNodeId: number; assetKey: string; featureKey: string;
  geometry: MapGeometry; description?: string
}): Promise<MapObservation> {
  validateMapGeometry(input.geometry)
  if (input.geometry.kind !== 'polygon') throw new Error('附加疆域必须是闭合区域')
  const node = await requireWorld(input.projectId, input.worldNodeId)
  const [asset, feature] = await Promise.all([
    db.mapAssets.where('[projectId+assetKey]').equals([input.projectId, input.assetKey]).first(),
    db.mapFeatures.where('[projectId+featureKey]').equals([input.projectId, input.featureKey]).first(),
  ])
  if (!asset || !inWorld(asset, node)) throw new Error('附加疆域原图与当前世界不匹配')
  if (!feature || !inWorld(feature, node) || feature.source !== 'manual' || feature.status !== 'confirmed') {
    throw new Error('只能为当前世界已确认的手工地图实体追加疆域')
  }
  const now = Date.now()
  const observation: MapObservation = { projectId: input.projectId, worldGroupId: node.worldGroupId ?? null,
    worldNodeId: input.worldNodeId, observationKey: crypto.randomUUID(), assetKey: asset.assetKey,
    featureKey: feature.featureKey, geometry: input.geometry, description: input.description?.trim().slice(0, 2000) ?? '',
    source: 'manual', status: 'confirmed', sourceHash: asset.sha256, createdAt: now, updatedAt: now }
  await db.transaction('rw', db.worldNodes, db.mapAssets, db.mapFeatures, db.mapObservations, async () => {
    const [currentNode, currentAsset, currentFeature] = await Promise.all([
      db.worldNodes.get(input.worldNodeId), db.mapAssets.get(asset.id!), db.mapFeatures.get(feature.id!),
    ])
    if (!currentNode || currentNode.projectId !== input.projectId || !currentAsset
      || !inWorld(currentAsset, currentNode) || currentAsset.sha256 !== asset.sha256
      || !currentFeature || !inWorld(currentFeature, currentNode)
      || currentFeature.status !== 'confirmed' || currentFeature.source !== 'manual') {
      throw new Error('附加疆域保存前地图实体或原图已改变')
    }
    observation.id = await db.mapObservations.add(observation)
  })
  return observation
}

/** AI suggestions remain candidate until one author action confirms them. */
export async function addMapCandidate(input: {
  projectId: number; worldNodeId: number; assetKey: string; geometry: MapGeometry;
  name: string; kind: string; description: string
}): Promise<MapFeature> {
  validateMapGeometry(input.geometry)
  const node = await requireWorld(input.projectId, input.worldNodeId)
  const asset = await db.mapAssets.where('[projectId+assetKey]').equals([input.projectId, input.assetKey]).first()
  if (!asset || asset.projectId !== input.projectId || !inWorld(asset, node)) throw new Error('候选来源图片与当前世界不匹配')
  const name = input.name.trim()
  if (!name || name.length > 120) throw new Error('候选名称无效')
  await requireOwnedCustomCategory(input.projectId, input.worldNodeId, input.kind)
  const now = Date.now()
  const sourceRevision = await mapRevision(input.projectId, input.worldNodeId)
  const possibleDuplicateFeatureKeys = (await listWorldMap(input.projectId, input.worldNodeId)).features
    .filter(row => row.name.trim().toLocaleLowerCase('zh-CN') === name.toLocaleLowerCase('zh-CN'))
    .map(row => row.featureKey)
  const common = { projectId: input.projectId, worldGroupId: node.worldGroupId ?? null, worldNodeId: input.worldNodeId, createdAt: now, updatedAt: now }
  const feature: MapFeature = { ...common, featureKey: crypto.randomUUID(), name, kind: input.kind.trim() || 'place',
    description: input.description.slice(0, 2000), aliases: [], status: 'candidate', locked: false, source: 'vision',
    sourceAssetKey: asset.assetKey, sourceHash: asset.sha256, sourceRevision, possibleDuplicateFeatureKeys }
  const observation: MapObservation = { ...common, observationKey: crypto.randomUUID(), assetKey: asset.assetKey,
    featureKey: feature.featureKey, geometry: input.geometry, description: '', source: 'vision', status: 'candidate', sourceHash: asset.sha256 }
  await db.transaction('rw', db.worldNodes, db.mapAssets, db.mapFeatures, db.mapObservations, async () => {
    const currentNode = await db.worldNodes.get(input.worldNodeId)
    const currentAsset = await db.mapAssets.get(asset.id!)
    if (!currentNode || currentNode.projectId !== input.projectId || !currentAsset
      || !inWorld(currentAsset, currentNode) || currentAsset.sha256 !== asset.sha256) {
      throw new Error('候选保存前原图或世界节点已改变')
    }
    feature.id = await db.mapFeatures.add(feature)
    await db.mapObservations.add(observation)
  })
  return feature
}

/** Persist a single vision response atomically after checking its input revision. */
export async function addMapCandidates(input: {
  projectId: number; worldNodeId: number; assetKey: string; assetHash: string; baseRevision: string;
  suggestions: Array<{ localId?: string; name: string; kind: string; description: string;
    geometry: MapGeometry; additionalGeometries?: MapGeometry[] }>;
  relations?: Array<{ from: string; to: string; kind: MapRelation['kind']; description: string }>;
  correlationId?: string;
  scanTaskKey?: string;
  saturated?: boolean;
  coverage?: { region: { x: number; y: number; width: number; height: number };
    expectedFeatureKeys: string[]; checkedFeatureKeys: string[]; model: string }
}): Promise<number> {
  if (input.suggestions.length > 12) throw new Error('地图候选数量超限')
  const node = await requireWorld(input.projectId, input.worldNodeId)
  const asset = await db.mapAssets.where('[projectId+assetKey]').equals([input.projectId, input.assetKey]).first()
  if (!asset || !inWorld(asset, node) || asset.sha256 !== input.assetHash) throw new Error('视觉分析使用的原图版本已改变')
  if (await mapRevision(input.projectId, input.worldNodeId) !== input.baseRevision) throw new Error('地图事实已改变，视觉候选需要重新核对')
  const scanTask = input.scanTaskKey
    ? await db.mapScanTasks.where('[projectId+taskKey]').equals([input.projectId, input.scanTaskKey]).first() : null
  if (input.scanTaskKey && (!scanTask || scanTask.assetKey !== input.assetKey || scanTask.sourceHash !== input.assetHash
    || scanTask.sourceRevision !== input.baseRevision || scanTask.worldNodeId !== input.worldNodeId
    || scanTask.status !== 'running')) throw new Error('地图扫描任务状态或来源已改变')
  for (const suggestion of input.suggestions) {
    await requireOwnedCustomCategory(input.projectId, input.worldNodeId, suggestion.kind)
    validateMapGeometry(suggestion.geometry)
    if ((suggestion.additionalGeometries?.length ?? 0) > 5) throw new Error('单个地图候选的分离区域过多')
    for (const extra of suggestion.additionalGeometries ?? []) {
      validateMapGeometry(extra)
      if (extra.kind !== 'polygon' || suggestion.geometry.kind !== 'polygon') {
        throw new Error('分离疆域必须由多块闭合区域组成')
      }
    }
    if (!suggestion.name.trim() || suggestion.name.length > 120) throw new Error('地图候选名称无效')
  }
  if ((input.relations?.length ?? 0) > 24) throw new Error('地图关系候选数量超限')
  let coverageGeometry: MapGeometry | null = null
  if (input.coverage) {
    const { region, expectedFeatureKeys, checkedFeatureKeys } = input.coverage
    coverageGeometry = { version: 1, space: 'image', kind: 'text-box',
      points: [[region.x, region.y], [region.x + region.width, region.y + region.height]] }
    validateMapGeometry(coverageGeometry)
    if (checkedFeatureKeys.some(key => !expectedFeatureKeys.includes(key))) throw new Error('扫描核对清单包含未知地图事实')
  }
  const existing = (await listWorldMap(input.projectId, input.worldNodeId)).features
  if (input.coverage?.checkedFeatureKeys.some(key => !existing.some(row => row.featureKey === key && row.status === 'confirmed'))) {
    throw new Error('扫描核对清单含非已确认地图事实')
  }
  const prepared = input.suggestions.map((suggestion, index) => ({ ...suggestion,
    localId: suggestion.localId ?? `c${index + 1}`, featureKey: crypto.randomUUID() }))
  const ids = prepared.map(row => row.localId)
  if (new Set(ids).size !== ids.length) throw new Error('地图候选 ID 重复')
  const candidateKeys = new Map(prepared.map(row => [row.localId, row.featureKey]))
  const checkedKeys = new Set(input.coverage?.checkedFeatureKeys ?? [])
  for (const relation of input.relations ?? []) {
    if (relation.from === relation.to || !relation.description.trim()
      || !candidateKeys.has(relation.from) && !checkedKeys.has(relation.from)
      || !candidateKeys.has(relation.to) && !checkedKeys.has(relation.to)) {
      throw new Error('地图关系候选端点或依据无效')
    }
  }
  const now = Date.now()
  await db.transaction('rw', [db.worldNodes, db.mapAssets, db.mapFeatures, db.mapObservations, db.mapRelations, db.mapScanTasks], async () => {
    const currentNode = await db.worldNodes.get(input.worldNodeId)
    const currentAsset = await db.mapAssets.get(asset.id!)
    if (!currentNode || currentNode.projectId !== input.projectId || !currentAsset
      || !inWorld(currentAsset, currentNode) || currentAsset.sha256 !== input.assetHash) {
      throw new Error('原图或世界节点在保存候选前已改变')
    }
    for (const suggestion of prepared) {
      const common = { projectId: input.projectId, worldGroupId: node.worldGroupId ?? null, worldNodeId: input.worldNodeId, createdAt: now, updatedAt: now }
      const featureKey = suggestion.featureKey
      const normalized = suggestion.name.trim().toLocaleLowerCase('zh-CN')
      const possibleDuplicateFeatureKeys = [
        ...existing.filter(row => row.name.trim().toLocaleLowerCase('zh-CN') === normalized).map(row => row.featureKey),
        ...prepared.filter(row => row.featureKey !== featureKey && row.name.trim().toLocaleLowerCase('zh-CN') === normalized).map(row => row.featureKey),
      ]
      await db.mapFeatures.add({ ...common, featureKey, name: suggestion.name.trim(), kind: suggestion.kind.trim() || 'place',
        description: suggestion.description.slice(0, 2000), aliases: [], status: 'candidate', locked: false,
        source: 'vision', sourceAssetKey: asset.assetKey, sourceHash: asset.sha256, sourceRevision: input.baseRevision, possibleDuplicateFeatureKeys })
      await db.mapObservations.add({ ...common, observationKey: crypto.randomUUID(), assetKey: asset.assetKey,
        featureKey, geometry: suggestion.geometry, description: '', source: 'vision', status: 'candidate', sourceHash: asset.sha256 })
      for (const geometry of suggestion.additionalGeometries ?? []) {
        await db.mapObservations.add({ ...common, observationKey: crypto.randomUUID(), assetKey: asset.assetKey,
          featureKey, geometry, description: '同一实体的另一块可见区域', source: 'vision', status: 'candidate', sourceHash: asset.sha256 })
      }
    }
    for (const suggestion of input.relations ?? []) {
      await db.mapRelations.add({ projectId: input.projectId, worldGroupId: node.worldGroupId ?? null,
        worldNodeId: input.worldNodeId, relationKey: crypto.randomUUID(),
        fromFeatureKey: candidateKeys.get(suggestion.from) ?? suggestion.from,
        toFeatureKey: candidateKeys.get(suggestion.to) ?? suggestion.to,
        kind: suggestion.kind, description: suggestion.description.trim().slice(0, 500),
        source: 'vision', status: 'candidate', sourceAssetKey: asset.assetKey,
        sourceHash: asset.sha256, sourceRevision: input.baseRevision, createdAt: now, updatedAt: now })
    }
    if (input.coverage && coverageGeometry) {
      await db.mapObservations.add({ projectId: input.projectId, worldGroupId: node.worldGroupId ?? null,
        worldNodeId: input.worldNodeId, observationKey: crypto.randomUUID(), assetKey: asset.assetKey,
        observationKind: 'coverage', geometry: coverageGeometry, description: 'AI 区域检查记录；不代表已识别全部内容',
        source: 'vision', status: 'candidate', sourceHash: asset.sha256, sourceRevision: input.baseRevision,
        expectedFeatureKeys: input.coverage.expectedFeatureKeys, checkedFeatureKeys: input.coverage.checkedFeatureKeys,
        model: input.coverage.model, createdAt: now, updatedAt: now })
    }
    if (scanTask) {
      const currentTask = await db.mapScanTasks.get(scanTask.id!)
      if (!currentTask || currentTask.status !== 'running') throw new Error('地图扫描任务已由别的操作处理')
      await db.mapScanTasks.update(scanTask.id!, { status: 'completed', candidateCount: prepared.length,
        saturated: !!input.saturated, error: undefined, updatedAt: now })
    }
  })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.vision.saved', projectId: input.projectId,
    correlationId: input.correlationId,
    meta: { worldNodeId: input.worldNodeId, assetKey: input.assetKey, hash: input.assetHash.slice(0, 12),
      candidates: prepared.length, relations: input.relations?.length ?? 0,
      checked: input.coverage?.checkedFeatureKeys.length ?? 0,
      expected: input.coverage?.expectedFeatureKeys.length ?? 0,
      regionX: input.coverage?.region.x ?? -1, regionY: input.coverage?.region.y ?? -1,
      regionWidth: input.coverage?.region.width ?? -1, regionHeight: input.coverage?.region.height ?? -1 } })
  return prepared.length
}

export async function reviewMapCoverage(projectId: number, observationKey: string): Promise<void> {
  const record = await db.mapObservations.where('[projectId+observationKey]').equals([projectId, observationKey]).first()
  if (!record || record.observationKind !== 'coverage' || record.projectId !== projectId) throw new Error('地图扫描区域不存在')
  const asset = await db.mapAssets.where('[projectId+assetKey]').equals([projectId, record.assetKey]).first()
  if (!asset || asset.sha256 !== record.sourceHash) throw new Error('扫描原图已不可核对')
  if (record.sourceRevision && await mapRevision(projectId, record.worldNodeId) !== record.sourceRevision) {
    throw new Error('扫描后地图事实已改变，请重新检查这一区域')
  }
  await db.mapObservations.update(record.id!, { status: 'confirmed', updatedAt: Date.now() })
}

/** Scope-and-page aware audit for an exact submitted region. It never claims visual completeness. */
export function summarizeMapCoverageRegion(input: {
  observations: MapObservation[]; assetHash: string; revision: string;
  confirmedFeatureKeys: string[]; region: { x: number; y: number; width: number; height: number }
}): '未检查' | '清单未全' | 'AI 已扫待审' | '作者已审' {
  const { x, y, width, height } = input.region
  const rows = input.observations.filter(row => row.observationKind === 'coverage'
    && row.sourceHash === input.assetHash && row.sourceRevision === input.revision
    && Math.abs(row.geometry.points[0][0] - x) < 0.001
    && Math.abs(row.geometry.points[0][1] - y) < 0.001
    && Math.abs(row.geometry.points[1][0] - (x + width)) < 0.001
    && Math.abs(row.geometry.points[1][1] - (y + height)) < 0.001)
  if (!rows.length) return '未检查'
  const latestByPage = new Map<string, MapObservation>()
  for (const row of rows) {
    const pageKey = [...(row.expectedFeatureKeys ?? [])].sort().join('|')
    const previous = latestByPage.get(pageKey)
    if (!previous || row.createdAt > previous.createdAt) latestByPage.set(pageKey, row)
  }
  const currentRows = [...latestByPage.values()]
  const sentKeys = new Set(currentRows.flatMap(row => row.expectedFeatureKeys ?? []))
  if (input.confirmedFeatureKeys.some(key => !sentKeys.has(key))) return '清单未全'
  return currentRows.every(row => row.status === 'confirmed') ? '作者已审' : 'AI 已扫待审'
}

/** Older 3×3 audits remain readable after the adaptive plan replaces the UI. */
export function summarizeMapCoverageCell(input: {
  observations: MapObservation[]; assetHash: string; revision: string;
  confirmedFeatureKeys: string[]; cellIndex: number
}): '未检查' | '清单未全' | 'AI 已扫待审' | '作者已审' {
  return summarizeMapCoverageRegion({ ...input, region: {
    x: (input.cellIndex % 3) / 3, y: Math.floor(input.cellIndex / 3) / 3, width: 1 / 3, height: 1 / 3,
  } })
}

export async function reviewMapFeature(projectId: number, featureKey: string, status: MapReviewStatus, allowStale = false): Promise<void> {
  const feature = await db.mapFeatures.where('[projectId+featureKey]').equals([projectId, featureKey]).first()
  if (!feature || feature.projectId !== projectId) throw new Error('地图候选不存在')
  if (feature.source !== 'vision') throw new Error('作者标注不可由视觉候选审核覆盖')
  if (status !== 'candidate' && feature.status !== 'candidate') throw new Error('候选已审核，需先撤销审核')
  if (status === 'confirmed') {
    const asset = feature.sourceAssetKey
      ? await db.mapAssets.where('[projectId+assetKey]').equals([projectId, feature.sourceAssetKey]).first()
      : null
    if (!asset || asset.sha256 !== feature.sourceHash) throw new Error('候选来源原图缺失或已改变，无法核对后接受')
  }
  if (feature.source === 'vision' && status === 'confirmed' && feature.sourceRevision
    && !allowStale && await mapRevision(projectId, feature.worldNodeId) !== feature.sourceRevision) {
    throw new Error('候选已过期：地图事实在视觉分析后发生变化，请重新核对原图')
  }
  if (status === 'candidate' && feature.previousStatus !== 'candidate') throw new Error('这条候选没有可撤销的审核')
  const observations = (await db.mapObservations.where('featureKey').equals(featureKey).toArray()).filter(row => row.projectId === projectId)
  await db.transaction('rw', db.mapFeatures, db.mapObservations, db.mapRelations, async () => {
    await db.mapFeatures.update(feature.id!, {
      status, previousStatus: status === 'candidate' ? undefined : feature.status,
      reviewedAt: status === 'candidate' ? undefined : Date.now(), updatedAt: Date.now(),
    })
    for (const row of observations) await db.mapObservations.update(row.id!, { status, updatedAt: Date.now() })
    if (status !== 'confirmed') await demoteVisionRelations(projectId, featureKey)
  })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.feature.reviewed', projectId,
    meta: { worldNodeId: feature.worldNodeId, featureKey, status, staleOverride: allowStale } })
}

async function demoteVisionRelations(projectId: number, featureKey: string): Promise<void> {
  const [outgoing, incoming] = await Promise.all([
    db.mapRelations.where('fromFeatureKey').equals(featureKey).toArray(),
    db.mapRelations.where('toFeatureKey').equals(featureKey).toArray(),
  ])
  for (const relation of new Map([...outgoing, ...incoming].map(row => [row.id, row])).values()) {
    if (relation.projectId === projectId && relation.source === 'vision' && relation.status === 'confirmed') {
      await db.mapRelations.update(relation.id!, { status: 'candidate', previousStatus: 'candidate', updatedAt: Date.now() })
    }
  }
}

/** Author edits a vision proposal before deciding whether it becomes a map fact. */
export async function updateMapCandidate(projectId: number, featureKey: string, changes: {
  name: string; kind: string; description: string
}): Promise<void> {
  const feature = await db.mapFeatures.where('[projectId+featureKey]').equals([projectId, featureKey]).first()
  if (!feature || feature.projectId !== projectId || feature.source !== 'vision' || feature.status !== 'candidate') {
    throw new Error('只有待审视觉候选可以在此修改')
  }
  const name = changes.name.trim()
  if (!name || name.length > 120) throw new Error('候选名称需为 1 至 120 字')
  await requireOwnedCustomCategory(projectId, feature.worldNodeId, changes.kind.trim())
  await db.mapFeatures.update(feature.id!, {
    name, kind: changes.kind.trim().slice(0, 60) || 'place',
    description: changes.description.trim().slice(0, 2000), updatedAt: Date.now(),
  })
}

/** Author-maintained semantic data remains editable even after removing the image. */
export async function updateConfirmedMapFeature(projectId: number, featureKey: string, changes: {
  name: string; kind: string; description: string
}): Promise<void> {
  const feature = await db.mapFeatures.where('[projectId+featureKey]').equals([projectId, featureKey]).first()
  if (!feature || feature.projectId !== projectId || feature.status !== 'confirmed') throw new Error('已确认地图事实不存在')
  const name = changes.name.trim()
  if (!name || name.length > 120) throw new Error('地图事实名称需为 1 至 120 字')
  const updatedKind = changes.kind.trim().slice(0, 60) || 'place'
  await requireOwnedCustomCategory(projectId, feature.worldNodeId, updatedKind)
  const data = await listWorldMap(projectId, feature.worldNodeId)
  const features = new Map(data.features.map(row => [row.featureKey, row]))
  for (const relation of data.relations.filter(row => row.status === 'confirmed'
    && (row.fromFeatureKey === featureKey || row.toFeatureKey === featureKey))) {
    const from = features.get(relation.fromFeatureKey)
    const to = features.get(relation.toFeatureKey)
    if (from && to) validateRelationEndpoints(relation.kind,
      from.featureKey === featureKey ? { ...from, kind: updatedKind } : from,
      to.featureKey === featureKey ? { ...to, kind: updatedKind } : to)
  }
  await db.mapFeatures.update(feature.id!, {
    name, kind: updatedKind,
    description: changes.description.trim().slice(0, 2000), updatedAt: Date.now(),
  })
}

/** Author-only reversible removal of a locked manual fact. */
export async function setManualMapFeatureVisible(projectId: number, featureKey: string, visible: boolean): Promise<void> {
  const feature = await db.mapFeatures.where('[projectId+featureKey]').equals([projectId, featureKey]).first()
  if (!feature || feature.source !== 'manual' || !feature.locked) throw new Error('作者标注不存在')
  const observations = (await db.mapObservations.where('featureKey').equals(featureKey).toArray())
    .filter(row => row.projectId === projectId)
  const status: MapReviewStatus = visible ? 'confirmed' : 'rejected'
  await db.transaction('rw', db.mapFeatures, db.mapObservations, db.mapRelations, async () => {
    await db.mapFeatures.update(feature.id!, { status, updatedAt: Date.now() })
    for (const row of observations) await db.mapObservations.update(row.id!, { status, updatedAt: Date.now() })
    if (!visible) await demoteVisionRelations(projectId, featureKey)
  })
}

export async function addMapRelation(input: {
  projectId: number; worldNodeId: number; fromFeatureKey: string; toFeatureKey: string;
  kind: MapRelation['kind']; description?: string; value?: number; unit?: string
}): Promise<MapRelation> {
  const node = await requireWorld(input.projectId, input.worldNodeId)
  if (input.fromFeatureKey === input.toFeatureKey) throw new Error('地图关系两端不能相同')
  const [from, to] = await Promise.all([
    db.mapFeatures.where('[projectId+featureKey]').equals([input.projectId, input.fromFeatureKey]).first(),
    db.mapFeatures.where('[projectId+featureKey]').equals([input.projectId, input.toFeatureKey]).first(),
  ])
  if (!from || !to || from.projectId !== input.projectId || to.projectId !== input.projectId
    || !inWorld(from, node) || !inWorld(to, node)) throw new Error('地图关系两端必须属于当前世界')
  if (from.status !== 'confirmed' || to.status !== 'confirmed') throw new Error('地图关系只能连接已确认事实')
  validateRelationEndpoints(input.kind, from, to)
  if (input.value !== undefined && (!Number.isFinite(input.value) || input.value < 0)) throw new Error('地图关系数值无效')
  const now = Date.now()
  const relation: MapRelation = {
    projectId: input.projectId, worldGroupId: node.worldGroupId ?? null, worldNodeId: input.worldNodeId,
    relationKey: crypto.randomUUID(), fromFeatureKey: from.featureKey, toFeatureKey: to.featureKey,
    kind: input.kind, description: input.description?.trim() ?? '', value: input.value, unit: input.unit,
    source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now,
  }
  relation.id = await db.mapRelations.add(relation)
  return relation
}

/** Vision relationships are stored as guesses until both endpoints and the image are reviewed. */
export async function reviewMapRelation(projectId: number, relationKey: string,
  status: MapReviewStatus, allowStale = false): Promise<void> {
  const relation = await db.mapRelations.where('[projectId+relationKey]').equals([projectId, relationKey]).first()
  if (!relation || relation.source !== 'vision') throw new Error('视觉地图关系候选不存在')
  if (status !== 'candidate' && relation.status !== 'candidate') throw new Error('关系候选已审核')
  if (status === 'candidate' && relation.previousStatus !== 'candidate') throw new Error('关系候选没有可撤销的审核')
  if (status === 'confirmed') {
    const node = await requireWorld(projectId, relation.worldNodeId)
    const [asset, from, to] = await Promise.all([
      relation.sourceAssetKey
        ? db.mapAssets.where('[projectId+assetKey]').equals([projectId, relation.sourceAssetKey]).first() : null,
      db.mapFeatures.where('[projectId+featureKey]').equals([projectId, relation.fromFeatureKey]).first(),
      db.mapFeatures.where('[projectId+featureKey]').equals([projectId, relation.toFeatureKey]).first(),
    ])
    if (!asset || !inWorld(asset, node) || asset.sha256 !== relation.sourceHash) throw new Error('关系候选来源原图缺失或改变')
    if (!from || !to || from.status !== 'confirmed' || to.status !== 'confirmed'
      || !inWorld(from, node) || !inWorld(to, node)) {
      throw new Error('请先确认关系两端的地图事实')
    }
    validateRelationEndpoints(relation.kind, from, to)
    if (relation.sourceRevision && !allowStale
      && await mapRevision(projectId, relation.worldNodeId) !== relation.sourceRevision) {
      throw new Error('关系候选已过期：地图事实在视觉分析后发生变化，请重新核对原图')
    }
  }
  await db.mapRelations.update(relation.id!, { status,
    previousStatus: status === 'candidate' ? undefined : relation.status,
    reviewedAt: status === 'candidate' ? undefined : Date.now(), updatedAt: Date.now() })
}

export async function setMapRelationVisible(projectId: number, relationKey: string, visible: boolean): Promise<void> {
  const relation = await db.mapRelations.where('[projectId+relationKey]').equals([projectId, relationKey]).first()
  if (relation?.source === 'vision') throw new Error('视觉关系须逐条审核')
  if (!relation || relation.projectId !== projectId || relation.source !== 'manual') throw new Error('作者地图关系不存在')
  await db.mapRelations.update(relation.id!, { status: visible ? 'confirmed' : 'rejected', updatedAt: Date.now() })
}

export async function removeMapAsset(projectId: number, assetKey: string): Promise<void> {
  const asset = await db.mapAssets.where('[projectId+assetKey]').equals([projectId, assetKey]).first()
  if (!asset || asset.projectId !== projectId) throw new Error('地图原图不存在')
  const blob = await db.mapAssetBlobs.where('[projectId+assetKey]').equals([projectId, assetKey]).first()
  const legends = (await db.mapLegendEntries.where('projectId').equals(projectId).toArray())
    .filter(row => row.assetKey === assetKey)
  const scanTasks = (await db.mapScanTasks.where('assetKey').equals(assetKey).toArray())
    .filter(row => row.projectId === projectId)
  await db.transaction('rw', db.mapAssets, db.mapAssetBlobs, db.mapLegendEntries, db.mapScanTasks, async () => {
    await db.mapAssets.delete(asset.id!)
    if (blob?.id != null) await db.mapAssetBlobs.delete(blob.id)
    for (const legend of legends) await db.mapLegendEntries.update(legend.id!, {
      status: 'rejected', locked: false, updatedAt: Date.now(),
    })
    for (const task of scanTasks) await db.mapScanTasks.delete(task.id!)
  })
  logEvent({ level: 'info', tag: 'MapImage', event: 'map.image.removed', projectId,
    meta: { worldNodeId: asset.worldNodeId, assetKey, hash: asset.sha256.slice(0, 12), disabledLegends: legends.length } })
  // Image-space observations are retained as provenance, but the image itself is unavailable.
  // Confirmed semantic features and relations remain usable as a data-only map.
}

/** A deterministic fingerprint for stale AI candidate detection and creative context. */
export async function mapRevision(projectId: number, worldNodeId: number): Promise<string> {
  const data = await listWorldMap(projectId, worldNodeId)
  const canonical = JSON.stringify({
    assets: data.assets.map(a => [a.assetKey, a.sha256]).sort(),
    features: data.features.filter(f => f.status === 'confirmed').map(f => [f.featureKey, f.name, f.kind, f.description, f.validFrom, f.validTo, f.codexEntryId, f.importantLocationId]).sort(),
    observations: data.observations.filter(o => o.status === 'confirmed' && o.observationKind !== 'coverage').map(o => [o.observationKey, o.featureKey, o.assetKey, o.geometry]).sort(),
    relations: data.relations.filter(r => r.status === 'confirmed').map(r => [r.relationKey, r.fromFeatureKey, r.toFeatureKey, r.kind, r.value, r.unit, r.validFrom, r.validTo]).sort(),
    legends: data.legends.filter(row => row.status === 'confirmed').map(row => [row.legendKey, row.assetKey, row.sourceHash, row.label, row.featureKind, row.description, row.sampleKind, row.sampleOrigin, row.sampleColor, row.sampleRegion]).sort(),
    categories: data.categories.filter(row => row.active).map(row => [row.code, row.label, row.baseKind, row.shape]).sort(),
  })
  return sha256Blob(new Blob([canonical]))
}

/** Budgeted, text-only context. No image bytes and no unreviewed vision guesses. */
export async function readMapFactsContext(projectId: number, worldGroupId: number | null): Promise<string> {
  const nodes = (await db.worldNodes.where('projectId').equals(projectId).toArray())
    .filter(node => (node.worldGroupId ?? null) === worldGroupId)
  if (!nodes.length) return ''
  const sections: string[] = []
  for (const node of nodes) {
    if (node.id == null) continue
    const data = await listWorldMap(projectId, node.id)
    const confirmed = data.features.filter(feature => feature.status === 'confirmed')
    const confirmedKeys = new Set(confirmed.map(feature => feature.featureKey))
    const relations = data.relations.filter(relation => relation.status === 'confirmed'
      && confirmedKeys.has(relation.fromFeatureKey) && confirmedKeys.has(relation.toFeatureKey))
    if (!confirmed.length && !relations.length) continue
    const shown = confirmed.slice(0, 35)
    const byKey = new Map(confirmed.map(feature => [feature.featureKey, feature.name]))
    sections.push(`【地图事实：${node.name}，节点 #${node.id}】已确认实体 ${confirmed.length}、关系 ${relations.length}；以下展示 ${shown.length} 项。原图未自动发送。`)
    for (const feature of shown) {
      const customCategory = data.categories.find(category => category.code === feature.kind)
      const kindLabel = customCategory ? `${customCategory.label}/${customCategory.baseKind}` : feature.kind
      sections.push(`- ${feature.name} [${kindLabel}; ${feature.featureKey}]：${feature.description.slice(0, 180)}（${feature.source === 'manual' ? '作者标注' : '作者审核的视觉候选'}；时段 ${feature.validFrom || feature.validTo ? `${feature.validFrom ?? '?'}—${feature.validTo ?? '?'}` : '未注明'}）`)
    }
    for (const relation of relations.slice(0, 20)) {
      sections.push(`- 关系 ${byKey.get(relation.fromFeatureKey) ?? relation.fromFeatureKey} ${relation.kind} ${byKey.get(relation.toFeatureKey) ?? relation.toFeatureKey}${relation.value == null ? '' : ` ${relation.value}${relation.unit ?? ''}`} [${relation.relationKey}]${relation.description ? `；依据 ${relation.description.slice(0, 130)}` : ''}；时段 ${relation.validFrom || relation.validTo ? `${relation.validFrom ?? '?'}—${relation.validTo ?? '?'}` : '未注明'}`)
    }
    if (confirmed.length > shown.length || relations.length > 20) sections.push('地图事实还有未展示条目；如需完整核查，请分页读取 mapFeatures / mapRelations。')
  }
  return sections.join('\n')
}
