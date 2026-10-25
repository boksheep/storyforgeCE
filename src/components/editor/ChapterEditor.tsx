import { lazy, Suspense, useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { FileText, ClipboardList, AlertTriangle } from 'lucide-react'
import { useChapterStore } from '../../stores/chapter'
import { useNoteStore } from '../../stores/note'
import { useOutlineStore } from '../../stores/outline'
import { useStateCardStore } from '../../stores/state-card'
import { useCharacterStore } from '../../stores/character'
import { useAIStream } from '../../hooks/useAIStream'
import { createAISessionKey } from '../../stores/ai-generation-session'
import { useChapterAutoSave } from '../../hooks/useChapterAutoSave'
import { useBeforeUnload } from '../../hooks/useBeforeUnload'
import { buildChapterContentPrompt, buildContinuePrompt, buildPolishPrompt, buildExpandPrompt, buildDeAIPrompt } from '../../lib/ai/adapters/chapter-adapter'
import { buildReviewRevisePrompt, type ReviewResult } from '../../lib/ai/adapters/review-adapter'
import { buildStateExtractPrompt, parseStateDiffs } from '../../lib/ai/adapters/state-extract-adapter'
import { rebuildChapterChunks, ensureChunkEmbeddings, rebuildProjectNarrativeSummaries } from '../../lib/retrieval/retrieval'
import { isEmbeddingReady } from '../../lib/ai/adapters/embedding-adapter'
import { propagateChapterEditStale, analyzeEditImpact } from '../../lib/consistency/impact-analysis'
import { runChapterMemoryTask } from '../../lib/ai/chapter-memory/run-chapter-memory'
import { prepareContinuityContext, type PreparedContinuityContext } from '../../lib/ai/chapter-memory/continuity-context'
import { isPlanReconciliationCurrent } from '../../lib/ai/chapter-memory/plan-reconciliation'
import { findNextCanonicalChapter, findPreviousCanonicalChapter } from '../../lib/ai/chapter-memory/canonical-chapter-sequence'
import { chat, resolveRequestConfig } from '../../lib/ai/client'
import { getAIConfigRequiredMessage, isAIConfigReady } from '../../lib/ai/config-readiness'
import { classifyAITask, TASK_ROUTE_META } from '../../lib/ai/task-routing'
import { db } from '../../lib/db/schema'
import { buildGenreConstraintContext } from '../../lib/ai/genre-metadata'
import { buildStylePromptInjection } from '../../lib/ai/writing-styles'
import { assembleContext } from '../../lib/registry/assemble-context'
import { resolveChapterDisplayMeta } from '../../lib/outline/chapter-display'
import { pickBestChapterForOutline, effectiveChapterWordCount } from '../../lib/chapters/selectors'
import { buildSurfaceToCanonicalMap } from '../../lib/character/character-identity'
import { useCreativeRulesStore } from '../../stores/project-singletons'
import { useStoryArcStore } from '../../stores/story-arc'
import { useForeshadowStore } from '../../stores/foreshadow'
import { htmlToPlainText, plainTextToHtml, countWords } from '../../lib/utils/html'
import { createTypingStats, formatTypingDuration, recordTypingActivity, typingWordsPerMinute } from '../../lib/chapters/typing-stats'
import { recordChapterContentStep } from '../../lib/history/step-recorder'
import AIStreamOutput from '../shared/AIStreamOutput'
import ContextBudgetBar from '../shared/ContextBudgetBar'
import { useDialog } from '../shared/Dialog'
import { useReviewResultStore } from '../../stores/review-result'
import { useAIConfigStore } from '../../stores/ai-config'
import { analyzeContextSegments, calculateBudget, getModelPreset, type ContextBudget } from '../../lib/ai/context-budget'
import {
  prepareGenerationNode,
  runGenerationNode,
  type PreparedGenerationNode,
} from '../../lib/generation/generation-node'
import {
  createChapterGenerationNode,
  type ChapterGenerationCategory,
  type ChapterGenerationOperation,
} from '../../lib/generation/chapter-generation-node'
import RichEditor, { type RichEditorHandle } from './RichEditor'
import EmotionBeatCard from './EmotionBeatCard'
import FloatingToolbar from './FloatingToolbar'
import ChapterEditorHeader from './ChapterEditorHeader'
import ChapterMemoryPanel from './ChapterMemoryPanel'
import ChapterContextPreview from './ChapterContextPreview'
import ChapterEditorToolbar from './ChapterEditorToolbar'
import PromptPreviewGate from '../shared/PromptPreviewGate'
import PlanRequestedFields from '../shared/PlanRequestedFields'
import ChapterPlanPanel, { type PlanCallCategory } from './ChapterPlanPanel'
import GenerationStatusBar, { getGenerationStatusTitle, shouldShowGenerationStatus } from './GenerationStatusBar'
import { PLAN_FLOOR_SOURCES, formatPlanUserHint, type PlanSelection } from '../../lib/generation/plan-needs'
import { mergeAuthorHint } from '../../lib/generation/plan-ask'
import { TimeoutError, withTimeout, CONTEXT_ASSEMBLE_TIMEOUT_MS, PREP_TIMEOUT_MS } from '../../lib/utils/with-timeout'
import { useItemLedgerStore } from '../../stores/item-ledger'
import { useLocationStore } from '../../stores/location'
import { useCodexStore } from '../../stores/codex'
import { buildEditorEntityReferences } from '../../lib/editor/entity-reference'
import type { ChatMessage, Project, StateDiffItem } from '../../lib/types'
import {
  adoptChapterOrganizationSelection,
  isChapterOrganizationCurrent,
  persistChapterOrganizationCandidate,
  readLatestChapterOrganizationRun,
  runChapterOrganization,
  type ChapterOrganizationRun,
  type ChapterOrganizationSelection,
} from '../../lib/agent/chapter-organization'
import { AgentTeamBudgetTracker } from '../../lib/agent/team-budget'
import { log, logEvent } from '../../lib/logging/logger'
import { extractGenerationEntityCandidates, adoptGenerationEntityCandidates } from '../../lib/generation/generation-entity-adoption'
import {
  isConsistencyAgentCurrent,
  persistConsistencyAgentCandidate,
  readLatestConsistencyAgentRun,
  runBackgroundConsistencyAgent,
  toConsistencyAuditResult,
  type ConsistencyAgentRun,
} from '../../lib/agent/consistency-agent'

const StateDiffModal = lazy(() => import('../state/StateDiffModal'))
const OutlinePreview = lazy(() => import('../outline/OutlinePreview'))
const ReviewPanel = lazy(() => import('./ReviewPanel'))
const NotePanel = lazy(() => import('./NotePanel'))
const ComparePolishPanel = lazy(() => import('./ComparePolishPanel'))
const ChapterOrganizationModal = lazy(() => import('./ChapterOrganizationModal'))

function LazyPanelFallback() {
  return <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-text-muted">面板加载中...</div>
}

/** 生成任务类型(原 memory-builder 三层记忆已被 assembleContext 取代,此类型仅用于调试日志标签) */
type MemoryTaskType = 'write' | 'plan' | 'review'

interface PendingChapterGeneration {
  operation: ChapterGenerationOperation
  category: ChapterGenerationCategory
  prepared: PreparedGenerationNode
  backgroundMemoryIds: number[]
}

interface PendingEditGeneration {
  operation: 'polish' | 'expand'
  messages: ChatMessage[]
  targetText: string
}

interface Props {
  project: Project
  outlineNodeId?: number | null
}

/**
 * STEP-1：AI 对正文的操作 → 撤回历史里的步骤名。
 * 键是 `useAIStream` 的 operation，未知操作回退为「AI 修改正文」。
 */
const AI_ACTION_LABELS: Record<string, string> = {
  generate: 'AI 生成正文',
  continue: 'AI 续写正文',
  polish: 'AI 润色正文',
  expand: 'AI 扩写正文',
  deai: 'AI 去AI味（选区）',
  'deai-full': 'AI 去AI味（全文）',
  'revise-full': 'AI 按报告修改正文',
}

export default function ChapterEditor({ project, outlineNodeId }: Props) {
  const {
    chapters,
    currentChapter,
    selectChapter,
    getOrCreateByOutlineNode,
    updateChapter,
    refreshChapter,
    loadAll: loadChapters,
  } = useChapterStore()
  const { nodes, updateNode } = useOutlineStore()
  const { cards: stateCards, loadAll: loadStateCards, selectStateCardIds, applyDiffs } = useStateCardStore()
  const { characters, loadAll: loadCharacters } = useCharacterStore()
  const { creativeRules } = useCreativeRulesStore()
  const { loadAll: loadArcs } = useStoryArcStore()
  const { buildForeshadowContext, loadAll: loadForeshadows } = useForeshadowStore()
  const { entries: itemEntries, loadAll: loadItemLedger } = useItemLedgerStore()
  const { locations, loadAll: loadLocations } = useLocationStore()
  const { categories: codexCategories, entries: codexEntries, loadExisting: loadCodex } = useCodexStore()

  // content 为 HTML 字符串；旧数据是纯文本，RichEditor 内部会自动包装
  const [content, setContent] = useState('')
  const [contentChapterId, setContentChapterId] = useState<number | undefined>()
  const contentRef = useRef(content)
  contentRef.current = content
  const [plainText, setPlainText] = useState('')
  const [savedContent, setSavedContent] = useState('')
  const typingStatsRef = useRef(currentChapter?.typingStats)
  const previousTypedTextRef = useRef('')
  const typingPersistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const currentChapterIdRef = useRef<number | undefined>(currentChapter?.id)
  const loadedChapterRef = useRef<{ id: number | undefined; content: string } | null>(null)
  const [manualSaving, setManualSaving] = useState(false)
  const [manualSaveError, setManualSaveError] = useState('')
  const [showContext, setShowContext] = useState(false)
  const [customInstruction, setCustomInstruction] = useState('')
  const [impactInfo, setImpactInfo] = useState<string | null>(null)
  const [analyzingImpact, setAnalyzingImpact] = useState(false)
  const [pendingDiffs, setPendingDiffs] = useState<StateDiffItem[] | null>(null)
  // A2: 按需召回 — 手动额外勾选/取消的状态卡 ID
  const [extraStateIds, setExtraStateIds] = useState<number[]>([])
  const [showStatePreview, setShowStatePreview] = useState(false)
  const ai = useAIStream(createAISessionKey(
    project.id!,
    'chapter.content',
    currentChapter?.id ?? outlineNodeId ?? 'unselected',
  ))
  const stateAI = useAIStream()
  const memoryAI = useAIStream()
  const editorRef = useRef<RichEditorHandle>(null)
  const organizationAbortRef = useRef<AbortController | null>(null)
  const consistencyRunRef = useRef<ConsistencyAgentRun | null>(null)
  const memoryRebuildInFlightRef = useRef(new Set<number>())
  const creatingChapterForOutlineRef = useRef(new Set<number>())
  const reviseReportRef = useRef<ReviewResult | null>(null)  // G8：记住上次"按报告修改"的报告，供重试
  // Phase A1: 自动流程标记
  const [autoProcessing, setAutoProcessing] = useState<'idle' | 'extracting' | 'memory'>('idle')
  const [showOutlinePreview, setShowOutlinePreview] = useState(false)
  const [showReviewPanel, setShowReviewPanel] = useState(false)
  const [showNotePanel, setShowNotePanel] = useState(false)
  const [addingNote, setAddingNote] = useState(false)
  const noteAreaRef = useRef<HTMLDivElement>(null)
  const notePaperRef = useRef<HTMLDivElement>(null)
  const [compareSourceHtml, setCompareSourceHtml] = useState<string | null>(null)
  const [contextBudget, setContextBudget] = useState<ContextBudget | null>(null)
  const [transparentMode, setTransparentMode] = useState(true)
  const [pendingGeneration, setPendingGeneration] = useState<PendingChapterGeneration | null>(null)
  // PROMPT-PLAN-1: 生成前协商（opt-in）。产物是会话级 state，不落库。
  const [planMode, setPlanMode] = useState(true)
  const [planRequest, setPlanRequest] = useState<{ operation: 'generate' | 'continue' | 'polish' | 'expand'; targetText?: string } | null>(null)
  const [pendingEditGeneration, setPendingEditGeneration] = useState<PendingEditGeneration | null>(null)
  const [planSelection, setPlanSelection] = useState<PlanSelection | null>(null)
  const [planReconciliationCurrent, setPlanReconciliationCurrent] = useState(false)
  const [organizationRun, setOrganizationRun] = useState<ChapterOrganizationRun | null>(null)
  const [organizationCurrent, setOrganizationCurrent] = useState(false)
  const [organizingChapter, setOrganizingChapter] = useState(false)
  const [organizationError, setOrganizationError] = useState('')
  const [showOrganization, setShowOrganization] = useState(false)
  const [consistencyRun, setConsistencyRun] = useState<ConsistencyAgentRun | null>(null)
  const [consistencyCurrent, setConsistencyCurrent] = useState(false)
  const aiConfig = useAIConfigStore(s => s.config)
  const dialog = useDialog()

  const { schedule: scheduleChapterSave, flush: flushChapterSave } = useChapterAutoSave(async (chapterId, html) => {
    await updateChapter(chapterId, { content: html, wordCount: countWords(htmlToPlainText(html)) })
    if (currentChapterIdRef.current === chapterId && contentRef.current === html) setSavedContent(html)
  })

  const applyEditedContent = (html: string, plain: string) => {
    contentRef.current = html
    setContent(html)
    setPlainText(plain)
    if (currentChapter?.id) scheduleChapterSave(currentChapter.id, html)
  }

  useEffect(() => {
    consistencyRunRef.current = consistencyRun
  }, [consistencyRun])

  // 字数（基于纯文本）
  const wordCount = useMemo(() => countWords(plainText), [plainText])

  // 长期码字统计：逐键只在内存累加，防抖落盘，避免每个字符都写库并触发全局重渲染。
  useEffect(() => {
    if (!currentChapter?.id || previousTypedTextRef.current === plainText) return
    const nextStats = recordTypingActivity(typingStatsRef.current, typingStatsRef.current?.lastTypedAt, previousTypedTextRef.current, plainText)
    typingStatsRef.current = nextStats
    previousTypedTextRef.current = plainText
    const chapterId = currentChapter.id
    if (typingPersistTimerRef.current) clearTimeout(typingPersistTimerRef.current)
    typingPersistTimerRef.current = setTimeout(() => {
      typingPersistTimerRef.current = null
      void updateChapter(chapterId, { typingStats: typingStatsRef.current })
      // debug 级别：默认级别（info）不会写进 txt，需要排查码字统计时再调级别。
      log.debug('TypingStats', 'typing.stats.persisted', '码字统计已落盘', {
        chapterId,
        typedCharacters: typingStatsRef.current?.typedCharacters,
        activeTypingMs: typingStatsRef.current?.activeTypingMs,
        wordsPerMinute: typingStatsRef.current
          ? typingWordsPerMinute(typingStatsRef.current)
          : undefined,
      })
    }, 1200)
    return () => {
      if (typingPersistTimerRef.current) clearTimeout(typingPersistTimerRef.current)
    }
  }, [plainText, currentChapter?.id, updateChapter])

  // 离开编辑器（切模块/卸载）时把未落盘的统计补写一次。
  useEffect(() => () => {
    const chapterId = currentChapterIdRef.current
    if (typingPersistTimerRef.current) {
      clearTimeout(typingPersistTimerRef.current)
      typingPersistTimerRef.current = null
    }
    if (chapterId != null && typingStatsRef.current) {
      void updateChapter(chapterId, { typingStats: typingStatsRef.current })
    }
  }, [updateChapter])

  // 有未保存内容时阻止页面关闭
  useBeforeUnload(content !== savedContent && plainText.length > 0)

  useEffect(() => { loadChapters(project.id!) }, [project.id, loadChapters])
  useEffect(() => { loadStateCards(project.id!) }, [project.id, loadStateCards])
  useEffect(() => { loadCharacters(project.id!) }, [project.id, loadCharacters])
  useEffect(() => { loadArcs(project.id!) }, [project.id, loadArcs])
  useEffect(() => { loadForeshadows(project.id!) }, [project.id, loadForeshadows])
  useEffect(() => { loadItemLedger(project.id!) }, [project.id, loadItemLedger])
  useEffect(() => { loadLocations(project.id!) }, [project.id, loadLocations])
  useEffect(() => { loadCodex(project.id!) }, [project.id, loadCodex])
  useEffect(() => {
    let active = true
    setOrganizationRun(null)
    setOrganizationCurrent(false)
    setShowOrganization(false)
    setOrganizationError('')
    if (!currentChapter?.id) return () => { active = false }
    void (async () => {
      const run = await readLatestChapterOrganizationRun({
        projectId: project.id!,
        chapterId: currentChapter.id!,
      })
      const current = run ? await isChapterOrganizationCurrent(run.candidate) : false
      if (!active) return
      setOrganizationRun(run)
      setOrganizationCurrent(current)
    })().catch(error => {
      if (active) setOrganizationError(error instanceof Error ? error.message : '读取整理记录失败')
    })
    return () => { active = false }
  }, [currentChapter?.id, project.id])
  useEffect(() => {
    let active = true
    setConsistencyRun(null)
    setConsistencyCurrent(false)
    if (!currentChapter?.id) return () => { active = false }
    void (async () => {
      const run = await readLatestConsistencyAgentRun({
        projectId: project.id!,
        chapterId: currentChapter.id!,
      })
      const current = run ? await isConsistencyAgentCurrent(run.candidate) : false
      if (!active) return
      setConsistencyRun(run)
      setConsistencyCurrent(current)
      if (run) {
        useReviewResultStore.getState().setConsistency(
          currentChapter.id!,
          toConsistencyAuditResult(run.candidate),
        )
      }
    })()
    return () => { active = false }
  }, [currentChapter?.id, project.id])
  // 切换章节/大纲节点时，上一章的协商结果作废（会话级，不跨章复用）。
  //
  // ⚠️ 必须区分"切换"与"落定"：从大纲进入工作区时 `currentChapter?.id` 会由 undefined 落到真实 id
  //（自动建章）。把这次落定当成切换，就会在作者刚点开协商/刚打开预览的那一刻把它清掉 ——
  // 真实事故：「仅勾选发送前预览时，原本应该有的预览直接不见了」。
  // 因此只在 outlineNodeId 变化、或章节 id 在两个**非空**值之间变化时才动作。
  const chapterIdentityRef = useRef<{ outlineNodeId: string; chapterId: string } | null>(null)
  useEffect(() => {
    const next = { outlineNodeId: String(outlineNodeId ?? ''), chapterId: String(currentChapter?.id ?? '') }
    const previous = chapterIdentityRef.current
    chapterIdentityRef.current = next
    if (!previous) return
    const outlineChanged = previous.outlineNodeId !== next.outlineNodeId
    const chapterChanged = previous.chapterId !== '' && next.chapterId !== '' && previous.chapterId !== next.chapterId
    if (!outlineChanged && !chapterChanged) return
    setPendingGeneration(null)
    setPlanRequest(null)
    setPlanSelection(null)
    setGenerationNotice('')
    // 正在跑的生成不要在这里放闸门：流是会话级的，切章不会终止它，
    // 释放闸门等于允许并行发起第二次生成。等它自己结束（runPrepared 的 finally 释放）。
    if (!ai.isStreaming) endGeneration()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentChapter?.id, outlineNodeId])

  // 如果从大纲进入，选择/创建对应章节（自动创建）
  useEffect(() => {
    if (!outlineNodeId) return
    const existing = pickBestChapterForOutline(chapters.filter(c => c.outlineNodeId === outlineNodeId))
    if (existing?.id) {
      selectChapter(existing.id)
      return
    }

    const node = nodes.find(n => n.id === outlineNodeId)
    if (!node || creatingChapterForOutlineRef.current.has(outlineNodeId)) return

    creatingChapterForOutlineRef.current.add(outlineNodeId)
    void getOrCreateByOutlineNode(project.id!, outlineNodeId, {
      title: node.title,
      content: '', wordCount: 0, status: 'outline', order: chapters.length, notes: '',
    })
      .then(chapter => {
        if (chapter.id) selectChapter(chapter.id)
      })
      .finally(() => {
        creatingChapterForOutlineRef.current.delete(outlineNodeId)
      })
  }, [outlineNodeId, chapters, selectChapter, nodes, getOrCreateByOutlineNode, project.id])

  const persistCurrentEditorContent = useCallback(async (): Promise<{ html: string; plain: string; wordCount: number } | null> => {
    if (!currentChapter?.id) return null
    await flushChapterSave()
    const html = editorRef.current?.getHTML() ?? content
    const plain = editorRef.current?.getPlainText() ?? htmlToPlainText(html)
    const wc = countWords(plain)
    await updateChapter(currentChapter.id, { content: html, wordCount: wc })
    setContent(html)
    setPlainText(plain)
    setSavedContent(html)
    return { html, plain, wordCount: wc }
  }, [content, currentChapter?.id, updateChapter, flushChapterSave])

  const handleManualSave = useCallback(async () => {
    if (manualSaving) return
    setManualSaving(true)
    setManualSaveError('')
    try {
      await persistCurrentEditorContent()
    } catch (error) {
      setManualSaveError(error instanceof Error ? error.message : String(error))
    } finally {
      setManualSaving(false)
    }
  }, [manualSaving, persistCurrentEditorContent])

  // 切换章节：同步到本地 state（RichEditor 会基于 value 重建内容）
  useEffect(() => {
    const raw = currentChapter?.content || ''
    if (loadedChapterRef.current?.id === currentChapter?.id && loadedChapterRef.current?.content === raw) {
      currentChapterIdRef.current = currentChapter?.id
      return
    }
    // 切章前把上一章尚未落盘的统计与正文补写，避免防抖窗口内丢失计时或输入。
    const previousId = loadedChapterRef.current?.id
    if (previousId != null && previousId !== currentChapter?.id) {
      if (typingPersistTimerRef.current) {
        clearTimeout(typingPersistTimerRef.current)
        typingPersistTimerRef.current = null
      }
      if (typingStatsRef.current) void updateChapter(previousId, { typingStats: typingStatsRef.current })
      void flushChapterSave()
    }
    loadedChapterRef.current = { id: currentChapter?.id, content: raw }
    currentChapterIdRef.current = currentChapter?.id
    const plain = htmlToPlainText(raw)
    setContent(raw)
    setContentChapterId(currentChapter?.id)
    setPlainText(plain)
    previousTypedTextRef.current = plain
    const stats = currentChapter?.typingStats ?? createTypingStats()
    typingStatsRef.current = stats
  }, [currentChapter, updateChapter, flushChapterSave])

  // 切换章节时同步 savedContent（只在章节 id 变化时）
  useEffect(() => {
    setSavedContent(currentChapter?.content || '')
    setManualSaveError('')
  }, [currentChapter?.id]) // eslint-disable-line react-hooks/exhaustive-deps -- 保存基线只在切章时重置，自动保存不能重置脏状态

  useEffect(() => {
    setCompareSourceHtml(null)
  }, [currentChapter?.id])

  useEffect(() => {
    let cancelled = false
    if (!currentChapter?.planReconciliation) {
      setPlanReconciliationCurrent(false)
      return
    }
    isPlanReconciliationCurrent(project.id!, currentChapter).then(current => {
      if (!cancelled) setPlanReconciliationCurrent(current)
    })
    return () => { cancelled = true }
  }, [project.id, currentChapter])

  // 只有真实编辑才排队保存；初次装载正文和切章时的 state 同步不能写回 IndexedDB。

  const outlineNode = currentChapter ? nodes.find(n => n.id === currentChapter.outlineNodeId) : null
  const chapterDisplay = useMemo(() => {
    return currentChapter ? resolveChapterDisplayMeta(currentChapter, nodes) : null
  }, [currentChapter, nodes])
  // 多世界：沿父链找到所属卷的 worldGroupId
  const chapterWorldGroupId = useMemo(() => {
    if (!project.enableMultiWorld || !outlineNode) return null
    let cur: typeof outlineNode | undefined = outlineNode
    const guard = new Set<number>()
    while (cur && !guard.has(cur.id!)) {
      if (cur.worldGroupId != null) return cur.worldGroupId
      guard.add(cur.id!)
      cur = cur.parentId != null ? nodes.find(n => n.id === cur!.parentId) : undefined
    }
    return null
  }, [project.enableMultiWorld, outlineNode, nodes])

  // 后台一致性 Agent：正文稳定落盘后只跑零 token 确定性守卫。
  // 没有告警时不制造归档记录；LLM fast/deep 必须由质量审校面板中的明确按钮触发。
  useEffect(() => {
    let active = true
    const chapterId = currentChapter?.id
    const savedPlain = htmlToPlainText(savedContent).trim()
    if (!chapterId || !savedPlain) return () => { active = false }
    const timer = setTimeout(() => {
      void (async () => {
        if (consistencyRunRef.current) {
          const current = await isConsistencyAgentCurrent(consistencyRunRef.current.candidate)
          if (active) setConsistencyCurrent(current)
        }
        const budget = new AgentTeamBudgetTracker(
          useAIConfigStore.getState().agentTeamBudgetProfile,
        )
        const candidate = await runBackgroundConsistencyAgent({
          projectId: project.id!,
          chapterId,
          chapterTitle: outlineNode?.title || currentChapter.title || '未知章节',
          worldGroupId: chapterWorldGroupId ?? null,
          chapterContent: savedContent,
          budget,
        })
        if (!active || candidate.findings.length === 0) return
        const run = await persistConsistencyAgentCandidate(candidate)
        if (!active) return
        setConsistencyRun(run)
        setConsistencyCurrent(true)
        useReviewResultStore.getState().setConsistency(
          chapterId,
          toConsistencyAuditResult(candidate),
        )
      })().catch(error => {
        logEvent({ level: 'error', tag: 'ConsistencyAgent', event: 'consistencyagent', message: '[ConsistencyAgent] 后台确定性检查失败:', error })
      })
    }, 350)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [
    chapterWorldGroupId,
    currentChapter?.id,
    currentChapter?.title,
    outlineNode?.title,
    project.id,
    savedContent,
  ])
  const entityReferences = useMemo(() => buildEditorEntityReferences({
    characters,
    itemEntries,
    locations,
    codexCategories,
    codexEntries,
    worldGroupId: project.enableMultiWorld ? chapterWorldGroupId : undefined,
  }), [characters, itemEntries, locations, codexCategories, codexEntries, project.enableMultiWorld, chapterWorldGroupId])

  const [worldCtx, setWorldCtx] = useState('')
  const [charCtx, setCharCtx] = useState('')
  useEffect(() => {
    let cancelled = false
    assembleContext({
      projectId: project.id!,
      worldGroupId: chapterWorldGroupId ?? null,
      outlineNodeId: outlineNode?.id ?? null,
      chapterId: currentChapter?.id ?? null,
      provider: aiConfig.provider,
      model: aiConfig.model,
      // ALIAS-1: 正文的角色上下文改用 characterFocus（本章相关角色 + 其余名单），
      // 不再把整个世界全部角色一次性灌进来再由预算砍尾。
      sourceKeys: ['contextMemo', 'chapterOutline', 'canonAssertions', 'worldview', 'storyCore', 'characterDrivenPlan', 'powerSystem', 'cultivationProgress', 'codex', 'characterFocus', 'creativeRules', 'worldRules', 'historical', 'locations', 'mapRelevantFacts', 'userStyleProfile'],
    }).then(assembled => {
      if (cancelled) return
      const charIdx = assembled.included.indexOf('characterFocus')
      setWorldCtx(assembled.text)
      setCharCtx(charIdx >= 0 ? assembled.segments[charIdx]?.content ?? '' : '')
    })
    return () => { cancelled = true }
  }, [project.id, chapterWorldGroupId, outlineNode?.id, currentChapter?.id, aiConfig.provider, aiConfig.model])

  // A2: 按需召回 — 根据章节大纲+标题+已有文本筛选相关状态卡
  const selectiveState = useMemo(() => {
    if (!stateCards.length) return { matchedIds: [] as number[], allIds: [] as number[] }
    const refParts: string[] = []
    if (outlineNode?.title) refParts.push(outlineNode.title)
    if (outlineNode?.summary) refParts.push(outlineNode.summary)
    if (currentChapter?.title) refParts.push(currentChapter.title)
    if (plainText) refParts.push(plainText.slice(-2000))
    const ref = refParts.join(' ')
    return selectStateCardIds(ref, extraStateIds)
  }, [stateCards, outlineNode?.title, outlineNode?.summary, currentChapter?.title, plainText, extraStateIds, selectStateCardIds])

  const assembleCurrentStateContext = useCallback(async (referenceText: string): Promise<string> => {
    const assembled = await assembleContext({
      projectId: project.id!,
      chapterId: currentChapter?.id ?? null,
      worldGroupId: chapterWorldGroupId ?? null,
      stateReferenceText: referenceText,
      extraStateIds,
      sourceKeys: ['currentFacts', 'stateCards'],
      provider: aiConfig.provider,
      model: aiConfig.model,
    })
    return assembled.text
  }, [project.id, currentChapter?.id, chapterWorldGroupId, extraStateIds, aiConfig.provider, aiConfig.model])

  const handleCreateFromOutline = async () => {
    if (!outlineNodeId) return
    const node = nodes.find(n => n.id === outlineNodeId)
    if (!node) return
    const chapter = await getOrCreateByOutlineNode(project.id!, outlineNodeId, {
      title: node.title,
      content: '', wordCount: 0, status: 'outline', order: chapters.length, notes: '',
    })
    if (chapter.id) selectChapter(chapter.id)
  }

  const handleOpenComparePolish = async () => {
    const saved = await persistCurrentEditorContent()
    if (!saved?.plain.trim()) {
      await dialog.alert({ title: '暂无正文可供对照', message: '请先写入或生成本章正文，再打开对照润色。' })
      return
    }
    setCompareSourceHtml(saved.html)
  }

  // AI 操作 —— 所有 AI 交互都基于纯文本
  // Phase A2: 使用三层记忆构建器生成完整上下文
  const rebuildChapterMemoryById = async (chapterId: number): Promise<void> => {
    if (memoryRebuildInFlightRef.current.has(chapterId)) return
    const chapter = await db.chapters.get(chapterId)
    if (!chapter?.content?.trim()) return
    const chapterTitle = nodes.find(node => node.id === chapter.outlineNodeId)?.title || chapter.title
    memoryRebuildInFlightRef.current.add(chapterId)
    try {
      const result = await runChapterMemoryTask({
        projectId: project.id!,
        chapterId,
        chapterTitle,
        chapterContent: chapter.content,
        call: messages => chat(messages, aiConfig, {
          category: 'chapter.memory',
          projectId: project.id!,
        }),
      })
      if (result.status === 'written') await refreshChapter(chapterId)
    } catch (error) {
      log.warn('ChapterMemory', 'chaptermemory', '[ChapterMemory] 惰性重建失败，继续使用 tail 降级:', { error: String(error) })
    } finally {
      memoryRebuildInFlightRef.current.delete(chapterId)
    }
  }

  const prepareContinuityBeforeGeneration = async (): Promise<PreparedContinuityContext | null> => {
    if (!currentChapter?.id) return null
    const snapshot = await prepareContinuityContext({
      projectId: project.id!,
      chapterId: currentChapter.id,
    })
    if (snapshot.anomalies.length) {
      log.warn('ChapterMemory', 'chaptermemory', '[ChapterMemory] 规范章节序列 anomalies:', { count: snapshot.anomalies.length })
    }
    const predecessorId = snapshot.predecessor?.chapter.id
    if (predecessorId != null && snapshot.memoryRebuildCandidateIds.includes(predecessorId)) {
      // 直接前驱优先且同步补建；失败仍由真实 tail 保底。
      await rebuildChapterMemoryById(predecessorId)
    }
    return snapshot
  }

  /**
   * 这次生成要顺手补建哪些章节的记忆（直接前驱已同步补建，故排除）。
   *
   * 与 `prepareContinuityBeforeGeneration` 拆开的原因：那份快照本身要**原样传给装配**
   * （见 `buildFullWorldCtx` 的 `continuitySnapshot`）——否则同一次生成会把
   * 章序解析、前驱正文 hash、对账校验各做两遍。
   */
  const backgroundMemoryIdsOf = (snapshot: PreparedContinuityContext | null): number[] => {
    if (!snapshot) return []
    const predecessorId = snapshot.predecessor?.chapter.id
    return snapshot.memoryRebuildCandidateIds
      .filter(id => id !== predecessorId)
      .slice(-4)
  }

  const scheduleRecentMemoryRebuild = (chapterIds: number[]) => {
    if (!chapterIds.length) return
    void (async () => {
      for (const chapterId of chapterIds) await rebuildChapterMemoryById(chapterId)
    })()
  }

  const buildFullWorldCtx = async (
    taskType: MemoryTaskType = 'write',
    plan?: PlanSelection | null,
    continuitySnapshot?: PreparedContinuityContext | null,
  ) => {
    // 引用手法注入（Phase 20）
    let citedIds: number[] = []
    try {
      citedIds = JSON.parse(creativeRules?.citedReferenceIds || '[]')
    } catch { /* ignore */ }

    const stateRef = [
      outlineNode?.title,
      outlineNode?.summary,
      currentChapter?.title,
      plainText.slice(-2000),
    ].filter(Boolean).join(' ')

    const assembled = await assembleContext({
      projectId: project.id!,
      worldGroupId: chapterWorldGroupId ?? null,
      outlineNodeId: outlineNode?.id ?? null,
      chapterId: currentChapter?.id ?? null,
      currentChapterOrder: currentChapter?.order ?? 0,
      provider: aiConfig.provider,
      model: aiConfig.model,
      citedReferenceIds: citedIds,
      stateReferenceText: stateRef,
      extraStateIds,
      // PROMPT-PLAN-1:确认过协商选择时用它的清单(地板 ∪ AI 申报);
      // 否则用搬迁到 plan-needs 的同一份默认清单 —— 两条路径只差"追加"部分。
      // 注意:不含 'characters' —— 角色由 charCtx 单独注入(见 handleGenerate / handleContinue),
      // 此前 fullCtx(含characters)+charCtx 双传导致角色内容被注入两遍、白白吃掉一大块 token。
      subjectCharacterName: plan?.subjectCharacterName ?? undefined,
      ragEntryKeys: plan?.ragEntryKeys.length ? plan.ragEntryKeys : undefined,
      sourceKeys: plan ? plan.sourceKeys : [...PLAN_FLOOR_SOURCES],
      // 复用调用方刚备好的连续性快照：同一次生成不再重复解析章序/哈希前驱正文。
      // 为 null（未建章或准备超时降级）时不传，让 assembleContext 按原逻辑自行装配。
      continuitySnapshot: continuitySnapshot ?? undefined,
    })

    log.info('assembleContext', 'assemblecontext', `[assembleContext] ${taskType} 模式 — included:${assembled.included.join(',')} trimmed:${assembled.trimmed.join(',') || 'none'} tokens:${assembled.totalInputTokens}`)

    // Phase E: 题材约束 + 写作风格注入
    const genreCtx = buildGenreConstraintContext(project.genres?.length ? project.genres : project.genre)
    const styleCtx = project.writingStyleId ? buildStylePromptInjection(project.writingStyleId) : ''

    const segmentFor = (key: string) => {
      const index = assembled.included.indexOf(key)
      return index >= 0 ? assembled.segments[index]?.content ?? '' : ''
    }
    const continuityKeys = new Set([
      'chapterContinuityHandoff',
      'previousPlanReconciliation',
      'previousChapterEnding',
      'recentChapterSummaries',
    ])
    const assembledSegmentsWithoutContinuity = assembled.segments
      .filter((_, index) => !continuityKeys.has(assembled.included[index]))
    const assembledWithoutContinuity = assembledSegmentsWithoutContinuity
      .map(segment => segment.content)
      .join('\n\n')
    const parts = [assembledWithoutContinuity]
    if (genreCtx) parts.push(genreCtx)
    if (styleCtx) parts.push(styleCtx)
    const worldRulesIdx = assembled.included.indexOf('worldRules')
    const maxContext = aiConfig.contextWindow && aiConfig.contextWindow > 0
      ? aiConfig.contextWindow
      : getModelPreset(aiConfig.provider, aiConfig.model).maxContext
    const continuityBudgetTokens = maxContext <= 8_192 ? 3000 : maxContext <= 32_768 ? 6000 : 10_000
    return {
      text: parts.filter(Boolean).join('\n\n'),
      segments: assembledSegmentsWithoutContinuity,
      worldRulesContext: worldRulesIdx >= 0 ? assembled.segments[worldRulesIdx]?.content ?? '' : '',
      continuity: {
        handoff: segmentFor('chapterContinuityHandoff'),
        planReconciliation: segmentFor('previousPlanReconciliation'),
        previousTail: segmentFor('previousChapterEnding'),
        recentSummaries: segmentFor('recentChapterSummaries'),
      },
      continuityBudgetTokens,
    }
  }

  const chapterGenerationNode = (
    operation: ChapterGenerationOperation,
    category: ChapterGenerationCategory,
  ) => createChapterGenerationNode({
    operation,
    category,
    projectId: project.id!,
    chapterIdentity: currentChapter?.id ?? outlineNodeId ?? 'unselected',
    ai,
  })

  /**
   * 生成在途闸门（单一在途）。
   *
   * 为什么不能只靠 `ai.isStreaming`：从"点击生成"到"第一个 token 到达"之间还有一段
   * **装配窗口**（读大纲/装配上下文/重建章节记忆，实测可达数秒），这期间 `isStreaming` 仍是 false，
   * 工具栏按钮因此仍可点 —— 第二次点击会并行启动第二次生成，而 `useAIStream.start` 开头就会
   * `abort()` 上一次请求并把已生成文本清空，于是"误点一下，45 秒的生成白跑"。
   * 真实事故日志里正是这样：20:44:58 开始 stream，20:45:43 以
   * `signal is aborted without reason` 结束（被取代/被停止），而界面把它报成了红色失败。
   */
  const generationInFlightRef = useRef(false)
  const [generationInFlight, setGenerationInFlight] = useState(false)
  /**
   * **真的在跑**（装配中 / 等模型 / 收 token），与"在途闸门"分开：
   * 闸门要一直持有到这次生成结束（防重复发起），但"作者正在看发送前预览"不是"正在生成" ——
   * 状态条只反映 running，否则会出现"还没发送就显示正在生成"（作者反馈过）。
   */
  const [generationRunning, setGenerationRunning] = useState(false)
  const [generationNotice, setGenerationNotice] = useState('')

  const beginGeneration = useCallback((): boolean => {
    if (generationInFlightRef.current) {
      setGenerationNotice('已有一次生成在进行中：请等它结束，或先点「停止」再重新发起。')
      return false
    }
    generationInFlightRef.current = true
    setGenerationInFlight(true)
    setGenerationNotice('')
    return true
  }, [])

  const endGeneration = useCallback(() => {
    generationInFlightRef.current = false
    setGenerationInFlight(false)
    setGenerationRunning(false)
  }, [])

  /** 所有"会真正发起一次生成"的入口都必须先过这里；返回 false 表示已被拦截。 */
  const claimGenerationSlot = useCallback((what: string): boolean => {
    if (ai.isStreaming || generationInFlightRef.current) {
      setGenerationNotice(`已有一次生成在进行中（${what}已忽略）：请等它结束，或先点「停止」。`)
      log.warn('ChapterEditor', 'chaptereditor', '[ChapterEditor] 生成在途，已拦截重复发起', { what })
      return false
    }
    return beginGeneration()
  }, [ai, beginGeneration])

  const runPreparedChapterGeneration = (
    operation: ChapterGenerationOperation,
    category: ChapterGenerationCategory,
    prepared: PreparedGenerationNode,
    backgroundMemoryIds: number[],
    messages?: ChatMessage[],
  ) => {
    ai.setOperation(operation)
    // 到了真正执行这一步才算"在跑"（此前可能是预览等待）。
    setGenerationRunning(true)
    const node = chapterGenerationNode(operation, category)
    // 无论成功、报错还是被中止，都要释放闸门 —— 否则界面会永远停在"生成中"。
    void runGenerationNode(node, prepared, { messages })
      .catch(error => {
        logEvent({ level: 'error', tag: 'ChapterEditor', event: 'chaptereditor', message: '[ChapterEditor] 生成节点执行失败:', error })
      })
      .finally(() => { endGeneration() })
    scheduleRecentMemoryRebuild(backgroundMemoryIds)
  }

  const prepareOrRunChapterGeneration = (
    operation: ChapterGenerationOperation,
    category: ChapterGenerationCategory,
    messages: ChatMessage[],
    backgroundMemoryIds: number[],
  ) => {
    const node = chapterGenerationNode(operation, category)
    const prepared = prepareGenerationNode(node, messages)
    if (transparentMode) {
      ai.setOperation(operation)
      // 闸门保持持有（预览还开着时不允许再发起第二次生成），但**不再算"正在跑"**：
      // 现在轮到作者看预览、决定要不要发送 —— 状态条这时不该显示"正在生成"。
      setGenerationRunning(false)
      setPendingGeneration({ operation, category, prepared, backgroundMemoryIds })
      return
    }
    setPendingGeneration(null)
    runPreparedChapterGeneration(
      operation,
      category,
      prepared,
      backgroundMemoryIds,
    )
  }

  /**
   * 连续性准备：**可降级**步骤。
   *
   * 它只决定"要不要顺手补建前驱章节记忆"，正文本身有前章结尾（tail）兜底，
   * 底层失败时自己也会降级。因此超时/失败都不该让整次生成失败 ——
   * 事故里作者看到「生成准备失败：连续性准备超时（20 秒未返回）」以为生成坏了，
   * 其实那次只是背景补建没做成。现在：超时只记 warn + 一条说明，然后继续生成。
   */
  const prepareContinuitySafely = async (): Promise<PreparedContinuityContext | null> => {
    try {
      return await withTimeout(prepareContinuityBeforeGeneration(), PREP_TIMEOUT_MS, '连续性准备')
    } catch (error) {
      const timedOut = error instanceof TimeoutError
      log.warn('ChapterEditor', 'chaptereditor',
        timedOut
          ? '[ChapterEditor] 连续性准备超时，已跳过背景补建继续生成（正文有 tail 兜底）'
          : '[ChapterEditor] 连续性准备失败，已跳过背景补建继续生成',
        { timeout: timedOut })
      setGenerationNotice(timedOut
        ? '连续性背景补建超时（可能是检索/嵌入服务不可达）：已跳过它继续生成，正文仍会用前章结尾兜底。'
        : '连续性背景补建失败：已跳过它继续生成。')
      return null
    }
  }

  const handleGenerate = async (planOverride?: PlanSelection | null) => {
    if (!outlineNode) return
    const plan = planOverride !== undefined ? planOverride : planSelection
    const continuitySnapshot = await prepareContinuitySafely()
    const backgroundMemoryIds = backgroundMemoryIdsOf(continuitySnapshot)
    const {
      text: fullCtx,
      segments: assembledSegments,
      worldRulesContext,
      continuity,
      continuityBudgetTokens,
    } = await withTimeout(buildFullWorldCtx('write', plan, continuitySnapshot), CONTEXT_ASSEMBLE_TIMEOUT_MS, '上下文装配')
    const messages = buildChapterContentPrompt(
      outlineNode.title,
      outlineNode.summary,
      fullCtx,
      charCtx,
      continuity.previousTail,
      worldRulesContext,
      plan?.plan ? formatPlanUserHint(plan.plan, mergeAuthorHint(customInstruction.trim(), plan.answers)) || undefined : (customInstruction.trim() || undefined),
      { continuity, continuityBudgetTokens },
    )

    // Phase 21.3: 计算上下文预算
    const segments = analyzeContextSegments([
      { label: 'System Prompt', content: messages.find(m => m.role === 'system')?.content || '', layer: 'L0' },
      { label: '章节大纲', content: outlineNode.summary || '', layer: 'L1' },
      ...assembledSegments,
      { label: 'User Prompt', content: messages.find(m => m.role === 'user')?.content || '', layer: 'L1' },
    ])
    setContextBudget(calculateBudget(aiConfig.provider, aiConfig.model, segments, aiConfig.contextWindow))

    prepareOrRunChapterGeneration(
      'generate',
      'chapter.content',
      messages,
      backgroundMemoryIds,
    )
  }

  const handleContinue = async (planOverride?: PlanSelection | null) => {
    if (!plainText || !outlineNode) return
    const plan = planOverride !== undefined ? planOverride : planSelection
    const continuitySnapshot = await prepareContinuitySafely()
    const backgroundMemoryIds = backgroundMemoryIdsOf(continuitySnapshot)
    const { text: fullCtx, continuity, continuityBudgetTokens } = await withTimeout(
      buildFullWorldCtx('write', plan, continuitySnapshot), CONTEXT_ASSEMBLE_TIMEOUT_MS, '上下文装配',
    )
    // fullCtx 已不含角色(见 buildFullWorldCtx),续写也要角色 → 把 charCtx 一并带上(只此一次,不重复)
    const ctxWithChars = charCtx ? `${fullCtx}\n\n【角色设定】\n${charCtx}` : fullCtx
    const messages = buildContinuePrompt(
      plainText,
      outlineNode.summary,
      ctxWithChars,
      plan?.plan ? formatPlanUserHint(plan.plan, mergeAuthorHint(customInstruction.trim(), plan.answers)) || undefined : (customInstruction.trim() || undefined),
      { continuity, continuityBudgetTokens },
    )
    prepareOrRunChapterGeneration(
      'continue',
      'chapter.continue',
      messages,
      backgroundMemoryIds,
    )
  }

  /**
   * PROMPT-PLAN-1:开关打开时，先把作者送进"生成前协商"，由面板确认后再真正生成。
   *
   * 闸门**不在这里占用**（教训，见 `startGeneration`）：协商面板本身就是"还没生成"的状态，
   * 若在此 claim，面板会把自己锁死 —— 它拿到的 `generationBusy` 恒为 true，
   * 于是"下一步/跳过/确认"全部禁用，作者卡在协商里出不来（真实事故）。
   * 真正需要在途保护的时刻是**开始跑一次生成**，因此 claim 收敛到 `startGeneration` 一处。
   */
  const requestGeneration = (operation: 'generate' | 'continue') => {
    if (planMode) {
      setPlanRequest({ operation })
      return
    }
    void startGeneration(operation)
  }

  /**
   * 正在生成时显示"这次用的是哪个模型"。
   *
   * 事故教训：作者只看到"正在生成"，不知道它调的是哪个模型、是不是自己配置的「创作生成」，
   * 于是无法判断该不该等。这里把**任务路由的真实结果**摊开：
   * 类目 → 任务种类（创作生成/提取/分析/审校）→ provider/model。
   * 同一份信息也进日志（client.ts 的 AI 事件带 category 与 provider/model）。
   */
  const generatingLabel = useMemo((): string => {
    if (!ai.isStreaming && !generationInFlight) return ''
    const category = ai.operation === 'continue' ? 'chapter.continue' : 'chapter.content'
    const taskKind = classifyAITask(category)
    const kindLabel = taskKind ? TASK_ROUTE_META[taskKind].label : '未分类'
    const resolved = resolveRequestConfig(aiConfig, { category })
    const routed = resolved.presetId ? '已按路由' : '跟随全局'
    return `正在生成 · ${kindLabel}（${routed}）· ${resolved.config.provider}/${resolved.config.model}`
  }, [ai.isStreaming, ai.operation, aiConfig, generationInFlight])

  /**
   * 悬浮状态条：只要**任何** AI 长任务在跑就显示（流式生成，或协商的三步非流式调用）。
   *
   * 为什么不能只靠工具栏：工具栏在编辑区顶部，滚到正文中间就看不见；
   * 而协商阶段父级的 `isStreaming` 与在途闸门都是 false（那是非流式调用），
   * 工具栏在外观上等于"什么都没发生" —— 作者既看不到圆环也找不到取消（真实事故）。
   */
  const [negotiationBusy, setNegotiationBusy] = useState(false)
  const [negotiationHint, setNegotiationHint] = useState('')
  /** 协商面板上报忙闲与"已等待 N 秒"（非流式调用父级本来什么都看不见）。 */
  const handleNegotiationBusy = useCallback((busy: boolean, hint?: string) => {
    setNegotiationBusy(busy)
    setNegotiationHint(hint ?? '')
  }, [])
  const longTaskRunning = shouldShowGenerationStatus({ isStreaming: ai.isStreaming, running: generationRunning, negotiationBusy })
  const statusTitle = getGenerationStatusTitle({
    isStreaming: ai.isStreaming,
    running: generationRunning,
    negotiationBusy,
    operation: ai.operation,
  })
  const statusDetail = negotiationBusy && !ai.isStreaming && !generationRunning
    ? negotiationHint
    : ai.isStreaming ? generatingLabel : ''

  /**
   * 取消生成：**任何阶段都必须有效**的逃生口。
   *
   * 真实事故：准备阶段卡住（无超时的网络调用）时，界面一直显示"正在生成"，再点任何按钮都没反应。
   * 因此这里不做任何条件判断 —— 既中止流，也强制释放闸门、关掉预览，让界面一定能回到可操作状态。
   */
  const cancelGeneration = useCallback(() => {
    ai.stop()
    setPendingGeneration(null)
    setPendingEditGeneration(null)
    setGenerationNotice('')
    endGeneration()
    log.warn('ChapterEditor', 'chaptereditor', '[ChapterEditor] 用户取消生成', { operation: ai.operation ?? '' })
  }, [ai, endGeneration])

  /** 真正发起一次生成：在这里 claim，直到这次生成结束/报错/被中止。 */
  const startGeneration = async (
    operation: 'generate' | 'continue',
    selection?: PlanSelection | null,
  ): Promise<void> => {
    if (!claimGenerationSlot(operation === 'generate' ? '生成正文' : '续写')) return
    // 从这一刻起就是"在跑"：装配/等模型/收 token 都算（预览等待会在打开预览时把它关掉）。
    setGenerationRunning(true)
    try {
      if (operation === 'generate') await handleGenerate(selection)
      else await handleContinue(selection)
    } catch (error) {
      // 装配阶段（读大纲/上下文/记忆）抛错时必须释放闸门并如实报错，
      // 否则界面会永远停在"生成中"，而且错误会变成无人处理的 unhandled rejection。
      endGeneration()
      setGenerationNotice(`生成准备失败：${error instanceof Error ? error.message : String(error)}`)
      logEvent({ level: 'error', tag: 'ChapterEditor', event: 'chaptereditor', message: '[ChapterEditor] 生成准备阶段失败:', error })
      return
    }
    // 透明预览模式下 handleGenerate 只是把预览打开，闸门由预览的取消/发送接管；
    // 非透明模式下 runPreparedChapterGeneration 的 finally 已经释放，这里只兜底。
    if (!transparentMode && !ai.isStreaming) endGeneration()
  }

  /**
   * 协商用的模型调用：父级负责配置就绪检查与分类记账（面板只管流程与闭集校验）。
   *
   * 刻意拆成两个**字面量 category** 的函数：`AI-FUNCTIONS-MANUAL` 的静态扫描按字面量
   * 统计调用点，`{ category: 变量 }` 会被记成「未分类调用（必须修复）」，
   * 于是"这次协商花了什么类目的钱"在说明书与消耗统计里都会失真。
   */
  const assertPlanConfigReady = useCallback((category: PlanCallCategory) => {
    const effectiveConfig = resolveRequestConfig(aiConfig, { category }).config
    if (!isAIConfigReady(effectiveConfig)) {
      throw new Error(getAIConfigRequiredMessage(effectiveConfig))
    }
  }, [aiConfig])

  const callPlanSummaryModel = useCallback(async (messages: ChatMessage[], signal?: AbortSignal): Promise<string> => {
    assertPlanConfigReady('chapter.plan.summary')
    return await chat(messages, aiConfig, { category: 'chapter.plan.summary', projectId: project.id! }, signal)
  }, [aiConfig, assertPlanConfigReady, project.id])

  const callPlanNeedsModel = useCallback(async (messages: ChatMessage[], signal?: AbortSignal): Promise<string> => {
    assertPlanConfigReady('chapter.plan.needs')
    return await chat(messages, aiConfig, { category: 'chapter.plan.needs', projectId: project.id! }, signal)
  }, [aiConfig, assertPlanConfigReady, project.id])

  const callPlanAskModel = useCallback(async (messages: ChatMessage[], signal?: AbortSignal): Promise<string> => {
    assertPlanConfigReady('chapter.plan.ask')
    return await chat(messages, aiConfig, { category: 'chapter.plan.ask', projectId: project.id! }, signal)
  }, [aiConfig, assertPlanConfigReady, project.id])

  const callPlanModel = useCallback(async (
    messages: ChatMessage[],
    category: PlanCallCategory,
    signal?: AbortSignal,
  ): Promise<string> => {
    if (category === 'chapter.plan.needs') return await callPlanNeedsModel(messages, signal)
    if (category === 'chapter.plan.ask') return await callPlanAskModel(messages, signal)
    return await callPlanSummaryModel(messages, signal)
  }, [callPlanAskModel, callPlanNeedsModel, callPlanSummaryModel])

  const handlePlanConfirm = (selection: PlanSelection | null) => {
    const request = planRequest
    const operation = request?.operation ?? 'generate'
    setPlanRequest(null)
    setPlanSelection(selection)
    // 闸门统一在 startGeneration 里 claim（不在这里预占，避免"面板自己锁死自己"）。
    if (operation === 'polish' || operation === 'expand') {
      void startEditGeneration(operation, request?.targetText, selection)
    } else {
      void startGeneration(operation, selection)
    }
  }

  /** 取消协商：关掉面板即可；若此刻真有生成在跑则一并释放闸门。 */
  const cancelPlanNegotiation = useCallback(() => {
    setPlanRequest(null)
    if (!ai.isStreaming) endGeneration()
  }, [ai.isStreaming, endGeneration])

  /**
   * 状态条的取消：按**当前阶段**分派。
   * - 只有协商在跑（非流式）→ 取消协商；
   * - 其它情形（生成中/装配中）→ 取消生成（它同时会释放闸门，卡住时也能救回来）。
   *
   * 定义在 `cancelPlanNegotiation` 之后：`useCallback` 的依赖数组在渲染期求值，
   * 提前引用会撞上 TDZ（上一版就撞了）。
   */
  const cancelCurrentTask = useCallback(() => {
    if (negotiationBusy && !ai.isStreaming && !generationRunning) {
      cancelPlanNegotiation()
      setNegotiationBusy(false)
      return
    }
    cancelGeneration()
  }, [ai.isStreaming, cancelGeneration, cancelPlanNegotiation, generationRunning, negotiationBusy])

  // 切换章节/大纲节点时，上一章的协商结果作废（会话级，不跨章复用）。
  useEffect(() => {
    setPlanRequest(null)
    setPlanSelection(null)
    setPendingEditGeneration(null)
    editTargetRef.current = null
  }, [currentChapter?.id, outlineNode?.id])

  const editTargetRef = useRef<{ chapterId: number; fullText: string; range: { from: number; to: number } | null } | null>(null)

  const runEditGeneration = async (operation: 'polish' | 'expand', messages: ChatMessage[]) => {
    ai.setOperation(operation)
    setGenerationRunning(true)
    try {
      if (operation === 'polish') await ai.start(messages, undefined, { category: 'chapter.polish', projectId: project.id! })
      else await ai.start(messages, undefined, { category: 'chapter.expand', projectId: project.id! })
    } finally {
      endGeneration()
    }
  }

  const startEditGeneration = async (operation: 'polish' | 'expand', targetText?: string, selection?: PlanSelection | null) => {
    const target = editTargetRef.current
    if (!target || !targetText || !claimGenerationSlot(operation === 'polish' ? '润色' : '扩写')) return
    try {
      const authorHint = selection?.plan
        ? formatPlanUserHint(selection.plan, mergeAuthorHint(customInstruction.trim(), selection.answers))
        : customInstruction.trim()
      // 扩写/润色也必须消费协商确认的资料清单。此前这里只拼了写作计划和回答，
      // 导致 sourceKeys/ragEntryKeys 虽然在面板中确认，却没有进入最终发送消息。
      let hint = authorHint
      if (selection) {
        const { text: negotiatedContext } = await withTimeout(
          buildFullWorldCtx('write', selection),
          CONTEXT_ASSEMBLE_TIMEOUT_MS,
          '上下文装配',
        )
        const contextParts = [
          negotiatedContext,
          charCtx ? `【角色设定】\n${charCtx}` : '',
        ].filter(Boolean)
        if (contextParts.length) {
          hint = [
            authorHint,
            `【本次创作前协商确认的资料】\n${contextParts.join('\n\n')}`,
          ].filter(Boolean).join('\n\n')
        }
      }
      const messages = operation === 'polish'
        ? buildPolishPrompt(targetText, hint || '优化文笔，使表达更生动', undefined, target.fullText)
        : buildExpandPrompt(targetText, hint || undefined, undefined, target.fullText)
      if (transparentMode) {
        ai.setOperation(operation)
        setGenerationRunning(false)
        setPendingEditGeneration({ operation, messages, targetText })
      } else {
        await runEditGeneration(operation, messages)
      }
    } catch (error) {
      endGeneration()
      setGenerationNotice(`编辑准备失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const requestEditGeneration = (operation: 'polish' | 'expand', selectedText?: string, range?: { from: number; to: number } | null) => {
    if (ai.isStreaming || generationInFlightRef.current || planRequest) return
    const editor = editorRef.current
    if (!editor || !currentChapter?.id) return
    const fullText = editor.getPlainText()
    const selected = selectedText ?? editor.getSelectedText()
    const targetText = selected || fullText
    if (!targetText.trim()) return
    editTargetRef.current = { chapterId: currentChapter.id, fullText, range: selected ? (range ?? editor.captureSelectionRange()) : null }
    setPlanSelection(null)
    if (planMode) setPlanRequest({ operation, targetText })
    else void startEditGeneration(operation, targetText)
  }

  const handlePolish = () => requestEditGeneration('polish')
  const handleExpand = () => requestEditGeneration('expand')

  const handleDeAI = async () => {
    // 有选区只去味选区；没选区则对【整章正文】去味（不再只取末尾 1000 字 → 修字数缩水 bug G4）
    const selected = editorRef.current?.getSelectedText()
    const isFull = !selected
    const target = (selected || plainText).trim()
    if (!target) return
    // G1：点击先确认，避免误触烧 token
    const ok = await dialog.confirm({
      title: '去 AI 味改写？',
      message: isFull
        ? `将对整章正文（约 ${countWords(target)} 字）做去 AI 味改写，篇幅与原文保持相近。改写结果会先预览，确认后才替换原文。`
        : '将对选中的文字做去 AI 味改写。改写结果会先预览，确认后才替换。',
      confirmText: '开始改写',
    })
    if (!ok) return
    const messages = buildDeAIPrompt(target)
    ai.setOperation(isFull ? 'deai-full' : 'deai')
    ai.start(messages, undefined, { category: 'chapter.deai', projectId: project.id! })
  }

  // G8：按审校报告让 AI 改全文 —— 走和「生成正文」相同的预览→采纳/关闭流程
  const handleReviseByReport = async (report: ReviewResult) => {
    if (!plainText.trim()) return
    const ok = await dialog.confirm({
      title: '按审校报告让 AI 改全文？',
      message: `将依据本章审校报告修改整章正文（约 ${countWords(plainText)} 字），篇幅与原文保持相近。改写结果会先预览，确认后才替换原文。`,
      confirmText: '开始修改',
    })
    if (!ok) return
    reviseReportRef.current = report
    const messages = buildReviewRevisePrompt(plainText, report, worldCtx, charCtx)
    ai.setOperation('revise-full')
    ai.start(messages, undefined, { category: 'review.revise', projectId: project.id! })
  }

  const handleRunChapterOrganization = async (force = false) => {
    if (!currentChapter?.id || !plainText.trim()) return
    if (organizingChapter) {
      organizationAbortRef.current?.abort()
      return
    }
    if (organizationRun && !force) {
      const current = await isChapterOrganizationCurrent(organizationRun.candidate)
      setOrganizationCurrent(current)
      const hasPending = Object.values(organizationRun.candidate.domainStatus).some(
        status => status === 'pending' || status === 'failed',
      )
      if (hasPending || !current) {
        setShowOrganization(true)
        return
      }
    }

    const effectiveConfig = resolveRequestConfig(aiConfig, { category: 'chapter.organize' }).config
    if (!isAIConfigReady(effectiveConfig)) {
      const message = getAIConfigRequiredMessage(effectiveConfig)
      setOrganizationError(message)
      await dialog.alert({ title: '无法整理本章', message })
      return
    }
    const persisted = await persistCurrentEditorContent()
    if (!persisted) return

    const controller = new AbortController()
    organizationAbortRef.current?.abort()
    organizationAbortRef.current = controller
    setOrganizingChapter(true)
    setOrganizationError('')
    try {
      const [allRelations] = await Promise.all([
        db.characterRelations.where('projectId').equals(project.id!).toArray(),
        loadForeshadows(project.id!),
      ])
      const scopedCharacters = project.enableMultiWorld
        ? characters.filter(character => (
          character.isCrossWorld
          || (character.homeWorldGroupId ?? null) === (chapterWorldGroupId ?? null)
        ))
        : characters
      const scopedCharacterIds = new Set(
        scopedCharacters.flatMap(character => character.id != null ? [character.id] : []),
      )
      const existingRelations = allRelations.filter(relation => (
        scopedCharacterIds.has(relation.fromCharacterId)
        && scopedCharacterIds.has(relation.toCharacterId)
      ))
      const chapterTitle = outlineNode?.title || currentChapter.title || '未知章节'
      const budget = new AgentTeamBudgetTracker(useAIConfigStore.getState().agentTeamBudgetProfile)
      const candidate = await runChapterOrganization({
        projectId: project.id!,
        chapterId: currentChapter.id,
        chapterTitle,
        worldGroupId: chapterWorldGroupId ?? null,
        chapterContent: persisted.html,
        stateContext: await assembleCurrentStateContext(persisted.plain),
        characters: scopedCharacters,
        knownItemNames: itemEntries.map(entry => entry.itemName),
        existingRelations,
        foreshadows: useForeshadowStore.getState().foreshadows,
        budget,
        call: messages => chat(messages, aiConfig, {
          category: 'chapter.organize',
          projectId: project.id!,
          configOverrides: { maxTokens: 8_000 },
          contextOverflowPolicy: 'reject',
        }, controller.signal),
      })
      const run = await persistChapterOrganizationCandidate(candidate)
      setOrganizationRun(run)
      setOrganizationCurrent(true)
      setShowOrganization(true)
    } catch (error) {
      if (!controller.signal.aborted) {
        const message = error instanceof Error ? error.message : '整理本章失败'
        setOrganizationError(message)
        await dialog.alert({ title: '整理本章失败', message })
      }
    } finally {
      if (organizationAbortRef.current === controller) organizationAbortRef.current = null
      setOrganizingChapter(false)
    }
  }

  const handleApplyChapterOrganization = async (selection: ChapterOrganizationSelection) => {
    if (!organizationRun || organizingChapter) return
    setOrganizingChapter(true)
    setOrganizationError('')
    try {
      const result = await adoptChapterOrganizationSelection({ run: organizationRun, selection })
      setOrganizationRun(result.run)
      setOrganizationCurrent(true)
      const failed = Object.entries(result.run.candidate.domainErrors)
      if (failed.length) {
        setOrganizationError(failed.map(([domain, message]) => `${domain}: ${message}`).join('；'))
      }
    } catch (error) {
      setOrganizationError(error instanceof Error ? error.message : '写入整理结果失败')
      if (organizationRun) {
        setOrganizationCurrent(await isChapterOrganizationCurrent(organizationRun.candidate))
      }
    } finally {
      setOrganizingChapter(false)
    }
  }

  // NS-6：改了历史章后，传播 stale（证据失效的确认事实标记为 stale）+ 列出受影响后续章，交作者复核。
  // 只读·只提示·不自动改任何正文；不删事实、不动 locked。
  const handleEditImpact = async () => {
    if (!currentChapter?.id || !project.id) return
    setAnalyzingImpact(true)
    try {
      // 先把当前正文真正落盘，再据落盘正文判断证据是否失效
      await persistCurrentEditorContent()
      const { demotedFacts } = await propagateChapterEditStale(project.id, currentChapter.id)
      const { factsFromChapter, downstreamChapterIds } = await analyzeEditImpact(project.id, currentChapter.id)
      const parts = [
        `源自本章事实 ${factsFromChapter.length} 条`,
        demotedFacts > 0 ? `其中 ${demotedFacts} 条证据已失效→标记 stale 待复核` : '证据均仍成立',
        `建议复核后续 ${downstreamChapterIds.length} 章`,
      ]
      setImpactInfo(parts.join('；'))
    } catch (err) {
      logEvent({ level: 'error', tag: 'EditImpact', event: 'editimpact', message: '[EditImpact] 失败:', error: err })
      setImpactInfo('影响分析失败，请重试')
    } finally {
      setAnalyzingImpact(false)
    }
  }

  const handleAcceptDiffs = async (accepted: StateDiffItem[]) => {
    try {
      await applyDiffs(project.id!, accepted, currentChapter?.id)
      log.info('StateExtract', 'stateextract', `[StateExtract] ${accepted.length} 条变更已写入状态表`)
    } catch (err) {
      logEvent({ level: 'error', tag: 'StateExtract', event: 'stateextract', message: '[StateExtract] 写入状态表失败:', error: err })
    }
    setPendingDiffs(null)
    stateAI.reset()
  }

  // ── NS-1: 单次生成 summary + continuity handoff ──
  const handleChapterMemory = async (task: {
    chapterId: number
    chapterTitle: string
    chapterContent: string
  }) => {
    setAutoProcessing('memory')
    try {
      log.info('ChapterMemory', 'chaptermemory', '[ChapterMemory] 开始统一抽取:', { chapterTitle: task.chapterTitle })
      const result = await runChapterMemoryTask({
        projectId: project.id!,
        ...task,
        call: messages => memoryAI.start(messages, undefined, {
          category: 'chapter.memory',
          projectId: project.id!,
        }),
      })
      if (result.status === 'written') {
        await refreshChapter(task.chapterId)
        log.info('ChapterMemory', 'chaptermemory', '[ChapterMemory] summary + handoff 已原子写回')
      } else if (result.status === 'stale') {
        log.warn('ChapterMemory', 'chaptermemory', '[ChapterMemory] 正文已变化，旧任务结果已丢弃')
      } else {
        log.error('ChapterMemory', 'chaptermemory', '[ChapterMemory] 结构化输出解析失败，保留真实 tail 降级')
      }
    } catch (err) {
      logEvent({ level: 'error', tag: 'ChapterMemory', event: 'chaptermemory', message: '[ChapterMemory] 统一抽取失败，保留真实 tail 降级:', error: err })
    } finally {
      setAutoProcessing('idle')
      memoryAI.reset()
    }
  }

  const handleManualMemory = async () => {
    if (!currentChapter?.id || !plainText.trim() || autoProcessing === 'memory') return
    const chapterId = currentChapter.id
    const chapterTitle = outlineNode?.title || currentChapter.title || '未知章节'
    const persisted = await persistCurrentEditorContent()
    if (!persisted) return
    await handleChapterMemory({ chapterId, chapterTitle, chapterContent: persisted.html })
  }

  const handleConfirmActualProgress = async () => {
    if (!currentChapter?.id || !currentChapter.planReconciliation) return
    const reconciliation = currentChapter.planReconciliation
    const confirmedActualProgress = [
      ...reconciliation.completedGoals.map(item => `已完成：${item.text}`),
      ...reconciliation.deviations.map(item => `实际偏移：${item.text}`),
      ...reconciliation.newConstraints.map(item => `新增约束：${item.text}`),
      ...reconciliation.unfinishedGoals.map(item => `仍未完成：${item.text}`),
    ].join('；')
    await updateChapter(currentChapter.id, {
      planReconciliation: {
        ...reconciliation,
        reviewStatus: 'confirmed-constraint',
        confirmedActualProgress,
        reviewedAt: Date.now(),
      },
    })
  }

  const handleApplyOutlineCandidate = async () => {
    const reconciliation = currentChapter?.planReconciliation
    if (!currentChapter?.id || !outlineNode?.id || !reconciliation?.proposedOutlineSummary) return
    await updateNode(outlineNode.id, { summary: reconciliation.proposedOutlineSummary })
    await updateChapter(currentChapter.id, {
      planReconciliation: {
        ...reconciliation,
        reviewStatus: 'applied-outline',
        reviewedAt: Date.now(),
      },
    })
  }

  // ── Phase A1: 生成正文完成后的自动流程 ──
  // 接受 AI 生成的文本后，自动触发状态提取 → 一次统一章节记忆抽取。
  const handleAutoPostGenerate = async (task: {
    chapterId: number
    chapterTitle: string
    chapterContent: string
    chapterPlainText: string
  }) => {
    // 0. NS-5：重建本章检索块（非 AI，hash 守卫，便宜；供「相关前文召回」用）
    try {
      if (currentChapter) {
        await rebuildChapterChunks({
          projectId: project.id!,
          chapter: { ...currentChapter, content: task.chapterContent },
          worldGroupId: chapterWorldGroupId ?? null,
          knownEntities: characters.map(c => c.name),
        })
        await rebuildProjectNarrativeSummaries({ projectId: project.id! })
        // NS-5：若启用 embedding，后台为新块补语义向量（best-effort，不阻塞、失败退回关键词）
        const embCfg = useAIConfigStore.getState().embedding
        if (isEmbeddingReady(embCfg)) {
          void ensureChunkEmbeddings({ projectId: project.id!, cfg: embCfg })
            .catch(e => logEvent({ level: 'warn', tag: 'AutoPost', event: 'autopost', message: '[AutoPost] 语义索引补建失败（不影响）:', error: e }))
        }
      }
    } catch (e) { logEvent({ level: 'error', tag: 'AutoPost', event: 'autopost', message: '[AutoPost] 检索块重建失败:', error: e }) }

    // 1. 自动提取状态
    setAutoProcessing('extracting')
    try {
      const stateCtx = await assembleCurrentStateContext(task.chapterPlainText)
      const characterNames = characters.map(character => character.name)
      const messages = buildStateExtractPrompt(stateCtx, task.chapterTitle, task.chapterPlainText, characterNames)
      log.info('AutoPost', 'autopost', '[AutoPost] 自动提取状态:', { chapterTitle: task.chapterTitle })
      const raw = await stateAI.start(messages, undefined, { category: 'state.extract', projectId: project.id! })
      // ALIAS-1: 抽取里用别称点名角色时，归一到正名再落状态卡（别丢、也别把一个人拆成两张卡）。
      const { diffs, error } = parseStateDiffs(raw, characterNames, buildSurfaceToCanonicalMap(characters))
      if (error) {
        logEvent({ level: 'error', tag: 'AutoPost', event: 'autopost', message: '[AutoPost] 状态提取解析失败:', error })
      }
      if (diffs.length > 0) {
        setPendingDiffs(diffs as StateDiffItem[])
      } else {
        log.info('AutoPost', 'autopost', '[AutoPost] 本章无状态变更')
      }
    } catch (err) {
      logEvent({ level: 'error', tag: 'AutoPost', event: 'autopost', message: '[AutoPost] 状态提取失败:', error: err })
    }

    // 2. summary + handoff 只发起这一轮统一调用，不增加第三次正文读取。
    await handleChapterMemory({
      chapterId: task.chapterId,
      chapterTitle: task.chapterTitle,
      chapterContent: task.chapterContent,
    })
  }

  const handleAcceptAI = async (text: string) => {
    if (!editorRef.current || !currentChapter?.id) return
    const acceptedChapterId = currentChapter.id
    const acceptedChapterTitle = outlineNode?.title || currentChapter.title || '未知章节'
    const aiAction = ai.operation
    const isEditAction = aiAction === 'polish' || aiAction === 'expand'
    const editTarget = isEditAction ? editTargetRef.current : null
    if (isEditAction && (!editTarget || editTarget.chapterId !== currentChapter.id || editTarget.fullText !== editorRef.current.getPlainText())) {
      await dialog.alert({ title: '正文已变化', message: '请重新发起扩写或润色，当前结果保留，不会覆盖已修改的正文。' })
      return
    }
    if (aiAction === 'deai' && !editorRef.current.getSelectedText()) {
      await dialog.alert({
        title: '请重新选中原文',
        message: '切换页面后原选区无法安全恢复。请在正文中重新选中要替换的文字，再点击“采纳”。生成结果会继续保留。',
      })
      return
    }
    // G6：去掉段落之间的多余空行——丢弃纯空行，每个非空行成一段，段间距交给 CSS（不要空段落）
    const normalizeProse = (t: string) =>
      t.split(/\r?\n/).map(l => l.trimEnd()).filter(l => l.trim().length > 0).join('\n')
    // STEP-1：应用 AI 结果前的正文，作为撤回历史里的"上一步"。
    const beforeHtmlForHistory = editorRef.current.getHTML()
    const beforeTextForHistory = editorRef.current.getPlainText()
    const html = plainTextToHtml(normalizeProse(text))
    const shouldAutoProcess = aiAction === 'generate' || aiAction === 'continue'

    if (editTarget) {
      if (editTarget.range) {
        if (!editorRef.current.replaceRange(editTarget.range.from, editTarget.range.to, html)) {
          await dialog.alert({ title: '选区已失效', message: '请重新选择文字并发起扩写或润色。' })
          return
        }
      } else {
        editorRef.current.setContent(html)
      }
      applyEditedContent(editorRef.current.getHTML(), editorRef.current.getPlainText())
    } else if (aiAction === 'continue') {
      editorRef.current.appendContent(html)
    } else if (aiAction === 'generate' || aiAction === 'deai-full' || aiAction === 'revise-full') {
      // generate / 整章去AI味 / 按报告修改：替换全文
      editorRef.current.setContent(html)
      // setContent 不触发 onChange，这里手动同步
      const newHtml = editorRef.current.getHTML()
      applyEditedContent(newHtml, editorRef.current.getPlainText())
    } else {
      // polish/expand/deai（选区）：替换选区（若无选区则插入在光标处）
      editorRef.current.replaceSelection(html)
    }
    ai.reset()

    // 先把完整正文落库，再启动带 hash CAS 的异步后处理。
    if (shouldAutoProcess) {
      const fullHtml = editorRef.current.getHTML()
      const fullText = editorRef.current.getPlainText()
      await updateChapter(acceptedChapterId, {
        content: fullHtml,
        wordCount: countWords(fullText),
      })
      applyEditedContent(fullHtml, fullText)
      setSavedContent(fullHtml)
       void extractGenerationEntityCandidates({
         projectId: project.id!,
         worldGroupId: chapterWorldGroupId ?? null,
         sourceText: fullText,
         call: messages => chat(messages, aiConfig, { category: 'generation.entities.extract', projectId: project.id! }),
       }).then(candidates => {
         if (!candidates.characters.length && !candidates.locations.length) return
         return adoptGenerationEntityCandidates({ projectId: project.id!, worldGroupId: chapterWorldGroupId ?? null, candidates })
       }).catch(error => logEvent({ level: 'error', tag: 'AI', event: 'generation.entities.failed', message: '生成结果角色地点整理失败', error }))
      void handleAutoPostGenerate({
        chapterId: acceptedChapterId,
        chapterTitle: acceptedChapterTitle,
        chapterContent: fullHtml,
        chapterPlainText: fullText,
      })
    }

    // STEP-1：正文的 AI 修改不经过 adopt()，在这里显式记一步，供「上一步 / 下一步」撤回。
    const afterHtmlForHistory = editorRef.current.getHTML()
    const afterTextForHistory = editorRef.current.getPlainText()
    void recordChapterContentStep({
      projectId: project.id!,
      chapterId: acceptedChapterId,
      label: AI_ACTION_LABELS[aiAction ?? ''] ?? 'AI 修改正文',
      source: 'chapter-editor',
      beforeContent: beforeHtmlForHistory,
      beforeWordCount: countWords(beforeTextForHistory),
      afterContent: afterHtmlForHistory,
      afterWordCount: countWords(afterTextForHistory),
    }).catch(() => { /* 历史记录失败不影响正文写入 */ })
  }

  const handleAddNote = async () => {
    if (addingNote || !currentChapter?.id || !project.id) return
    setAddingNote(true)
    try {
      await useNoteStore.getState().loadAll(project.id)
      const canvas = noteAreaRef.current
      const rect = canvas?.getBoundingClientRect()
      const visibleCount = useNoteStore.getState().notes.filter(note => note.projectId === project.id
        && (note.chapterId === currentChapter.id || note.chapterId == null)).length
      const width = canvas?.clientWidth ?? 768
      const height = canvas?.clientHeight ?? 640
      const canvasX = Math.max(0, Math.min(visibleCount % 2 === 0 ? width - 250 : 18, width - 232))
      const y = Math.max(0, Math.min(Math.max(160, 260 - (rect?.top ?? 0))
        + Math.floor(visibleCount / 2) * 54, height - 184))
      await useNoteStore.getState().addNote(project.id, '', currentChapter.id, 'yellow', {
        x: Math.round(canvasX - (notePaperRef.current?.offsetLeft ?? 0)), y: Math.round(y),
      })
      setShowNotePanel(true)
    } catch (error) {
      log.error('NoteStore', 'note.create.failed', '正文便签创建失败', {
        projectId: project.id, chapterId: currentChapter.id,
      }, error)
      await dialog.alert({ title: '无法新建便签', message: '便签保存失败，请稍后重试。' })
    } finally {
      setAddingNote(false)
    }
  }

  // 没有选中章节
  if (!currentChapter) {
    if (outlineNodeId) {
      const node = nodes.find(n => n.id === outlineNodeId)
      return (
        <div className="max-w-4xl flex flex-col items-center justify-center h-64 gap-3">
          <p className="text-text-muted text-sm">章节「{node?.title}」还没有正文</p>
          <button onClick={handleCreateFromOutline}
            className="px-4 py-2 bg-accent text-white text-sm rounded-md hover:bg-accent-hover transition-colors">
            创建章节并开始写作
          </button>
        </div>
      )
    }
    return (
      <div className="max-w-4xl">
        <h2 className="text-xl font-bold text-text-primary mb-4">✍️ 写作</h2>
        <div className="space-y-1">
          {chapters.map(ch => (
            <button key={ch.id} onClick={() => selectChapter(ch.id!)}
              className="w-full text-left px-3 py-2 rounded-md text-sm bg-bg-surface hover:bg-bg-hover text-text-secondary transition-colors">
              <span className="text-text-primary">{ch.title}</span>
              <span className="ml-2 text-text-muted text-xs">{effectiveChapterWordCount(ch)} 字</span>
            </button>
          ))}
          {chapters.length === 0 && (
            <p className="text-text-muted text-sm text-center py-12">请先在「大纲」中创建章节，然后点击写作图标进入编辑</p>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-full bg-bg-base/40">
      {/* 标题栏 —— sticky 固定在顶部，必须不透光，否则正文下滑时会从底下透出来 */}
      <div className="sticky top-0 z-20 border-b border-border bg-bg-base">
        <ChapterEditorHeader
          title={chapterDisplay?.title ?? currentChapter.title}
          wordCount={wordCount}
          typingSpeed={typingWordsPerMinute(currentChapter.typingStats)}
          typingDuration={formatTypingDuration(currentChapter.typingStats)}
          status={currentChapter.status}
          showContext={showContext}
          canCompare={!!plainText && compareSourceHtml == null}
          saveDisabled={compareSourceHtml != null}
          saving={manualSaving}
          saveError={manualSaveError}
          isSaved={content === savedContent}
          onStatusChange={status => {
            if (currentChapter.id) void updateChapter(currentChapter.id, { status })
          }}
          onToggleContext={() => setShowContext(!showContext)}
          onOpenCompare={() => { void handleOpenComparePolish() }}
          onSave={() => { void handleManualSave() }}
        />

      {showContext && (
        <ChapterContextPreview
          worldContext={worldCtx}
          characterContext={charCtx}
          outlineNode={outlineNode ?? undefined}
          stateCards={stateCards}
          matchedIds={selectiveState.matchedIds}
          allIds={selectiveState.allIds}
          extraIds={extraStateIds}
          stateListExpanded={showStatePreview}
          onToggleStateList={() => setShowStatePreview(!showStatePreview)}
          onToggleStateCard={cardId => {
            const isExtra = extraStateIds.includes(cardId)
            const isMatched = selectiveState.matchedIds.includes(cardId)
            if (isExtra) {
              setExtraStateIds(extraStateIds.filter(id => id !== cardId))
            } else if (!isMatched) {
              setExtraStateIds([...extraStateIds, cardId])
            }
          }}
        />
      )}

      {/* AI 工具栏 */}
      {compareSourceHtml == null && (
        <ChapterEditorToolbar
          isStreaming={ai.isStreaming}
          generationBusy={generationInFlight}
          hasText={!!plainText}
          organizingChapter={organizingChapter}
          hasOrganizationCandidate={Boolean(
            organizationRun
            && Object.values(organizationRun.candidate.domainStatus).some(
              status => status === 'pending' || status === 'failed',
            ),
          )}
          analyzingImpact={analyzingImpact}
          impactInfo={impactInfo}
          hasOutline={!!outlineNodeId}
          showOutlinePreview={showOutlinePreview}
          showReviewPanel={showReviewPanel}
          consistencyAlertCount={consistencyCurrent ? consistencyRun?.candidate.findings.length ?? 0 : 0}
          showNotePanel={showNotePanel}
          addingNote={addingNote}
          customInstruction={customInstruction}
          onGenerate={() => { void requestGeneration('generate') }}
          onContinue={() => { void requestGeneration('continue') }}
          onExpand={handleExpand}
          onPolish={handlePolish}
          onDeAI={() => { void handleDeAI() }}
          onOrganizeChapter={() => { void handleRunChapterOrganization() }}
          onAnalyzeImpact={() => { void handleEditImpact() }}
          onDismissImpact={() => setImpactInfo(null)}
          onToggleOutlinePreview={() => setShowOutlinePreview(!showOutlinePreview)}
          onToggleReviewPanel={() => setShowReviewPanel(!showReviewPanel)}
          onToggleNotePanel={() => setShowNotePanel(!showNotePanel)}
          onAddNote={() => { void handleAddNote() }}
          onCustomInstructionChange={setCustomInstruction}
        />
      )}
      </div>

      <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
      {outlineNode && (
        <div className="rounded-xl border border-border bg-bg-surface/70 px-5 py-4 shadow-theme-sm">
          <div className="flex items-start gap-3">
            <span className="mt-1 text-accent">☰</span>
            <div>
              <p className="text-xs font-semibold text-text-secondary">本章目标 · {outlineNode.title}</p>
              <p className="mt-1 text-sm leading-7 text-text-secondary">
                {outlineNode.summary || '暂无章纲摘要。'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* D3: 大纲预览 */}
      {showOutlinePreview && outlineNodeId && (
        <div className="mb-3">
          <Suspense fallback={<LazyPanelFallback />}>
            <OutlinePreview outlineNodeId={outlineNodeId} onClose={() => setShowOutlinePreview(false)} />
          </Suspense>
        </div>
      )}

      {/* F: 质量审校面板 */}
      {showReviewPanel && (
        <div className="mb-3">
          <Suspense fallback={<LazyPanelFallback />}>
            <ReviewPanel
              projectId={project.id!}
              chapterId={currentChapter.id!}
              outlineNodeId={currentChapter.outlineNodeId}
              worldGroupId={chapterWorldGroupId}
              chapterContent={plainText}
              chapterTitle={outlineNode?.title || currentChapter?.title || ''}
              worldContext={worldCtx}
              characterContext={charCtx}
              prevChapterSummary={(() => {
                const prev = findPreviousCanonicalChapter(nodes, chapters, currentChapter)
                return prev?.summary || ''
              })()}
              nextChapterSummary={(() => {
                const next = findNextCanonicalChapter(nodes, chapters, currentChapter)
                return next?.summary || ''
              })()}
              foreshadowContext={currentChapter?.id ? buildForeshadowContext(currentChapter.id, chapters, nodes) : ''}
              resolveStateContext={() => assembleCurrentStateContext(plainText)}
              onClose={() => setShowReviewPanel(false)}
              onReviseByReport={handleReviseByReport}
              consistencyRun={consistencyRun}
              consistencyCurrent={consistencyCurrent}
              onConsistencyRun={run => {
                setConsistencyRun(run)
                setConsistencyCurrent(true)
              }}
              onBeforeConsistencyRun={async () => {
                await persistCurrentEditorContent()
              }}
            />
          </Suspense>
        </div>
      )}

      {/* AI 输出 */}
      {/* A3: 情感节拍卡 */}
      {outlineNode && currentChapter?.id && (
        <EmotionBeatCard
          projectId={project.id!}
          chapterId={currentChapter.id}
          chapterTitle={outlineNode.title || currentChapter.title}
          chapterSummary={outlineNode.summary || ''}
          worldContext={worldCtx}
          characterContext={charCtx}
          prevChapterEnding={(() => {
            const prev = findPreviousCanonicalChapter(nodes, chapters, currentChapter)
            return htmlToPlainText(prev?.content || '').slice(-500)
          })()}
        />
      )}

      {/* Phase 21.3: 上下文预算条 */}
      <details className="mb-2 rounded-lg border border-border bg-bg-surface/60 px-3 py-2 text-xs">
        <summary className="cursor-pointer text-text-secondary hover:text-text-primary">
          AI 生成高级选项
          {transparentMode && <span className="ml-2 text-accent">透明模式已开启</span>}
          {planMode && <span className="ml-2 text-accent">生成前协商已开启</span>}
        </summary>
        <label className="mt-2 flex cursor-pointer items-start gap-2 border-t border-border pt-2">
          <input
            type="checkbox"
            checked={transparentMode}
            onChange={event => {
              setTransparentMode(event.target.checked)
              setPendingGeneration(null)
               setPendingEditGeneration(null)
            }}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="font-medium text-text-secondary">发送前预览最终提示词</span>
            <span className="ml-2 text-[10px] text-text-muted">
              默认关闭；开启后可临时编辑拼接后的真实消息，不写回模板或作品资料。
            </span>
          </span>
        </label>
        <label className="mt-2 flex cursor-pointer items-start gap-2 border-t border-border pt-2">
          <input
            type="checkbox"
            checked={planMode}
            onChange={event => {
              setPlanMode(event.target.checked)
              // 关掉开关 = 放弃这次协商：用 cancelPlanNegotiation 而不是只清 planRequest，
              // 否则面板虽卸载、在途闸门却留着（生成入口会一直提示"已有生成在进行中"）。
              if (!event.target.checked) {
                cancelPlanNegotiation()
                setPlanSelection(null)
              } else {
                setPlanRequest(null)
              }
            }}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="font-medium text-text-secondary">生成前协商：先出摘要与字段需求</span>
            <span className="ml-2 text-[10px] text-text-muted">
              默认关闭；开启后生成正文前先用 2 次调用产出可编辑摘要与"所需资料"清单，确认后才提取最终提示词。
            </span>
          </span>
        </label>
      </details>

      {contextBudget && (
        <div className="mb-2">
          <ContextBudgetBar budget={contextBudget} compact={ai.isStreaming} />
        </div>
      )}

      {planRequest && (
        <ChapterPlanPanel
          runtime={{
            projectId: project.id!,
            worldGroupId: chapterWorldGroupId ?? null,
            outlineNodeId: outlineNode?.id ?? null,
            chapterId: currentChapter?.id ?? null,
            provider: aiConfig.provider,
            model: aiConfig.model,
          }}
          chapterTitle={outlineNode?.title ?? currentChapter?.title ?? ''}
          chapterSummary={outlineNode?.summary ?? ''}
          userHint={customInstruction.trim() || undefined}
          call={callPlanModel}
          generationBusy={generationInFlight}
          onBusyChange={handleNegotiationBusy}
          onConfirm={handlePlanConfirm}
          onCancel={cancelPlanNegotiation}
        />
      )}

      <GenerationStatusBar
        visible={longTaskRunning}
        title={statusTitle}
        detail={statusDetail}
        cancelLabel={negotiationBusy && !ai.isStreaming && !generationRunning ? '取消协商' : '取消生成'}
        onCancel={cancelCurrentTask}
      />

      {/* 生成在途闸门的可见反馈：被拦截的重复点击必须说明原因，不能静默无反应。 */}
      {generationNotice && (
        <div className="mb-2 flex items-start justify-between gap-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning" data-testid="generation-blocked-notice">
          <span className="flex items-start gap-1">
            <AlertTriangle className="mt-[2px] h-3 w-3 flex-shrink-0" />{generationNotice}
          </span>
          <button type="button" onClick={() => setGenerationNotice('')} className="text-warning/80 hover:text-warning">关闭</button>
        </div>
      )}

      {pendingEditGeneration && (
        <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <PromptPreviewGate
            messages={pendingEditGeneration.messages}
            requestedFields={planSelection ? <PlanRequestedFields selection={planSelection} ragEntryLabels={planSelection.ragEntryLabels} /> : undefined}
            backLabel="取消本次预览"
            onBack={() => { setPendingEditGeneration(null); endGeneration() }}
            onConfirm={messages => {
              setPendingEditGeneration(null)
              void runEditGeneration(pendingEditGeneration.operation, messages)
            }}
          />
        </div>
      )}

      {pendingGeneration && (
        <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 p-3">
          <PromptPreviewGate
            messages={pendingGeneration.prepared.messages}
            backLabel="取消本次预览"
            // PROMPT-PLAN-2：把"这次具体点了哪些字段"与最终提示词放在同一屏。
            requestedFields={planSelection ? <PlanRequestedFields selection={planSelection} ragEntryLabels={planSelection.ragEntryLabels} /> : undefined}
            onBack={() => { setPendingGeneration(null); endGeneration() }}
            onConfirm={messages => {
              const pending = pendingGeneration
              setPendingGeneration(null)
              runPreparedChapterGeneration(
                pending.operation,
                pending.category,
                pending.prepared,
                pending.backgroundMemoryIds,
                messages,
              )
            }}
          />
        </div>
      )}

      {(ai.output || ai.isStreaming || ai.error) && (
        <div className="mb-3">
          <AIStreamOutput output={ai.output} isStreaming={ai.isStreaming} error={ai.error} tokenUsage={ai.tokenUsage}
            onStop={cancelGeneration} onAccept={handleAcceptAI}
            onDismiss={ai.reset}
            onRetry={() => {
              if (ai.operation === 'generate') requestGeneration('generate')
              else if (ai.operation === 'continue') requestGeneration('continue')
              else if (ai.operation === 'polish') handlePolish()
              else if (ai.operation === 'expand') handleExpand()
              else if (ai.operation === 'deai' || ai.operation === 'deai-full') handleDeAI()
              else if (ai.operation === 'revise-full') {
                const cachedReport = currentChapter?.id
                  ? useReviewResultStore.getState().byChapter[currentChapter.id]?.review
                  : null
                const report = reviseReportRef.current ?? cachedReport
                if (report) handleReviseByReport(report)
              }
            }} />
        </div>
      )}

      {/* Phase A1/A3: 自动后处理状态指示 */}
      {autoProcessing !== 'idle' && (
        <div className="mb-3 p-3 bg-emerald-500/10 border border-emerald-500/20 rounded-lg">
          <div className="flex items-center gap-2 text-sm text-emerald-400">
            <ClipboardList className="w-3.5 h-3.5 animate-pulse" />
            {autoProcessing === 'extracting' && '正在自动提取状态变更...'}
            {autoProcessing === 'memory' && '正在生成章节记忆与计划对账...'}
          </div>
        </div>
      )}

      <ChapterMemoryPanel
        summary={currentChapter.summary}
        hasText={!!plainText}
        memoryBusy={autoProcessing === 'memory' || memoryAI.isStreaming}
        reconciliation={currentChapter.planReconciliation}
        reconciliationCurrent={planReconciliationCurrent}
        onGenerateMemory={() => { void handleManualMemory() }}
        onConfirmActualProgress={() => { void handleConfirmActualProgress() }}
        onApplyOutlineCandidate={() => { void handleApplyOutlineCandidate() }}
      />

      {/* TipTap 富文本编辑器 / 对照润色模式 */}
      {compareSourceHtml != null ? (
        <Suspense fallback={<LazyPanelFallback />}>
          <ComparePolishPanel
            key={currentChapter.id}
            projectId={project.id!}
            chapterId={currentChapter.id!}
            chapterTitle={chapterDisplay?.title ?? currentChapter.title}
            worldGroupId={chapterWorldGroupId}
            sourceHtml={compareSourceHtml}
            entityReferences={entityReferences}
            onSaved={result => {
              contentRef.current = result.html
              setContent(result.html)
              setPlainText(result.plainText)
              setSavedContent(result.html)
            }}
            onClose={() => setCompareSourceHtml(null)}
          />
        </Suspense>
      ) : contentChapterId !== currentChapter.id ? (
        <div className="py-12 text-center text-sm text-text-muted">正在载入正文…</div>
      ) : (
      <div ref={noteAreaRef} className="relative min-h-[640px] w-full" data-testid="manuscript-area">
      <div ref={notePaperRef} className="mx-auto min-h-[640px] max-w-3xl rounded-2xl border border-border bg-bg-elevated px-8 py-8 shadow-theme-md" data-testid="manuscript-paper">
        <RichEditor
          ref={editorRef}
          value={content}
          onChange={(html, plain) => {
            if (contentChapterId !== currentChapter.id) return
            applyEditedContent(html, plain)
            setManualSaveError('')
          }}
          placeholder="开始写作..."
          minHeight={560}
          className="sf-manuscript-editor border-0 bg-transparent shadow-none"
          entityReferences={entityReferences}
          contentHeader={
            <div className="mb-8 mt-8 text-center">
              <p className="text-[11px] uppercase tracking-[0.28em] text-text-muted">
                {chapterDisplay?.ordinal != null ? `第 ${chapterDisplay.ordinal} 章` : '正文'}
              </p>
              <h1 className="mt-4 font-serif text-3xl font-semibold tracking-wide text-text-primary">
                {chapterDisplay?.title ?? currentChapter.title}
              </h1>
              <div className="mx-auto mt-5 h-px w-24 bg-border" />
            </div>
          }
        />
      </div>
        {showNotePanel && (
          <Suspense fallback={null}>
            <NotePanel projectId={project.id!} chapterId={currentChapter?.id}
              paperRef={notePaperRef} />
          </Suspense>
        )}
      </div>
      )}

      {/* Phase 24.3: 选中文本浮动工具栏 */}
      {compareSourceHtml == null && <FloatingToolbar
        getSelectedText={() => editorRef.current?.getSelectedText() || ''}
        getSelectionRect={() => {
          const sel = window.getSelection()
          if (!sel || sel.isCollapsed || !sel.rangeCount) return null
          return sel.getRangeAt(0).getBoundingClientRect()
        }}
        replaceSelectedText={(text) => {
          editorRef.current?.replaceSelection(text)
        }}
        captureSelectionRange={() => editorRef.current?.captureSelectionRange() ?? null}
        replaceRange={(from, to, html) => editorRef.current?.replaceRange(from, to, html) ?? false}
        deleteRange={(from, to) => editorRef.current?.deleteSelectionRange(from, to) ?? false}
        getEditorElement={() => editorRef.current?.getElement() ?? null}
        disabled={ai.isStreaming || generationInFlight}
         onPolish={(text, range) => requestEditGeneration('polish', text, range)}
         onExpand={(text, range) => requestEditGeneration('expand', text, range)}
      />}

      {/* 作者笔记 */}
      <div className="mt-3">
        <label className="block text-xs text-text-muted mb-1">
          <FileText className="w-3 h-3 inline mr-1" />作者笔记
        </label>
        <textarea
          value={currentChapter.notes || ''}
          onChange={e => currentChapter.id && updateChapter(currentChapter.id, { notes: e.target.value })}
          placeholder="写给自己的备忘..."
          rows={2}
          className="w-full p-2 bg-bg-elevated border border-border rounded text-xs text-text-muted resize-y focus:outline-none focus:border-accent"
        />
      </div>

      </div>

      {/* 状态变更审核弹窗 */}
      {pendingDiffs !== null && (
        <Suspense fallback={null}>
          <StateDiffModal
            diffs={pendingDiffs}
            chapterTitle={outlineNode?.title || currentChapter.title || ''}
            onConfirm={handleAcceptDiffs}
            onCancel={() => { setPendingDiffs(null); stateAI.reset() }}
            showSkip={autoProcessing !== 'idle'}
          />
        </Suspense>
      )}

      {organizationRun && showOrganization && (
        <Suspense fallback={null}>
          <ChapterOrganizationModal
            run={organizationRun}
            current={organizationCurrent}
            busy={organizingChapter}
            error={organizationError}
            onApply={selection => { void handleApplyChapterOrganization(selection) }}
            onRerun={() => { void handleRunChapterOrganization(true) }}
            onClose={() => setShowOrganization(false)}
          />
        </Suspense>
      )}
    </div>
  )
}
