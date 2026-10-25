/** WORLD-1: deterministic image-space tiling for auditable map vision runs. */
export interface MapVisionRegion { x: number; y: number; width: number; height: number }
export interface MapVisionTile {
  id: string
  row: number
  column: number
  core: MapVisionRegion
  region: MapVisionRegion
}

export interface MapTilePlan { rows: number; columns: number; tiles: MapVisionTile[]; version: 1 }

/** Keep each submitted crop near the vision client's 1600px limit, with overlap at borders. */
export function planMapTiles(width: number, height: number, maxSide = 1400, maxTiles = 96): MapTilePlan {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('地图尺寸无效')
  }
  const columns = Math.ceil(width / maxSide)
  const rows = Math.ceil(height / maxSide)
  if (columns * rows > maxTiles) throw new Error(`地图需要 ${columns * rows} 个分块，超出 ${maxTiles} 块预算；请手动框选区域`)
  const overlapX = Math.min(96 / width, 0.08)
  const overlapY = Math.min(96 / height, 0.08)
  const tiles: MapVisionTile[] = []
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const left = column / columns
      const right = (column + 1) / columns
      const top = row / rows
      const bottom = (row + 1) / rows
      const x = Math.max(0, left - overlapX)
      const y = Math.max(0, top - overlapY)
      tiles.push({ id: `r${row + 1}c${column + 1}`, row, column,
        core: { x: left, y: top, width: right - left, height: bottom - top },
        region: { x, y, width: Math.min(1, right + overlapX) - x, height: Math.min(1, bottom + overlapY) - y } })
    }
  }
  return { rows, columns, tiles, version: 1 }
}
