import { useState, useEffect, useMemo, useRef } from 'react'
import { Sparkles, Brain, Loader2, Check, AlertCircle, Power } from 'lucide-react'
import { useChapterStore } from '../../stores/chapter'
import { useUserStyleStore } from '../../stores/user-style'
import { useAIConfigStore } from '../../stores/ai-config'
import { buildStyleLearnPrompt } from '../../lib/ai/adapters/style-adapter'
import { chat, resolveRequestConfig } from '../../lib/ai/client'
import { getAIConfigRequiredMessage, isAIConfigReady } from '../../lib/ai/config-readiness'
import {
  formatStyleCalibrationFeedback,
  formatStyleFewShotPairs,
  parseStyleCalibrationFeedback,
  parseStyleRevisionPairs,
} from '../../lib/style/style-learning'
import { countWords, htmlToPlainText } from '../../lib/utils/html'
import type { Project, Chapter, ChapterStatus } from '../../lib/types'
import StyleCalibrationPanel from './StyleCalibrationPanel'
import StyleRevisionPairsPanel from './StyleRevisionPairsPanel'
import { logEvent } from '../../lib/logging/logger'

interface Props {
  project: Project
}

/** 可作为文风语料的章节状态:用户亲手打磨过的 */
const CORPUS_STATUSES: ChapterStatus[] = ['revised', 'polished', 'final']
const STATUS_LABEL: Record<string, string> = { revised: '已修改', polished: '已润色', final: '定稿' }
/** 每章取样上限(控 token);整体也按选中章数自然封顶 */
const PER_CHAPTER_CHARS = 2500
const MAX_CORPUS_CHAPTERS = 6

