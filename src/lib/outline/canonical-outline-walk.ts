import type { OutlineNode } from '../types'

export type OutlineWalkAnomalyKind =
  | 'orphan-outline-node'
  | 'outline-cycle'
  | 'duplicate-sibling-order'

export interface OutlineWalkAnomaly {
  kind: OutlineWalkAnomalyKind
  detail: string
}

export interface CanonicalOutlineChapter {
  outlineNode: OutlineNode
  worldGroupId: number | null
  ordinal: number
}

export interface CanonicalOutlineWalk {
  chapters: CanonicalOutlineChapter[]
  anomalies: OutlineWalkAnomaly[]
  nodeById: Map<number, OutlineNode>
}

export function byOutlineOrderThenId(a: OutlineNode, b: OutlineNode): number {
  return a.order - b.order || (a.id ?? Number.MAX_SAFE_INTEGER) - (b.id ?? Number.MAX_SAFE_INTEGER)
}

/**
 * Traverse the outline tree in the single canonical chapter order used by
 * continuity, display numbering, extraction ranges, and future outline tools.
 */
export function walkOutlineChaptersInCanonicalOrder(outlineNodes: OutlineNode[]): CanonicalOutlineWalk {
  const anomalies: OutlineWalkAnomaly[] = []
  const nodes = [...outlineNodes].sort(byOutlineOrderThenId)
  const nodeById = new Map(nodes.filter(node => node.id != null).map(node => [node.id!, node]))
  const children = new Map<number | null, OutlineNode[]>()

  for (const node of nodes) {
    const parentId = node.parentId ?? null
    if (parentId != null && !nodeById.has(parentId)) {
      anomalies.push({ kind: 'orphan-outline-node', detail: `outline ${node.id ?? '?'} parent ${parentId} missing` })
    }
    const effectiveParent = parentId != null && nodeById.has(parentId) ? parentId : null
    const list = children.get(effectiveParent) ?? []
    list.push(node)
    children.set(effectiveParent, list)
  }

  for (const [parentId, siblings] of children) {
    siblings.sort(byOutlineOrderThenId)
    const seenOrders = new Set<number>()
    for (const sibling of siblings) {
      if (seenOrders.has(sibling.order)) {
        anomalies.push({
          kind: 'duplicate-sibling-order',
          detail: `parent ${parentId ?? 'root'} has duplicate order ${sibling.order}`,
        })
      }
      seenOrders.add(sibling.order)
    }
  }

  const chapters: CanonicalOutlineChapter[] = []
  const visited = new Set<number>()
  const visiting = new Set<number>()
  let ordinal = 0

  const visit = (node: OutlineNode, inheritedWorldGroupId: number | null) => {
    if (node.id == null) return
    if (visiting.has(node.id)) {
      anomalies.push({ kind: 'outline-cycle', detail: `cycle reaches outline ${node.id}` })
      return
    }
    if (visited.has(node.id)) return

    visiting.add(node.id)
    const worldGroupId = node.worldGroupId ?? inheritedWorldGroupId
    if (node.type === 'chapter') {
      ordinal += 1
      chapters.push({ outlineNode: node, worldGroupId, ordinal })
    }
    for (const child of children.get(node.id) ?? []) visit(child, worldGroupId)
    visiting.delete(node.id)
    visited.add(node.id)
  }

  for (const root of children.get(null) ?? []) visit(root, root.worldGroupId ?? null)
  for (const node of nodes) if (node.id != null && !visited.has(node.id)) visit(node, node.worldGroupId ?? null)

  return { chapters, anomalies, nodeById }
}
