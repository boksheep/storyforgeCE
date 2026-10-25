import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  appendAgentEvent,
  getOrCreateAgentConversation,
  readAgentEvents,
  updateAgentEventCandidate,
} from '../../lib/agent/conversations'
import {
  adoptMasterCandidate,
  createMasterAgentPlan,
  executeMasterAgentPlan,
  type ExecutedMasterCandidate,
  type MasterCandidatePayload,
  type MasterAgentPlan,
} from '../../lib/agent/orchestrator'
import { resolveVolumePlotReview, runVolumePlotReview } from '../../lib/agent/project-review'
import { answerProjectQuestion, isProjectReadOnlyQuestion } from '../../lib/agent/project-answer'
import {
  adoptProjectFieldCandidate,
  isProjectFieldEditRequest,
  prepareProjectFieldCandidate,
  type ProjectFieldCandidatePayload,
} from '../../lib/agent/project-field-copilot'
import {
  adoptProjectCreateCandidate,
  isProjectCreateRequest,
  prepareProjectCreateCandidate,
  type ProjectCreateCandidatePayload,
} from '../../lib/agent/project-create-copilot'
import { describeProjectOperationBoundary } from '../../lib/agent/project-operation-boundary'
import type { AgentEvent, Project } from '../../lib/types'
import { parseAgentEventPayload } from '../../lib/types'
import { AgentTeamBudgetTracker } from '../../lib/agent/team-budget'
import { resolveNativeAgentLimits } from '../../lib/agent/native-agent-limits'
import {
  EMPTY_AGENT_USAGE,
  readAgentContextUsage,
  recordAgentContextUsage,
  summarizeAgentUsage,
  type AgentUsageSummary,
} from '../../lib/agent/agent-usage'
import { checkpointMasterConversation } from '../../lib/agent/conversation-memory'
import { log, logEvent } from '../../lib/logging/logger'
import { useAIConfigStore } from '../../stores/ai-config'
import { resolveMasterAgentExecutionMode } from '../../lib/agent/execution-mode'
import type { NativeOperationsCandidatePayload } from '../../lib/agent/project-native-operations'
import type { ChapterDeletionCandidatePayload } from '../../lib/agent/project-lifecycle-copilot'
import type { NativeAgentDecision, NativeAgentProgress } from '../../lib/agent/project-native-agent'
import { deriveTaskContinuation, type MasterTaskRunSnapshot } from '../../lib/agent/task-continuation'

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return '操作失败，请稍后重试。'
}

export interface PendingMasterCandidate {
  event: AgentEvent
  payload: MasterCandidatePayload | ProjectFieldCandidatePayload | ProjectCreateCandidatePayload | NativeOperationsCandidatePayload | ChapterDeletionCandidatePayload
}

export interface PendingMasterReview {
  event: AgentEvent
  plan: MasterAgentPlan
}

const CONFIRM_ONLY = /^(确认|同意|允许|开始审阅|开始审计|可以|是的)[。！!\s]*$/
const CANCEL_ONLY = /^(取消|拒绝|不用了|不审了)[。！!\s]*$/
const CANDIDATE_CONFIRM_ONLY = /^(确认|同意|采纳|批准|允许|可以|是的)[。！!\s]*$/
const CANDIDATE_CANCEL_ONLY = /^(取消|拒绝|不用了|不采纳|否决)[。！!\s]*$/

