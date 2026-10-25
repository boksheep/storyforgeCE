import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BookOpen, CalendarPlus, Grip, Layers, Plus, Sparkles, Trash2, ZoomIn, ZoomOut } from 'lucide-react'
import { Button } from '../shared/Button'
import type { Project } from '../../lib/types/project'
import type { HistoricalTimelineEvent } from '../../lib/types/history'
import type { StoryTimelineEvent } from '../../lib/types/story-timeline'
import { useHistoricalStore } from '../../stores/historical'
import { useStoryTimelineStore } from '../../stores/story-timeline'
import { useStoryArcStore } from '../../stores/story-arc'
import { useChapterStore } from '../../stores/chapter'
import { parseStages, type StoryStage } from '../../lib/types/story-arc'
import { timelineValueAtX, timelineXFor, type TimelineCoordinateDomain } from '../../lib/timeline/timeline-coordinates'
import { useAIConfigStore } from '../../stores/ai-config'
import { resolveRequestConfig } from '../../lib/ai/client'
import { getAIConfigRequiredMessage, isAIConfigReady } from '../../lib/ai/config-readiness'
import { extractStoryTimelineFromChapters } from '../../lib/ai/story-timeline-extraction'

export function parseAbsoluteYear(storyTime: string | undefined): number | null {
  if (!storyTime || typeof storyTime !== 'string') return null
  const absoluteMatch = storyTime.match(/^公元前(\d+)年/) || storyTime.match(/^公元(\d+)年/) || storyTime.match(/^(\d+)年/)
  if (absoluteMatch) {
    return storyTime.startsWith('公元前') ? -parseInt(absoluteMatch[1]) : parseInt(absoluteMatch[1])
  }
  return null
}

type TickUnit = 'year' | 'month' | 'day' | 'custom'
type UnifiedItem = { kind: 'history' | 'story'; id: number; title: string; subtitle: string; position: number; event: HistoricalTimelineEvent | StoryTimelineEvent }
type StageRow = { arcId: number; arcName: string; arcType: string; stage: StoryStage }
type UnplacedStoryItem = { id: number; title: string; storyTime: string; event: StoryTimelineEvent }

const CANVAS_WIDTH = 1600
const CANVAS_HEIGHT = 460
const LEFT_PADDING = 48
const RIGHT_PADDING = 48
const AXIS_Y = 232

const unitLabel = (unit: TickUnit) => unit === 'year' ? '年份' : unit === 'month' ? '月份' : unit === 'day' ? '日期' : '自定义'
const shortTitle = (title: string) => title.length > 16 ? title.slice(0, 14) + '…' : title

type Props = { project: Project; onOpenChapter?: (chapterId: number) => void }