export default function StyleLearningPanel({ project }: Props) {
  const { chapters, loadAll } = useChapterStore()
  const {
    profile,
    loadProfile,
    saveProfile,
    updateProfileText,
    setEnabled,
    updateRevisionPairNote,
    removeRevisionPair,
  } = useUserStyleStore()
  const aiConfig = useAIConfigStore(s => s.config)

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => { loadAll(project.id!); loadProfile(project.id!) }, [project.id, loadAll, loadProfile])
  useEffect(() => { setDraft(profile?.profile || '') }, [profile?.profile])

  // 候选语料章节(已修改/已润色/定稿 + 有正文)
  const candidates = useMemo(
    () => chapters
      .filter(c => CORPUS_STATUSES.includes(c.status) && (c.content?.trim().length ?? 0) > 0)
      .sort((a, b) => a.order - b.order),
    [chapters],
  )

  // 默认选最近 6 个候选章节，避免旧项目一打开就把全部成稿送进模型。
  useEffect(() => {
    setSelectedIds(new Set(candidates.slice(-MAX_CORPUS_CHAPTERS).map(c => c.id!)))
  }, [candidates])

  const selected = candidates.filter(c => selectedIds.has(c.id!))
  const sampleWords = selected.reduce((sum, chapter) => {
    const sample = htmlToPlainText(chapter.content).trim().slice(0, PER_CHAPTER_CHARS)
    return sum + countWords(sample)
  }, 0)
  const revisionPairs = useMemo(
    () => parseStyleRevisionPairs(profile?.revisionPairs),
    [profile?.revisionPairs],
  )
  const formattedRevisionPairs = useMemo(
    () => formatStyleFewShotPairs(revisionPairs),
    [revisionPairs],
  )
  const formattedCalibrationFeedback = useMemo(
    () => formatStyleCalibrationFeedback(
      parseStyleCalibrationFeedback(profile?.calibrationFeedback),
    ),
    [profile?.calibrationFeedback],
  )
  const hasLearnableSources = selected.length > 0 || revisionPairs.length > 0
  const hasProfile = !!profile?.profile.trim()

  const toggle = (id: number) => {
    if (!selectedIds.has(id) && selectedIds.size >= MAX_CORPUS_CHAPTERS) {
      setError(`为控制输入成本，每次最多选择 ${MAX_CORPUS_CHAPTERS} 章。可取消一章后再选择。`)
      return
    }
    setError(null)
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const buildSamples = (chs: Chapter[]): string =>
    chs.map((c, i) => {
      const plain = htmlToPlainText(c.content).trim()
      const body = plain.slice(0, PER_CHAPTER_CHARS)
      const more = plain.length > PER_CHAPTER_CHARS ? '\n（……本章节选，后略）' : ''
      return `【样本 ${i + 1}·${c.title}】\n${body}${more}`
    }).join('\n\n────────\n\n')

  const handleLearn = async () => {
    if (!hasLearnableSources) return
    const effectiveConfig = resolveRequestConfig(aiConfig, { category: 'style.learn' }).config
    if (!isAIConfigReady(effectiveConfig)) {
      setError(getAIConfigRequiredMessage(effectiveConfig))
      return
    }
    setRunning(true)
    setError(null)
    try {
      const samples = buildSamples(selected)
      const messages = buildStyleLearnPrompt(samples, selected.length, sampleWords, {
        revisionPairs: formattedRevisionPairs,
        calibrationFeedback: formattedCalibrationFeedback,
      })
      const out = await chat(messages, aiConfig, { category: 'style.learn', projectId: project.id! })
      const text = out.trim()
      if (!text) { setError('AI 未返回内容,请重试。'); return }
      await saveProfile(project.id!, {
        profile: text,
        sourceChapterIds: selected.map(c => c.id!),
        sampleCount: selected.length,
        sampleWords,
      })
    } catch (e) {
      logEvent({ level: 'error', tag: 'StyleLearning', event: 'stylelearning', message: '[StyleLearning] 学习失败:', error: e })
      setError(e instanceof Error ? e.message : '学习失败,请重试。')
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto p-5 space-y-5">
        {/* 标题 */}
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-text-primary">
            <Brain className="w-5 h-5 text-accent" /> 文风学习
          </h2>
          <p className="text-xs text-text-muted mt-1">
            让 AI 阅读你已打磨过的章节,总结出你的个人文风画像。开启后,后续章节生成会自动贴合你的笔触。
          </p>
        </div>

        {/* 语料选择 */}
        <div className="bg-bg-surface border border-border rounded-lg p-4 space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-text-primary">学习语料</span>
            <span className="text-xs text-text-muted">
              已选 {selected.length} 章 · 约 {sampleWords.toLocaleString()} 字
            </span>
          </div>

          {candidates.length === 0 ? (
            <div className="flex items-start gap-2 text-xs text-text-muted bg-bg-base rounded p-3">
              <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" />
              <span>
                暂无可学习的章节。请先写几章正文,并把它们的状态设为「已修改 / 已润色 / 定稿」
                (这些是你亲手打磨过的内容,最能代表你的文风),或先保存改稿对照样本。
              </span>
            </div>
          ) : (
            <div className="space-y-1 max-h-56 overflow-y-auto">
              {candidates.map(c => (
                <label key={c.id} className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-bg-base cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(c.id!)}
                    onChange={() => toggle(c.id!)}
                    className="accent-accent"
                  />
                  <span className="text-sm text-text-primary flex-1 truncate">{c.title}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent shrink-0">
                    {STATUS_LABEL[c.status] || c.status}
                  </span>
                  <span className="text-[10px] text-text-muted shrink-0">{(c.wordCount || c.content.length).toLocaleString()} 字</span>
                </label>
              ))}
            </div>
          )}

          <button
            onClick={handleLearn}
            disabled={running || !hasLearnableSources}
            className="w-full flex items-center justify-center gap-2 px-4 py-2 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {running
              ? <><Loader2 className="w-4 h-4 animate-spin" /> 正在学习你的文风…</>
              : <><Sparkles className="w-4 h-4" /> {hasProfile ? '重新学习我的文风' : '一键学习我的文风'}</>}
          </button>

          <p className="text-[11px] leading-5 text-text-muted">
            每次最多读取 {MAX_CORPUS_CHAPTERS} 章、每章 {PER_CHAPTER_CHARS.toLocaleString()} 字符；
            改稿对照最多注入 3 组短片段，不会反复发送整章。
          </p>

          {error && (
            <div className="flex items-start gap-2 text-xs text-error bg-error/10 rounded p-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /> <span>{error}</span>
            </div>
          )}
        </div>

        <div className="space-y-3 rounded-lg border border-border bg-bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-medium text-text-primary">改稿对照样本</h3>
              <p className="mt-1 text-[11px] text-text-muted">
                已保存 {revisionPairs.length} / 8 组；带作者说明的样本会优先参与学习。
              </p>
            </div>
          </div>
          <StyleRevisionPairsPanel
            pairs={revisionPairs}
            onUpdateNote={updateRevisionPairNote}
            onRemove={removeRevisionPair}
          />
        </div>

        {/* 画像展示 + 开关 */}
        {profile && hasProfile && (
          <div className="bg-bg-surface border border-border rounded-lg p-4 space-y-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-sm font-medium text-text-primary">
                <Check className="w-4 h-4 text-success" /> 我的文风画像
              </span>
              <button
                onClick={() => setEnabled(!profile.enabled)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                  profile.enabled ? 'bg-success/15 text-success' : 'bg-text-muted/15 text-text-muted'
                }`}
                title={profile.enabled ? '已开启:生成时注入文风' : '已关闭:生成时不注入'}
              >
                <Power className="w-3.5 h-3.5" /> {profile.enabled ? '注入中' : '已关闭'}
              </button>
            </div>

            <p className="text-[11px] text-text-muted">
              画像基于 {profile.sampleCount} 章、约 {profile.sampleWords.toLocaleString()} 字学习而成。
              下方可手动修改,失焦自动保存。
            </p>

            <textarea
              ref={taRef}
              value={draft}
              onChange={e => setDraft(e.target.value)}
              onBlur={() => { if (draft !== (profile.profile || '')) updateProfileText(draft) }}
              rows={16}
              placeholder="文风画像(可手动编辑,失焦自动保存)"
              className="w-full px-3 py-2 bg-bg-base border border-border rounded text-sm text-text-secondary leading-relaxed resize-y focus:outline-none focus:border-accent font-mono"
            />
          </div>
        )}

        {profile && hasProfile && (
          <StyleCalibrationPanel projectId={project.id!} profile={profile} />
        )}
      </div>
    </div>
  )
}
