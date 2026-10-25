import type { Chapter, ImportantLocation, OutlineNode } from '../types'
import { db } from '../db/schema'

/** Single source of truth for location visibility in creative and agent reads. */
export function locationInWorld(location: ImportantLocation, multiWorld: boolean, worldGroupId: number | null): boolean {
  if (!multiWorld) return true
  if (location.scope === 'shared') return true
  if (location.scope === 'world') return location.worldGroupId != null && location.worldGroupId === worldGroupId
  // Legacy and imported unassigned records are reviewable in the UI, not AI Canon.
  return false
}

export async function chaptersInWorld(projectId: number, chapters: Chapter[], worldGroupId: number | null): Promise<Chapter[]> {
  const nodes = await db.outlineNodes.where('projectId').equals(projectId).toArray()
  const byId = new Map(nodes.filter(node => node.id != null).map(node => [node.id!, node]))
  const scopeOf = (node: OutlineNode | undefined): number | null => {
    const seen = new Set<number>()
    while (node) {
      if (node.worldGroupId != null) return node.worldGroupId
      if (node.parentId == null || seen.has(node.parentId)) return null
      seen.add(node.parentId)
      node = byId.get(node.parentId)
    }
    return null
  }
  return chapters.filter(chapter => scopeOf(byId.get(chapter.outlineNodeId)) === worldGroupId)
}
