import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import {
  appendSimulationEvent,
  branchSimulationSession,
  createSimulationCheckpoint,
  createSimulationSession,
  deleteSimulationSession,
  readSimulationState,
  resolveSimulationDice,
} from '../lib/simulation/runtime'
import {
  EMPTY_SIMULATION_STATE,
  type SimulationCheckpoint,
  type SimulationEvent,
  type SimulationRuntimeState,
  type SimulationSession,
  type SimulationSessionKind,
} from '../lib/types'

interface SimulationRuntimeStore {
  projectId: number | null
  sessions: SimulationSession[]
  selectedSessionId: number | null
  events: SimulationEvent[]
  checkpoints: SimulationCheckpoint[]
  runtimeState: SimulationRuntimeState
  loading: boolean
  error: string
  load(projectId: number): Promise<void>
  select(sessionId: number | null): Promise<void>
  createSession(input: {
    projectId: number
    worldGroupId: number | null
    kind: SimulationSessionKind
    title: string
    seed?: string
  }): Promise<number>
  advanceTime(amount: number): Promise<void>
  recordNarrative(text: string): Promise<void>
  rollDice(expression: string): Promise<void>
  checkpoint(name: string): Promise<void>
  branch(title: string): Promise<number>
  remove(sessionId: number): Promise<void>
}

async function readSessionDetails(sessionId: number) {
  const [events, checkpoints, runtimeState] = await Promise.all([
    db.simulationEvents.where('sessionId').equals(sessionId).toArray(),
    db.simulationCheckpoints.where('sessionId').equals(sessionId).toArray(),
    readSimulationState(sessionId),
  ])
  events.sort((left, right) => left.sequence - right.sequence)
  checkpoints.sort((left, right) => right.createdAt - left.createdAt)
  return { events, checkpoints, runtimeState }
}

export const useSimulationRuntimeStore = create<SimulationRuntimeStore>((set, get) => {
  const refreshSelected = async () => {
    const sessionId = get().selectedSessionId
    if (sessionId == null) return
    const details = await readSessionDetails(sessionId)
    set(details)
  }

  return {
    projectId: null,
    sessions: [],
    selectedSessionId: null,
    events: [],
    checkpoints: [],
    runtimeState: structuredClone(EMPTY_SIMULATION_STATE),
    loading: false,
    error: '',

    load: async projectId => {
      set({ loading: true, error: '' })
      try {
        const sessions = await db.simulationSessions.where('projectId').equals(projectId).toArray()
        sessions.sort((left, right) => right.updatedAt - left.updatedAt)
        const current = get().projectId === projectId ? get().selectedSessionId : null
        const selectedSessionId = current != null && sessions.some(row => row.id === current)
          ? current
          : sessions[0]?.id ?? null
        set({ projectId, sessions, selectedSessionId, loading: false })
        if (selectedSessionId != null) await refreshSelected()
        else set({
          events: [],
          checkpoints: [],
          runtimeState: structuredClone(EMPTY_SIMULATION_STATE),
        })
      } catch (error) {
        set({ loading: false, error: error instanceof Error ? error.message : String(error) })
        log.error('SimulationRuntime', 'simulation.load.failed', '模拟会话列表读取失败', { projectId }, error)
      }
    },

    select: async sessionId => {
      set({ selectedSessionId: sessionId, error: '' })
      if (sessionId == null) {
        set({
          events: [],
          checkpoints: [],
          runtimeState: structuredClone(EMPTY_SIMULATION_STATE),
        })
        return
      }
      try {
        set(await readSessionDetails(sessionId))
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
        log.error('SimulationRuntime', 'simulation.select.failed', '模拟会话详情读取失败', { projectId: get().projectId, sessionId }, error)
      }
    },

    createSession: async input => {
      const session = await createSimulationSession({
        ...input,
        canonSnapshot: {
          version: 1,
          sources: [],
          note: 'SIM-1A 核心会话；结构化 Canon 选择将在 SIM-1B 接入。',
        },
      })
      await get().load(input.projectId)
      await get().select(session.id!)
      log.info('SimulationRuntime', 'simulation.session.created', '模拟会话已创建', { projectId: input.projectId, sessionId: session.id, worldGroupId: input.worldGroupId, kind: input.kind })
      return session.id!
    },

    advanceTime: async amount => {
      const sessionId = get().selectedSessionId
      if (sessionId == null) throw new Error('请先选择运行时会话。')
      await appendSimulationEvent({
        sessionId,
        type: 'time.advanced',
        payload: { amount },
      })
      await refreshSelected()
      log.info('SimulationRuntime', 'simulation.time.advanced', '模拟时间已推进', { projectId: get().projectId, sessionId, amount })
    },

    recordNarrative: async text => {
      const sessionId = get().selectedSessionId
      if (sessionId == null) throw new Error('请先选择运行时会话。')
      await appendSimulationEvent({
        sessionId,
        type: 'narrative.recorded',
        payload: { text },
      })
      await refreshSelected()
      log.info('SimulationRuntime', 'simulation.narrative.recorded', '模拟叙事事件已记录', { projectId: get().projectId, sessionId, textChars: text.length })
    },

    rollDice: async expression => {
      const sessionId = get().selectedSessionId
      if (sessionId == null) throw new Error('请先选择运行时会话。')
      await resolveSimulationDice({ sessionId, expression })
      await refreshSelected()
      log.info('SimulationRuntime', 'simulation.dice.rolled', '模拟掷骰已完成', { projectId: get().projectId, sessionId, expressionLength: expression.length })
    },

    checkpoint: async name => {
      const sessionId = get().selectedSessionId
      if (sessionId == null) throw new Error('请先选择运行时会话。')
      await createSimulationCheckpoint({ sessionId, name })
      await refreshSelected()
      log.info('SimulationRuntime', 'simulation.checkpoint.created', '模拟检查点已创建', { projectId: get().projectId, sessionId, nameLength: name.length })
    },

    branch: async title => {
      const sessionId = get().selectedSessionId
      if (sessionId == null) throw new Error('请先选择运行时会话。')
      const parent = get().sessions.find(row => row.id === sessionId)
      if (!parent) throw new Error('当前运行时会话不存在。')
      const throughSequence = get().runtimeState.lastSequence
      const child = await branchSimulationSession({
        parentSessionId: sessionId,
        throughSequence,
        title,
      })
      await get().load(parent.projectId)
      await get().select(child.id!)
      log.info('SimulationRuntime', 'simulation.session.branched', '模拟会话已分支', { projectId: parent.projectId, parentSessionId: sessionId, sessionId: child.id, throughSequence })
      return child.id!
    },

    remove: async sessionId => {
      const projectId = get().projectId
      await deleteSimulationSession(sessionId)
      log.info('SimulationRuntime', 'simulation.session.deleted', '模拟会话删除已执行', { projectId, sessionId })
      if (projectId != null) await get().load(projectId)
    },
  }
})
