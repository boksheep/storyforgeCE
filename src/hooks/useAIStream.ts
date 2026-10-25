import { useCallback, useMemo, useRef, useState } from 'react'
import { resolveRequestConfig, streamChat, type StreamResult, type AICallMeta } from '../lib/ai/client'
import { getAIConfigRequiredMessage, isAIConfigReady } from '../lib/ai/config-readiness'
import { log } from '../lib/logging/logger'
import { useAIConfigStore } from '../stores/ai-config'
import {
  type AIGenerationSession,
  selectAIGenerationSession,
  useAIGenerationSessionStore,
} from '../stores/ai-generation-session'
import type { AIConfig, ChatMessage } from '../lib/types'
import type { TokenUsage } from '../lib/ai/logger'

export interface UseAIStreamReturn {
  /** 当前累积的输出文本 */
  output: string
  /** 是否正在生成 */
  isStreaming: boolean
  /** 错误信息 */
  error: string | null
  /** 本次生成的 token 用量（流结束后可用） */
  tokenUsage: TokenUsage | null
  /** 当前会话对应的操作类型，用于组件卸载后恢复正确的采纳/重试语义。 */
  operation: string | null
  /**
   * 开始流式生成。
   * @param messages 聊天消息
   * @param overrideConfig 临时覆盖的配置片段（例如导入面板需要 maxTokens=16384）
   */
  start: (messages: ChatMessage[], overrideConfig?: Partial<AIConfig>, meta?: AICallMeta) => Promise<string>
  /** 停止生成 */
  stop: () => void
  /** 重置状态 */
  reset: () => void
  /** 设置当前会话的操作类型。 */
  setOperation: (operation: string | null) => void
}

const sharedAbortControllers = new Map<string, AbortController>()

/**
 * 流式 AI 输出 Hook
 * 封装 streamChat，提供 start/stop/reset 控制
 *
 * 传入 sessionKey 后，状态与请求控制器脱离组件生命周期：
 * 一级标签切换导致组件卸载时，生成仍继续，重新挂载可恢复输出。
 */
