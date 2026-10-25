import type { AssembleContextResult } from '../registry/types'

export type OutlineGenerationRequest =
  | { kind: 'volumes' }
  | { kind: 'chapters'; volumeId: number }
  | { kind: 'chapters-optimize'; volumeId: number }
  | { kind: 'single-volume'; volumeId: number }
  | { kind: 'single-chapter'; chapterId: number }

export type OutlinePlanningRequest = OutlineGenerationRequest | { kind: 'all-chapters' }

export function outlineNegotiationTitle(request: OutlinePlanningRequest): string {
  if (request.kind === 'single-chapter') return '生成本章章纲'
  if (request.kind === 'chapters') return '生成本卷各章章纲'
  if (request.kind === 'chapters-optimize') return '优化本卷各章章纲'
  if (request.kind === 'single-volume') return '生成本卷卷纲'
  if (request.kind === 'all-chapters') return '生成全书各卷章纲'
  return '生成全书卷级大纲'
}

export interface PreparedGenerationContext {
  operation: string
  assembled: AssembleContextResult
}

export function outlineGenerationModuleKey(
  request: OutlineGenerationRequest,
): 'outline.volume' | 'outline.chapter' {
  return request.kind === 'volumes' || request.kind === 'single-volume'
    ? 'outline.volume'
    : 'outline.chapter'
}

export function encodeGenerationOperation(request: OutlineGenerationRequest): string {
  if (request.kind === 'volumes') return 'outline.volume:batch'
  if (request.kind === 'chapters') return `outline.chapter:batch:${request.volumeId}`
  if (request.kind === 'chapters-optimize') return `outline.chapter:optimize:${request.volumeId}`
  if (request.kind === 'single-volume') return `outline.volume:single:${request.volumeId}`
  return `outline.chapter:single:${request.chapterId}`
}

export function decodeGenerationOperation(operation: string | null): OutlineGenerationRequest | null {
  if (!operation) return null
  if (operation === 'outline.volume' || operation === 'outline.volume:batch') return { kind: 'volumes' }
  const parts = operation.split(':')
  const id = Number(parts[2])
  if (!Number.isFinite(id)) return null
  if (parts[0] === 'outline.volume' && parts[1] === 'single') return { kind: 'single-volume', volumeId: id }
  if (parts[0] === 'outline.chapter' && parts[1] === 'batch') return { kind: 'chapters', volumeId: id }
  if (parts[0] === 'outline.chapter' && parts[1] === 'optimize') return { kind: 'chapters-optimize', volumeId: id }
  if (parts[0] === 'outline.chapter' && parts[1] === 'single') return { kind: 'single-chapter', chapterId: id }
  return null
}
