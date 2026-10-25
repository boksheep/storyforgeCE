import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Search, Replace, RotateCcw, ShieldCheck, X } from 'lucide-react'
import { useBackupStore } from '../../stores/backup'
import { useChapterStore } from '../../stores/chapter'
import { useCharacterStore } from '../../stores/character'
import { useDialog } from '../shared/Dialog'
import { useToast } from '../shared/Toast'
import { Button } from '../shared/Button'
import {
  buildChapterSearchTargets,
  findChapterMatches,
  type ChapterMatchPreview,
  type FindReplaceOptions,
} from '../../lib/editor/find-replace'
import {
  countPlannedReplacements,
  executeFindReplace,
  undoFindReplace,
  type ReplaceMode,
  type FindReplaceUndoPatch,
} from '../../lib/editor/find-replace-operation'
import type { Chapter, OutlineNode } from '../../lib/types'
import EntityRenamePanel from './EntityRenamePanel'

type SearchScope = 'chapter' | 'book'

interface Props {
  projectId: number
  chapters: Chapter[]
  outlineNodes: OutlineNode[]
  selectedOutlineNodeId: number | null
  onSelectOutlineNode: (outlineNodeId: number) => void
  onClose: () => void
}

function formatTime(ts: number): string {
  const date = new Date(ts)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export default function FindReplacePanel({
  projectId,
  chapters,
  outlineNodes,
  selectedOutlineNodeId,
  onSelectOutlineNode,
  onClose,
}: Props) {
  const dialog = useDialog()
  const toast = useToast()
  const { updateChapter } = useChapterStore()
  const { createSnapshot } = useBackupStore()
  const characters = useCharacterStore(state => state.characters)
  const queryInputRef = useRef<HTMLInputElement | null>(null)

  const [scope, setScope] = useState<SearchScope>('chapter')
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [selected, setSelected] = useState<{ chapterId: number; occurrenceIndex: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [undoPatch, setUndoPatch] = useState<FindReplaceUndoPatch | null>(null)
  const [panelMode, setPanelMode] = useState<'text' | 'entity'>('text')

  useEffect(() => {
    queryInputRef.current?.focus()
  }, [])

  const protectedTerms = useMemo(() => {
    const names = characters
      .filter(character => character.projectId === projectId)
      .map(character => character.name.trim())
      .filter(Boolean)
    return Array.from(new Set(names))
  }, [characters, projectId])

  const searchOptions: FindReplaceOptions = useMemo(() => ({
    query,
    caseSensitive,
    wholeWord,
    useRegex,
    protectedTerms,
  }), [query, caseSensitive, wholeWord, useRegex, protectedTerms])

  const targets = useMemo(() => {
    const all = buildChapterSearchTargets(chapters, outlineNodes)
    if (scope === 'book') return all
    return all.filter(target => target.outlineNodeId === selectedOutlineNodeId)
  }, [chapters, outlineNodes, scope, selectedOutlineNodeId])

  const matches = useMemo(() => {
    if (!query.trim()) return []
    try {
      return targets
        .map(target => findChapterMatches(target, searchOptions))
        .filter((item): item is ChapterMatchPreview => !!item)
    } catch (error) {
      return [{ chapterId: -1, outlineNodeId: -1, title: '查找条件有误', count: 0, occurrences: [{
        occurrenceIndex: 0,
        matchText: '',
        snippet: error instanceof Error ? error.message : String(error),
      }] }]
    }
  }, [query, searchOptions, targets])

  const totalMatches = matches.reduce((sum, item) => sum + item.count, 0)
  const affectedChapters = matches.filter(match => match.chapterId > 0).length
  const flatOccurrences = matches
    .filter(match => match.chapterId > 0 && match.count > 0)
    .flatMap(match => match.occurrences.map(occurrence => ({
      chapterId: match.chapterId,
      outlineNodeId: match.outlineNodeId,
      occurrenceIndex: occurrence.occurrenceIndex,
    })))
  const activeSelected = selected && matches.some(match =>
    match.chapterId === selected.chapterId
    && match.occurrences.some(occurrence => occurrence.occurrenceIndex === selected.occurrenceIndex),
  )
    ? selected
    : null
  const selectedChapterMatch = activeSelected
    ? matches.find(match => match.chapterId === activeSelected.chapterId)
    : null
  const activeFlatIndex = activeSelected
    ? flatOccurrences.findIndex(item =>
      item.chapterId === activeSelected.chapterId
      && item.occurrenceIndex === activeSelected.occurrenceIndex,
    )
    : -1

  const selectFlatOccurrence = (offset: -1 | 1) => {
    if (!flatOccurrences.length) return
    const base = activeFlatIndex >= 0 ? activeFlatIndex : (offset > 0 ? -1 : 0)
    const nextIndex = (base + offset + flatOccurrences.length) % flatOccurrences.length
    const next = flatOccurrences[nextIndex]
    setSelected({ chapterId: next.chapterId, occurrenceIndex: next.occurrenceIndex })
    if (next.outlineNodeId > 0) onSelectOutlineNode(next.outlineNodeId)
  }

  const applyReplace = async (mode: ReplaceMode) => {
    if (!query.trim()) {
      toast.error('请先输入查找内容')
      return
    }
    if (!totalMatches) {
      toast.info('没有可替换的命中')
      return
    }

    const selectedChapterId = activeSelected?.chapterId ?? matches[0]?.chapterId
    const chaptersToReplace = mode === 'book'
      ? targets
      : mode === 'chapter'
        ? targets.filter(target => target.id === selectedChapterId || (selectedChapterId == null && target.outlineNodeId === selectedOutlineNodeId))
        : targets.filter(target => target.id === selectedChapterId)

    if (!chaptersToReplace.length) {
      toast.error('没有可替换的章节')
      return
    }

    const plan = countPlannedReplacements(chaptersToReplace, searchOptions, mode)

    const ok = await dialog.confirm({
      title: '确认替换？',
      message: [
        `将替换 ${plan.count} 处，分布在 ${plan.affectedChapters} 章。`,
        '执行前会自动创建项目快照；本次会话内也可一键撤销到替换前内容。',
        '如当前章有未保存草稿，请先点击正文页“保存”。',
      ].join('\n'),
      confirmText: '创建快照并替换',
      cancelText: '取消',
      tone: mode === 'book' ? 'danger' : 'info',
    })
    if (!ok) return

    setBusy(true)
    try {
      const result = await executeFindReplace({
        mode,
        targets: chaptersToReplace,
        chapters,
        options: { ...searchOptions, replacement },
        projectId,
        selected: activeSelected,
        createSnapshot,
        updateChapter,
        label: `查找替换前自动快照 ${formatTime(Date.now())}`,
      })

      setUndoPatch(result.undoPatch)
      setSelected(null)
      toast.success(`已替换 ${result.replaced} 处，并创建快照`)
    } catch (error) {
      toast.error(`替换失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const handleUndo = async () => {
    if (!undoPatch) return
    const ok = await dialog.confirm({
      title: '撤销上次替换？',
      message: `将把 ${undoPatch.chapters.length} 章恢复到「${undoPatch.label}」对应内容。`,
      confirmText: '撤销',
      cancelText: '取消',
      tone: 'danger',
    })
    if (!ok) return
    setBusy(true)
    try {
      await undoFindReplace(undoPatch, updateChapter)
      setUndoPatch(null)
      toast.success('已撤销上次替换')
    } catch (error) {
      toast.error(`撤销失败：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-xl border border-border bg-bg-surface shadow-theme-sm">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <p className="text-sm font-medium text-text-primary">
            {panelMode === 'text' ? '全书查找替换' : '智能实体改名'}
          </p>
          <p className="text-[11px] text-text-muted">
            {panelMode === 'text'
              ? '基于已保存正文查找；批量替换前自动创建快照。'
              : '同步稳定实体、正文和结构化冗余名称；执行前先预览并创建快照。'}
          </p>
        </div>
        <Button variant="ghost" size="xs" iconOnly onClick={onClose} aria-label="关闭查找替换">
          <X />
        </Button>
      </div>

      <div className="flex gap-1 border-b border-border px-4 pt-2">
        <button
          onClick={() => setPanelMode('text')}
          className={`rounded-t-md px-3 py-1.5 text-xs ${
            panelMode === 'text' ? 'bg-accent/10 text-accent' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          文字替换
        </button>
        <button
          onClick={() => setPanelMode('entity')}
          className={`rounded-t-md px-3 py-1.5 text-xs ${
            panelMode === 'entity' ? 'bg-accent/10 text-accent' : 'text-text-muted hover:text-text-primary'
          }`}
        >
          智能实体改名
        </button>
      </div>

      {panelMode === 'entity' ? (
        <EntityRenamePanel projectId={projectId} onSelectOutlineNode={onSelectOutlineNode} />
      ) : (
      <div className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_260px]">
        <div className="space-y-3">
          <div className="grid gap-2 md:grid-cols-2">
            <label className="space-y-1">
              <span className="text-[11px] text-text-muted">查找</span>
              <input
                ref={queryInputRef}
                value={query}
                onChange={event => { setQuery(event.target.value); setSelected(null) }}
                placeholder="输入要查找的文字"
                className="w-full rounded-md border border-border bg-bg-base px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-text-muted">替换为</span>
              <input
                value={replacement}
                onChange={event => setReplacement(event.target.value)}
                placeholder="留空表示删除命中文字"
                className="w-full rounded-md border border-border bg-bg-base px-3 py-2 text-sm text-text-primary outline-none focus:border-accent"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-base px-2 py-1 text-text-secondary">
              <input type="radio" checked={scope === 'chapter'} onChange={() => { setScope('chapter'); setSelected(null) }} />
              单章
            </label>
            <label className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-base px-2 py-1 text-text-secondary">
              <input type="radio" checked={scope === 'book'} onChange={() => { setScope('book'); setSelected(null) }} />
              全书
            </label>
            <label className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-base px-2 py-1 text-text-secondary">
              <input type="checkbox" checked={wholeWord} onChange={event => { setWholeWord(event.target.checked); setSelected(null) }} />
              全字匹配
            </label>
            <label className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-base px-2 py-1 text-text-secondary">
              <input type="checkbox" checked={caseSensitive} onChange={event => { setCaseSensitive(event.target.checked); setSelected(null) }} />
              大小写敏感
            </label>
            <label className="inline-flex items-center gap-1.5 rounded-md border border-border bg-bg-base px-2 py-1 text-text-secondary">
              <input type="checkbox" checked={useRegex} onChange={event => { setUseRegex(event.target.checked); setSelected(null) }} />
              正则
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void applyReplace('one')}
              disabled={busy || !totalMatches}
              icon={<Replace />}
            >
              替换单处
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void applyReplace('chapter')}
              disabled={busy || !totalMatches}
              icon={<Replace />}
            >
              本章全部
            </Button>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void applyReplace('book')}
              disabled={busy || !totalMatches}
              icon={<ShieldCheck />}
            >
              全书替换
            </Button>
            {undoPatch && (
              <Button
                variant="warning-soft"
                size="sm"
                onClick={() => void handleUndo()}
                disabled={busy}
                icon={<RotateCcw />}
              >
                撤销上次替换
              </Button>
            )}
          </div>
        </div>

        <aside className="rounded-lg border border-border bg-bg-base p-3">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-xs font-medium text-text-secondary">
              <Search className="h-3.5 w-3.5" /> 命中
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="secondary"
                size="xs"
                iconOnly
                onClick={() => selectFlatOccurrence(-1)}
                disabled={!flatOccurrences.length}
                title="上一处"
                aria-label="上一处命中"
              >
                <ChevronLeft />
              </Button>
              <Button
                variant="secondary"
                size="xs"
                iconOnly
                onClick={() => selectFlatOccurrence(1)}
                disabled={!flatOccurrences.length}
                title="下一处"
                aria-label="下一处命中"
              >
                <ChevronRight />
              </Button>
              <span className="text-[11px] text-text-muted">{totalMatches} 处 / {affectedChapters} 章</span>
            </div>
          </div>
          <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
            {!query.trim() && <p className="py-8 text-center text-xs text-text-muted">输入查找内容后显示命中。</p>}
            {query.trim() && !totalMatches && <p className="py-8 text-center text-xs text-text-muted">没有命中。</p>}
            {matches.map(match => (
              <div key={match.chapterId} className="space-y-1">
                <button
                  onClick={() => {
                    if (match.outlineNodeId > 0) onSelectOutlineNode(match.outlineNodeId)
                  }}
                  className="w-full truncate text-left text-[11px] font-medium text-accent hover:underline"
                >
                  {match.title} · {match.count} 处
                </button>
                {match.occurrences.slice(0, 5).map(occurrence => {
                  const active = activeSelected?.chapterId === match.chapterId && activeSelected.occurrenceIndex === occurrence.occurrenceIndex
                  return (
                    <button
                      key={occurrence.occurrenceIndex}
                      onClick={() => {
                        setSelected({ chapterId: match.chapterId, occurrenceIndex: occurrence.occurrenceIndex })
                        if (match.outlineNodeId > 0) onSelectOutlineNode(match.outlineNodeId)
                      }}
                      className={`w-full rounded border px-2 py-1.5 text-left text-[11px] leading-4 ${
                        active
                          ? 'border-accent/50 bg-accent/10 text-text-primary'
                          : 'border-border bg-bg-surface text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {occurrence.snippet || occurrence.matchText || '命中'}
                    </button>
                  )
                })}
                {match.occurrences.length > 5 && (
                  <p className="text-[10px] text-text-muted">另有 {match.occurrences.length - 5} 处命中。</p>
                )}
              </div>
            ))}
          </div>
          {selectedChapterMatch && (
            <p className="mt-2 border-t border-border pt-2 text-[10px] text-text-muted">
              已选: {selectedChapterMatch.title} 第 {(activeSelected?.occurrenceIndex ?? 0) + 1} 处
            </p>
          )}
        </aside>
      </div>
      )}
    </div>
  )
}
