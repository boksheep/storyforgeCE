import { useEffect, useMemo, useState } from 'react'
import { Check, Loader2, Network, RefreshCw, Sparkles } from 'lucide-react'
import { useAIStream } from '../../hooks/useAIStream'
import { createAISessionKey } from '../../stores/ai-generation-session'
import { useStorylineProgressStore } from '../../stores/storyline-progress'
import type { Chapter, StoryArc } from '../../lib/types'
import { parseStages } from '../../lib/types'
import { db } from '../../lib/db/schema'
import { htmlToPlainText } from '../../lib/utils/html'
import { resolveCanonicalChapterSequence } from '../../lib/ai/chapter-memory/canonical-chapter-sequence'
import {
  acceptNewStorylineCandidate,
  acceptStorylineCrossingCandidate,
  acceptStorylineProgressCandidate,
  buildStorylineProgressPrompt,
  parseStorylineProgressResult,
  type NewStorylineCandidate,
  type StorylineAnalysisCandidates,
  type StorylineCrossingCandidate,
  type StorylineProgressCandidate,
} from '../../lib/storyline/storyline-progress'

const EMPTY: StorylineAnalysisCandidates = { progress: [], crossings: [], newArcs: [] }
const STATUS_LABELS = {
  dormant: '休眠',
  active: '活跃',
  climax: '高潮',
  resolved: '已解决',
  abandoned: '已放弃',
} as const

