export interface TimelineCoordinateDomain {
  min: number
  max: number
  leftPadding: number
  rightPadding: number
  canvasWidth: number
}

export function timelineXFor(value: number, domain: TimelineCoordinateDomain, zoom: number, offset: number): number {
  const span = Math.max(1, domain.max - domain.min)
  const plotWidth = domain.canvasWidth - domain.leftPadding - domain.rightPadding
  return (domain.leftPadding + ((value - domain.min) / span) * plotWidth) * zoom + offset
}

export function timelineValueAtX(x: number, domain: TimelineCoordinateDomain, zoom: number, offset: number): number {
  const span = Math.max(1, domain.max - domain.min)
  const plotWidth = domain.canvasWidth - domain.leftPadding - domain.rightPadding
  return domain.min + (((x - offset) / zoom - domain.leftPadding) / plotWidth) * span
}

export function visibleTimelineStart(leftEdge: number, domain: TimelineCoordinateDomain, zoom: number, offset: number): number {
  return timelineValueAtX(leftEdge, domain, zoom, offset)
}
