import type { RelationGraphLink, RelationGraphNode } from './relation-graph-model'

export type PositionedRelationNode = RelationGraphNode & { x: number; y: number }
export type PositionedRelationLink = RelationGraphLink & {
  source: PositionedRelationNode
  target: PositionedRelationNode
}

export interface GraphLabelBox {
  id: string
  kind: 'node' | 'link'
  lines: string[]
  x: number
  y: number
  width: number
  height: number
  color: string
  related: boolean
}

function overlapArea(a: Pick<GraphLabelBox, 'x' | 'y' | 'width' | 'height'>,
  b: Pick<GraphLabelBox, 'x' | 'y' | 'width' | 'height'>): number {
  return Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
    * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
}

function wrapName(name: string): string[] {
  const chars = Array.from(name)
  if (chars.length <= 14) return [name]
  const lines: string[] = []
  for (let index = 0; index < chars.length && lines.length < 3; index += 14) {
    lines.push(chars.slice(index, index + 14).join(''))
  }
  if (chars.length > 42) lines[2] += '…'
  return lines
}

function boxFor(lines: string[], scale: number, measure: (text: string) => number) {
  return {
    width: Math.max(...lines.map(measure)) + 14 / scale,
    height: lines.length * 18 / scale + 5 / scale,
  }
}

function leastOverlap<T extends { x: number; y: number; width: number; height: number }>(
  candidates: T[], nearby: (box: T) => GraphLabelBox[],
): { box: T; ratio: number } {
  let best = candidates[0]
  let bestScore = Number.POSITIVE_INFINITY
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index]
    const area = nearby(candidate).reduce((total, other) => total + overlapArea(candidate, other), 0)
    const score = area + index * 0.01
    if (score < bestScore) { best = candidate; bestScore = score }
  }
  return { box: best, ratio: bestScore / Math.max(1, best.width * best.height) }
}

/** 在图坐标中放置文字；高密度时仅跳过确实无法避让的边标签。 */
export function layoutRelationLabels(
  nodes: PositionedRelationNode[],
  links: PositionedRelationLink[],
  scale: number,
  measure: (text: string) => number,
  activeId?: string | null,
  highlightedLinkId?: number | null,
): GraphLabelBox[] {
  if (!Number.isFinite(scale) || scale <= 0) return []
  const visible = nodes.filter(node => Number.isFinite(node.x) && Number.isFinite(node.y))
  if (!visible.length) return []
  const centerX = visible.reduce((sum, node) => sum + node.x, 0) / visible.length
  const centerY = visible.reduce((sum, node) => sum + node.y, 0) / visible.length
  const degree = new Map<string, number>()
  for (const link of links) {
    degree.set(link.source.id, (degree.get(link.source.id) ?? 0) + 1)
    degree.set(link.target.id, (degree.get(link.target.id) ?? 0) + 1)
  }
  const grid = new Map<string, GraphLabelBox[]>()
  const cellSize = 80 / scale
  const cellsOf = (box: Pick<GraphLabelBox, 'x' | 'y' | 'width' | 'height'>) => {
    const cells: string[] = []
    for (let x = Math.floor(box.x / cellSize); x <= Math.floor((box.x + box.width) / cellSize); x++) {
      for (let y = Math.floor(box.y / cellSize); y <= Math.floor((box.y + box.height) / cellSize); y++) cells.push(`${x}:${y}`)
    }
    return cells
  }
  const addOccupied = (box: GraphLabelBox) => {
    for (const cell of cellsOf(box)) grid.set(cell, [...(grid.get(cell) ?? []), box])
  }
  const nearby = (box: Pick<GraphLabelBox, 'x' | 'y' | 'width' | 'height'>) =>
    [...new Set(cellsOf(box).flatMap(cell => grid.get(cell) ?? []))]
  visible.map((node): GraphLabelBox => {
    const radius = (node.kind === 'group' ? 11 : 10) / scale
    return { id: node.id, kind: 'node', lines: [], x: node.x - radius, y: node.y - radius,
      width: radius * 2, height: radius * 2, color: node.color, related: false }
  }).forEach(addOccupied)
  const labels: GraphLabelBox[] = []
  const orderedNodes = [...visible].sort((a, b) => (degree.get(b.id) ?? 0) - (degree.get(a.id) ?? 0))
  for (const node of orderedNodes) {
    const lines = wrapName(node.name)
    const size = boxFor(lines, scale, measure)
    const gap = (node.kind === 'group' ? 17 : 16) / scale
    const right = { x: node.x + gap, y: node.y - size.height / 2, ...size }
    const left = { x: node.x - gap - size.width, y: node.y - size.height / 2, ...size }
    const below = { x: node.x - size.width / 2, y: node.y + gap, ...size }
    const above = { x: node.x - size.width / 2, y: node.y - gap - size.height, ...size }
    const dx = node.x - centerX
    const dy = node.y - centerY
    const candidates = Math.abs(dx) > Math.abs(dy)
      ? dx >= 0 ? [right, below, above, left] : [left, below, above, right]
      : dy >= 0 ? [below, right, left, above] : [above, right, left, below]
    const { box } = leastOverlap(candidates, nearby)
    const placed: GraphLabelBox = { id: node.id, kind: 'node', lines, ...box,
      color: node.color, related: !activeId || activeId === node.id
        || links.some(link => (link.source.id === activeId && link.target.id === node.id)
          || (link.target.id === activeId && link.source.id === node.id)) }
    labels.push(placed)
    addOccupied(placed)
  }

  for (const [index, link] of links.entries()) {
    // 多人关系已经由菱形节点标名；每条辐射线不再重复同一文字。
    if (link.source.kind === 'group' || link.target.kind === 'group') continue
    if (![link.source.x, link.source.y, link.target.x, link.target.y].every(Number.isFinite)) continue
    const distinct = [...new Set(link.labels.filter(Boolean))]
    if (!distinct.length) continue
    const lines = distinct.slice(0, 3).flatMap(wrapName)
    if (distinct.length > 3) lines.push(`另有 ${distinct.length - 3} 条`)
    const size = boxFor(lines, scale, measure)
    const dx = link.target.x - link.source.x
    const dy = link.target.y - link.source.y
    const length = Math.hypot(dx, dy) || 1
    const nx = -dy / length
    const ny = dx / length
    const candidates = [0.5, 0.36, 0.64, 0.25, 0.75].flatMap(fraction =>
      [16, -16, 32, -32].map(offset => ({
        x: link.source.x + dx * fraction + nx * offset / scale - size.width / 2,
        y: link.source.y + dy * fraction + ny * offset / scale - size.height / 2,
        ...size,
      })))
    const { box, ratio } = leastOverlap(candidates, nearby)
    const related = !activeId || link.source.id === activeId || link.target.id === activeId
    const highlighted = highlightedLinkId != null && link.relationIds.includes(highlightedLinkId)
    if (ratio > 0.4 && !highlighted && !(activeId && related)) continue
    const placed: GraphLabelBox = { id: `link:${index}`, kind: 'link', lines, ...box,
      color: link.color, related: related || highlighted }
    labels.push(placed)
    addOccupied(placed)
  }
  return labels
}
