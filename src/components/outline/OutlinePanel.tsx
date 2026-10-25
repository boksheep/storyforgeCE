import { useState, useEffect, useMemo, useCallback } from 'react'
import { useOutlineStore } from '../../stores/outline'
import { useWorldGroupStore } from '../../stores/world-group'
import { useAIStream } from '../../hooks/useAIStream'
import { createAISessionKey } from '../../stores/ai-generation-session'
import { assembleContext } from '../../lib/registry/assemble-context'
import { logEvent } from '../../lib/logging/logger'
import {
  parseVolumeOutlineSmart, parseChapterOutlineSmart,
  type ParsedVolume, type ParsedChapter,
} from '../../lib/ai/parse-outline-output'
import { useAIConfigStore } from '../../stores/ai-config'
import { chat } from '../../lib/ai/client'
import OutlinePlanNegotiationPanel from './OutlinePlanNegotiationPanel'
import type { PlanCallCategory } from '../editor/ChapterPlanPanel'
import { getTopLevelVolumes } from '../../lib/outline/selectors'
import { normalizeOutlineNode } from '../../lib/outline/normalize'
import { adoptGeneratedOutlineItems, adoptGeneratedOutlineSummary, adoptOptimizedChapterOutlines } from '../../lib/outline/adopt-generation'
import PromptRunPanel from '../shared/PromptRunPanel'
import PanelLayout from '../shared/PanelLayout'
import { CInput } from '../shared/CompositionInput'
import { useDialog } from '../shared/Dialog'
import { useToast } from '../shared/Toast'
import type { Project, StoryStructure } from '../../lib/types'
import { STORY_STRUCTURES } from '../../lib/types/outline'
import OutlineVolumeSidebar from './OutlineVolumeSidebar'
import OutlineVolumeDetail from './OutlineVolumeDetail'
import OutlineGenerationRequestPanel from './OutlineGenerationRequestPanel'
import OutlineGenerationResultPanel from './OutlineGenerationResultPanel'
import { useOutlineBatchGeneration } from './useOutlineBatchGeneration'
import { useOutlineGenerationController } from './useOutlineGenerationController'
import { useOutlineChapterCountEstimate } from './useOutlineChapterCountEstimate'
import { useOutlineChapterDrag } from './useOutlineChapterDrag'
import { decodeGenerationOperation, outlineNegotiationTitle, type OutlineGenerationRequest } from '../../lib/outline/generation-request'
import { findVolumeForOutlineChapter } from '../../lib/outline/generation-plan'
import { withPlanFloor, OUTLINE_FLOOR_SOURCES, type PlanSelection } from '../../lib/generation/plan-needs'
import { adoptGenerationEntityCandidates } from '../../lib/generation/generation-entity-adoption'
import type { GeneratedOutlineItem } from '../../lib/outline/adopt-generation'
import { usePersistentTaskStore } from '../../stores/persistent-task'

interface Props {
  project: Project
  onOpenChapter?: (nodeId: number) => void
}

