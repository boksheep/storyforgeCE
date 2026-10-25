import { useCallback, useRef, useState } from 'react'
import { runBatchOutlineGeneration, type BatchOutlineProgress } from '../../lib/ai/batch-outline-runner'
import type { ParsedChapter } from '../../lib/ai/parse-outline-output'
import { adoptGeneratedOutlineItems } from '../../lib/outline/adopt-generation'
import { logEvent } from '../../lib/logging/logger'
import type { AssembleContextResult } from '../../lib/registry/types'
import type { PlanSelection } from '../../lib/generation/plan-needs'
import type { OutlineNode } from '../../lib/types'
import type { GeneratedOutlineItem } from '../../lib/outline/adopt-generation'

interface Options {
  projectId: number
  multiWorldEnabled: boolean
  volumes: OutlineNode[]
  nodes: OutlineNode[]
  hint: string
  assembleContext: (
    worldGroupId: number | null,
    outlineNodeId?: number | null,
    selection?: PlanSelection | null,
  ) => Promise<AssembleContextResult>
  reloadOutline: () => Promise<void>
  onError: (message: string) => void
  onGeneratedEntities?: (items: GeneratedOutlineItem[], worldGroupId: number | null) => Promise<void>
}

function contextPart(assembled: AssembleContextResult, key: string): string {
  const index = assembled.included.indexOf(key)
  return index >= 0 ? assembled.segments[index]?.content ?? '' : ''
}

export function useOutlineBatchGeneration({
  projectId, multiWorldEnabled, volumes, nodes, hint, assembleContext, reloadOutline, onError, onGeneratedEntities,
}: Options) {
  const [progress, setProgress] = useState<BatchOutlineProgress | null>(null)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Map<number, ParsedChapter[]> | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  const generate = useCallback(async (negotiatedHint?: string, selection?: PlanSelection | null) => {
    if (volumes.length === 0) return
    setRunning(true)
    setResult(null)
    setProgress(null)
    const controller = new AbortController()
    abortRef.current = controller
    try {
      // 协商申报的来源必须进入每一卷的装配（多世界时逐卷解析也带上同一份申报）。
      const assembled = await assembleContext(null, null, selection)
      const generationResult = await runBatchOutlineGeneration({
        volumes,
        worldContext: assembled.text,
        worldContextResolver: multiWorldEnabled ? async volumeId => {
          const volume = nodes.find(node => node.id === volumeId)
          return (await assembleContext(volume?.worldGroupId ?? null, volumeId, selection)).text
        } : undefined,
        worldRulesContextResolver: multiWorldEnabled ? async volumeId => {
          const volume = nodes.find(node => node.id === volumeId)
          return contextPart(await assembleContext(volume?.worldGroupId ?? null, volumeId, selection), 'worldRules')
        } : undefined,
        userHint: negotiatedHint || hint || undefined,
        characterContext: contextPart(assembled, 'characters'),
        worldRulesContext: contextPart(assembled, 'worldRules'),
        signal: controller.signal,
        onProgress: setProgress,
      })
      if (!generationResult.cancelled) setResult(generationResult.chaptersByVolume)
    } catch (error) {
      logEvent({ level: 'error', tag: 'BatchOutline', event: 'batchoutline', message: '[BatchOutline] 失败:', error })
      onError(`批量生成章节失败：${error instanceof Error ? error.message : '未知错误'}。`)
    } finally {
      if (abortRef.current === controller) abortRef.current = null
      setRunning(false)
    }
  }, [volumes, nodes, multiWorldEnabled, hint, assembleContext, onError])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
    abortRef.current = null
    setRunning(false)
  }, [])

  const confirm = useCallback(async () => {
    if (!result) return
    const writtenByVolume = new Map<number, GeneratedOutlineItem[]>()
    try {
      for (const [volumeId, chapters] of result) {
        const existingCount = nodes.filter(node => node.parentId === volumeId && node.type === 'chapter').length
        const adopted = await adoptGeneratedOutlineItems({ projectId, parentId: volumeId, type: 'chapter', items: chapters, startingOrder: existingCount })
        writtenByVolume.set(volumeId, adopted.writtenItems ?? [])
      }
    } catch (error) {
      logEvent({ level: 'error', tag: 'Outline', event: 'outline', message: '[Outline] 批量写入章节失败:', error })
      onError(`批量写入章节时出错：${error instanceof Error ? error.message : '未知错误'}。请查看控制台获取详情。`)
      return
    }
    await reloadOutline()
    if (onGeneratedEntities) {
      for (const volumeId of result.keys()) {
        const volume = volumes.find(item => item.id === volumeId)
        const writtenItems = writtenByVolume.get(volumeId) ?? []
        if (writtenItems.length) await onGeneratedEntities(writtenItems, volume?.worldGroupId ?? null)
      }
    }
    setResult(null)
    setProgress(null)
  }, [result, nodes, volumes, projectId, reloadOutline, onError, onGeneratedEntities])

  const dismiss = useCallback(() => {
    setResult(null)
    setProgress(null)
  }, [])

  return { progress, running, result, generate, cancel, confirm, dismiss }
}
