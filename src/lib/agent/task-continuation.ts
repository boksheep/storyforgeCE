import { parseAgentEventPayload, type AgentEvent } from '../types'
import type { MasterAgentPlan, MasterAgentTask } from './orchestrator'
import type { ReadOnlyAgentCheckpoint } from './runner'

export type MasterTaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'awaiting-confirmation' | 'adopted' | 'rejected'

export interface MasterTaskCheckpoint {
  id: string
  agentId: MasterAgentTask['agentId']
  instruction: string
  dependsOn: string[]
  status: MasterTaskStatus
  candidateEventId?: number
  candidateSequence?: number
  output?: string
  error?: string
}

export interface MasterTaskRunSnapshot {
  version: 1
  runId: string
  userEventSequence: number
  originalRequest: string
  plan: MasterAgentPlan
  tasks: MasterTaskCheckpoint[]
  nativeCheckpoint?: ReadOnlyAgentCheckpoint
}

export interface TaskContinuation {
  originalRequest: string
  request: string
  completedTaskIds: string[]
  unfinishedTaskIds: string[]
  snapshot: MasterTaskRunSnapshot
  /**
   * `resume` 继续未完成任务；`summarize` 表示任务都已结算但从未给出答复，
   * 继续动作只需汇总已完成结果，不能再重跑领域任务（否则会重复生成候选）。
   */
  kind: 'resume' | 'summarize'
}

const FAILURE_PREFIX = '本轮没有完成：'

function runIdFor(user: AgentEvent): string {
  const payload = parseAgentEventPayload<{ runId?: string }>(user, {})
  return payload.runId?.trim() || `legacy-${user.sequence}`
}