export default function OutlinePanel({ project, onOpenChapter }: Props) {
  const dialog = useDialog()
  const toast = useToast()
  const { nodes, loadAll, addNode, updateNode, deleteNode, reorderNodes, insertNodeAt, moveNodeToParent } = useOutlineStore()
  const worldGroups = useWorldGroupStore(s => s.groups)
  const aiConfig = useAIConfigStore(s => s.config)
  const [selectedVolId, setSelectedVolId] = useState<number | null>(null)
  const [hint, setHint] = useState('')
  const [parameterValues, setParameterValues] = useState<Record<string, unknown>>({})
  const [systemOverride, setSystemOverride] = useState<string | null>(null)
  const [userOverride, setUserOverride] = useState<string | null>(null)
  const [promptPanelOpen, setPromptPanelOpen] = useState(false)
  const [negotiationTargetId, setNegotiationTargetId] = useState<number | null>(null)
  const [negotiationMode, setNegotiationMode] = useState<'single-chapter' | 'chapters-optimize' | 'batch-chapters' | 'volume' | null>(null)
  const [negotiationRequest, setNegotiationRequest] = useState<OutlineGenerationRequest | { kind: 'all-chapters' } | null>(null)
  const [outlineNegotiationEnabled, setOutlineNegotiationEnabled] = useState(true)
  const { activeChapterDrag, beginChapterDrag, clearActiveChapterDrag, getActiveChapterDrag } = useOutlineChapterDrag()

  // 采纳预览
  const [previewVolumes, setPreviewVolumes] = useState<ParsedVolume[] | null>(null)
  const [previewChapters, setPreviewChapters] = useState<ParsedChapter[] | null>(null)
  const [previewTargetId, setPreviewTargetId] = useState<number | null>(null)
  const clearGenerationPreview = useCallback(() => {
    setPreviewVolumes(null)
    setPreviewChapters(null)
    setPreviewTargetId(null)
  }, [])

  const ai = useAIStream(createAISessionKey(project.id!, 'outline.generate'))

  useEffect(() => { loadAll(project.id!) }, [project.id, loadAll])

  const normalizedNodes = useMemo(() => nodes.map(normalizeOutlineNode), [nodes])
  const volumes = getTopLevelVolumes(normalizedNodes)
  const selectedVol = volumes.find(v => v.id === selectedVolId) || null

  useOutlineChapterCountEstimate({
    selectedVolumeId: selectedVolId,
    selectedVolumeExists: selectedVol != null,
    targetWordCount: project.targetWordCount,
    volumeCount: volumes.length,
    parameterValues,
    setParameterValues,
  })

  // 自动选中第一个卷
  useEffect(() => {
    if (selectedVolId === null && volumes.length > 0) {
      setSelectedVolId(volumes[0].id!)
    }
  }, [volumes, selectedVolId])

  const handleAddVolume = async () => {
    const id = await addNode({
      projectId: project.id!, parentId: null, type: 'volume',
      title: `第${volumes.length + 1}卷`, summary: '', order: volumes.length,
    })
    setSelectedVolId(id)
  }

  const handleAddChapter = async (parentId?: number) => {
    const pid = parentId ?? selectedVol?.id
    if (!pid) return
    const siblings = nodes.filter(n => n.parentId === pid && n.type === 'chapter')
    await addNode({
      projectId: project.id!, parentId: pid, type: 'chapter',
      title: `第${siblings.length + 1}章`, summary: '', order: siblings.length,
    })
  }

  // FB-2 任意位置插入：在某章之后插入一章（同 parentId 内重排 order）
  const handleInsertChapterAfter = async (afterChapterId: number, parentId: number) => {
    const siblingIds = nodes
      .filter(n => n.parentId === parentId && n.type === 'chapter')
      .sort((a, b) => a.order - b.order)
      .map(n => n.id!)
    const index = siblingIds.indexOf(afterChapterId) + 1
    await insertNodeAt(
      { projectId: project.id!, parentId, type: 'chapter', title: '新章节', summary: '', order: 0 },
      siblingIds,
      index,
    )
  }

  const findWorldGroupForParent = (parentId: number | null): number | null => {
    if (parentId == null) return null
    const parent = normalizedNodes.find(node => node.id === parentId)
    if (!parent) return null
    if (parent.type === 'volume') return parent.worldGroupId ?? null
    if (parent.type === 'storyBlock') {
      const volume = normalizedNodes.find(node => node.id === parent.parentId && node.type === 'volume')
      return volume?.worldGroupId ?? null
    }
    return null
  }

  const canMoveChapterToParent = (chapterId: number, targetParentId: number | null): boolean => {
    if (!project.enableMultiWorld) return true
    const chapter = normalizedNodes.find(node => node.id === chapterId && node.type === 'chapter')
    if (!chapter) return false
    return findWorldGroupForParent(chapter.parentId) === findWorldGroupForParent(targetParentId)
  }

  const handleMoveChapter = async (chapterId: number, targetParentId: number, index: number) => {
    if (!canMoveChapterToParent(chapterId, targetParentId)) {
      toast.error('不能把章节拖到其它世界组的卷下。')
      return
    }
    try {
      await moveNodeToParent(chapterId, targetParentId, index)
    } catch (error) {
      logEvent({ level: 'error', tag: 'OutlinePanel', event: 'outlinepanel', message: '[OutlinePanel] Failed to move chapter', error })
      toast.error('章节移动失败，请重试。')
    }
  }

  const handleAddStructure = async (structure: StoryStructure) => {
    if (!selectedVol) return
    const def = STORY_STRUCTURES[structure]
    const currentBlocks = normalizedNodes
      .filter(node => node.parentId === selectedVol.id && node.type === 'storyBlock')
      .sort((a, b) => a.order - b.order)
    if (structure === 'custom') {
      await addNode({
        projectId: project.id!, parentId: selectedVol.id!, type: 'storyBlock',
        title: '自定义故事块', summary: '', order: currentBlocks.length,
      })
    } else {
      for (let i = 0; i < def.blocks.length; i++) {
        await addNode({
          projectId: project.id!, parentId: selectedVol.id!, type: 'storyBlock',
          title: def.blocks[i], summary: '', order: currentBlocks.length + i,
        })
      }
    }
  }

  const generationRunOptions = useMemo(() => ({
    parameterValues: Object.keys(parameterValues).length > 0 ? parameterValues : undefined,
    overrides: (systemOverride != null || userOverride != null) ? {
      systemPrompt: systemOverride ?? undefined,
      userPromptTemplate: userOverride ?? undefined,
    } : undefined,
  }), [parameterValues, systemOverride, userOverride])

  /**
   * 大纲生成的地板来源（= 搬迁前的组件内固定清单，现在这里是唯一事实源）。
   * 协商只能在这之上**追加**；追加项来自 `withPlanFloor` 合并的 AI 申报，
   * 因此「已自动提取上下文来源」不再只是提示词里的一串 key 名。
   */
  const buildOutlineAssembledContext = useCallback(async (
    worldGroupId: number | null,
    outlineNodeId?: number | null,
    selection?: PlanSelection | null,
  ) => {
    return await assembleContext({
      projectId: project.id!,
      worldGroupId,
      outlineNodeId: outlineNodeId ?? null,
      provider: aiConfig.provider,
      model: aiConfig.model,
      // 未走协商时保持原固定清单，行为不变。
      sourceKeys: selection
        ? withPlanFloor(selection, OUTLINE_FLOOR_SOURCES)
        : [...OUTLINE_FLOOR_SOURCES],
      // AI 点名的记录字段必须真正被 ragSelection 源消费，否则等于没申报。
      ragEntryKeys: selection?.ragEntryKeys.length ? selection.ragEntryKeys : undefined,
      subjectCharacterName: selection?.subjectCharacterName ?? undefined,
    })
  }, [project.id, aiConfig.provider, aiConfig.model])

  const generation = useOutlineGenerationController({
    project,
    nodes,
    volumes,
    hint,
    runOptions: generationRunOptions,
    ai,
    assembleContext: buildOutlineAssembledContext,
    openPromptPanel: () => setPromptPanelOpen(true),
    clearPreview: clearGenerationPreview,
    onInfo: toast.info,
    onError: toast.error,
  })

  const requestOutlineGeneration = useCallback((request: OutlineGenerationRequest) => {
    ai.reset()
    clearGenerationPreview()
    if (!outlineNegotiationEnabled) {
      void generation.prepare(request)
      return
    }
    const targetId = request.kind === 'single-chapter' ? request.chapterId : request.kind === 'single-volume' || request.kind === 'chapters' || request.kind === 'chapters-optimize' ? request.volumeId : null
    setNegotiationRequest(request)
    setNegotiationTargetId(targetId)
    setNegotiationMode(request.kind === 'single-chapter' ? 'single-chapter' : request.kind === 'chapters-optimize' ? 'chapters-optimize' : request.kind === 'chapters' ? 'batch-chapters' : 'volume')
  }, [ai, clearGenerationPreview, generation, outlineNegotiationEnabled])

  const handleAIVolumes = () => requestOutlineGeneration({ kind: 'volumes' })
  const handleAIChapter = (chapterId: number) => requestOutlineGeneration({ kind: 'single-chapter', chapterId })
  const handleOptimizeAllChapters = () => {
    if (selectedVol?.id) requestOutlineGeneration({ kind: 'chapters-optimize', volumeId: selectedVol.id })
  }
  const callOutlinePlanModel = useCallback(async (
    messages: import('../../lib/types').ChatMessage[],
    category: PlanCallCategory,
    signal?: AbortSignal,
  ) => {
    if (category === 'chapter.plan.summary') return chat(messages, aiConfig, { category: 'chapter.plan.summary', projectId: project.id! }, signal)
    if (category === 'chapter.plan.ask') return chat(messages, aiConfig, { category: 'chapter.plan.ask', projectId: project.id! }, signal)
    return chat(messages, aiConfig, { category: 'chapter.plan.needs', projectId: project.id! }, signal)
  }, [aiConfig, project.id])
  const handleAIChapters = () => {
    if (selectedVol?.id) requestOutlineGeneration({ kind: 'chapters', volumeId: selectedVol.id })
  }

  // ── 采纳预览 + 确认 ──

  const [restructuring, setRestructuring] = useState(false)
  const handlePreviewAccept = async (text: string) => {
    setRestructuring(true)
    try {
      if (generation.moduleKey === 'outline.volume') {
        const parsed = await parseVolumeOutlineSmart(text, aiConfig)
        if (parsed.length === 0) {
          toast.error('未能从 AI 输出中解析出卷级大纲，请检查输出内容或重试。')
          return
        }
        const operation = decodeGenerationOperation(ai.operation)
        if (operation?.kind === 'single-volume') {
          setPreviewTargetId(operation.volumeId)
          setPreviewVolumes(parsed.slice(0, 1))
        } else {
          setPreviewTargetId(null)
          setPreviewVolumes(parsed)
        }
      } else {
        const parsed = await parseChapterOutlineSmart(text, aiConfig)
        if (parsed.length === 0) {
          toast.error('未能从 AI 输出中解析出章节大纲，请检查输出内容或重试。')
          return
        }
        const operation = decodeGenerationOperation(ai.operation)
        if (operation?.kind === 'single-chapter') {
          const targetChapter = nodes.find(node => node.id === operation.chapterId && node.type === 'chapter')
           setPreviewTargetId(operation.chapterId)
          setPreviewChapters([{ ...parsed[0], title: targetChapter?.title || parsed[0].title }])
        } else {
          setPreviewTargetId(null)
          setPreviewChapters(parsed)
        }
      }
    } finally {
      setRestructuring(false)
    }
  }

  const handleConfirmVolumes = async () => {
    if (!previewVolumes) return
    const targetId = previewTargetId
    ai.reset()
    if (targetId != null) {
      const result = await adoptGeneratedOutlineSummary(project.id!, targetId, previewVolumes[0]?.summary ?? '')
      if (!result.written) {
        toast.error(`未能写入本卷卷纲：${result.reason}`)
        return
      }
      await loadAll(project.id!)
       await handleConfirmGeneratedEntities([{ ...previewVolumes[0], entities: previewVolumes[0].entities }], nodes.find(node => node.id === targetId)?.worldGroupId ?? null)
      setPreviewVolumes(null)
      setPreviewTargetId(null)
      toast.success('本卷卷纲已写入。')
      return
    }
    const existingCount = volumes.length
    let result: Awaited<ReturnType<typeof adoptGeneratedOutlineItems>>
    try {
      result = await adoptGeneratedOutlineItems({
        projectId: project.id!,
        parentId: null,
        type: 'volume',
        items: previewVolumes,
        startingOrder: existingCount,
      })
    } catch (err) {
      logEvent({ level: 'error', tag: 'Outline', event: 'outline', message: '[Outline] 写入卷失败:', error: err })
      toast.error(`写入卷时出错：${err instanceof Error ? err.message : '未知错误'}。请查看控制台获取详情。`)
      return
    }
    await loadAll(project.id!)
    if (result.writtenCount > 0) await handleConfirmGeneratedEntities(result.writtenItems ?? [], null)
    setPreviewVolumes(null)
    setPreviewTargetId(null)
    if (result.firstId) setSelectedVolId(result.firstId)
    // FB-10:不再静默——全跳过/部分跳过都明确告知用户原因
    if (result.writtenCount === 0) {
      toast.error(`未写入任何卷。原因:${result.skippedReasons.join('；') || '与已有卷标题重复(已跳过)'}。若想替换/更新同名卷,请先删除同名卷再采纳。`)
    } else if (result.writtenCount < previewVolumes.length) {
      toast.info(`已写入 ${result.writtenCount} 个卷,另有 ${previewVolumes.length - result.writtenCount} 个被跳过(${result.skippedReasons.join('；') || '标题重复'})。`)
    } else {
      toast.success(`已写入 ${result.writtenCount} 个卷。`)
    }
  }

  const handleConfirmGeneratedEntities = async (items: GeneratedOutlineItem[], worldGroupId: number | null) => {
    const candidates = {
      characters: items.flatMap(item => item.entities?.characters ?? []),
      locations: items.flatMap(item => item.entities?.locations ?? []),
    }
    if (!candidates.characters.length && !candidates.locations.length) return
    const accepted = await dialog.confirm({ title: '大纲附带的新增角色和地点', message: `本次生成同时提供了 ${candidates.characters.length} 个角色、${candidates.locations.length} 个地点，是否纳入设定库？`, confirmText: '纳入设定库', cancelText: '暂不纳入' })
    if (!accepted) return
    const taskId = usePersistentTaskStore.getState().start({ title: '正在保存新增角色和地点' })
    try {
      const result = await adoptGenerationEntityCandidates({ projectId: project.id!, worldGroupId, candidates })
      toast.success(`已纳入 ${result.characters} 个角色、${result.locations} 个地点。`)
    } catch (error) {
      logEvent({ level: 'error', tag: 'AI', event: 'generation.entities.failed', message: '生成结果角色地点采纳失败', error })
      toast.error(`大纲已保存，但角色地点保存失败：${error instanceof Error ? error.message : '未知错误'}。`)
    } finally {
      usePersistentTaskStore.getState().finish(taskId)
    }
  }

  const handleConfirmChapters = async () => {
    if (!previewChapters) return
    const targetId = previewTargetId
    const operation = decodeGenerationOperation(ai.operation)
    ai.reset()
    if (targetId != null) {
      const result = await adoptGeneratedOutlineSummary(project.id!, targetId, previewChapters[0]?.summary ?? '')
      if (!result.written) {
        toast.error(`未能写入本章章纲：${result.reason}`)
        return
      }
      await loadAll(project.id!)
       await handleConfirmGeneratedEntities([previewChapters[0]], nodes.find(node => node.id === targetId)?.worldGroupId ?? null)
      setPreviewChapters(null)
      setPreviewTargetId(null)
      toast.success('本章章纲已写入。')
      return
    }
    const destinationVolume = operation?.kind === 'chapters' || operation?.kind === 'chapters-optimize'
      ? volumes.find(volume => volume.id === operation.volumeId) ?? null
      : selectedVol
    if (!destinationVolume) return
    if (operation?.kind === 'chapters-optimize') {
      const existing = nodes.filter(node => node.type === 'chapter' && node.parentId === destinationVolume.id)
      const result = await adoptOptimizedChapterOutlines({ projectId: project.id!, parentId: destinationVolume.id!, items: previewChapters, existing })
      await loadAll(project.id!)
       await handleConfirmGeneratedEntities(result.writtenItems ?? [], destinationVolume.worldGroupId ?? null)
      setPreviewChapters(null)
      setPreviewTargetId(null)
      toast.success(`已优化或扩展 ${result.writtenCount} 个章节。`)
      return
    }
    const existingCount = nodes.filter(node => node.parentId === destinationVolume.id && node.type === 'chapter').length
    let result: Awaited<ReturnType<typeof adoptGeneratedOutlineItems>>
    try {
      result = await adoptGeneratedOutlineItems({
        projectId: project.id!,
        parentId: destinationVolume.id!,
        type: 'chapter',
        items: previewChapters,
        startingOrder: existingCount,
      })
    } catch (err) {
      logEvent({ level: 'error', tag: 'Outline', event: 'outline', message: '[Outline] 写入章节失败:', error: err })
      toast.error(`写入章节时出错：${err instanceof Error ? err.message : '未知错误'}。请查看控制台获取详情。`)
      return
    }
    await loadAll(project.id!)
    if (result.writtenCount > 0) await handleConfirmGeneratedEntities(result.writtenItems ?? [], destinationVolume.worldGroupId ?? null)
    setPreviewChapters(null)
    setPreviewTargetId(null)
    if (result.writtenCount === 0) {
      toast.error(`未写入任何章节。原因:${result.skippedReasons.join('；') || '与本卷已有章节标题重复(已跳过)'}。`)
    } else if (result.writtenCount < previewChapters.length) {
      toast.info(`已写入 ${result.writtenCount} 章,另有 ${previewChapters.length - result.writtenCount} 章被跳过(${result.skippedReasons.join('；') || '标题重复'})。`)
    }
  }

  const handleDeleteSelectedVolume = async () => {
    if (!selectedVol?.id) return
    const ok = await dialog.confirm({
      title: `删除「${selectedVol.title}」及其所有章节？`,
      message: '此操作不可恢复。',
      confirmText: '删除',
      tone: 'danger',
    })
    if (!ok) return
    deleteNode(selectedVol.id)
    setSelectedVolId(null)
  }

  const batch = useOutlineBatchGeneration({
    projectId: project.id!,
    multiWorldEnabled: Boolean(project.enableMultiWorld),
    volumes,
    nodes,
    hint,
    assembleContext: buildOutlineAssembledContext,
    reloadOutline: () => loadAll(project.id!),
    onError: toast.error,
     onGeneratedEntities: handleConfirmGeneratedEntities,
  })

  // ── 侧栏：卷列表 ──

  const sidebarContent = (
    <OutlineVolumeSidebar
      volumes={volumes}
      nodes={normalizedNodes}
      selectedVolumeId={selectedVolId}
      multiWorldEnabled={Boolean(project.enableMultiWorld)}
      worldGroups={worldGroups}
      aiStreaming={ai.isStreaming}
      batchRunning={batch.running}
      batchProgress={batch.progress}
      batchResult={batch.result}
      activeChapterDrag={activeChapterDrag}
      getActiveChapterDrag={getActiveChapterDrag}
      onClearActiveChapterDrag={clearActiveChapterDrag}
      onSelectVolume={setSelectedVolId}
      onAddVolume={() => { void handleAddVolume() }}
      onGenerateVolumes={handleAIVolumes}
      onGenerateAllChapters={() => {
         if (!selectedVolId) return
         if (!outlineNegotiationEnabled) void batch.generate()
         else {
           ai.reset()
           clearGenerationPreview()
           setNegotiationRequest({ kind: 'all-chapters' })
           setNegotiationTargetId(selectedVolId)
           setNegotiationMode('batch-chapters')
         }
       }}
      onCancelBatch={batch.cancel}
      onConfirmBatch={() => { void batch.confirm() }}
      onDismissBatch={batch.dismiss}
      onReorderVolumes={reorderNodes}
      onMoveChapter={handleMoveChapter}
    />
  )

  // ── 右侧编辑区 ──

  return (
    <PanelLayout
      sidebar={sidebarContent}
      sidebarTitle="📖 大纲"
      defaultWidth={220}
      minWidth={160}
      maxWidth={360}
      className="h-[calc(100vh-8rem)]"
    >
      <div className="p-4 space-y-4">
        <label className="flex items-start gap-2 rounded border border-border bg-bg-surface/60 px-2.5 py-2 text-xs">
          <input type="checkbox" checked={outlineNegotiationEnabled} onChange={event => setOutlineNegotiationEnabled(event.target.checked)} className="mt-0.5 accent-accent" aria-label="大纲生成前协商" />
          <span><span className="font-medium text-text-secondary">生成前协商</span><span className="ml-2 text-[10px] text-text-muted">先梳理目标、确认剧情走向并提取所需资料；可关闭以直接生成。</span></span>
        </label>

        {/* 调参 + 提示 */}
        <CInput value={hint} onChange={e => setHint(e.target.value)} placeholder="给 AI 的补充说明（可选）"
          className="w-full px-3 py-2 bg-bg-surface border border-border rounded-md text-text-primary text-sm focus:outline-none focus:border-accent" />

        <PromptRunPanel
          moduleKey={generation.moduleKey}
          parameterValues={parameterValues}
          onParamChange={setParameterValues}
          systemOverride={systemOverride}
          onSystemOverrideChange={setSystemOverride}
          userOverride={userOverride}
          onUserOverrideChange={setUserOverride}
          open={promptPanelOpen}
          onOpenChange={setPromptPanelOpen}
        />

        {negotiationMode && negotiationRequest && (() => {
          const target = negotiationTargetId != null
            ? normalizedNodes.find(node => node.id === negotiationTargetId && (node.type === 'chapter' || node.type === 'volume'))
            : null
          const volume = target?.type === 'chapter' ? findVolumeForOutlineChapter(normalizedNodes, target.id!) : target
          const title = target?.title ?? (negotiationRequest.kind === 'volumes' ? '全书卷级大纲' : '本卷所有章节')
          const summary = target?.summary || (volume?.summary ?? '')
          const siblingChapters = volume
            ? normalizedNodes.filter(node => node.type === 'chapter' && node.parentId === volume.id).sort((a, b) => a.order - b.order)
            : []
          return <OutlinePlanNegotiationPanel
            runtime={{ projectId: project.id!, worldGroupId: target?.worldGroupId ?? volume?.worldGroupId ?? null, outlineNodeId: target?.id ?? null, chapterId: null, provider: aiConfig.provider, model: aiConfig.model }}
            chapterTitle={title}
            chapterSummary={summary}
            planningScope={negotiationRequest.kind === 'single-chapter' ? 'chapter' : 'volume'}
             negotiationTitle={outlineNegotiationTitle(negotiationRequest)}
            positionContext={volume && target?.type === 'chapter'
              ? `所属卷：${volume.title}\n目标章序号：${siblingChapters.findIndex(node => node.id === target.id) + 1} / ${siblingChapters.length}\n卷内章节顺序：\n${siblingChapters.map((node, index) => `${index + 1}. ${node.id === target.id ? '【目标章】' : ''}${node.title}${node.summary ? `：${node.summary}` : '（暂无章纲）'}`).join('\n')}`
              : undefined}
            userHint={hint || undefined}
            call={callOutlinePlanModel}
            onCancel={() => { setNegotiationTargetId(null); setNegotiationMode(null); setNegotiationRequest(null) }}
            onConfirm={(planHint, selection) => {
              const request = negotiationRequest
              setNegotiationTargetId(null)
              setNegotiationMode(null)
              setNegotiationRequest(null)
              // selection 必须交给装配：否则 AI 提取的 key 只是提示词里的一串名字。
              if (request.kind === 'all-chapters') void batch.generate(planHint, selection)
              else void generation.prepare(request, planHint, selection)
            }}
          />
        })()}

        {generation.pendingRequest && (
          <OutlineGenerationRequestPanel
            request={generation.pendingRequest}
            preparedContext={generation.preparedContext}
            loading={generation.contextLoading}
            error={generation.contextError}
            messages={generation.preparedNode?.messages}
            transparentMode={generation.transparentMode}
            promptReviewOpen={generation.promptReviewOpen}
            onTransparentModeChange={generation.setTransparentMode}
            onClosePromptReview={generation.closePromptReview}
            onConfirmMessages={messages => { void generation.confirmMessages(messages) }}
            onRetry={() => { void generation.prepare(generation.pendingRequest!) }}
            onCancel={generation.cancel}
            onConfirm={() => { void generation.confirm() }}
          />
        )}

        <OutlineGenerationResultPanel
          output={ai.output}
          isStreaming={ai.isStreaming}
          error={ai.error}
          tokenUsage={ai.tokenUsage}
          moduleKey={generation.moduleKey}
          restructuring={restructuring}
          previewVolumes={previewVolumes}
          previewChapters={previewChapters}
          previewTargetId={previewTargetId}
          selectedVolumeTitle={selectedVol?.title}
          onStop={ai.stop}
          onAccept={handlePreviewAccept}
          onRetry={() => { void generation.retry() }}
          onConfirmVolumes={() => { void handleConfirmVolumes() }}
          onConfirmChapters={() => { void handleConfirmChapters() }}
          onCancelPreview={clearGenerationPreview}
        />

        <OutlineVolumeDetail
          volume={selectedVol}
          nodes={normalizedNodes}
          multiWorldEnabled={Boolean(project.enableMultiWorld)}
          worldGroups={worldGroups}
          aiStreaming={ai.isStreaming}
          activeChapterDrag={activeChapterDrag}
          getActiveChapterDrag={getActiveChapterDrag}
          onChapterDragStart={beginChapterDrag}
          onChapterDragEnd={clearActiveChapterDrag}
          onUpdateNode={updateNode}
          onDeleteNode={deleteNode}
          onGenerateVolume={volumeId => { void generation.prepare({ kind: 'single-volume', volumeId }) }}
          onGenerateAllChapters={handleAIChapters}
           onOptimizeAllChapters={handleOptimizeAllChapters}
          onAddChapter={parentId => { void handleAddChapter(parentId) }}
          onDeleteVolume={() => { void handleDeleteSelectedVolume() }}
          onAddStructure={structure => { void handleAddStructure(structure) }}
          onInsertChapterAfter={(chapterId, parentId) => { void handleInsertChapterAfter(chapterId, parentId) }}
          onGenerateChapter={handleAIChapter}
          onOpenChapter={onOpenChapter}
          onReorderNodes={orderedIds => { void reorderNodes(orderedIds) }}
          onMoveChapter={handleMoveChapter}
        />
      </div>
    </PanelLayout>
  )
}