export default function UnifiedTimelinePanel({ project, onOpenChapter }: Props) {
  const aiConfig = useAIConfigStore(s => s.config)
  const [extracting, setExtracting] = useState(false)
  const [extractProgress, setExtractProgress] = useState<{ done: number; total: number } | null>(null)
  const [extractError, setExtractError] = useState<string | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState(0)
  const [unit, setUnit] = useState<TickUnit>('year')
  const [customUnit, setCustomUnit] = useState('刻度')
  const [selected, setSelected] = useState<string | null>(null)
  const [hovered, setHovered] = useState<string | null>(null)
  const dragRef = useRef<{ x: number; offset: number } | null>(null)
  const itemDragRef = useRef<{ key: string; startX: number; startPosition: number; currentPosition: number } | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const zoomRef = useRef(zoom)
  const offsetRef = useRef(offset)
  const coordinateDomainRef = useRef<TimelineCoordinateDomain | null>(null)

  const { events: historicalEvents, loading: historicalLoading, loadEvents: loadHistorical, addEvent: createHistoricalEvent, updateEvent: updateHistoricalEvent, deleteEvent: deleteHistoricalEvent } = useHistoricalStore()
  const { events: storyEvents, loading: storyLoading, loadAll: loadStoryTimeline, updateEvent: updateStoryEvent, deleteEvent: deleteStoryEvent } = useStoryTimelineStore()
  const { arcs: storyArcs, loading: storyArcLoading, loadAll: loadArcs, updateStages } = useStoryArcStore()
  const { chapters, loading: chaptersLoading, loadAll: loadChapters } = useChapterStore()

  const extractFromChapters = async () => {
    const effective = resolveRequestConfig(aiConfig, { category: 'story.timeline' }).config
    if (!isAIConfigReady(effective)) {
      setExtractError(getAIConfigRequiredMessage(effective))
      return
    }
    setExtracting(true)
    setExtractError(null)
    try {
      await extractStoryTimelineFromChapters({
        projectId: project.id!,
        chapters,
        config: aiConfig,
        onProgress: (done, total) => setExtractProgress({ done, total }),
      })
      await loadStoryTimeline(project.id!)
    } catch (error) {
      setExtractError(error instanceof Error ? error.message : String(error))
    } finally {
      setExtracting(false)
      setExtractProgress(null)
    }
  }

  useEffect(() => {
    if (project.id == null) return
    void loadHistorical(project.id)
    void loadStoryTimeline(project.id)
    void loadArcs(project.id)
    void loadChapters(project.id)
  }, [project.id, loadHistorical, loadStoryTimeline, loadArcs, loadChapters])

  const historyYears = historicalEvents.map(event => event.year).filter(Number.isFinite)
  const historyMin = historyYears.length ? Math.min(...historyYears) : 0
  const historyMax = historyYears.length ? Math.max(...historyYears) : 0

  const unplacedStoryItems = useMemo<UnplacedStoryItem[]>(() => storyEvents
    .filter(event => parseAbsoluteYear(event.storyTime) == null)
    .map((event, index) => ({ id: event.id ?? index, title: event.title, storyTime: event.storyTime || '未填写明确时间', event })), [storyEvents])

  const items = useMemo<UnifiedItem[]>(() => {
    const historyItems = historicalEvents.map((event, index) => ({
      kind: 'history' as const,
      id: event.id ?? index,
      title: event.title,
      subtitle: event.date || `${event.year}`,
      position: Number.isFinite(event.year) ? event.year : historyMin + index,
      event,
    }))
    const storyItems = storyEvents
      .map((event, index) => ({ event, index, position: parseAbsoluteYear(event.storyTime) }))
      .filter((item): item is { event: StoryTimelineEvent; index: number; position: number } => item.position != null)
      .map(({ event, index, position }) => ({
        kind: 'story' as const,
        id: event.id ?? index,
        title: event.title,
        subtitle: event.storyTime || `${position}年`,
        position,
        event,
      }))
    return [...historyItems, ...storyItems]
  }, [historicalEvents, storyEvents, historyMin])

  const stages = useMemo<StageRow[]>(() => storyArcs.flatMap(arc => parseStages(arc.stages)
    .filter(stage => stage.timelineStartYear == null || stage.timelineEndYear == null)
    .map(stage => ({ arcId: arc.id!, arcName: arc.name, arcType: arc.type === 'main' ? '主线' : '支线', stage }))), [storyArcs])
  const placedStages = useMemo(() => storyArcs.flatMap(arc => parseStages(arc.stages)
    .filter(stage => Number.isFinite(stage.timelineStartYear) && Number.isFinite(stage.timelineEndYear))
    .map(stage => ({ arcName: arc.name, arcType: arc.type === 'main' ? '主线' : '支线', stage, startYear: stage.timelineStartYear!, endYear: stage.timelineEndYear! }))), [storyArcs])

  const positions = [...items.map(item => item.position), ...placedStages.flatMap(stage => [stage.startYear, stage.endYear])]
  const timelineMin = positions.length ? Math.min(...positions) : historyMin
  const timelineMax = Math.max(timelineMin + 1, ...positions)
  const timelineDomain = timelineMax - timelineMin
  const zoomMax = 36500
  const coordinateDomain = useMemo<TimelineCoordinateDomain>(() => ({
    min: timelineMin, max: timelineMax, leftPadding: LEFT_PADDING,
    rightPadding: RIGHT_PADDING, canvasWidth: CANVAS_WIDTH,
  }), [timelineMin, timelineMax])
  useEffect(() => { zoomRef.current = zoom }, [zoom])
  useEffect(() => { offsetRef.current = offset }, [offset])
  useEffect(() => { coordinateDomainRef.current = coordinateDomain }, [coordinateDomain])
  const xFor = useCallback((yearPosition: number) => timelineXFor(yearPosition, coordinateDomain, zoom, offset), [coordinateDomain, zoom, offset])

  const ticks = useMemo(() => {
    const pixelsPerYear = ((CANVAS_WIDTH - LEFT_PADDING - RIGHT_PADDING) / timelineDomain) * zoom
    const effectiveUnit: TickUnit = unit === 'custom'
      ? 'custom'
      : unit === 'day' || (unit === 'year' && pixelsPerYear >= 420)
        ? 'day'
        : unit === 'month' || (unit === 'year' && pixelsPerYear >= 24)
          ? 'month'
          : 'year'
    const baseStep = effectiveUnit === 'day' ? 1 / 365 : effectiveUnit === 'month' ? 1 / 12 : effectiveUnit === 'year' ? 1 : Math.max(1 / 365, timelineDomain / 8)
    const step = baseStep * Math.max(1, Math.ceil(80 / (pixelsPerYear * baseStep)))
    const visibleStart = timelineValueAtX(-24, coordinateDomain, zoom, offset)
    const visibleEnd = timelineValueAtX(CANVAS_WIDTH + 24, coordinateDomain, zoom, offset)
    const first = Math.ceil(visibleStart / step)
    const values: number[] = []
    for (let count = 0, value = first * step; count < 160 && value <= visibleEnd; count++, value = (first + count) * step) {
      const x = xFor(value)
      if (x >= -24 && x <= CANVAS_WIDTH + 24) values.push(value)
    }
    return values.map(value => {
      const x = xFor(value)
      const year = Math.floor(value)
      const fraction = value - year
      const label = effectiveUnit === 'year'
        ? `${Math.round(value)}年`
        : effectiveUnit === 'month'
          ? `${Math.floor(fraction * 12) + 1}月 · ${year}年`
          : effectiveUnit === 'day'
            ? `${Math.floor(fraction * 365) + 1}日 · ${year}年`
            : `${value.toFixed(2)}${customUnit}`
      return { value, x, label }
    })
  }, [unit, customUnit, timelineDomain, coordinateDomain, zoom, offset, xFor])

  const addHistoricalEvent = async () => {
    if (project.id == null) return
    const year = Math.round((historyMax || new Date().getFullYear()) + 1)
    const id = await createHistoricalEvent({ projectId: project.id, era: 'custom', year, date: `${year}年`, title: '新历史事件', description: '补充事件描述', isHistorical: false })
    setSelected(`history-${id}`)
  }

  const beginDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (itemDragRef.current) return
    dragRef.current = { x: event.clientX, offset }
    svgRef.current?.setPointerCapture(event.pointerId)
  }
  const moveDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (itemDragRef.current) {
      const year = timelineValueAtX(((event.clientX - event.currentTarget.getBoundingClientRect().left) / event.currentTarget.getBoundingClientRect().width) * CANVAS_WIDTH, coordinateDomain, zoom, offset)
      itemDragRef.current.currentPosition = year
      return
    }
    if (!dragRef.current) return
    setOffset(dragRef.current.offset + event.clientX - dragRef.current.x)
  }
  const endDrag = (event?: React.PointerEvent<SVGSVGElement>) => {
    const drag = itemDragRef.current
    if (drag) {
      const year = Math.round(drag.currentPosition)
      if (drag.key.startsWith('history-')) void updateHistoricalEvent(Number(drag.key.slice(8)), { year, date: `${year}年` })
      else void updateStoryEvent(Number(drag.key.slice(6)), { storyTime: `${year}年` })
      if (event) event.currentTarget.releasePointerCapture(event.pointerId)
    } else if (event && dragRef.current) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    itemDragRef.current = null
    dragRef.current = null
  }
  const beginItemDrag = (event: React.PointerEvent<SVGGElement>, item: UnifiedItem) => {
    event.stopPropagation()
    itemDragRef.current = { key: `${item.kind}-${item.id}`, startX: event.clientX, startPosition: item.position, currentPosition: item.position }
    svgRef.current?.setPointerCapture(event.pointerId)
  }
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const preventPageWheel = (event: WheelEvent) => {
      event.preventDefault()
      event.stopPropagation()
      const domain = coordinateDomainRef.current
      if (!domain) return
      const rect = svg.getBoundingClientRect()
      if (!rect.width) return
      const viewX = ((event.clientX - rect.left) / rect.width) * CANVAS_WIDTH
      const oldZoom = zoomRef.current
      const oldOffset = offsetRef.current
      const nextZoom = Math.max(0.55, Math.min(zoomMax, oldZoom * (event.deltaY < 0 ? 1.12 : 0.89)))
      if (nextZoom === oldZoom) return
      const baseX = (viewX - oldOffset) / oldZoom
      const nextOffset = viewX - baseX * nextZoom
      zoomRef.current = nextZoom
      offsetRef.current = nextOffset
      setOffset(nextOffset)
      setZoom(nextZoom)
    }
    svg.addEventListener('wheel', preventPageWheel, { passive: false })
    return () => svg.removeEventListener('wheel', preventPageWheel)
  }, [])

  const loading = historicalLoading || storyLoading || storyArcLoading || chaptersLoading
  const [placementYears, setPlacementYears] = useState<Record<string, string>>({})
  const [stagePlacementYears, setStagePlacementYears] = useState<Record<string, { start: string; end: string }>>({})
  const deleteSelected = async () => {
    if (!selected) return
    const [kind, rawId] = selected.split('-')
    const id = Number(rawId)
    if (!Number.isFinite(id)) return
    if (kind === 'history') await deleteHistoricalEvent(id)
    if (kind === 'story') await deleteStoryEvent(id)
    setSelected(null)
  }
  const placeStoryEvent = async (event: StoryTimelineEvent) => {
    const value = placementYears[`story-${event.id}`]
    const year = Number(value)
    if (!Number.isFinite(year) || event.id == null) return
    await updateStoryEvent(event.id, { storyTime: `${Math.round(year)}年` })
    setPlacementYears(current => ({ ...current, [`story-${event.id}`]: '' }))
  }
  const placeStage = async (arcId: number, stage: StoryStage) => {
    const draft = stagePlacementYears[stage.id]
    const start = Number(draft?.start)
    const end = Number(draft?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return
    const arc = storyArcs.find(item => item.id === arcId)
    if (!arc) return
    const nextStages = parseStages(arc.stages).map(item => item.id === stage.id ? { ...item, timelineStartYear: Math.round(start), timelineEndYear: Math.round(end) } : item)
    await updateStages(arcId, nextStages)
  }
  const renderChapterAnchor = (event: StoryTimelineEvent) => {
    if (event.chapterId == null) return null
    const chapter = chapters.find(item => item.id === event.chapterId)
    return chapter ? <button type="button" onClick={() => onOpenChapter?.(chapter.id!)} disabled={!onOpenChapter} className="inline-flex items-center gap-1 text-[10px] text-accent hover:underline disabled:text-text-muted"><BookOpen className="h-3 w-3" />{chapter.title}</button> : null
  }

  return (
    <section className="space-y-4" aria-label="统一时间线">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border/50 pb-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold text-text-primary"><Layers className="h-5 w-5" />统一时间线</h2>
          <p className="mt-1 text-xs text-text-muted">合并历史事件、剧情事件与故事线阶段，拖动画布查看全局关系</p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-text-muted">刻度
            <select value={unit} onChange={event => setUnit(event.target.value as TickUnit)} className="rounded border border-border bg-bg-base px-2 py-1 text-xs text-text-primary">
              <option value="year">年</option><option value="month">月</option><option value="day">日</option><option value="custom">自定义</option>
            </select>
          </label>
          {unit === 'custom' && <input value={customUnit} onChange={event => setCustomUnit(event.target.value)} aria-label="自定义刻度单位" className="w-16 rounded border border-border bg-bg-base px-2 py-1 text-xs text-text-primary" />}
          <Button variant="secondary" size="sm" icon={<ZoomOut />} onClick={() => setZoom(current => Math.max(0.55, current / 1.15))} aria-label="缩小" />
          <span className="min-w-10 text-center text-xs text-text-muted">{Math.round(zoom * 100)}%</span>
          <Button variant="secondary" size="sm" icon={<ZoomIn />} onClick={() => setZoom(current => Math.min(zoomMax, current * 1.15))} aria-label="放大" />
          <Button variant="primary" size="sm" icon={<CalendarPlus />} onClick={() => void addHistoricalEvent()}>新增历史事件</Button>
          <Button variant="secondary" size="sm" icon={<Sparkles />} disabled={extracting} onClick={() => void extractFromChapters()}>
            {extracting ? `提取中 ${extractProgress?.done ?? 0}/${extractProgress?.total ?? chapters.length}` : '从正文提取年表'}
          </Button>
        </div>
      </header>
      {extractError && <p role="alert" className="text-sm text-red-400">{extractError}</p>}

      <div className="overflow-hidden rounded-lg border border-border bg-bg-surface">
        {loading ? <div className="py-16 text-center text-sm text-text-muted">加载中...</div> : (
          <svg ref={svgRef} viewBox={`0 0 ${CANVAS_WIDTH} ${CANVAS_HEIGHT}`} className="h-[460px] w-full select-none bg-bg-base overscroll-contain" style={{ overscrollBehavior: 'contain', touchAction: 'none' }} role="application" aria-label="可拖拽缩放的时间线画布" onPointerDown={beginDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <text x="18" y="24" className="fill-text-muted text-[11px]">{unit === 'custom' ? customUnit : unitLabel(unit)}</text>
            {ticks.map(tick => <g key={`${tick.value}-${tick.x}`}><line x1={tick.x} x2={tick.x} y1="38" y2="430" stroke="currentColor" className="text-border/40" strokeDasharray="3 5" /><text x={tick.x} y="32" textAnchor="middle" className="fill-text-muted text-[10px]">{tick.label}</text></g>)}
            <line x1="0" x2={CANVAS_WIDTH} y1={AXIS_Y} y2={AXIS_Y} stroke="currentColor" className="text-accent" strokeWidth="3" vectorEffect="non-scaling-stroke" />
            <text x="18" y={AXIS_Y + 4} className="fill-text-muted text-[11px]">事件</text>
            {placedStages.map((row, index) => {
              const x1 = xFor(row.startYear)
              const x2 = xFor(row.endYear)
              return <g key={`${row.arcName}-${row.stage.id}`}>
                <rect x={x1} y={70 + (index % 5) * 26} width={Math.max(18, x2 - x1)} height="16" rx="3" className={row.arcType === '主线' ? 'fill-accent/35' : 'fill-amber-400/30'} />
                <text x={x1 + 5} y={82 + (index % 5) * 26} className="fill-text-primary text-[9px]">{shortTitle(`${row.arcName} · ${row.stage.title}`)}</text>
              </g>
            })}
            {[...items].sort((a, b) => Number(`${a.kind}-${a.id}` === hovered || `${a.kind}-${a.id}` === selected) - Number(`${b.kind}-${b.id}` === hovered || `${b.kind}-${b.id}` === selected)).map((item, index) => { const x = xFor(item.position); const y = item.kind === 'history' ? 172 - (index % 3) * 22 : 292 + (index % 3) * 22; const key = `${item.kind}-${item.id}`; const highlighted = hovered === key || selected === key; return <g key={key} transform={`translate(${x} ${y})`} onPointerDown={event => beginItemDrag(event, item)} onClick={() => setSelected(key)} onMouseEnter={() => setHovered(key)} onMouseLeave={() => setHovered(null)} className="cursor-grab active:cursor-grabbing"><line y1={item.kind === 'history' ? 15 : -15} y2={item.kind === 'history' ? AXIS_Y - y : y - AXIS_Y} className={item.kind === 'history' ? 'stroke-sky-400/50' : 'stroke-emerald-400/50'} strokeWidth={highlighted ? 3 : 1} /><circle r={highlighted ? 10 : 7} className={highlighted ? 'fill-accent stroke-white' : item.kind === 'history' ? 'fill-sky-400 stroke-bg-base' : 'fill-emerald-400 stroke-bg-base'} strokeWidth={highlighted ? 3 : 2} /><rect x={highlighted ? -72 : -58} y={item.kind === 'history' ? -42 : 12} width={highlighted ? 144 : 116} height={highlighted ? 38 : 30} rx="4" className={highlighted ? 'fill-bg-elevated stroke-accent' : 'fill-bg-surface stroke-border'} /><text x="0" y={item.kind === 'history' ? -27 : 27} textAnchor="middle" className="fill-text-primary text-[10px]">{shortTitle(item.title)}</text><text x="0" y={item.kind === 'history' ? -15 : 39} textAnchor="middle" className="fill-text-muted text-[8px]">{shortTitle(item.subtitle)}</text></g> })}
          </svg>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-4 text-xs text-text-muted"><span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-sky-400" />历史事件</span><span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />明确公历年份的故事事件</span><span className="flex items-center gap-1"><span className="h-2.5 w-2.5 rounded-sm bg-accent/60" />故事线阶段</span><Grip className="ml-auto h-3.5 w-3.5" />拖拽平移，滚轮缩放；日刻度按公历年份内 365 天显示</div>

      {selected && (() => { const item = items.find(candidate => `${candidate.kind}-${candidate.id}` === selected); if (!item) return null; return <div className="flex items-center gap-3 border-t border-border/50 pt-3 text-sm text-text-secondary"><strong className="text-text-primary">{item.title}</strong>{item.kind === 'story' && <><span>{item.event.description || '暂无描述'}</span>{renderChapterAnchor(item.event as StoryTimelineEvent)}</>}<button type="button" onClick={() => void deleteSelected()} className="ml-auto inline-flex items-center gap-1 text-red-400 hover:underline"><Trash2 className="h-3 w-3" />删除</button></div> })()}
      {unplacedStoryItems.length > 0 && <section className="border-t border-border/50 pt-3" aria-label="待定位故事事件"><h3 className="mb-2 text-sm font-medium text-text-primary">待定位故事事件 <span className="text-xs text-text-muted">{unplacedStoryItems.length}</span></h3><div className="grid gap-2 sm:grid-cols-2">{unplacedStoryItems.map(item => <article key={item.id} className="border border-border bg-bg-surface px-3 py-2"><h4 className="text-xs font-medium text-text-primary">{item.title}</h4><p className="mt-1 text-[11px] text-text-muted">时间：{item.storyTime}</p><div className="mt-2 flex items-center gap-2"><input type="number" placeholder="公历年份" value={placementYears[`story-${item.id}`] || ''} onChange={event => setPlacementYears(current => ({ ...current, [`story-${item.id}`]: event.target.value }))} className="w-24 rounded border border-border bg-bg-base px-2 py-1 text-xs" /><button type="button" onClick={() => void placeStoryEvent(item.event)} className="text-xs text-accent hover:underline">定位</button>{renderChapterAnchor(item.event)}</div></article>)}</div></section>}
      {stages.length > 0 && <section className="border-t border-border/50 pt-3" aria-label="待定位故事线阶段"><h3 className="mb-2 text-sm font-medium text-text-primary">待定位故事线阶段 <span className="text-xs text-text-muted">{stages.length}</span></h3><div className="grid gap-2 sm:grid-cols-2">{stages.map(item => <article key={`${item.arcId}-${item.stage.id}`} className="border border-border bg-bg-surface px-3 py-2"><h4 className="text-xs font-medium text-text-primary">{item.arcName} · {item.stage.title}</h4><div className="mt-2 flex items-center gap-2"><input type="number" placeholder="起始年" value={stagePlacementYears[item.stage.id]?.start || ''} onChange={event => setStagePlacementYears(current => ({ ...current, [item.stage.id]: { start: event.target.value, end: current[item.stage.id]?.end || '' } }))} className="w-20 rounded border border-border bg-bg-base px-2 py-1 text-xs" /><input type="number" placeholder="结束年" value={stagePlacementYears[item.stage.id]?.end || ''} onChange={event => setStagePlacementYears(current => ({ ...current, [item.stage.id]: { start: current[item.stage.id]?.start || '', end: event.target.value } }))} className="w-20 rounded border border-border bg-bg-base px-2 py-1 text-xs" /><button type="button" onClick={() => void placeStage(item.arcId, item.stage)} className="text-xs text-accent hover:underline">定位</button></div></article>)}</div></section>}
      <div className="flex items-center justify-between text-xs text-text-muted"><span>{items.length} 个已定位事件 · {unplacedStoryItems.length} 个待定位故事事件 · {stages.length} 个待定位阶段</span><button type="button" onClick={() => void addHistoricalEvent()} className="inline-flex items-center gap-1 text-accent hover:underline"><Plus className="h-3 w-3" />快速新增历史事件</button></div>
    </section>
  )
}

export type { Props as UnifiedTimelinePanelProps }
