import { useCallback, useMemo, useRef, useState } from 'react'
import type { UseAIStreamReturn } from '../../hooks/useAIStream'
import type { RunOptions } from '../../lib/ai/adapters/outline-adapter'
import {
  prepareGenerationNode,
  runGenerationNode,
  type PreparedGenerationNode,
} from '../../lib/generation/generation-node'
import {
  findGenerationTargetVolume,
  outlineGenerationTargetError,
} from '../../lib/outline/generation-plan'
import {
  createOutlineGenerationNode,
  OutlineGenerationSkipError,
} from '../../lib/outline/generation-node'
import {
  decodeGenerationOperation,
  encodeGenerationOperation,
  outlineGenerationModuleKey,
  type OutlineGenerationRequest,
  type PreparedGenerationContext,
} from '../../lib/outline/generation-request'
import type { AssembleContextResult } from '../../lib/registry/types'
import type { PlanSelection } from '../../lib/generation/plan-needs'
import { logEvent } from '../../lib/logging/logger'
import type { ChatMessage, OutlineNode, Project } from '../../lib/types'

type GenerationAI = Pick<
  UseAIStreamReturn,
  'operation' | 'reset' | 'setOperation' | 'start'
>

interface Options {
  project: Project
  nodes: OutlineNode[]
  volumes: OutlineNode[]
  hint: string
  runOptions: RunOptions
  ai: GenerationAI
  assembleContext: (
    worldGroupId: number | null,
    outlineNodeId?: number | null,
    selection?: PlanSelection | null,
  ) => Promise<AssembleContextResult>
  openPromptPanel: () => void
  clearPreview: () => void
  onInfo: (message: string) => void
  onError: (message: string) => void
}

