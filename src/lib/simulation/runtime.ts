import { db } from '../db/schema'
import { transactionTablesForReferences } from '../registry/lifecycle'
import {
  EMPTY_SIMULATION_STATE,
  RUNTIME_ENTITY_KINDS,
  RUNTIME_LIFECYCLE_STATUSES,
  SIMULATION_EVENT_TYPES,
  SIMULATION_SESSION_KINDS,
  type RuntimeAttributes,
  type RuntimeEntityState,
  type RuntimeMemory,
  type SimulationCheckpoint,
  type SimulationEvent,
  type SimulationEventType,
  type SimulationRuntimeState,
  type SimulationSession,
  type SimulationSessionKind,
} from '../types'

type JsonObject = Record<string, unknown>

export interface CreateSimulationSessionInput {
  projectId: number
  worldGroupId?: number | null
  kind: SimulationSessionKind
  title: string
  seed?: string
  canonSnapshot?: unknown
  initialState?: SimulationRuntimeState
}

export interface DiceResolution {
  expression: string
  dice: number[]
  modifier: number
  total: number
  nonce: string
}

function isObject(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseJsonObject(value: string, label: string): JsonObject {
  try {
    const parsed = JSON.parse(value)
    if (!isObject(parsed)) throw new Error(`${label} 必须是 JSON 对象。`)
    return parsed
  } catch (error) {
    if (error instanceof Error && error.message.endsWith('必须是 JSON 对象。')) throw error
    throw new Error(`${label} 不是合法 JSON。`)
  }
}

function assertFiniteInteger(value: unknown, label: string, min: number, max: number): number {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} 必须是 ${min}..${max} 的整数。`)
  }
  return Number(value)
}

function assertRuntimeAttributes(value: unknown): RuntimeAttributes {
  if (!isObject(value)) throw new Error('运行时 attributes 必须是对象。')
  const result: RuntimeAttributes = {}
  for (const [key, raw] of Object.entries(value)) {
    if (!key.trim() || key.length > 80) throw new Error('运行时属性键无效。')
    if (raw !== null && !['string', 'number', 'boolean'].includes(typeof raw)) {
      throw new Error(`运行时属性 ${key} 只能是标量。`)
    }
    if (typeof raw === 'number' && !Number.isFinite(raw)) {
      throw new Error(`运行时属性 ${key} 不是有限数字。`)
    }
    result[key] = raw as RuntimeAttributes[string]
  }
  return result
}

function assertRuntimeEntity(value: unknown): RuntimeEntityState {
  if (!isObject(value)) throw new Error('运行时实体必须是对象。')
  const entityKey = String(value.entityKey ?? '').trim()
  const name = String(value.name ?? '').trim()
  const kind = String(value.kind ?? '')
  const lifecycleStatus = String(value.lifecycleStatus ?? '')
  if (!entityKey || entityKey.length > 160) throw new Error('运行时实体缺少有效 entityKey。')
  if (!name || name.length > 200) throw new Error('运行时实体缺少有效名称。')
  if (!RUNTIME_ENTITY_KINDS.includes(kind as RuntimeEntityState['kind'])) {
    throw new Error(`未知运行时实体类型: ${kind}`)
  }
  if (!RUNTIME_LIFECYCLE_STATUSES.includes(lifecycleStatus as RuntimeEntityState['lifecycleStatus'])) {
    throw new Error(`未知运行时生命周期: ${lifecycleStatus}`)
  }
  const sourceId = value.sourceId == null
    ? null
    : assertFiniteInteger(value.sourceId, 'sourceId', 1, Number.MAX_SAFE_INTEGER)
  const locationKey = value.locationKey == null ? null : String(value.locationKey).trim() || null
  return {
    entityKey,
    kind: kind as RuntimeEntityState['kind'],
    sourceId,
    name,
    locationKey,
    lifecycleStatus: lifecycleStatus as RuntimeEntityState['lifecycleStatus'],
    attributes: assertRuntimeAttributes(value.attributes ?? {}),
  }
}

function assertRuntimeMemory(value: unknown): RuntimeMemory {
  if (!isObject(value)) throw new Error('运行时记忆必须是对象。')
  const id = String(value.id ?? '').trim()
  const subjectKey = String(value.subjectKey ?? '').trim()
  const content = String(value.content ?? '').trim()
  const status = String(value.status ?? '')
  if (!id || id.length > 160) throw new Error('运行时记忆缺少有效 id。')
  if (!subjectKey || subjectKey.length > 160) throw new Error('运行时记忆缺少主体。')
  if (!content || content.length > 4_000) throw new Error('运行时记忆内容无效。')
  if (!['known', 'mistaken', 'forgotten'].includes(status)) {
    throw new Error(`未知运行时记忆状态: ${status}`)
  }
  return {
    id,
    subjectKey,
    content,
    status: status as RuntimeMemory['status'],
    sourceEventSequence: assertFiniteInteger(
      value.sourceEventSequence,
      'sourceEventSequence',
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  }
}

export function parseSimulationState(value: string | SimulationRuntimeState): SimulationRuntimeState {
  const parsed = typeof value === 'string' ? parseJsonObject(value, '运行时状态') : value
  if (parsed.version !== 1) throw new Error('不支持的运行时状态版本。')
  const clock = assertFiniteInteger(parsed.clock, '运行时时钟', 0, Number.MAX_SAFE_INTEGER)
  const lastSequence = assertFiniteInteger(
    parsed.lastSequence,
    'lastSequence',
    0,
    Number.MAX_SAFE_INTEGER,
  )
  if (!isObject(parsed.entities)) throw new Error('运行时 entities 必须是对象。')
  const entities: Record<string, RuntimeEntityState> = {}
  for (const [key, raw] of Object.entries(parsed.entities)) {
    const entity = assertRuntimeEntity(raw)
    if (entity.entityKey !== key) throw new Error(`实体索引与 entityKey 不一致: ${key}`)
    entities[key] = entity
  }
  if (!Array.isArray(parsed.memories)) throw new Error('运行时 memories 必须是数组。')
  if (!Array.isArray(parsed.narratives)) throw new Error('运行时 narratives 必须是数组。')
  const memories = parsed.memories.map(assertRuntimeMemory)
  const narratives = parsed.narratives.map(raw => {
    if (!isObject(raw)) throw new Error('运行时叙事记录必须是对象。')
    const text = String(raw.text ?? '').trim()
    if (!text || text.length > 20_000) throw new Error('运行时叙事文本无效。')
    return {
      eventSequence: assertFiniteInteger(
        raw.eventSequence,
        'narrative.eventSequence',
        1,
        Number.MAX_SAFE_INTEGER,
      ),
      text,
    }
  })
  return { version: 1, clock, entities, memories, narratives, lastSequence }
}

function cloneState(state: SimulationRuntimeState): SimulationRuntimeState {
  return structuredClone(state)
}

function parseEventPayload(event: SimulationEvent): JsonObject {
  if (!SIMULATION_EVENT_TYPES.includes(event.type)) {
    throw new Error(`未知模拟事件类型: ${event.type}`)
  }
  return parseJsonObject(event.payloadJson, `模拟事件 ${event.type}`)
}

export function applySimulationEvent(
  current: SimulationRuntimeState,
  event: SimulationEvent,
): SimulationRuntimeState {
  const state = cloneState(parseSimulationState(current))
  if (event.sequence !== state.lastSequence + 1) {
    throw new Error(`模拟事件序号不连续: 期望 ${state.lastSequence + 1}，收到 ${event.sequence}`)
  }
  const payload = parseEventPayload(event)
  switch (event.type) {
    case 'time.advanced': {
      const amount = assertFiniteInteger(payload.amount, '时间推进量', 1, 1_000_000_000)
      if (state.clock + amount > Number.MAX_SAFE_INTEGER) throw new Error('运行时时钟溢出。')
      state.clock += amount
      break
    }
    case 'entity.upserted': {
      const entity = assertRuntimeEntity(payload.entity)
      state.entities[entity.entityKey] = entity
      break
    }
    case 'entity.patched': {
      const entityKey = String(payload.entityKey ?? '').trim()
      const existing = state.entities[entityKey]
      if (!existing) throw new Error(`运行时实体不存在: ${entityKey}`)
      if (!isObject(payload.patch)) throw new Error('实体补丁必须是对象。')
      const allowed = new Set(['name', 'locationKey', 'lifecycleStatus', 'attributes'])
      for (const key of Object.keys(payload.patch)) {
        if (!allowed.has(key)) throw new Error(`实体补丁禁止字段: ${key}`)
      }
      state.entities[entityKey] = assertRuntimeEntity({
        ...existing,
        ...payload.patch,
        entityKey,
        kind: existing.kind,
        sourceId: existing.sourceId,
        attributes: payload.patch.attributes == null
          ? existing.attributes
          : { ...existing.attributes, ...assertRuntimeAttributes(payload.patch.attributes) },
      })
      break
    }
    case 'entity.removed': {
      const entityKey = String(payload.entityKey ?? '').trim()
      if (!state.entities[entityKey]) throw new Error(`运行时实体不存在: ${entityKey}`)
      delete state.entities[entityKey]
      break
    }
    case 'memory.recorded': {
      const memory = assertRuntimeMemory(payload.memory)
      if (memory.sourceEventSequence !== event.sequence) {
        throw new Error('运行时记忆必须引用自身事件序号。')
      }
      const index = state.memories.findIndex(row => row.id === memory.id)
      if (index >= 0) state.memories[index] = memory
      else state.memories.push(memory)
      break
    }
    case 'random.resolved': {
      assertDiceResolution(payload)
      break
    }
    case 'narrative.recorded': {
      const text = String(payload.text ?? '').trim()
      if (!text || text.length > 20_000) throw new Error('运行时叙事文本无效。')
      state.narratives.push({ eventSequence: event.sequence, text })
      break
    }
  }
  state.lastSequence = event.sequence
  return state
}

export function replaySimulationEvents(
  initialState: SimulationRuntimeState,
  events: readonly SimulationEvent[],
  throughSequence = Number.MAX_SAFE_INTEGER,
): SimulationRuntimeState {
  let state = cloneState(parseSimulationState(initialState))
  const ordered = [...events]
    .filter(event => event.sequence <= throughSequence)
    .sort((a, b) => a.sequence - b.sequence)
  for (const event of ordered) state = applySimulationEvent(state, event)
  return state
}

async function assertSessionScope(input: {
  projectId: number
  worldGroupId?: number | null
}): Promise<void> {
  if (!await db.projects.get(input.projectId)) throw new Error('模拟会话所属项目不存在。')
  if (input.worldGroupId != null) {
    const world = await db.worldGroups.get(input.worldGroupId)
    if (!world || world.projectId !== input.projectId) {
      throw new Error('模拟会话所属世界不存在或不属于当前项目。')
    }
  }
}

function defaultSeed(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

export async function createSimulationSession(
  input: CreateSimulationSessionInput,
): Promise<SimulationSession> {
  await assertSessionScope(input)
  if (!SIMULATION_SESSION_KINDS.includes(input.kind)) throw new Error('未知模拟会话类型。')
  const title = input.title.trim()
  if (!title || title.length > 200) throw new Error('模拟会话标题无效。')
  const initialState = parseSimulationState(input.initialState ?? EMPTY_SIMULATION_STATE)
  if (initialState.lastSequence !== 0) throw new Error('模拟会话初始状态 lastSequence 必须为 0。')
  const canonSnapshot = input.canonSnapshot ?? { version: 1, sources: [] }
  if (!isObject(canonSnapshot)) throw new Error('Canon 冻结快照必须是对象。')
  const now = Date.now()
  const session: SimulationSession = {
    projectId: input.projectId,
    worldGroupId: input.worldGroupId ?? null,
    kind: input.kind,
    title,
    status: 'active',
    rulesetVersion: 1,
    seed: input.seed?.trim() || defaultSeed(),
    canonSnapshotJson: JSON.stringify(canonSnapshot),
    initialStateJson: JSON.stringify(initialState),
    parentSessionId: null,
    parentThroughSequence: null,
    createdAt: now,
    updatedAt: now,
  }
  session.id = await db.simulationSessions.add(session) as number
  return session
}

async function readSessionEvents(
  session: SimulationSession,
  throughSequence = Number.MAX_SAFE_INTEGER,
): Promise<SimulationEvent[]> {
  const events = await db.simulationEvents.where('sessionId').equals(session.id!).toArray()
  for (const event of events) {
    if (
      event.projectId !== session.projectId
      || (event.worldGroupId ?? null) !== (session.worldGroupId ?? null)
    ) {
      throw new Error(`模拟事件 ${event.id ?? '?'} 作用域与会话不一致。`)
    }
  }
  return events.filter(event => event.sequence <= throughSequence)
}

export async function readSimulationState(
  sessionId: number,
  throughSequence = Number.MAX_SAFE_INTEGER,
): Promise<SimulationRuntimeState> {
  const session = await db.simulationSessions.get(sessionId)
  if (!session) throw new Error('模拟会话不存在。')
  const events = await readSessionEvents(session, throughSequence)
  return replaySimulationEvents(parseSimulationState(session.initialStateJson), events, throughSequence)
}

async function appendBuiltEvent(
  sessionId: number,
  build: (input: {
    session: SimulationSession
    state: SimulationRuntimeState
    sequence: number
  }) => Omit<SimulationEvent, 'id' | 'projectId' | 'worldGroupId' | 'sessionId' | 'sequence' | 'createdAt'>,
): Promise<SimulationEvent> {
  return db.transaction(
    'rw',
    db.simulationSessions,
    db.simulationEvents,
    async () => {
      const session = await db.simulationSessions.get(sessionId)
      if (!session) throw new Error('模拟会话不存在。')
      if (session.status !== 'active') throw new Error('只有 active 会话可以追加事件。')
      const events = await readSessionEvents(session)
      const state = replaySimulationEvents(parseSimulationState(session.initialStateJson), events)
      const sequence = state.lastSequence + 1
      const built = build({ session, state, sequence })
      const event: SimulationEvent = {
        projectId: session.projectId,
        worldGroupId: session.worldGroupId ?? null,
        sessionId,
        sequence,
        ...built,
        createdAt: Date.now(),
      }
      applySimulationEvent(state, event)
      event.id = await db.simulationEvents.add(event) as number
      await db.simulationSessions.update(sessionId, { updatedAt: event.createdAt })
      return event
    },
  )
}

export async function appendSimulationEvent(input: {
  sessionId: number
  type: SimulationEventType
  actorKey?: string | null
  targetKey?: string | null
  payload: unknown
}): Promise<SimulationEvent> {
  if (input.type === 'random.resolved') {
    throw new Error('随机判定只能通过 resolveSimulationDice() 生成。')
  }
  return appendBuiltEvent(input.sessionId, ({ sequence }) => {
    let payload = input.payload
    if (
      input.type === 'memory.recorded'
      && isObject(payload)
      && isObject(payload.memory)
    ) {
      payload = {
        ...payload,
        memory: {
          ...payload.memory,
          sourceEventSequence: sequence,
        },
      }
    }
    return {
      type: input.type,
      actorKey: input.actorKey ?? null,
      targetKey: input.targetKey ?? null,
      payloadJson: JSON.stringify(payload),
    }
  })
}

function hash32(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  hash ^= hash >>> 16
  return hash >>> 0
}

function deterministicDie(seed: string, sides: number): number {
  let value = hash32(seed)
  value += 0x6d2b79f5
  value = Math.imul(value ^ (value >>> 15), value | 1)
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
  return ((value ^ (value >>> 14)) >>> 0) % sides + 1
}

function parseDiceExpression(expression: string): {
  normalized: string
  count: number
  sides: number
  modifier: number
} {
  const match = expression.trim().toLowerCase().match(/^(\d{1,3})d(\d{1,4})(?:([+-])(\d{1,7}))?$/)
  if (!match) throw new Error('骰式必须是 NdM±K，例如 1d20+3。')
  const count = assertFiniteInteger(Number(match[1]), '骰子数量', 1, 100)
  const sides = assertFiniteInteger(Number(match[2]), '骰子面数', 2, 1_000)
  const rawModifier = match[4] ? Number(match[4]) : 0
  const modifier = match[3] === '-' ? -rawModifier : rawModifier
  if (Math.abs(modifier) > 1_000_000) throw new Error('骰式修正值过大。')
  const normalized = `${count}d${sides}${modifier > 0 ? `+${modifier}` : modifier < 0 ? modifier : ''}`
  return { normalized, count, sides, modifier }
}

function assertDiceResolution(value: unknown): DiceResolution {
  if (!isObject(value)) throw new Error('随机判定结果必须是对象。')
  const parsed = parseDiceExpression(String(value.expression ?? ''))
  if (!Array.isArray(value.dice) || value.dice.length !== parsed.count) {
    throw new Error('随机判定骰子数量与骰式不一致。')
  }
  const dice = value.dice.map(die => assertFiniteInteger(die, '骰子点数', 1, parsed.sides))
  const modifier = Number(value.modifier)
  const total = Number(value.total)
  if (modifier !== parsed.modifier || total !== dice.reduce((sum, die) => sum + die, modifier)) {
    throw new Error('随机判定合计与骰式不一致。')
  }
  return {
    expression: parsed.normalized,
    dice,
    modifier,
    total,
    nonce: String(value.nonce ?? ''),
  }
}

export async function resolveSimulationDice(input: {
  sessionId: number
  expression: string
  nonce?: string
  actorKey?: string | null
  targetKey?: string | null
}): Promise<SimulationEvent> {
  const parsed = parseDiceExpression(input.expression)
  const nonce = input.nonce?.trim() ?? ''
  if (nonce.length > 200) throw new Error('随机判定 nonce 过长。')
  return appendBuiltEvent(input.sessionId, ({ session, sequence }) => {
    const dice = Array.from({ length: parsed.count }, (_, index) => (
      deterministicDie(
        `${session.seed}\u0000${sequence}\u0000${parsed.normalized}\u0000${nonce}\u0000${index}`,
        parsed.sides,
      )
    ))
    const resolution: DiceResolution = {
      expression: parsed.normalized,
      dice,
      modifier: parsed.modifier,
      total: dice.reduce((sum, die) => sum + die, parsed.modifier),
      nonce,
    }
    return {
      type: 'random.resolved',
      actorKey: input.actorKey ?? null,
      targetKey: input.targetKey ?? null,
      payloadJson: JSON.stringify(resolution),
    }
  })
}

async function hashStateJson(stateJson: string): Promise<string> {
  const data = new TextEncoder().encode(stateJson)
  const digest = await crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

export async function createSimulationCheckpoint(input: {
  sessionId: number
  name: string
  throughSequence?: number
}): Promise<SimulationCheckpoint> {
  const session = await db.simulationSessions.get(input.sessionId)
  if (!session) throw new Error('模拟会话不存在。')
  const events = await readSessionEvents(session)
  const latest = events.reduce((max, event) => Math.max(max, event.sequence), 0)
  const throughSequence = input.throughSequence ?? latest
  if (!Number.isInteger(throughSequence) || throughSequence < 0 || throughSequence > latest) {
    throw new Error('检查点序号不在会话事件范围内。')
  }
  const state = replaySimulationEvents(
    parseSimulationState(session.initialStateJson),
    events,
    throughSequence,
  )
  const stateJson = JSON.stringify(state)
  const name = input.name.trim() || `检查点 ${throughSequence}`
  if (name.length > 200) throw new Error('检查点名称不能超过 200 个字符。')
  const checkpoint: SimulationCheckpoint = {
    projectId: session.projectId,
    worldGroupId: session.worldGroupId ?? null,
    sessionId: session.id!,
    throughSequence,
    name,
    stateJson,
    stateHash: await hashStateJson(stateJson),
    createdAt: Date.now(),
  }
  checkpoint.id = await db.simulationCheckpoints.add(checkpoint) as number
  return checkpoint
}

export async function verifySimulationCheckpoint(checkpointId: number): Promise<boolean> {
  const checkpoint = await db.simulationCheckpoints.get(checkpointId)
  if (!checkpoint) return false
  const session = await db.simulationSessions.get(checkpoint.sessionId)
  if (
    !session
    || session.projectId !== checkpoint.projectId
    || (session.worldGroupId ?? null) !== (checkpoint.worldGroupId ?? null)
  ) return false
  const replayed = await readSimulationState(checkpoint.sessionId, checkpoint.throughSequence)
  const stateJson = JSON.stringify(replayed)
  return stateJson === checkpoint.stateJson
    && await hashStateJson(stateJson) === checkpoint.stateHash
}

export async function branchSimulationSession(input: {
  parentSessionId: number
  throughSequence: number
  title: string
  seed?: string
}): Promise<SimulationSession> {
  const parent = await db.simulationSessions.get(input.parentSessionId)
  if (!parent) throw new Error('父模拟会话不存在。')
  const events = await readSessionEvents(parent)
  const latest = events.reduce((max, event) => Math.max(max, event.sequence), 0)
  if (
    !Number.isInteger(input.throughSequence)
    || input.throughSequence < 0
    || input.throughSequence > latest
  ) throw new Error('分支序号不在父会话事件范围内。')
  const state = replaySimulationEvents(
    parseSimulationState(parent.initialStateJson),
    events,
    input.throughSequence,
  )
  state.lastSequence = 0
  const child = await createSimulationSession({
    projectId: parent.projectId,
    worldGroupId: parent.worldGroupId ?? null,
    kind: parent.kind,
    title: input.title,
    seed: input.seed,
    canonSnapshot: parseJsonObject(parent.canonSnapshotJson, 'Canon 冻结快照'),
    initialState: state,
  })
  await db.simulationSessions.update(child.id!, {
    parentSessionId: parent.id!,
    parentThroughSequence: input.throughSequence,
  })
  return {
    ...child,
    parentSessionId: parent.id!,
    parentThroughSequence: input.throughSequence,
  }
}

export async function deleteSimulationSession(sessionId: number): Promise<void> {
  await db.transaction('rw', transactionTablesForReferences('simulationSessions'), async () => {
    await db.simulationEvents.where('sessionId').equals(sessionId).delete()
    await db.simulationCheckpoints.where('sessionId').equals(sessionId).delete()
    const children = await db.simulationSessions.where('parentSessionId').equals(sessionId).toArray()
    for (const child of children) {
      if (child.id != null) {
        await db.simulationSessions.update(child.id, {
          parentSessionId: null,
          parentThroughSequence: null,
        })
      }
    }
    await db.simulationSessions.delete(sessionId)
  })
}
