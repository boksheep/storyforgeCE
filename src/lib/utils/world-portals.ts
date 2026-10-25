import type { WorldPortal } from '../types'

function isWorldPortal(value: unknown): value is WorldPortal {
  if (!value || typeof value !== 'object') return false
  const portal = value as Partial<WorldPortal>
  return (
    typeof portal.name === 'string' &&
    typeof portal.targetWorldId === 'number' &&
    Number.isFinite(portal.targetWorldId) &&
    typeof portal.x === 'number' &&
    Number.isFinite(portal.x) &&
    typeof portal.y === 'number' &&
    Number.isFinite(portal.y)
  )
}

export function parseWorldPortals(json?: string | null): WorldPortal[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter(isWorldPortal) : []
  } catch {
    return []
  }
}

export function stringifyWorldPortals(portals: WorldPortal[]): string | undefined {
  return portals.length ? JSON.stringify(portals) : undefined
}

export function remapWorldPortalTargets(
  portalsJSON: string | undefined,
  remapTargetId: (targetWorldId: number) => number | null | undefined,
): string | undefined {
  const remapped: WorldPortal[] = []
  for (const portal of parseWorldPortals(portalsJSON)) {
    const targetWorldId = remapTargetId(portal.targetWorldId)
    if (targetWorldId == null) continue
    remapped.push({ ...portal, targetWorldId })
  }
  return stringifyWorldPortals(remapped)
}