export function useOutlineGenerationController({
  project,
  nodes,
  volumes,
  hint,
  runOptions,
  ai,
  assembleContext,
  openPromptPanel,
  clearPreview,
  onInfo,
  onError,
}: Options) {
  const [activeModuleKey, setActiveModuleKey] = useState<'outline.volume' | 'outline.chapter'>('outline.volume')
  const [pendingRequest, setPendingRequest] = useState<OutlineGenerationRequest | null>(null)
  const [pendingHint, setPendingHint] = useState(hint)
  const [preparedContext, setPreparedContext] = useState<PreparedGenerationContext | null>(null)
  const [contextLoading, setContextLoading] = useState(false)
  const [contextError, setContextError] = useState('')
  // 默认打开「发送前预览」：与章节编辑器一致（作者要求：预览是默认路径，不再是高级选项）。
  const [transparentMode, setTransparentModeState] = useState(true)
  const [promptReviewOpen, setPromptReviewOpen] = useState(false)
  const contextRequestRef = useRef(0)
  /**
   * 本次大纲生成采用的协商结果（会话级，不落库）。
   * 保存它是因为 `retry()` 会在没有上下文快照时重新装配 —— 若只把 selection 传给
   * `prepare` 的第一次装配，重试就会退回固定清单，出现"重试后资料悄悄变少"。
   */
  const negotiatedSelectionRef = useRef<PlanSelection | null>(null)
  /**
   * 协商产出的写作要求（摘要 / 回答 / 计划 / 依据字段）。
   * 与 selection 同因保存：重试时 `prepare(request)` 不再传 hint，
   * 若不记住它，作者确认过的协商内容会在重试后从提示词里消失。
   */
  const negotiatedHintRef = useRef<string | null>(null)

  const moduleKey: 'outline.volume' | 'outline.chapter' = pendingRequest
    ? outlineGenerationModuleKey(pendingRequest)
    : ai.operation?.startsWith('outline.chapter')
      ? 'outline.chapter'
      : ai.operation?.startsWith('outline.volume')
        ? 'outline.volume'
        : activeModuleKey

  const buildNode = useCallback((request: OutlineGenerationRequest) => (
    createOutlineGenerationNode({
      request,
      project,
      nodes,
      volumes,
      hint: pendingHint,
      runOptions,
      ai,
    })
  ), [ai, nodes, pendingHint, project, runOptions, volumes])

  const preparedNodeResult = useMemo<{
    prepared: PreparedGenerationNode | null
    error: string
  }>(() => {
    if (!pendingRequest || !preparedContext) return { prepared: null, error: '' }
    if (preparedContext.operation !== encodeGenerationOperation(pendingRequest)) {
      return { prepared: null, error: '' }
    }
    try {
      return {
        prepared: prepareGenerationNode(
          buildNode(pendingRequest),
          preparedContext.assembled,
        ),
        error: '',
      }
    } catch (error) {
      return {
        prepared: null,
        error: error instanceof Error ? error.message : '无法装配最终提示词',
      }
    }
  }, [buildNode, pendingRequest, preparedContext])

  const execute = useCallback(async (
    request: OutlineGenerationRequest,
    contextSnapshot?: AssembleContextResult | null,
    preparedSnapshot?: PreparedGenerationNode | null,
    messageOverride?: ChatMessage[],
  ) => {
    setActiveModuleKey(outlineGenerationModuleKey(request))
    ai.setOperation(encodeGenerationOperation(request))
    clearPreview()

    const targetError = outlineGenerationTargetError(request, nodes, volumes)
    if (targetError) {
      ai.reset()
      onError(targetError)
      return
    }

    try {
      const targetVolume = findGenerationTargetVolume(request, nodes, volumes)
      const assembled = contextSnapshot
        ?? await assembleContext(targetVolume?.worldGroupId ?? null, targetVolume?.id, negotiatedSelectionRef.current)
      const node = buildNode(request)
      const prepared = preparedSnapshot ?? prepareGenerationNode(node, assembled)
      await runGenerationNode(node, prepared, { messages: messageOverride })
    } catch (error) {
      if (error instanceof OutlineGenerationSkipError) {
        ai.reset()
        if (error.message.includes('无需继续生成')) onInfo(error.message)
        else onError(error.message)
        return
      }
      logEvent({ level: 'error', tag: 'Outline', event: 'outline', message: '[Outline] 准备生成失败:', error })
      ai.reset()
      onError(`准备大纲生成时出错：${error instanceof Error ? error.message : '未知错误'}。`)
    }
  }, [ai, assembleContext, buildNode, clearPreview, nodes, onError, onInfo, volumes])

  const prepare = useCallback(async (
    request: OutlineGenerationRequest,
    requestHint?: string,
    selection?: PlanSelection | null,
  ) => {
    const requestId = contextRequestRef.current + 1
    contextRequestRef.current = requestId
    const operation = encodeGenerationOperation(request)
    /**
     * 「重试/重新准备」与「开始一次全新生成」都走 `prepare`，但**恰好都只传 request**，
     * 无法靠参数个数区分。判据用请求身份：正在准备的就是当前 pending 的那一次 →
     * 属于重试，必须沿用已确认的协商结果；换了请求（或本来没有 pending）→ 是新一轮，
     * 清空旧协商，回到大纲固定清单。否则上一章的申报会泄漏到下一次生成。
     */
    const isRePrepare = pendingRequest != null
      && encodeGenerationOperation(pendingRequest) === operation
    if (selection !== undefined) negotiatedSelectionRef.current = selection
    else if (!isRePrepare) negotiatedSelectionRef.current = null
    setActiveModuleKey(outlineGenerationModuleKey(request))
    setPendingRequest(request)
    if (requestHint !== undefined) negotiatedHintRef.current = requestHint
    else if (!isRePrepare) negotiatedHintRef.current = null
    setPendingHint(requestHint ?? negotiatedHintRef.current ?? hint)
    setPreparedContext(null)
    setContextLoading(true)
    setContextError('')
    setTransparentModeState(true)
    setPromptReviewOpen(false)
    openPromptPanel()
    clearPreview()

    try {
      const targetVolume = findGenerationTargetVolume(request, nodes, volumes)
      const assembled = await assembleContext(
        targetVolume?.worldGroupId ?? null,
        targetVolume?.id,
        negotiatedSelectionRef.current,
      )
      if (contextRequestRef.current !== requestId) return
      setPreparedContext({ operation, assembled })
    } catch (error) {
      if (contextRequestRef.current !== requestId) return
      setContextError(error instanceof Error ? error.message : '未知错误')
    } finally {
      if (contextRequestRef.current === requestId) setContextLoading(false)
    }
  }, [assembleContext, clearPreview, hint, nodes, openPromptPanel, pendingRequest, volumes])

  const cancel = useCallback(() => {
    contextRequestRef.current += 1
    // 取消 = 放弃这次协商：重试/重新准备必须回到固定清单，不能沿用已作废的申报。
    negotiatedSelectionRef.current = null
    negotiatedHintRef.current = null
    setPendingRequest(null)
    setPreparedContext(null)
    setContextLoading(false)
    setContextError('')
    setTransparentModeState(true)
    setPromptReviewOpen(false)
  }, [])

  const confirm = useCallback(async () => {
    if (!pendingRequest || contextLoading || contextError || preparedNodeResult.error) return
    const operation = encodeGenerationOperation(pendingRequest)
    const contextSnapshot = preparedContext?.operation === operation
      ? preparedContext.assembled
      : null
    if (!contextSnapshot || !preparedNodeResult.prepared) return
    if (transparentMode) {
      setPromptReviewOpen(true)
      return
    }
    const request = pendingRequest
    setPendingRequest(null)
    setPreparedContext(null)
    await execute(request, contextSnapshot, preparedNodeResult.prepared)
  }, [
    contextError,
    contextLoading,
    execute,
    pendingRequest,
    preparedContext,
    preparedNodeResult,
    transparentMode,
  ])

  const confirmMessages = useCallback(async (messages: ChatMessage[]) => {
    if (!pendingRequest || !promptReviewOpen || !preparedNodeResult.prepared) return
    const operation = encodeGenerationOperation(pendingRequest)
    const contextSnapshot = preparedContext?.operation === operation
      ? preparedContext.assembled
      : null
    if (!contextSnapshot) return
    const request = pendingRequest
    setPromptReviewOpen(false)
    setPendingRequest(null)
    setPreparedContext(null)
    await execute(
      request,
      contextSnapshot,
      preparedNodeResult.prepared,
      messages,
    )
  }, [
    execute,
    pendingRequest,
    preparedContext,
    preparedNodeResult,
    promptReviewOpen,
  ])

  const setTransparentMode = useCallback((enabled: boolean) => {
    setTransparentModeState(enabled)
    setPromptReviewOpen(false)
  }, [])

  const retry = useCallback(async () => {
    const request = decodeGenerationOperation(ai.operation)
    if (request) await execute(request)
  }, [ai.operation, execute])

  return {
    moduleKey,
    pendingRequest,
    preparedContext,
    preparedNode: preparedNodeResult.prepared,
    contextLoading,
    contextError: contextError || preparedNodeResult.error,
    transparentMode,
    promptReviewOpen,
    prepare,
    cancel,
    confirm,
    confirmMessages,
    closePromptReview: () => setPromptReviewOpen(false),
    setTransparentMode,
    retry,
  }
}
