import { useEffect, useMemo, useState } from 'react'
import { BookOpen, Check, GitBranch, Loader2, Sparkles, Trash2, X } from 'lucide-react'
import type { Project } from '../../lib/types'
import { cultivationStageTiers, parseCultivationStages } from '../../lib/types'
import { resolveCanonicalChapterSequence } from '../../lib/ai/chapter-memory/canonical-chapter-sequence'
import {
  acceptCultivationProgressCandidate,
  buildCultivationProgressPrompt,
  parseCultivationProgressResult,
  type CultivationProgressCandidate,
} from '../../lib/cultivation/progress'
import { htmlToPlainText } from '../../lib/utils/html'
import { chat, resolveRequestConfig } from '../../lib/ai/client'
import { getAIConfigRequiredMessage, isAIConfigReady } from '../../lib/ai/config-readiness'
import { useAIConfigStore } from '../../stores/ai-config'
import { useChapterStore } from '../../stores/chapter'
import { useCharacterStore } from '../../stores/character'
import { useCultivationStore } from '../../stores/cultivation'
import { useCultivationProgressStore } from '../../stores/cultivation-progress'
import { useOutlineStore } from '../../stores/outline'
import { useProjectStore } from '../../stores/project'
import { useDialog } from '../shared/Dialog'

const TRANSITION_LABELS = {
  enter: '首次确认',
  advance: '突破',
  regress: '倒退',
  switch: '改道',
} as const