export default function StorylineProgressPanel(props: {
  projectId: number
  arcs: StoryArc[]
  onArcsChanged: () => Promise<void>
}) {
  const { progress, crossings, loadAll } = useStorylineProgressStore()
  const ai = useAIStream(createAISessionKey(props.projectId, 'storyline-progress.map'))
  const [chapters, setChapters] = useState<Chapter[]>([])
  const [chapterId, setChapterId] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<StorylineAnalysisCandidates>(EMPTY)
  const [accepted, setAccepted] = useState<Set<string>>(new Set())
  const [actionError, setActionError] = useState('')
  const arcVersion = props.arcs.map(arc => `${arc.id}:${arc.updatedAt}`).join('|')

  useEffect(() => {
    void Promise.all([
      loadAll(props.projectId),
      Promise.all([
        db.chapters.where('projectId').equals(props.projectId).toArray(),
        db.outlineNodes.where('projectId').equals(props.projectId).toArray(),
      ]).then(([chapterRows, outlineNodes]) => {
        const { sequence } = resolveCanonicalChapterSequence(outlineNodes, chapterRows)
        const written = sequence
          .map(entry => entry.chapter)
          .filter(row => htmlToPlainText(row.content || '').trim())
        setChapters(written)
        setChapterId(current => current != null && written.some(row => row.id === current)
          ? current
          : written[written.length - 1]?.id ?? null)
      }),
    ])
  }, [props.projectId, loadAll, arcVersion])

  const selectedChapter = chapters.find(row => row.id === chapterId) ?? null
  const arcsById = useMemo(
    () => new Map(props.arcs.filter(arc => arc.id != null).map(arc => [arc.id!, arc])),
    [props.arcs],
  )

  const analyze = async () => {
    if (!selectedChapter) return
    setActionError('')
    setAccepted(new Set())
    const content = htmlToPlainText(selectedChapter.content || '').trim()
    const raw = await ai.start(
      buildStorylineProgressPrompt({
        chapterTitle: selectedChapter.title,
        chapterContent: content,
        arcs: props.arcs,
      }),
      undefined,
      { category: 'storyline-progress.map', projectId: props.projectId },
    )
    if (!raw) return
    setCandidates(parseStorylineProgressResult({ raw, chapterContent: content, arcs: props.arcs }))
  }

  const markAccepted = (key: string) => setAccepted(current => new Set(current).add(key))

  const acceptProgress = async (candidate: StorylineProgressCandidate) => {
    if (!selectedChapter?.id) return
    try {
      setActionError('')
      await acceptStorylineProgressCandidate({
        projectId: props.projectId,
        chapterId: selectedChapter.id,
        candidate,
      })
      markAccepted(`p:${candidate.arcId}`)
      await loadAll(props.projectId)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const acceptCrossing = async (candidate: StorylineCrossingCandidate) => {
    if (!selectedChapter?.id) return
    try {
      setActionError('')
      await acceptStorylineCrossingCandidate({
        projectId: props.projectId,
        chapterId: selectedChapter.id,
        candidate,
      })
      markAccepted(`c:${candidate.arcIdA}:${candidate.arcIdB}`)
      await loadAll(props.projectId)
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const acceptNewArc = async (candidate: NewStorylineCandidate) => {
    try {
      setActionError('')
      await acceptNewStorylineCandidate({ projectId: props.projectId, candidate })
      markAccepted(`n:${candidate.name}`)
      await props.onArcsChanged()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    }
  }

  const hasCandidates = candidates.progress.length + candidates.crossings.length + candidates.newArcs.length > 0

  return (
    <section className="mt-6 space-y-4" aria-label="动态故事线进度">
      <div className="bg-bg-surface border border-border rounded-xl p-4">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
              <Network className="w-4 h-4 text-accent" /> 动态进度与交汇
            </h3>
            <p className="text-xs text-text-muted mt-1">AI 只生成闭集候选；点击采纳后才写入项目。</p>
          </div>
          <span className="text-[11px] text-text-muted">已确认 {progress.length} 条进度 · {crossings.length} 个交汇</span>
        </div>

        <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
          <select
            aria-label="选择已写章节"
            value={chapterId ?? ''}
            onChange={event => setChapterId(event.target.value ? Number(event.target.value) : null)}
            className="px-3 py-2 bg-bg-base border border-border rounded-lg text-sm text-text-primary"
          >
            <option value="">选择已写章节</option>
            {chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
          </select>
          <button
            onClick={analyze}
            disabled={!selectedChapter || !props.arcs.length || ai.isStreaming}
            className="flex items-center justify-center gap-1.5 px-4 py-2 bg-accent text-white rounded-lg text-sm disabled:opacity-50"
          >
            {ai.isStreaming ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            映射本章
          </button>
        </div>
        {!props.arcs.length && <p className="text-xs text-warning mt-2">请先登记至少一条故事线。</p>}
        {!chapters.length && <p className="text-xs text-text-muted mt-2">保存章节正文后才能进行映射。</p>}
        {(ai.error || actionError) && <p role="alert" className="text-xs text-error mt-2">{actionError || ai.error}</p>}
      </div>

      {progress.length > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {progress.map(row => {
            const arc = arcsById.get(row.arcId)
            const stage = arc ? parseStages(arc.stages).find(item => item.id === row.currentStageId) : null
            return (
              <div key={row.id} className="bg-bg-surface border border-border rounded-lg p-3">
                <div className="flex justify-between gap-2">
                  <strong className="text-sm text-text-primary">{arc?.name ?? `故事线 #${row.arcId}`}</strong>
                  <span className="text-xs text-accent">{STATUS_LABELS[row.status]}</span>
                </div>
                {stage && <p className="text-xs text-text-secondary mt-1">阶段：{stage.title}</p>}
                <p className="text-xs text-text-muted mt-1">{row.progressNote}</p>
                {row.lastActiveChapterTitle && <p className="text-[11px] text-text-muted mt-2">最近：{row.lastActiveChapterTitle}</p>}
              </div>
            )
          })}
        </div>
      )}

      {crossings.length > 0 && (
        <div className="bg-bg-surface border border-border rounded-xl p-4">
          <h4 className="text-sm font-medium text-text-primary mb-3">已确认交汇节点</h4>
          <div className="space-y-2">
            {crossings.slice(-12).reverse().map(row => (
              <div key={row.id} className="flex items-start gap-2 text-xs">
                <span className="shrink-0 px-2 py-0.5 rounded-full bg-accent/10 text-accent">
                  {arcsById.get(row.arcIdA)?.name ?? `#${row.arcIdA}`}
                  {' × '}
                  {arcsById.get(row.arcIdB)?.name ?? `#${row.arcIdB}`}
                </span>
                <p className="text-text-secondary">
                  {row.note}
                  {row.chapterTitle && <span className="text-text-muted"> · {row.chapterTitle}</span>}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {(hasCandidates || ai.output) && (
        <div className="bg-bg-surface border border-border rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-text-primary">本次待确认候选</h4>
            <button onClick={() => { setCandidates(EMPTY); ai.reset() }} className="text-xs text-text-muted flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> 清空
            </button>
          </div>
          {!hasCandidates && !ai.isStreaming && <p className="text-xs text-text-muted">没有通过闭集与逐字证据校验的候选。</p>}
          {candidates.progress.map(item => (
            <CandidateCard
              key={`p:${item.arcId}`}
              title={`推进 · ${arcsById.get(item.arcId)?.name ?? item.arcId}`}
              text={`${STATUS_LABELS[item.status]} · ${item.progressNote}`}
              quote={item.evidenceQuote}
              accepted={accepted.has(`p:${item.arcId}`)}
              onAccept={() => acceptProgress(item)}
            />
          ))}
          {candidates.crossings.map(item => (
            <CandidateCard
              key={`c:${item.arcIdA}:${item.arcIdB}`}
              title={`交汇 · ${arcsById.get(item.arcIdA)?.name} × ${arcsById.get(item.arcIdB)?.name}`}
              text={item.note}
              quote={item.evidenceQuote}
              accepted={accepted.has(`c:${item.arcIdA}:${item.arcIdB}`)}
              onAccept={() => acceptCrossing(item)}
            />
          ))}
          {candidates.newArcs.map(item => (
            <CandidateCard
              key={`n:${item.name}`}
              title={`疑似新故事线 · ${item.name}`}
              text={`${item.arcType === 'main' ? '主线' : '支线'} · ${item.description}`}
              quote={item.evidenceQuote}
              accepted={accepted.has(`n:${item.name}`)}
              onAccept={() => acceptNewArc(item)}
              acceptLabel="创建登记"
            />
          ))}
        </div>
      )}
    </section>
  )
}

function CandidateCard(props: {
  title: string
  text: string
  quote: string
  accepted: boolean
  onAccept: () => void
  acceptLabel?: string
}) {
  return (
    <div className="border border-border rounded-lg p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-text-primary">{props.title}</p>
          <p className="text-xs text-text-secondary mt-1">{props.text}</p>
          <p className="text-[11px] text-text-muted mt-2">证据：“{props.quote}”</p>
        </div>
        <button
          onClick={props.onAccept}
          disabled={props.accepted}
          className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 text-xs bg-accent/10 text-accent rounded disabled:opacity-60"
        >
          <Check className="w-3.5 h-3.5" /> {props.accepted ? '已采纳' : props.acceptLabel ?? '采纳'}
        </button>
      </div>
    </div>
  )
}
