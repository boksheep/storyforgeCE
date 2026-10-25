export const SIMULATION_SESSION_KINDS = [
  'sandbox',
  'npc-evolution',
  'ttrpg',
  'chatgame',
] as const
export type SimulationSessionKind = typeof SIMULATION_SESSION_KINDS[number]

export const SIMULATION_SESSION_STATUSES = ['active', 'paused', 'archived'] as const
export type SimulationSessionStatus = typeof SIMULATION_SESSION_STATUSES[number]

export const RUNTIME_ENTITY_KINDS = [
  'character',
  'npc',
  'player',
  'location',
  'item',
  'faction',
] as const
export type RuntimeEntityKind = typeof RUNTIME_ENTITY_KINDS[number]

export const RUNTIME_LIFECYCLE_STATUSES = [
  'active',
  'inactive',
  'dead',
  'destroyed',
] as const
export type RuntimeLifecycleStatus = typeof RUNTIME_LIFECYCLE_STATUSES[number]

export type RuntimeScalar = string | number | boolean | null
export type RuntimeAttributes = Record<string, RuntimeScalar>

export interface RuntimeEntityState {
  entityKey: string
  kind: RuntimeEntityKind
  sourceId?: number | null
  name: string
  locationKey?: string | null
  lifecycleStatus: RuntimeLifecycleStatus
  attributes: RuntimeAttributes
}

export type RuntimeMemoryStatus = 'known' | 'mistaken' | 'forgotten'

export interface RuntimeMemory {
  id: string
  subjectKey: string
  status: RuntimeMemoryStatus
  content: string
  sourceEventSequence: number
}

export interface SimulationRuntimeState {
  version: 1
  clock: number
  entities: Record<string, RuntimeEntityState>
  memories: RuntimeMemory[]
  narratives: Array<{
    eventSequence: number
    text: string
  }>
  lastSequence: number
}

export interface SimulationSession {
  id?: number
  projectId: number
  worldGroupId?: number | null
  kind: SimulationSessionKind
  title: string
  status: SimulationSessionStatus
  rulesetVersion: number
  seed: string
  canonSnapshotJson: string
  initialStateJson: string
  parentSessionId?: number | null
  parentThroughSequence?: number | null
  createdAt: number
  updatedAt: number
}

export const SIMULATION_EVENT_TYPES = [
  'time.advanced',
  'entity.upserted',
  'entity.patched',
  'entity.removed',
  'memory.recorded',
  'random.resolved',
  'narrative.recorded',
] as const
export type SimulationEventType = typeof SIMULATION_EVENT_TYPES[number]

export interface SimulationEvent {
  id?: number
  projectId: number
  worldGroupId?: number | null
  sessionId: number
  sequence: number
  type: SimulationEventType
  actorKey?: string | null
  targetKey?: string | null
  payloadJson: string
  createdAt: number
}

export interface SimulationCheckpoint {
  id?: number
  projectId: number
  worldGroupId?: number | null
  sessionId: number
  throughSequence: number
  name: string
  stateJson: string
  stateHash: string
  createdAt: number
}

export const EMPTY_SIMULATION_STATE: SimulationRuntimeState = {
  version: 1,
  clock: 0,
  entities: {},
  memories: [],
  narratives: [],
  lastSequence: 0,
}