export default function CultivationProgressPanel({ project }: { project: Project }) {
  const dialog = useDialog()
  const aiConfig = useAIConfigStore(state => state.config)
  const chapters = useChapterStore(state => state.chapters)
  const loadChapters = useChapterStore(state => state.loadAll)
  const outlineNodes = useOutlineStore(state => state.nodes)
  const loadOutline = useOutlineStore(state => state.loadAll)
  const characters = useCharacterStore(state => state.characters)
  const loadCharacters = useCharacterStore(state => state.loadAll)
  const systems = useCultivationStore(state => state.systems)
  const loadSystems = useCultivationStore(state => state.loadAll)
  const { events, loadAll: loadEvents, deleteEvent } = useCultivationProgressStore()
  const updateProject = useProjectStore(state => state.updateProject)

  const [selectedChapterId, setSelectedChapterId] = useState<number | null>(null)
  const [selectedCharacterId, setSelectedCharacterId] = useState<number | null>(null)
  const [candidates, setCandidates] = useState<CultivationProgressCandidate[]>([])
  const [analyzing, setAnalyzing] = useState(false)
  const [acceptingKey, setAcceptingKey] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!project.id) return
    loadChapters(project.id)
    loadOutline(project.id)
    loadCharacters(project.id)
    loadSystems(project.id)
    loadEvents(project.id)
  }, [loadChapters, loadCharacters, loadEvents, loadOutline, loadSystems, project.id])

  const sequence = useMemo(
    () => resolveCanonicalChapterSequence(outlineNodes, chapters).sequence,
    [chapters, outlineNodes],
  )
  const chapterOrder = useMemo(() => {
    const result = new Map<number, number>()
    sequence.forEach((entry, index) => {
      if (entry.chapter.id != null) result.set(entry.chapter.id, index)
    })
    return result
  }, [sequence])
  const writtenChapters = useMemo(() => sequence
    .map(entry => entry.chapter)
    .filter(chapter => chapter.id != null && htmlToPlainText(chapter.content || '').trim().length >= 20),
  [sequence])
  const trackableCharacters = useMemo(() => characters
    .filter(character => character.id != null && character.cultivationSystemId != null)
    .sort((left, right) => {
      if (left.roleWeight === 'main' && right.roleWeight !== 'main') return -1
      if (left.roleWeight !== 'main' && right.roleWeight === 'main') return 1
      return left.name.localeCompare(right.name, 'zh-CN')
    }),
  [characters])

  useEffect(() => {
    if (selectedChapterId == null && writtenChapters[0]?.id != null) {
      setSelectedChapterId(writtenChapters[0].id)
    }
  }, [selectedChapterId, writtenChapters])
  useEffect(() => {
    if (
      selectedCharacterId == null
      || !trackableCharacters.some(character => character.id === selectedCharacterId)
    ) {
      setSelectedCharacterId(trackableCharacters[0]?.id ?? null)
    }
  }, [selectedCharacterId, trackableCharacters])

  const selectedCharacter = trackableCharacters.find(character => character.id === selectedCharacterId)
  const selectedSystem = systems.find(system => system.id === selectedCharacter?.cultivationSystemId)
  const selectedStages = parseCultivationStages(selectedSystem?.stages)
  const tiers = cultivationStageTiers(selectedStages)
  const selectedEvents = events
    .filter(event => event.characterId === selectedCharacterId)
    .sort((left, right) => {
      const leftOrder = left.sourceChapterId == null
        ? Number.MAX_SAFE_INTEGER
        : chapterOrder.get(left.sourceChapterId) ?? Number.MAX_SAFE_INTEGER
      const rightOrder = right.sourceChapterId == null
        ? Number.MAX_SAFE_INTEGER
        : chapterOrder.get(right.sourceChapterId) ?? Number.MAX_SAFE_INTEGER
      return leftOrder - rightOrder || left.sourceOffset - right.sourceOffset
    })
  const confirmed = selectedEvents.filter(event => event.status === 'confirmed')
  const current = confirmed[confirmed.length - 1]
  const visited = new Set(confirmed.map(event => event.stageId).filter((id): id is string => Boolean(id)))

  const analyze = async () => {
    const chapter = chapters.find(row => row.id === selectedChapterId)
    if (!chapter) return
    const effective = resolveRequestConfig(aiConfig, { category: 'cultivation.progress' }).config
    if (!isAIConfigReady(effective)) {
      setMessage(getAIConfigRequiredMessage(effective))
      return
    }
    const outline = outlineNodes.find(node => node.id === chapter.outlineNodeId)
    const worldGroupId = outline?.worldGroupId ?? null
    const scopedSystems = systems.filter(system => (system.worldGroupId ?? null) === worldGroupId)
    const systemIds = new Set(scopedSystems.map(system => system.id))
    const scopedCharacters = trackableCharacters.filter(character =>
      character.cultivationSystemId != null
      && systemIds.has(character.cultivationSystemId)
      && (character.isCrossWorld || (character.homeWorldGroupId ?? null) === worldGroupId))
    if (!scopedCharacters.length) {
      setMessage('本章世界没有已关联修炼体系的角色，请先在角色卡设置主修体系。')
      return
    }
    const content = htmlToPlainText(chapter.content || '').trim()
    setAnalyzing(true)
    setMessage('')
    setCandidates([])
    try {
      const raw = await chat(
        buildCultivationProgressPrompt({
          chapterTitle: chapter.title,
          chapterContent: content,
          characters: scopedCharacters,
          systems: scopedSystems,
        }),
        aiConfig,
        { category: 'cultivation.progress', projectId: project.id! },
      )
      const next = parseCultivationProgressResult({
        raw,
        chapterContent: content,
        characters: scopedCharacters,
        systems: scopedSystems,
      })
      setCandidates(next)
      setMessage(next.length ? `发现 ${next.length} 条可靠候选，请逐条确认。` : '没有发现可可靠确认的境界变化。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '分析失败')
    } finally {
      setAnalyzing(false)
    }
  }

  const accept = async (candidate: CultivationProgressCandidate) => {
    if (selectedChapterId == null) return
    const key = candidateKey(candidate)
    setAcceptingKey(key)
    setMessage('')
    try {
      await acceptCultivationProgressCandidate({
        projectId: project.id!,
        chapterId: selectedChapterId,
        candidate,
      })
      await loadEvents(project.id!)
      setCandidates(currentRows => currentRows.filter(row => candidateKey(row) !== key))
      setSelectedCharacterId(candidate.characterId)
      setMessage('已确认并写入修炼历程。')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '确认失败')
    } finally {
      setAcceptingKey(null)
    }
  }

  const removeEvent = async (id: number) => {
    if (!await dialog.confirm({
      title: '删除这条已确认修炼事件？',
      message: '删除后当前境界和实际路径会按剩余事件重新投影。',
      confirmText: '删除',
      tone: 'danger',
    })) return
    await deleteEvent(id)
    await loadEvents(project.id!)
  }

  return (
    <div className="max-w-5xl space-y-5">
      <header className="flex items-start justify-between gap-4 border-b border-border/40 pb-4">
        <div>
          <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
            <GitBranch className="w-5 h-5" /> 修炼进度
          </h2>
          <p className="text-xs text-text-muted mt-1">
            这里是正文确认后的下游历程；角色卡“当前设定境界”仍是上游预设，两者不会互相冒充。
          </p>
        </div>
        <label className="flex items-center gap-2 text-xs text-text-secondary border border-border rounded-lg px-3 py-2">
          <input
            type="checkbox"
            checked={Boolean(project.includeCultivationProgressInAI)}
            onChange={event => updateProject(project.id!, {
              includeCultivationProgressInAI: event.target.checked,
            })}
          />
          反哺后续写作（默认关闭）
        </label>
      </header>

      <section className="rounded-xl border border-border bg-bg-surface p-4 space-y-3">
        <div className="flex items-end gap-3">
          <label className="flex-1">
            <span className="block text-xs text-text-muted mb-1">选择已写章节</span>
            <select
              aria-label="修炼进度来源章节"
              value={selectedChapterId ?? ''}
              onChange={event => {
                setSelectedChapterId(event.target.value ? Number(event.target.value) : null)
                setCandidates([])
                setMessage('')
              }}
              className="w-full bg-bg-base border border-border rounded-lg px-3 py-2 text-sm text-text-primary"
            >
              {writtenChapters.length === 0 && <option value="">暂无已写章节</option>}
              {writtenChapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
            </select>
          </label>
          <button
            onClick={analyze}
            disabled={analyzing || selectedChapterId == null}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-accent text-white text-sm disabled:opacity-40"
          >
            {analyzing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
            {analyzing ? '分析中' : '分析本章'}
          </button>
        </div>
        {message && <p className="text-xs text-text-secondary">{message}</p>}
        {candidates.length > 0 && (
          <div className="space-y-2 pt-2">
            {candidates.map(candidate => {
              const character = characters.find(row => row.id === candidate.characterId)
              const system = systems.find(row => row.id === candidate.cultivationSystemId)
              const stage = parseCultivationStages(system?.stages).find(row => row.id === candidate.stageId)
              const key = candidateKey(candidate)
              return (
                <article key={key} className="border border-accent/25 bg-accent/5 rounded-lg p-3">
                  <div className="flex items-start gap-3">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-text-primary">
                        {character?.name} · {system?.name} → {stage?.name}
                        <span className="ml-2 text-[10px] text-accent">{TRANSITION_LABELS[candidate.transition]}</span>
                      </p>
                      {candidate.trigger && <p className="text-xs text-text-muted mt-1">{candidate.trigger}</p>}
                      <blockquote className="text-xs text-text-secondary mt-2 border-l-2 border-accent/40 pl-2">
                        {candidate.evidenceQuote}
                      </blockquote>
                    </div>
                    <div className="flex gap-1">
                      <button
                        aria-label="确认修炼候选"
                        disabled={acceptingKey === key}
                        onClick={() => accept(candidate)}
                        className="p-1.5 rounded text-green-500 hover:bg-green-500/10 disabled:opacity-40"
                      >
                        {acceptingKey === key
                          ? <Loader2 className="w-4 h-4 animate-spin" />
                          : <Check className="w-4 h-4" />}
                      </button>
                      <button
                        aria-label="忽略修炼候选"
                        onClick={() => setCandidates(rows => rows.filter(row => candidateKey(row) !== key))}
                        className="p-1.5 rounded text-text-muted hover:text-error"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      {trackableCharacters.length === 0 ? (
        <div className="border border-dashed border-border rounded-xl py-12 text-center text-sm text-text-muted">
          还没有关联主修体系的角色。请先到“角色生成”设置主修体系。
        </div>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap">
            {trackableCharacters.map(character => (
              <button
                key={character.id}
                onClick={() => setSelectedCharacterId(character.id!)}
                className={`px-3 py-1.5 rounded-full border text-xs ${
                  character.id === selectedCharacterId
                    ? 'border-accent bg-accent/10 text-accent'
                    : 'border-border text-text-secondary'
                }`}
              >
                {character.name}{character.roleWeight === 'main' ? ' · 主要' : ''}
              </button>
            ))}
          </div>

          <section className="rounded-xl border border-border bg-bg-surface p-4">
            <div className="flex items-center justify-between gap-3 mb-4">
              <div>
                <p className="text-xs text-text-muted">{selectedSystem?.name ?? '未关联体系'}</p>
                <h3 className="text-lg font-semibold text-text-primary">
                  {current ? `正文当前：${current.stageName}` : '正文尚无已确认境界'}
                </h3>
              </div>
              {selectedCharacter?.cultivationStageId && (
                <span className="text-[10px] text-text-muted">
                  角色卡设定：{selectedStages.find(stage => stage.id === selectedCharacter.cultivationStageId)?.name ?? '已失效'}
                </span>
              )}
            </div>

            {selectedStages.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border bg-bg-base/40 p-3 mb-5">
                <div className="flex gap-4 min-w-max">
                  {Array.from({ length: Math.max(...tiers.values(), 0) + 1 }, (_, tier) => (
                    <div key={tier} className="w-36 space-y-2">
                      <p className="text-[10px] text-text-muted text-center">层级 {tier}</p>
                      {selectedStages.filter(stage => (tiers.get(stage.id) ?? 0) === tier).map(stage => (
                        <div
                          key={stage.id}
                          className={`rounded-lg border px-2 py-2 text-xs ${
                            current?.stageId === stage.id
                              ? 'border-accent bg-accent/15 text-accent'
                              : visited.has(stage.id)
                                ? 'border-green-500/40 bg-green-500/10 text-green-400'
                                : 'border-border text-text-muted'
                          }`}
                        >
                          {stage.name}
                          {stage.parentStageIds.length > 0 && (
                            <span className="block text-[9px] opacity-70 mt-1">
                              ← {stage.parentStageIds.map(id =>
                                selectedStages.find(row => row.id === id)?.name ?? id).join(' + ')}
                            </span>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {selectedEvents.length === 0 ? (
              <p className="text-sm text-text-muted text-center py-6">暂无作者确认的正文修炼事件</p>
            ) : (
              <div className="space-y-2 border-l border-border ml-2 pl-4">
                {selectedEvents.map(event => (
                  <article key={event.id} className="relative border border-border rounded-lg px-3 py-2">
                    <span className="absolute -left-[21px] top-3 w-2.5 h-2.5 rounded-full bg-accent border-2 border-bg-base" />
                    <div className="flex items-start gap-2">
                      <div className="flex-1">
                        <p className="text-sm text-text-primary">
                          {event.stageName}
                          <span className="ml-2 text-[10px] text-accent">{TRANSITION_LABELS[event.transition]}</span>
                          {event.status !== 'confirmed' && (
                            <span className="ml-2 text-[10px] text-error">{event.status}</span>
                          )}
                        </p>
                        <p className="text-[10px] text-text-muted flex items-center gap-1 mt-1">
                          <BookOpen className="w-3 h-3" /> {event.sourceChapterTitle}
                        </p>
                        <blockquote className="text-xs text-text-secondary mt-1">{event.sourceQuote}</blockquote>
                      </div>
                      {event.id != null && (
                        <button
                          aria-label="删除修炼事件"
                          onClick={() => removeEvent(event.id!)}
                          className="p-1 text-text-muted hover:text-error"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

function candidateKey(candidate: CultivationProgressCandidate): string {
  return `${candidate.characterId}:${candidate.cultivationSystemId}:${candidate.stageId}:${candidate.sourceOffset}`
}
