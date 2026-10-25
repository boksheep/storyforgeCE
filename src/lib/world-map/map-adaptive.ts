import type { MapScanTask } from '../types'
import type { MapTilePlan, MapVisionRegion } from './map-tiles'

type ScanMission = MapScanTask['mission']
type PlannedTask = Pick<MapScanTask, 'taskKey' | 'parentTaskKey' | 'round' | 'mission' | 'featurePage' | 'region' | 'reason'>

export interface AdaptiveScanPlan { tasks: PlannedTask[]; denseRegions: number; omittedTasks: number; truncated: boolean }

function childRegions(parent: MapVisionRegion, imageWidth: number, imageHeight: number): MapVisionRegion[] {
  const overlapX = Math.min(40 / imageWidth, parent.width * 0.06)
  const overlapY = Math.min(40 / imageHeight, parent.height * 0.06)
  const halfWidth = parent.width / 2
  const halfHeight = parent.height / 2
  return Array.from({ length: 4 }, (_, index) => {
    const column = index % 2
    const row = Math.floor(index / 2)
    const x = Math.max(0, parent.x + column * halfWidth - (column ? overlapX : 0))
    const y = Math.max(0, parent.y + row * halfHeight - (row ? overlapY : 0))
    const right = Math.min(1, parent.x + (column + 1) * halfWidth + (column ? 0 : overlapX))
    const bottom = Math.min(1, parent.y + (row + 1) * halfHeight + (row ? 0 : overlapY))
    return { x, y, width: right - x, height: bottom - y }
  })
}

/** Computes detail from the original pixels, including regions where a model returned no candidates. */
export async function scoreMapImageRegion(blob: Blob, region: MapVisionRegion): Promise<number> {
  const bitmap = await createImageBitmap(blob)
  try {
    return scoreMapImageBitmapRegion(bitmap, region)
  } finally { bitmap.close() }
}

/** Score pixels without taking ownership of the decoded source. */
export function scoreMapImageBitmapRegion(bitmap: ImageBitmap, region: MapVisionRegion): number {
  const canvas = document.createElement('canvas')
  canvas.width = 128; canvas.height = 128
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('浏览器无法分析地图细节')
  context.drawImage(bitmap, Math.floor(region.x * bitmap.width), Math.floor(region.y * bitmap.height),
    Math.max(1, Math.floor(region.width * bitmap.width)), Math.max(1, Math.floor(region.height * bitmap.height)),
    0, 0, 128, 128)
  const pixels = context.getImageData(0, 0, 128, 128).data
  let edges = 0
  let strongEdges = 0
  for (let y = 1; y < 128; y++) for (let x = 1; x < 128; x++) {
    const i = (y * 128 + x) * 4
    const left = i - 4
    const above = i - 128 * 4
    const delta = Math.abs(pixels[i] - pixels[left]) + Math.abs(pixels[i + 1] - pixels[left + 1])
      + Math.abs(pixels[i + 2] - pixels[left + 2])
      + Math.abs(pixels[i] - pixels[above]) + Math.abs(pixels[i + 1] - pixels[above + 1])
      + Math.abs(pixels[i + 2] - pixels[above + 2])
    if (delta > 40) edges++
    if (delta > 110) strongEdges++
  }
  return (edges + strongEdges) / (127 * 127 * 2)
}

/** Deterministic queue: overview first, then focused scans from sufficiently detailed source regions. */
export async function planAdaptiveMapScan(input: {
  tiles: MapTilePlan; width: number; height: number; featurePageCount: number;
  maxRounds: number; maxRequests: number; keyPrefix: string;
  scoreRegion: (region: MapVisionRegion) => Promise<number>
}): Promise<AdaptiveScanPlan> {
  const maxRounds = Math.max(0, Math.min(3, Math.floor(input.maxRounds)))
  const maxRequests = Math.max(1, Math.min(128, Math.floor(input.maxRequests)))
  const tasks: PlannedTask[] = []
  const queue: Array<{ id: string; region: MapVisionRegion; round: number; parentTaskKey: string }> = []
  if (input.tiles.tiles.length * input.featurePageCount > 256) throw new Error('首轮地图清单超过 256 个任务，请缩小范围')
  for (const tile of input.tiles.tiles) {
    for (let page = 0; page < input.featurePageCount; page++) {
      tasks.push({ taskKey: `${input.keyPrefix}:r0:${tile.id}:overview:p${page}`, round: 0,
        mission: 'overview', featurePage: page, region: tile.region, reason: '原图尺寸首轮全覆盖' })
    }
    queue.push({ id: tile.id, region: tile.core, round: 0,
      parentTaskKey: `${input.keyPrefix}:r0:${tile.id}:overview:p0` })
  }
  let denseRegions = 0
  let truncated = false
  while (queue.length && tasks.length < 256) {
    const parent = queue.shift()!
    if (parent.round >= maxRounds || parent.region.width * input.width < 260
      || parent.region.height * input.height < 260) continue
    const score = await input.scoreRegion(parent.region)
    // A blank or flat block should not trigger more calls. Dense regions are chosen from pixels,
    // independently of the number of candidates returned in the first pass.
    if (score < 0.045 + parent.round * 0.02) continue
    denseRegions++
    const children = childRegions(parent.region, input.width, input.height)
    for (let childIndex = 0; childIndex < children.length; childIndex++) {
      const region = children[childIndex]
      const id = `${parent.id}s${childIndex + 1}`
      const round = parent.round + 1
      const missions: ScanMission[] = round === 1
        ? ['cities', 'borders', 'railways', 'roads', 'waters'] : ['cities', 'borders', 'railways']
      for (const mission of missions) for (let page = 0; page < input.featurePageCount; page++) {
        if (tasks.length >= 256) { truncated = true; break }
        tasks.push({ taskKey: `${input.keyPrefix}:r${round}:${id}:${mission}:p${page}`,
          parentTaskKey: parent.parentTaskKey, round, mission, featurePage: page, region,
          reason: `原图细节评分 ${score.toFixed(2)}，第 ${round} 轮专项细分` })
      }
      const parentTaskKey = `${input.keyPrefix}:r${round}:${id}:cities:p0`
      if (tasks.some(task => task.taskKey === parentTaskKey)) queue.push({ id, region, round, parentTaskKey })
    }
  }
  if (queue.length && tasks.length >= 256) truncated = true
  const missionOrder: Record<ScanMission, number> = {
    overview: 0, cities: 1, borders: 2, railways: 3, roads: 4, waters: 5,
  }
  const priority = (task: PlannedTask) => {
    const path = task.taskKey.match(/s[1-4]/g)?.map(value => Number(value.slice(1))) ?? []
    const root = input.tiles.tiles.findIndex(tile => task.taskKey.includes(`:${tile.id}${path.length ? 's' : ':'}`))
    const stage = missionOrder[task.mission] > 3 ? 1 : 0
    return [task.round, stage, ...path, root, missionOrder[task.mission], task.featurePage]
  }
  tasks.sort((a, b) => {
    const left = priority(a); const right = priority(b)
    for (let index = 0; index < Math.max(left.length, right.length); index++) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0)
      if (delta) return delta
    }
    return a.taskKey.localeCompare(b.taskKey)
  })
  return { tasks, denseRegions, omittedTasks: Math.max(0, tasks.length - maxRequests), truncated }
}