export function useMasterCopilot(input: {
  project: Project
  worldGroupId: number | null
}) {
  const { project, worldGroupId } = input
  const [conversationId, setConversationId] = useState<number | null>(null)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [authorRequest, setAuthorRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [draftSaveError, setDraftSaveError] = useState('')
  const [submitNotice, setSubmitNotice] = useState('')
  const [liveProgress, setLiveProgress] = useState<NativeAgentProgress[]>([])
  const abortRef = useRef<AbortController | null>(null)
  const activeOperation = useRef<{ scope: string } | null>(null)
  const runtimeCandidates = useRef(new Map<number, ExecutedMasterCandidate>())
  const candidateDrafts = useRef(new Map<number, string>())
  const candidateWrites = useRef(new Map<number, Promise<void>>())
  const scopeKey = `${project.id}:${worldGroupId ?? 'global'}`
  const scopeRef = useRef(scopeKey)
  scopeRef.current = scopeKey
  // submit 是长生命周期回调；待确认计划必须在调用时读取最新值，
  // 否则“确认”会落到首轮渲染的 null 闭包上，被当成新指令重新规划（真实事故：确认后忘记审计任务）。
  const pendingReviewRef = useRef<PendingMasterReview | null>(null)
  const candidateResolverRef = useRef<((candidate: PendingMasterCandidate, decision: 'adopted' | 'rejected') => Promise<void>) | null>(null)
  // 失败重试要能重放作者最后一次指令，而不是让作者重新打字。
  const lastRequestRef = useRef('')
  const [lastRequest, setLastRequest] = useState('')
  // 底部状态栏：累计用量（持久） + 当前上下文压力（会话级）。
  const [usage, setUsage] = useState<AgentUsageSummary>(EMPTY_AGENT_USAGE)
  const [contextUsage, setContextUsage] = useState(() => readAgentContextUsage(input.project.id ?? -1))

  const reload = useCallback(async (id: number, expectedScope: string) => {
    const rows = await readAgentEvents(id)
    if (scopeRef.current === expectedScope) setEvents(rows)
  }, [])

  // 项目切换时重新读取指标：累计用量来自用量日志，上下文压力来自会话缓存。
  useEffect(() => {
    let active = true
    setUsage(EMPTY_AGENT_USAGE)
    setContextUsage(readAgentContextUsage(project.id ?? -1))
    if (project.id == null) return () => { active = false }
    void summarizeAgentUsage({ projectId: project.id })
      .then(summary => { if (active) setUsage(summary) })
      .catch(() => { /* 指标读取失败不影响对话 */ })
    return () => { active = false }
  }, [project.id])

  useEffect(() => {
    let active = true
    abortRef.current?.abort()
    activeOperation.current = null
    runtimeCandidates.current.clear()
    candidateDrafts.current.clear()
    candidateWrites.current.clear()
    setBusy(false)
    setLoading(true)
    setConversationId(null)
    setEvents([])
    lastRequestRef.current = ''
    setLastRequest('')
    setLiveProgress([])
    setDraftSaveError('')
    void (async () => {
      const conversation = await getOrCreateAgentConversation({
        projectId: project.id!,
        worldGroupId,
      })
      if (!active) return
      setConversationId(conversation.id!)
      let rows = await readAgentEvents(conversation.id!)
      if (!rows.length) {
        await appendAgentEvent({
          projectId: project.id!,
          conversationId: conversation.id!,
          kind: 'message',
          role: 'assistant',
          content: '直接告诉我你想完成什么。我会理解目标、调用需要的领域 Agent，并把结果统一交给你确认。',
        })
        rows = await readAgentEvents(conversation.id!)
      }
      if (active) {
        setEvents(rows)
        const restoredRequest = [...rows].reverse()
          .find(row => row.kind === 'message' && row.role === 'user')?.content ?? ''
        lastRequestRef.current = restoredRequest
        setLastRequest(restoredRequest)
        setLoading(false)
      }
    })().catch(error => {
      if (active) {
        logEvent({ level: 'error', tag: 'master-copilot', event: 'master-copilot', message: '[master-copilot] load failed', error })
        setLoading(false)
      }
    })
    return () => {
      active = false
      abortRef.current?.abort()
    }
  }, [project.id, scopeKey, worldGroupId])

  const pendingCandidates = useMemo(() => {
    const resolvedIds = new Set<number>()
    const resolvedSequences = new Set<number>()
    events.filter(event => event.kind === 'confirmation').forEach(event => {
      const payload = parseAgentEventPayload<{ candidateEventId?: number; candidateSequence?: number }>(event, {})
      if (typeof payload.candidateSequence === 'number') resolvedSequences.add(payload.candidateSequence)
      else if (typeof payload.candidateEventId === 'number') resolvedIds.add(payload.candidateEventId)
    })
    return events
      .filter(event => event.kind === 'candidate' && event.id != null
        && !resolvedIds.has(event.id) && !resolvedSequences.has(event.sequence))
      .map(event => ({
        event,
        payload: parseAgentEventPayload<PendingMasterCandidate['payload']>(event, {
          version: 1,
          taskId: '',
          agentId: 'character',
          label: '候选',
          contextSources: [],
          baseSnapshot: {},
        }),
      }))
  }, [events])

  const pendingReview = useMemo((): PendingMasterReview | null => {
    const resolved = new Set<number>()
    events.filter(event => event.kind === 'confirmation').forEach(event => {
      const payload = parseAgentEventPayload<{ reviewPlanSequence?: number }>(event, {})
      if (typeof payload.reviewPlanSequence === 'number') resolved.add(payload.reviewPlanSequence)
    })
    const event = [...events].reverse().find(row => row.kind === 'plan' && row.id != null
      && !resolved.has(row.sequence)
      && parseAgentEventPayload<MasterAgentPlan>(row, { summary: '', tasks: [] }).review?.kind === 'volume-plot')
    if (!event) return null
    return { event, plan: parseAgentEventPayload<MasterAgentPlan>(event, { summary: '', tasks: [] }) }
  }, [events])
  pendingReviewRef.current = pendingReview
  const taskContinuation = useMemo(() => deriveTaskContinuation(events), [events])

  const submit = useCallback(async (overrideRequest?: string, originalRequest?: string, checkpointSnapshot?: MasterTaskRunSnapshot) => {
    const resumeSnapshot = checkpointSnapshot?.plan.tasks.length ? checkpointSnapshot : undefined
    const nativeResumeCheckpoint = checkpointSnapshot?.nativeCheckpoint
    const submittedRequest = (overrideRequest ?? authorRequest).trim()
    let request = checkpointSnapshot?.originalRequest || submittedRequest || ''
    if (!request || busy || conversationId == null || activeOperation.current?.scope === scopeKey) return
    const lastClarification = [...events].reverse().find(event => event.kind === 'message'
      && event.role === 'assistant'
      && parseAgentEventPayload<{ clarificationKind?: string }>(event, {}).clarificationKind === 'project-field')
    if (CANDIDATE_CONFIRM_ONLY.test(request)
      && pendingCandidates.length === 0
      && lastClarification
      && lastRequestRef.current
      && lastRequestRef.current !== request) {
      request = lastRequestRef.current
    }
    const chatCandidate = pendingCandidates.length === 1 ? pendingCandidates[0] : null
    if (chatCandidate && (CANDIDATE_CONFIRM_ONLY.test(request) || CANDIDATE_CANCEL_ONLY.test(request))) {
      await candidateResolverRef.current?.(chatCandidate, CANDIDATE_CONFIRM_ONLY.test(request) ? 'adopted' : 'rejected')
      return
    }
    if (pendingCandidates.length) {
      // 不再静默丢弃：明确告诉作者必须先处理候选，否则输入框看起来"没反应"。
      setSubmitNotice(pendingCandidates.length === 1
        ? '当前有 1 份候选待你决定：请先在上方点「采纳」或「拒绝」，或直接输入「确认」/「取消」。'
        : `当前有 ${pendingCandidates.length} 份候选待你决定：请先逐份处理后再继续对话。`)
      return
    }
    setSubmitNotice('')
    lastRequestRef.current = request
    setLastRequest(request)
    const submissionScope = scopeKey
    const operation = { scope: submissionScope }
    activeOperation.current = operation
    const controller = new AbortController()
    abortRef.current?.abort()
    abortRef.current = controller
    setBusy(true)
    setAuthorRequest('')
    setLiveProgress([])
    try {
      const userEvent = resumeSnapshot
        ? events.find(event => event.sequence === resumeSnapshot.userEventSequence)
          ?? await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'user',
            content: resumeSnapshot.originalRequest,
            payload: { originalRequest: resumeSnapshot.originalRequest, runId: resumeSnapshot.runId },
          })
        : await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'user',
          content: submittedRequest,
          payload: { ...(originalRequest ? { originalRequest } : {}), runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
        })
      await reload(conversationId, submissionScope)
      // 上下文压力观测：每次调用前记录估算输入 token，供底部状态栏显示「用了多少上下文」。
      let turnLastInputTokens = 0
      let turnPeakInputTokens = 0
      const configAtStart = useAIConfigStore.getState().config
      const nativeCallLimit = nativeResumeCheckpoint != null
        || resolveMasterAgentExecutionMode(configAtStart) === 'agent-first'
        ? resolveNativeAgentLimits(configAtStart).maxSteps
        : undefined
      const teamBudget = new AgentTeamBudgetTracker(
        useAIConfigStore.getState().agentTeamBudgetProfile,
        reservation => {
          turnLastInputTokens = reservation.estimatedInputTokens
          turnPeakInputTokens = Math.max(turnPeakInputTokens, reservation.estimatedInputTokens)
          const snapshot = teamBudget.snapshot()
          const record = {
            lastInputTokens: turnLastInputTokens,
            peakInputTokens: turnPeakInputTokens,
            teamBudget: {
              usedTokens: snapshot.usedTokens,
              maxTokens: snapshot.maxTokens,
              calls: snapshot.calls,
              maxCalls: snapshot.maxCalls,
            },
            updatedAt: Date.now(),
          }
          recordAgentContextUsage(project.id!, record)
          if (scopeRef.current === submissionScope) setContextUsage(record)
        },
        nativeCallLimit,
      )
      const pendingReviewNow = pendingReviewRef.current
      if (!resumeSnapshot && pendingReviewNow?.event.id != null) {
        const decision = CONFIRM_ONLY.test(request)
          ? 'approved'
          : CANCEL_ONLY.test(request)
            ? 'rejected'
            : 'superseded'
        if (decision === 'approved') {
          const review = pendingReviewNow.plan.review!
          const report = await runVolumePlotReview({
            projectId: project.id!,
            worldGroupId,
            review,
            budget: teamBudget,
            signal: controller.signal,
          })
          if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'confirmation',
            content: `已确认只读审阅“${review.volumeTitle}”。`,
            payload: { reviewPlanSequence: pendingReviewNow.event.sequence, decision },
          })
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
            content: report,
          })
          return
        }
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'confirmation',
          content: decision === 'rejected' ? '已取消本次审阅。' : '已改用新的指令。',
          payload: { reviewPlanSequence: pendingReviewNow.event.sequence, decision },
        })
        if (decision === 'rejected') {
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
            content: '已取消本次审阅，没有修改项目数据。',
          })
          return
        }
      } else if (CONFIRM_ONLY.test(request) || CANCEL_ONLY.test(request)) {
        // 没有待确认计划时说清楚边界，不做“凭空规划”，也不假装任务已完成。
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
          content: '当前没有等待确认的任务，所以这次“确认/取消”没有对应目标。请直接说明要做什么，或先发起一个需要确认的只读审阅。',
        })
        return
      }
      const proposeProjectFieldEdit = async () => {
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'plan',
          content: '读取目标记录，生成可编辑的受控字段候选。',
          payload: { summary: '读取目标记录，生成可编辑的受控字段候选。', tasks: [] },
        })
        const prepared = await prepareProjectFieldCandidate({
          projectId: project.id!,
          worldGroupId,
          request,
          conversationId,
          historyBeforeSequence: userEvent.sequence,
          budget: teamBudget,
          signal: controller.signal,
        })
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if ('clarification' in prepared) {
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
            content: prepared.clarification,
            payload: { clarificationKind: 'project-field' },
          })
          return
        }
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'candidate',
          content: prepared.draft, payload: prepared.payload,
        })
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
          content: '已生成项目字段候选。请检查、编辑后决定是否采纳；正式数据此时尚未修改。',
        })
      }
      const executionMode = resolveMasterAgentExecutionMode(useAIConfigStore.getState().config)
      const agentFirst = nativeResumeCheckpoint != null || executionMode === 'agent-first'
      if (agentFirst && !resumeSnapshot) {
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'plan',
          content: request,
          payload: { summary: request, tasks: [], executionMode: 'agent-first' },
        })
        await reload(conversationId, submissionScope)
        const progressRows = new Map<string, NativeAgentProgress>()
        const onProgress = (progress: NativeAgentProgress) => {
          if (scopeRef.current !== submissionScope || controller.signal.aborted) return
          progressRows.set(progress.id, progress)
          setLiveProgress([...progressRows.values()])
        }
        let decision: NativeAgentDecision
        try {
          const { runNativeProjectAgent } = await import('../../lib/agent/project-native-agent')
          decision = await runNativeProjectAgent({
            projectId: project.id!, worldGroupId, request, conversationId,
            historyBeforeSequence: userEvent.sequence, budget: teamBudget,
            signal: controller.signal, onProgress,
            resumeCheckpoint: nativeResumeCheckpoint,
            onCheckpoint: async checkpoint => {
              await appendAgentEvent({ projectId: project.id!, conversationId, kind: 'task', content: '主 Agent 断点已保存',
                payload: { taskId: 'native-checkpoint', agentId: 'project-native', status: 'running',
                  runId: parseAgentEventPayload<{ runId?: string }>(userEvent, {}).runId, checkpoint } })
            },
          })
        } finally {
          try {
            for (const progress of progressRows.values()) {
              await appendAgentEvent({
                projectId: project.id!, conversationId, kind: 'task', content: progress.detail,
                payload: {
                  taskId: progress.id, agentId: progress.label,
                  status: progress.status === 'running' ? 'failed' : progress.status,
                  error: progress.status === 'running' ? '执行中断' : undefined,
                },
              })
            }
            await reload(conversationId, submissionScope)
          } catch (error) {
            logEvent({ level: 'warn', tag: 'master-copilot', event: 'master-copilot',
              message: '[master-copilot] progress persistence failed', error })
          } finally {
            if (scopeRef.current === submissionScope) setLiveProgress([])
          }
        }
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if (decision.kind === 'answer' || decision.kind === 'clarification') {
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
            content: decision.kind === 'answer' ? decision.answer : decision.question,
          })
          return
        }
        if (decision.kind === 'operations') {
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'candidate',
            content: decision.candidate.draft, payload: decision.candidate.payload,
          })
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
            content: `已读取项目并生成 ${decision.operations.length} 项操作候选。请检查后采纳；此时项目数据尚未修改。`,
          })
          return
        }
        if (decision.kind === 'delete-chapter') {
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'candidate',
            content: decision.candidate.draft, payload: decision.candidate.payload,
          })
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
            content: '已列出删章影响。请核对预览并确认；当前尚未删除。',
          })
          return
        }
        if (decision.kind === 'export-project') {
          const { exportProjectJSON, downloadJSON } = await import('../../lib/export/json-export')
          const data = await exportProjectJSON(project.id!)
          const safeName = project.name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || `project-${project.id}`
          downloadJSON(data, `${safeName}.json`)
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
            content: `已导出当前项目的完整 JSON 备份：${safeName}.json。`,
          })
          return
        }
        request = decision.request
      }
      const previousMessage = (await readAgentEvents(conversationId))
        .filter(event => event.sequence < userEvent.sequence && event.kind === 'message').slice(-1)[0]
      const fieldClarificationFollowUp = previousMessage?.role === 'assistant'
        && parseAgentEventPayload<{ clarificationKind?: string }>(previousMessage, {}).clarificationKind === 'project-field'
        && request.length <= 40
        && /项目|作品|角色|人物|词条|故事|大纲|世界|简介/.test(request)
        && !/删除|清空|创建|新增|续写|不要|取消/.test(request)
      // 确认问与征询问优先于一切写入判定：作者在问"这样行不行"时，
      // 绝不能进字段修改链路替他改数据。
      const isConfirmQuestion = /(?:行不行|好不好|对不对|可不可以|能不能|妥不妥|中不中|行吗|好吗|对吗|要不要|该不该|需不需要|是否需要|值不值得|有没有必要)/.test(request)
        && !/(?:改成|改为|写成|设为)/.test(request)
      if (!agentFirst && isConfirmQuestion) {
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'plan',
          content: '通过项目只读工具查找证据并回答。',
          payload: { summary: '通过项目只读工具查找证据并回答。', tasks: [] },
        })
        const answer = await answerProjectQuestion({
          projectId: project.id!,
          worldGroupId,
          request,
          conversationId,
          historyBeforeSequence: userEvent.sequence,
          budget: teamBudget,
          signal: controller.signal,
        })
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
          content: answer,
        })
        return
      }
      if (!resumeSnapshot && !agentFirst && (fieldClarificationFollowUp || isProjectFieldEditRequest(request))) {
        await proposeProjectFieldEdit()
        return
      }
      if (!resumeSnapshot && !agentFirst && isProjectReadOnlyQuestion(request) && !await resolveVolumePlotReview({
        projectId: project.id!, worldGroupId, request,
      })) {
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'plan',
          content: '通过项目只读工具查找证据并回答。',
          payload: { summary: '通过项目只读工具查找证据并回答。', tasks: [] },
        })
        const answer = await answerProjectQuestion({
          projectId: project.id!,
          worldGroupId,
          request,
          conversationId,
          historyBeforeSequence: userEvent.sequence,
          budget: teamBudget,
          signal: controller.signal,
        })
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
          content: answer,
        })
        return
      }
      if (!agentFirst && isProjectCreateRequest(request)) {
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'plan',
          content: '读取项目现有记录，生成可确认的新增候选。',
          payload: { summary: '读取项目现有记录，生成可确认的新增候选。', tasks: [] },
        })
        const preparedCreate = await prepareProjectCreateCandidate({
          projectId: project.id!,
          worldGroupId,
          request,
          conversationId,
          historyBeforeSequence: userEvent.sequence,
          budget: teamBudget,
          signal: controller.signal,
        })
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
        if ('clarification' in preparedCreate) {
          await appendAgentEvent({
            projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
            content: preparedCreate.clarification,
          })
          return
        }
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'candidate',
          content: preparedCreate.draft, payload: preparedCreate.payload,
        })
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
          content: '已生成新增候选。请检查、编辑后决定是否采纳；正式数据此时尚未新增。',
        })
        return
      }
      const boundary = describeProjectOperationBoundary(request)
      if (!agentFirst && boundary) {
        // 边界拦截必须留痕：作者看到的是"这件事不能由对话做"，
        // 维护者需要能在日志里判断是拦对了还是把正常请求误判成越界。
        log.warn('master-copilot', 'master-copilot.boundary.refused', '主 Agent 拒绝越界请求', {
          projectId: project.id,
          request: request.slice(0, 200),
          message: boundary.message.slice(0, 200),
        })
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
          content: boundary.message,
        })
        return
      }
      const plan = resumeSnapshot?.plan ?? await createMasterAgentPlan({
        projectId: project.id!,
        worldGroupId,
        request,
        conversationId,
        historyBeforeSequence: userEvent.sequence,
        budget: teamBudget,
        signal: controller.signal,
        allowDeterministicFallback: !agentFirst,
      })
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      if (agentFirst && boundary) {
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'plan',
          content: '已完成统一规划，但该请求触及受保护的数据操作边界。',
          payload: { summary: '已完成统一规划，但该请求触及受保护的数据操作边界。', tasks: [], boundary: boundary.message },
        })
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
          content: boundary.message,
        })
        return
      }
      if (plan.projectFieldRequest && !plan.tasks.length) {
        await proposeProjectFieldEdit()
        return
      }
      if (plan.projectCreateRequest && !plan.tasks.length) {
        const preparedCreate = await prepareProjectCreateCandidate({
          projectId: project.id!, worldGroupId, request, conversationId,
          historyBeforeSequence: userEvent.sequence, budget: teamBudget, signal: controller.signal,
        })
        if ('clarification' in preparedCreate) {
          await appendAgentEvent({ projectId: project.id!, conversationId, kind: 'message', content: preparedCreate.clarification, payload: { clarificationKind: 'project-create' } })
          return
        }
        await appendAgentEvent({ projectId: project.id!, conversationId, kind: 'candidate', content: preparedCreate.draft, payload: preparedCreate.payload })
        await appendAgentEvent({ projectId: project.id!, conversationId, kind: 'message', role: 'assistant', content: '已生成统一新增候选。请检查、编辑后决定是否采纳；正式数据此时尚未新增。' })
        return
      }
      if (!resumeSnapshot) {
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'plan', content: plan.summary, payload: plan,
        })
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
          content: plan.tasks.length
            ? `${plan.summary} 我会在后台完成 ${plan.tasks.length} 个领域任务。`
            : plan.summary,
        })
        await reload(conversationId, submissionScope)
      }

      if (!plan.tasks.length) {
        return
      }

      const taskStates = new Map(resumeSnapshot?.tasks.map(task => [task.id, task]) ?? [])
      const existingTaskIds = new Set(taskStates.keys())
      const saveTaskState = async (task: { id: string; agentId: string; instruction: string }, status: string, error?: string) => {
        if (!existingTaskIds.has(task.id)) existingTaskIds.add(task.id)
        const previous = taskStates.get(task.id)
        taskStates.set(task.id, { ...previous, id: task.id, agentId: task.agentId as MasterTaskRunSnapshot['plan']['tasks'][number]['agentId'], instruction: task.instruction, dependsOn: previous?.dependsOn ?? [], status: status as MasterTaskRunSnapshot['tasks'][number]['status'], error })
        await appendAgentEvent({
          projectId: project.id!, conversationId, kind: 'task', content: error || task.instruction,
          payload: { taskId: task.id, agentId: task.agentId, status, error, runId: resumeSnapshot?.runId ?? parseAgentEventPayload<{ runId?: string }>(userEvent, {}).runId },
        })
      }
      const resumeIds = resumeSnapshot
        ? resumeSnapshot.tasks.filter(task => !['awaiting-confirmation', 'adopted', 'rejected', 'completed'].includes(task.status)).map(task => task.id)
        : undefined
      const completedOutputs = new Map(resumeSnapshot?.tasks
        .filter(task => ['awaiting-confirmation', 'adopted', 'rejected', 'completed'].includes(task.status) && task.output)
        .map(task => [task.id, task.output!]) ?? [])
      const candidates = await executeMasterAgentPlan({
        projectId: project.id!, worldGroupId, plan, budget: teamBudget, signal: controller.signal,
        resumeTaskIds: resumeIds,
        completedOutputs,
        onTask: async (task, status, error) => saveTaskState(task, status, status === 'running' ? undefined : error),
        onCandidate: async (task, candidate) => {
          const event = await appendAgentEvent({ projectId: project.id!, conversationId, kind: 'candidate', content: candidate.draft, payload: candidate.payload })
          runtimeCandidates.current.set(event.id!, candidate)
          const prior = taskStates.get(task.id)
          taskStates.set(task.id, { ...prior!, candidateEventId: event.id, candidateSequence: event.sequence, output: candidate.draft, status: 'awaiting-confirmation' })
          await appendAgentEvent({ projectId: project.id!, conversationId, kind: 'task', content: task.instruction,
            payload: { taskId: task.id, agentId: task.agentId, status: 'awaiting-confirmation', candidateEventId: event.id, candidateSequence: event.sequence, output: candidate.draft } })
        },
      })
      if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      await appendAgentEvent({
        projectId: project.id!,
        conversationId,
        kind: 'message',
        role: 'assistant',
        content: [
          `后台领域 Agent 已完成，生成了 ${candidates.length} 份候选。请检查、编辑并决定是否采纳。`,
          `本轮团队约使用 ${teamBudget.snapshot().usedTokens.toLocaleString()} / `
          + `${teamBudget.snapshot().maxTokens.toLocaleString()} tokens，`
          + `${teamBudget.snapshot().calls} 次调用，`
          + `Canon 受控打回 ${teamBudget.snapshot().canonRetries} 次。`,
        ].join(' '),
      })
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = errorMessage(error)
        await appendAgentEvent({
          projectId: project.id!,
          conversationId,
          kind: 'error',
          content: message,
        })
        await appendAgentEvent({
          projectId: project.id!,
          conversationId,
          kind: 'message',
          role: 'assistant',
          content: `本轮没有完成：${message}`,
        })
      }
    } finally {
      try {
        await checkpointMasterConversation({ projectId: project.id!, conversationId, worldGroupId })
      } catch (error) {
        logEvent({ level: 'warn', tag: 'master-copilot', event: 'master-copilot', message: '[master-copilot] memory checkpoint failed', error })
      }
      try {
        await reload(conversationId, submissionScope)
      } finally {
        // 本轮结束后刷新累计用量（token/缓存命中/费用），失败不影响对话收尾。
        void summarizeAgentUsage({ projectId: project.id! })
          .then(summary => { if (scopeRef.current === submissionScope) setUsage(summary) })
          .catch(() => {})
        if (activeOperation.current === operation) activeOperation.current = null
        if (abortRef.current === controller) abortRef.current = null
        if (scopeRef.current === submissionScope && activeOperation.current == null) setBusy(false)
      }
    }
  }, [
    authorRequest,
    busy,
    conversationId,
    pendingCandidates,
    events,
    project.id,
    project.name,
    reload,
    scopeKey,
    worldGroupId,
  ])

  const updateCandidate = useCallback((eventId: number, draft: string) => {
    const editScope = scopeKey
    setDraftSaveError('')
    candidateDrafts.current.set(eventId, draft)
    setEvents(current => current.map(event => event.id === eventId ? { ...event, content: draft } : event))
    const previous = candidateWrites.current.get(eventId) ?? Promise.resolve()
    const write = previous.catch(() => {})
      .then(() => updateAgentEventCandidate(eventId, project.id!, draft))
      .then(() => {
        if (scopeRef.current === editScope && candidateDrafts.current.get(eventId) === draft) setDraftSaveError('')
      }, error => {
        if (scopeRef.current === editScope) setDraftSaveError(`候选保存失败：${errorMessage(error)}`)
        throw error
      })
    candidateWrites.current.set(eventId, write)
    return write
  }, [project.id, scopeKey])

  const resolveCandidate = useCallback(async (
    candidate: PendingMasterCandidate,
    decision: 'adopted' | 'rejected',
  ) => {
    if (busy || conversationId == null || candidate.event.id == null
      || activeOperation.current?.scope === scopeKey) return
    const candidateScope = scopeKey
    const operation = { scope: candidateScope }
    activeOperation.current = operation
    setBusy(true)
    setSubmitNotice('')
    try {
      await candidateWrites.current.get(candidate.event.id)
      let message = '候选已拒绝，没有写入项目。'
      if (decision === 'adopted') {
        const draft = candidateDrafts.current.get(candidate.event.id) ?? candidate.event.content
        message = candidate.payload.agentId === 'project-field'
          ? await adoptProjectFieldCandidate({
              projectId: project.id!, worldGroupId, payload: candidate.payload, draft,
            })
          : candidate.payload.agentId === 'project-native'
            ? await (await import('../../lib/agent/project-native-operations')).adoptNativeOperationsCandidate({
                projectId: project.id!, worldGroupId, payload: candidate.payload, draft,
              })
          : candidate.payload.agentId === 'project-lifecycle'
            ? await (await import('../../lib/agent/project-lifecycle-copilot')).adoptChapterDeletionCandidate({
                projectId: project.id!, worldGroupId, payload: candidate.payload, draft,
              })
          : candidate.payload.agentId === 'project-create'
            ? await adoptProjectCreateCandidate({
                projectId: project.id!, worldGroupId, payload: candidate.payload, draft,
              })
            : await adoptMasterCandidate({
                projectId: project.id!,
                worldGroupId,
                event: candidate.event,
                payload: candidate.payload,
                draft,
                runtime: runtimeCandidates.current.get(candidate.event.id),
              })
      }
      await appendAgentEvent({
        projectId: project.id!,
        conversationId,
        kind: 'confirmation',
        content: message,
        payload: {
          candidateEventId: candidate.event.id,
          candidateSequence: candidate.event.sequence,
          decision,
          taskId: candidate.payload.taskId,
        },
      })
      // 候选决策进日志：正文/大纲/字段是否被真正写入，是排"AI 说改了但没改"的第一手证据。
      log.info('master-copilot', `master-copilot.candidate.${decision}`, `候选${decision === 'adopted' ? '已采纳' : '已拒绝'}`, {
        projectId: project.id,
        agentId: candidate.payload.agentId,
        candidateEventId: candidate.event.id,
        decision,
      })
      await appendAgentEvent({
        projectId: project.id!,
        conversationId,
        kind: 'message',
        role: 'assistant',
        content: message,
      })
      runtimeCandidates.current.delete(candidate.event.id)
      candidateDrafts.current.delete(candidate.event.id)
      candidateWrites.current.delete(candidate.event.id)
    } catch (error) {
      await appendAgentEvent({
        projectId: project.id!,
        conversationId,
        kind: 'message',
        role: 'assistant',
        content: errorMessage(error),
      })
    } finally {
      try {
        await checkpointMasterConversation({ projectId: project.id!, conversationId, worldGroupId })
      } catch (error) {
        logEvent({ level: 'warn', tag: 'master-copilot', event: 'master-copilot', message: '[master-copilot] memory checkpoint failed', error })
      }
      try {
        await reload(conversationId, candidateScope)
      } finally {
        if (activeOperation.current === operation) activeOperation.current = null
        if (scopeRef.current === candidateScope && activeOperation.current == null) setBusy(false)
      }
    }
  }, [busy, conversationId, project.id, reload, scopeKey, worldGroupId])
  candidateResolverRef.current = resolveCandidate

  const stop = useCallback(() => abortRef.current?.abort(), [])

  /** 失败重试：重放作者最后一条指令；没有可重放的指令时返回 false。 */
  const retryLast = useCallback(async (): Promise<boolean> => {
    const request = taskContinuation?.originalRequest
      || lastRequestRef.current.trim()
      || [...events].reverse().find(event => event.kind === 'message' && event.role === 'user')?.content.trim()
    if (!request || busy || pendingCandidates.length > 0) return false
    await submit(request)
    return true
  }, [busy, events, pendingCandidates.length, submit, taskContinuation])

  const continueTask = useCallback(async (): Promise<boolean> => {
    if (!taskContinuation || busy || pendingCandidates.length > 0 || conversationId == null) return false
    // 任务已全部结算：只补一条汇总答复，绝不重跑领域任务（否则会重复生成候选）。
    if (taskContinuation.kind === 'summarize') {
      const settled = taskContinuation.snapshot.tasks.filter(task =>
        ['awaiting-confirmation', 'adopted', 'rejected', 'completed'].includes(task.status))
      const withOutput = settled.filter(task => Boolean(task.output)).length
      await appendAgentEvent({
        projectId: project.id!, conversationId, kind: 'message', role: 'assistant',
        content: withOutput
          ? `上一轮 ${settled.length} 个领域任务已全部结算，但没有留下答复。其中 ${withOutput} 份结果已作为候选等待你审核；如需新的执行，请再说明一次目标。`
          : `上一轮 ${settled.length} 个领域任务已全部结算，但没有留下答复，也没有生成候选。如需继续，请再说明一次目标。`,
      })
      await reload(conversationId, scopeKey)
      return true
    }
    await submit(taskContinuation.request, taskContinuation.originalRequest, taskContinuation.snapshot)
    return true
  }, [busy, conversationId, pendingCandidates.length, project.id, reload, scopeKey, submit, taskContinuation])

  return {
    authorRequest,
    setAuthorRequest,
    events,
    draftSaveError,
    submitNotice,
    pendingCandidates,
    pendingReview,
    liveProgress,
    busy,
    loading,
    submit,
    retryLast,
    continueTask,
    taskContinuation,
    lastRequest,
    usage,
    contextUsage,
    confirmReview: () => submit('确认'),
    rejectReview: () => submit('取消'),
    stop,
    updateCandidate,
    adoptCandidate: (candidate: PendingMasterCandidate) => resolveCandidate(candidate, 'adopted'),
    rejectCandidate: (candidate: PendingMasterCandidate) => resolveCandidate(candidate, 'rejected'),
  }
}