export function useAIStream(sessionKey?: string): UseAIStreamReturn {
  const [output, setOutput] = useState('')
  const [isStreaming, setIsStreaming] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tokenUsage, setTokenUsage] = useState<TokenUsage | null>(null)
  const [operation, setLocalOperation] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const sharedSession = useAIGenerationSessionStore(selectAIGenerationSession(sessionKey))

  const currentOutput = sessionKey ? sharedSession.output : output
  const currentIsStreaming = sessionKey ? sharedSession.isStreaming : isStreaming
  const currentError = sessionKey ? sharedSession.error : error
  const currentTokenUsage = sessionKey ? sharedSession.tokenUsage : tokenUsage
  const currentOperation = sessionKey ? sharedSession.operation : operation

  /**
   * `start` 是 memo 化的，闭包里的 `output` / `isStreaming` 会停留在创建那一刻。
   * "这次是否取代了上一次未采纳的结果"必须读到**最新值**，因此用 ref 镜像一份
   * （否则第二次生成时判断永远看到空输出，取代事件就丢了 —— 反例测试抓到的正是这个）。
   */
  const outputRef = useRef('')
  outputRef.current = currentOutput
  const isStreamingRef = useRef(false)
  isStreamingRef.current = currentIsStreaming

  const patchShared = useCallback((patch: Partial<AIGenerationSession>) => {
    if (sessionKey) useAIGenerationSessionStore.getState().patchSession(sessionKey, patch)
  }, [sessionKey])

  const stop = useCallback(() => {
    if (sessionKey) {
      sharedAbortControllers.get(sessionKey)?.abort()
      sharedAbortControllers.delete(sessionKey)
      patchShared({ isStreaming: false })
      return
    }
    abortRef.current?.abort()
    abortRef.current = null
    setIsStreaming(false)
  }, [sessionKey, patchShared])

  const reset = useCallback(() => {
    stop()
    if (sessionKey) {
      useAIGenerationSessionStore.getState().resetSession(sessionKey)
      return
    }
    setOutput('')
    setError(null)
    setTokenUsage(null)
    setLocalOperation(null)
  }, [sessionKey, stop])

  const setOperation = useCallback((nextOperation: string | null) => {
    if (sessionKey) {
      patchShared({ operation: nextOperation })
    } else {
      setLocalOperation(nextOperation)
    }
  }, [sessionKey, patchShared])

  const start = useCallback(async (
    messages: ChatMessage[],
    overrideConfig?: Partial<AIConfig>,
    meta?: AICallMeta,
  ): Promise<string> => {
    // 重置状态
    if (sessionKey) {
      // 取代上一次还没结束/还没被采纳的生成时，留下一条可追溯记录：
      // 否则"我明明生成了两分钟，结果什么都没了"在日志里查不到原因。
      const previous = useAIGenerationSessionStore.getState().sessions[sessionKey] as AIGenerationSession | undefined
      if (previous && (previous.isStreaming || previous.output.trim())) {
        log.warn('AI', 'ai', '[AI] 新的生成取代了上一次尚未采纳的结果（其文本不再显示）', {
          sessionKey,
          replacedStreaming: previous.isStreaming,
          replacedChars: previous.output.length,
        })
      }
      sharedAbortControllers.get(sessionKey)?.abort()
      patchShared({ output: '', error: null, tokenUsage: null, isStreaming: true })
    } else {
      if (isStreamingRef.current || outputRef.current.trim()) {
        log.warn('AI', 'ai', '[AI] 新的生成取代了上一次尚未采纳的结果（其文本不再显示）', {
          replacedStreaming: isStreamingRef.current,
          replacedChars: outputRef.current.length,
        })
      }
      setOutput('')
      setError(null)
      setTokenUsage(null)
      setIsStreaming(true)
    }

    const controller = new AbortController()
    if (sessionKey) sharedAbortControllers.set(sessionKey, controller)
    else abortRef.current = controller

    const baseConfig = useAIConfigStore.getState().config
    const config: AIConfig = overrideConfig
      ? { ...baseConfig, ...overrideConfig }
      : baseConfig
    meta = overrideConfig ? { ...meta, configOverrides: overrideConfig } : meta
    const effectiveConfig = resolveRequestConfig(config, meta).config

    if (!isAIConfigReady(effectiveConfig)) {
      const errMsg = getAIConfigRequiredMessage(effectiveConfig)
      log.warn('AI', 'ai', '[AI] 未配置可用 AI 服务，provider:', { provider: effectiveConfig.provider })
      if (sessionKey) {
        patchShared({ error: errMsg, isStreaming: false })
        sharedAbortControllers.delete(sessionKey)
      } else {
        setError(errMsg)
        setIsStreaming(false)
      }
      return ''
    }

    let accumulated = ''
    const streamResult: StreamResult = {}

    try {
      const stream = streamChat(messages, config, controller.signal, streamResult, meta)
      for await (const chunk of stream) {
        if (controller.signal.aborted) break
        accumulated += chunk
        if (sessionKey) {
          if (sharedAbortControllers.get(sessionKey) !== controller) break
          patchShared({ output: accumulated })
        } else {
          setOutput(accumulated)
        }
      }
    } catch (err: unknown) {
      // 中止（用户点「停止」/ 这次生成被新的生成取代）**不是错误**：
      // 报成错误会在界面上留下红色失败，让作者以为模型或网络出了问题
      // （真实事故：`signal is aborted without reason` 被当成失败，掩盖了"谁取代了谁"）。
      if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
        // 已生成的部分文本保持可见（不清空），用户仍可采纳或丢弃。
      } else {
        const errMsg = err instanceof Error ? err.message : '未知错误'
        if (sessionKey) patchShared({ error: errMsg })
        else setError(errMsg)
      }
    } finally {
      if (sessionKey) {
        // 同一会话可能已被重试；旧请求不得覆盖新请求状态。
        if (sharedAbortControllers.get(sessionKey) === controller) {
          sharedAbortControllers.delete(sessionKey)
          patchShared({
            isStreaming: false,
            ...(streamResult.usage ? { tokenUsage: streamResult.usage } : {}),
          })
        }
      } else {
        setIsStreaming(false)
        abortRef.current = null
        // 流结束后写入 token 用量（若 provider 返回了 usage）
        if (streamResult.usage) {
          setTokenUsage(streamResult.usage)
        }
      }
    }

    return accumulated
  }, [sessionKey, patchShared])

  return useMemo(
    () => ({
      output: currentOutput,
      isStreaming: currentIsStreaming,
      error: currentError,
      tokenUsage: currentTokenUsage,
      operation: currentOperation,
      start,
      stop,
      reset,
      setOperation,
    }),
    [
      currentOutput,
      currentIsStreaming,
      currentError,
      currentTokenUsage,
      currentOperation,
      start,
      stop,
      reset,
      setOperation,
    ],
  )
}