/** 从最近一轮事件重建终态；完成、待确认候选和失败恢复严格区分。 */
export function deriveTaskContinuation(events: readonly AgentEvent[]): TaskContinuation | null {
  const user = [...events].reverse().find(event => event.kind === 'message' && event.role === 'user')
  if (!user?.content.trim()) return null
  const originalRequest = parseAgentEventPayload<{ originalRequest?: string }>(user, {}).originalRequest?.trim() || user.content
  const turn = events.filter(event => event.sequence > user.sequence)
  const planEvent = [...turn].reverse().find(event => event.kind === 'plan')
  const planPayload = planEvent ? parseAgentEventPayload<Partial<MasterAgentPlan> & { executionMode?: string }>(planEvent, {}) : {}
  const tasks = Array.isArray(planPayload.tasks)
    ? planPayload.tasks.filter((task): task is MasterAgentTask => Boolean(task && typeof task.id === 'string'))
    : []
  const stateByTask = new Map<string, { status: MasterTaskStatus; error?: string }>()
  for (const event of turn) {
    if (event.kind !== 'task') continue
    const payload = parseAgentEventPayload<{ taskId?: string; status?: MasterTaskStatus; error?: string }>(event, {})
    if (payload.taskId) stateByTask.set(payload.taskId, { status: payload.status ?? 'pending', error: payload.error })
  }
  const candidates = new Map<string, { eventId?: number; sequence: number; output: string }>()
  for (const event of turn) {
    if (event.kind !== 'candidate') continue
    const payload = parseAgentEventPayload<{ taskId?: string }>(event, {})
    if (payload.taskId) candidates.set(payload.taskId, { eventId: event.id, sequence: event.sequence, output: event.content })
  }
  const confirmations = new Map<string, MasterTaskStatus>()
  for (const event of turn) {
    if (event.kind !== 'confirmation') continue
    const payload = parseAgentEventPayload<{ candidateEventId?: number; candidateSequence?: number; decision?: string }>(event, {})
    const match = [...candidates.entries()].find(([, candidate]) => candidate.eventId === payload.candidateEventId || candidate.sequence === payload.candidateSequence)
    if (match && (payload.decision === 'adopted' || payload.decision === 'rejected')) confirmations.set(match[0], payload.decision)
  }
  const runId = runIdFor(user)
  const nativeRun = !tasks.length && planPayload.executionMode === 'agent-first'
  const nativeCheckpointEvent = nativeRun ? [...turn].reverse().find(event => {
    if (event.kind !== 'task') return false
    const payload = parseAgentEventPayload<{ taskId?: string; agentId?: string; runId?: string; checkpoint?: unknown }>(event, {})
    return payload.taskId === 'native-checkpoint' && payload.agentId === 'project-native'
      && payload.runId === runId && Boolean(payload.checkpoint)
  }) : undefined
  const nativeCheckpoint = nativeCheckpointEvent
    ? parseAgentEventPayload<{ checkpoint?: ReadOnlyAgentCheckpoint }>(nativeCheckpointEvent, {}).checkpoint
    : undefined
  const checkpoints = tasks.map(task => {
    const candidate = candidates.get(task.id)
    const confirmation = confirmations.get(task.id)
    const recorded = stateByTask.get(task.id)
    const status: MasterTaskStatus = confirmation
      ?? (candidate ? 'awaiting-confirmation' : recorded?.status === 'completed' ? 'pending' : recorded?.status ?? 'pending')
    return { id: task.id, agentId: task.agentId, instruction: task.instruction, dependsOn: task.dependsOn, status, candidateEventId: candidate?.eventId, candidateSequence: candidate?.sequence, output: candidate?.output, error: recorded?.error }
  })
  const assistantMessages = turn.filter(event => event.kind === 'message' && event.role === 'assistant')
  const latestError = [...turn].reverse().find(event => event.kind === 'error')
  const latestAssistant = assistantMessages[assistantMessages.length - 1]
  const SETTLED: MasterTaskStatus[] = ['awaiting-confirmation', 'adopted', 'rejected', 'completed']
  // checkpoint.status 把「只有 completed 事件、没有候选」映射成 pending：这类任务没有
  // 可采纳产出，必须重跑，不能算已完成（既有反例见 R-AGENT2-task-continuation）。
  const completedTaskIds = checkpoints.filter(task => SETTLED.includes(task.status)).map(task => task.id)
  const unfinishedTaskIds = checkpoints.filter(task => !SETTLED.includes(task.status)).map(task => task.id)
  const hasPendingCandidate = checkpoints.some(task => task.status === 'awaiting-confirmation')
  const allTasksSettled = tasks.length > 0 && unfinishedTaskIds.length === 0
  const hasSuccessfulAnswer = Boolean(latestAssistant && !latestAssistant.content.startsWith(FAILURE_PREFIX) && (!latestError || latestAssistant.sequence > latestError.sequence))
  const hasFailure = Boolean(latestError && (!latestAssistant || latestError.sequence > latestAssistant.sequence || latestAssistant.content.startsWith(FAILURE_PREFIX)))
  // 任务全部结算且已有候选时，作者的下一步是审核候选，不是继续执行。
  const settledWithCandidate = allTasksSettled && hasPendingCandidate
  // 任务全部结算却从未给出答复（作者已逐条处理完候选）：仍然给一个汇总入口。
  const needsSummary = allTasksSettled && !hasSuccessfulAnswer && !hasPendingCandidate
  if (hasSuccessfulAnswer || settledWithCandidate || (!hasFailure && hasPendingCandidate)
    || (!tasks.length && turn.some(event => event.kind === 'candidate'))) return null
  if (!tasks.length) {
    // 中断在规划前：保留一个最小恢复计划，继续时重新规划。
    const emptyPlan: MasterAgentPlan = { summary: originalRequest, tasks: [] }
    return { originalRequest, request: `继续上次未完成的任务。原始目标：${originalRequest}`, completedTaskIds: [], unfinishedTaskIds: [], kind: 'resume', snapshot: { version: 1, runId: runIdFor(user), userEventSequence: user.sequence, originalRequest, plan: emptyPlan, tasks: [], nativeCheckpoint } }
  }
  // 有未完成任务就提供续跑，不再要求必须出现 error 事件：
  // 作者点停止、或进程在最后一次任务之后被打断时，同样没有 error 事件。
  if (!hasFailure && !needsSummary && unfinishedTaskIds.length === 0) return null
  const snapshot: MasterTaskRunSnapshot = { version: 1, runId: runIdFor(user), userEventSequence: user.sequence, originalRequest, plan: { ...planPayload, summary: planPayload.summary ?? originalRequest, tasks }, tasks: checkpoints, nativeCheckpoint }
  if (needsSummary) {
    return { originalRequest, completedTaskIds, unfinishedTaskIds,
      request: `继续上次未完成的任务。原始目标：${originalRequest}\n领域任务已全部结算但尚未给出答复：请汇总已有结果并直接回答原始目标，不要重复执行已完成任务。`,
      kind: 'summarize', snapshot }
  }
  const status = completedTaskIds.length ? `上次已完成的任务 ID：${completedTaskIds.join('、')}。` : '上次尚未产出完整结果。'
  return { originalRequest, request: `继续上次未完成的任务。原始目标：${originalRequest}\n${status}只处理尚未完成的部分。`, completedTaskIds, unfinishedTaskIds, kind: 'resume', snapshot }
}
