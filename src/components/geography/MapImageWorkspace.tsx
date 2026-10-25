import { useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent, type PointerEvent } from 'react'
import type { MapAsset, MapCategoryDefinition, MapFeature, MapGeometry, MapLegendEntry, MapObservation, MapRelation, MapScanTask } from '../../lib/types'
import { addMapAnnotation, addMapCandidates, addMapCategoryDefinition, addMapLegendEntry, addMapObservationToFeature, addMapRelation, ensureMapScanTasks, listDeclaredMapPortals, listMapLinkOptions, listWorldMap, mapRevision, readMapImage, removeMapAsset, renameMapCategoryDefinition, reviewMapCoverage, reviewMapFeature, reviewMapLegendEntry, reviewMapRelation, setManualMapFeatureVisible, setMapFeatureBinding, setMapRelationVisible, setMapScanTaskStatus, summarizeMapCoverageRegion, updateConfirmedMapFeature, updateMapCandidate, updateMapLegendEntry, uploadMapImage } from '../../lib/world-map/map-data'
import { useDialog } from '../shared/Dialog'
import { analyzeMapImage, analyzeMapLegend, mapVisionCompletionOptions, type MapVisionRegion } from '../../lib/world-map/map-vision'
import { useAIConfigStore } from '../../stores/ai-config'
import { resolveRequestConfig } from '../../lib/ai/client'
import { requireBackupBefore } from '../../lib/safety/require-backup-before'
import { MAP_CATEGORIES, canonicalMapCategory, mapCategoryLabel, mapCategoryShape } from '../../lib/world-map/map-categories'
import { planMapTiles } from '../../lib/world-map/map-tiles'
import { planAdaptiveMapScan } from '../../lib/world-map/map-adaptive'
import { openMapImageSession, type MapImageSession } from '../../lib/world-map/map-image-session'
import { recognizeMapText } from '../../lib/world-map/map-ocr'
import { logEvent, newCorrelationId } from '../../lib/logging/logger'
import MapAnalysisStatusBar from './MapAnalysisStatusBar'

interface Props {
  projectId: number
  worldNodeId: number
  onChanged?: () => void
  /** 识图/OCR 运行状态：父级用它决定是否允许切换视图（切换会卸载组件并中止任务）。 */
  onRunningChange?: (running: boolean) => void
}
type DrawKind = 'point' | 'polyline' | 'polygon'
type MapInteraction = 'vision' | 'annotation'
const RELATION_LABELS: Record<MapRelation['kind'], string> = {
  'north-of': '位于北侧', 'south-of': '位于南侧', 'east-of': '位于东侧', 'west-of': '位于西侧',
  adjacent: '相邻', 'land-border': '陆上接壤', 'across-water': '隔水相望', 'coast-of': '濒临海域',
  route: '有路线', distance: '相距',
}

/**
 * 覆盖状态配色：背景与描边表达状态，文字统一用主题前景色。
 *
 * 早前用 text-emerald-100 / text-white，在 paper/scroll/warm/slate 等浅色主题下
 * 与页面底色几乎同色，整块覆盖审计网格看起来是空的（尤其默认「未检查」全是白字）。
 * 图上叠加层与页面里的审计网格必须分开：叠加层只描边，否则半透明底色会盖住原图。
 */
function coverageTone(state: string, surface: 'grid' | 'overlay' = 'grid'): string {
  const overlay = surface === 'overlay'
  if (state === '作者已审') return overlay
    ? 'border-emerald-500/80' : 'border-emerald-500/60 bg-emerald-500/15 text-text-primary'
  if (state === 'AI 已扫待审') return overlay
    ? 'border-amber-500/80' : 'border-amber-500/60 bg-amber-500/15 text-text-primary'
  if (state === '清单未全') return overlay
    ? 'border-violet-500/80' : 'border-violet-500/60 bg-violet-500/15 text-text-primary'
  return overlay ? 'border-slate-400/60' : 'border-border bg-bg-elevated/60 text-text-secondary'
}

function observationStyle(kind: string, status: MapObservation['status']) {
  const candidate = status === 'candidate'
  const code = canonicalMapCategory(kind).toLowerCase()
  const color = code === 'river' || code === 'lake' ? '#38bdf8'
    : code === 'route' ? '#f59e0b' : code === 'railway' ? '#e2e8f0'
      : code === 'coastline' || code === 'sea' ? '#06b6d4'
        : code === 'border' || ['country', 'empire', 'kingdom', 'state'].includes(code) ? '#c084fc'
          : '#10b981'
  const dash = candidate ? '1.1 0.65' : code === 'route' ? '1.5 0.8' : code === 'railway' ? '0.8 0.45' : undefined
  return { color, dash, opacity: candidate ? 0.7 : 1, width: code === 'river' ? 0.38 : code === 'route' ? 0.45 : 0.55 }
}

export default function MapImageWorkspace({ projectId, worldNodeId, onChanged, onRunningChange }: Props) {
  const dialog = useDialog()
  const [assets, setAssets] = useState<MapAsset[]>([])
  const [features, setFeatures] = useState<MapFeature[]>([])
  const [relations, setRelations] = useState<MapRelation[]>([])
  const [legends, setLegends] = useState<MapLegendEntry[]>([])
  const [categories, setCategories] = useState<MapCategoryDefinition[]>([])
  const [observations, setObservations] = useState<MapObservation[]>([])
  const [scanTasks, setScanTasks] = useState<MapScanTask[]>([])
  const [portals, setPortals] = useState<Awaited<ReturnType<typeof listDeclaredMapPortals>>>([])
  const [linkOptions, setLinkOptions] = useState<Awaited<ReturnType<typeof listMapLinkOptions>>>({ codex: [], locations: [] })
  const [assetKey, setAssetKey] = useState<string | null>(null)
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [drawKind, setDrawKind] = useState<DrawKind>('point')
  const [extendFeatureKey, setExtendFeatureKey] = useState('')
  const [points, setPoints] = useState<[number, number][]>([])
  const [name, setName] = useState('')
  const [kind, setKind] = useState('place')
  const [relationFrom, setRelationFrom] = useState('')
  const [relationTo, setRelationTo] = useState('')
  const [relationKind, setRelationKind] = useState<MapRelation['kind']>('north-of')
  const [relationDescription, setRelationDescription] = useState('')
  const [description, setDescription] = useState('')
  const [legendLabel, setLegendLabel] = useState('')
  const [legendKind, setLegendKind] = useState('place')
  const [legendSampleKind, setLegendSampleKind] = useState<MapLegendEntry['sampleKind']>('color')
  const [legendColor, setLegendColor] = useState('#808080')
  const [legendDescription, setLegendDescription] = useState('')
  const [legendUseRegion, setLegendUseRegion] = useState(false)
  // 图例编辑走同一个表单：早前用三个连续 prompt，中途取消会静默丢弃前面的修改，
  // 而且类别用自由文本输入可以写进不存在的类别代码。
  const [editingLegendKey, setEditingLegendKey] = useState<string | null>(null)
  const [editingFeatureKey, setEditingFeatureKey] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [editKind, setEditKind] = useState('place')
  const [editDescription, setEditDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [visionCell, setVisionCell] = useState('auto')
  const [manualRegion, setManualRegion] = useState<MapVisionRegion | null>(null)
  const [draftRegion, setDraftRegion] = useState<MapVisionRegion | null>(null)
  const manualStart = useRef<[number, number] | null>(null)
  const visionAbort = useRef<AbortController | null>(null)
  const [zoom, setZoom] = useState(100)
  const [mapInteraction, setMapInteraction] = useState<MapInteraction>('vision')
  const [featurePage, setFeaturePage] = useState(0)
  const [scanMission, setScanMission] = useState<MapScanTask['mission']>('overview')
  const [maxRefinementRounds, setMaxRefinementRounds] = useState(1)
  const [maxScanRequests, setMaxScanRequests] = useState(32)
  const [revision, setRevision] = useState('')
  const [visionSummary, setVisionSummary] = useState<string | null>(null)
  const [analysisStatus, setAnalysisStatus] = useState<{ title: string; detail?: string } | null>(null)
  const [ocrText, setOcrText] = useState<string | null>(null)
  // 候选清单筛选与批量审核：整图扫描一轮就可能产出上百条，逐条点击不可行。
  const [featureFilter, setFeatureFilter] = useState<'all' | 'candidate' | 'confirmed'>('all')
  const [featureQuery, setFeatureQuery] = useState('')
  const [featureListPage, setFeatureListPage] = useState(0)
  const [selectedFeatureKeys, setSelectedFeatureKeys] = useState<Set<string>>(new Set())
  const [visionRunning, setVisionRunning] = useState(false)
  const runningChangeRef = useRef(onRunningChange)
  runningChangeRef.current = onRunningChange
  useEffect(() => { runningChangeRef.current?.(visionRunning) }, [visionRunning])
  // 组件卸载（切视图/换世界）会中止任务，必须把父级的「运行中」标记复位，
  // 否则父级会一直认为识图未结束。
  useEffect(() => () => { runningChangeRef.current?.(false) }, [])
  const aiConfig = useAIConfigStore(state => state.config)

  const refresh = async () => {
    const data = await listWorldMap(projectId, worldNodeId)
    const currentRevision = await mapRevision(projectId, worldNodeId)
    setAssets(data.assets)
    setFeatures(data.features)
    setRelations(data.relations)
    setLegends(data.legends)
    setCategories(data.categories)
    setObservations(data.observations)
    setScanTasks(data.scanTasks)
    setRevision(currentRevision)
    setAssetKey(current => data.assets.some(asset => asset.assetKey === current) ? current : (data.assets[data.assets.length - 1]?.assetKey ?? null))
  }

  useEffect(() => {
    let cancelled = false
    setAssets([]); setFeatures([]); setRelations([]); setLegends([]); setCategories([]); setObservations([]); setScanTasks([]); setPortals([]); setLinkOptions({ codex: [], locations: [] }); setAssetKey(null); setPoints([]); setExtendFeatureKey(''); setFeaturePage(0); setRevision(''); setVisionCell('auto'); setManualRegion(null); setDraftRegion(null); setZoom(100); setMapInteraction('vision'); setOcrText(null)
    Promise.all([listWorldMap(projectId, worldNodeId), mapRevision(projectId, worldNodeId)]).then(([data, currentRevision]) => {
      if (cancelled) return
      setAssets(data.assets); setFeatures(data.features); setRelations(data.relations); setLegends(data.legends); setCategories(data.categories); setObservations(data.observations); setScanTasks(data.scanTasks)
      setRevision(currentRevision)
      setAssetKey(data.assets[data.assets.length - 1]?.assetKey ?? null)
    }).catch(err => { if (!cancelled) setError(String(err)) })
    listDeclaredMapPortals(projectId, worldNodeId).then(rows => { if (!cancelled) setPortals(rows) })
      .catch(err => { if (!cancelled) setError(String(err)) })
    listMapLinkOptions(projectId, worldNodeId).then(options => { if (!cancelled) setLinkOptions(options) })
      .catch(err => { if (!cancelled) setError(String(err)) })
    return () => { cancelled = true; visionAbort.current?.abort() }
  }, [projectId, worldNodeId])

  useEffect(() => {
    if (!assetKey) { setImageUrl(null); return }
    let cancelled = false
    let url: string | null = null
    readMapImage(projectId, assetKey).then(blob => {
      url = URL.createObjectURL(blob)
      if (!cancelled) setImageUrl(url)
      else URL.revokeObjectURL(url)
    }).catch(err => { if (!cancelled) setError(String(err)) })
    return () => { cancelled = true; setImageUrl(null); if (url) URL.revokeObjectURL(url) }
  }, [projectId, assetKey])

  const onUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setBusy(true); setError(null)
    try {
      const asset = await uploadMapImage(projectId, worldNodeId, file)
      await refresh()
      setAssetKey(asset.assetKey)
      setVisionCell('auto'); setManualRegion(null); setDraftRegion(null); setMapInteraction('vision')
      onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const addPoint = (event: MouseEvent<HTMLDivElement>) => {
    if (mapInteraction !== 'annotation') return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width))
    const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    setPoints(old => drawKind === 'point' ? [[x, y]] : [...old, [x, y]])
  }

  const pointOnImage = (event: PointerEvent<HTMLDivElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect()
    return [Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))]
  }

  const regionBetween = (start: [number, number], end: [number, number]): MapVisionRegion => ({
    x: Math.min(start[0], end[0]), y: Math.min(start[1], end[1]),
    width: Math.abs(end[0] - start[0]), height: Math.abs(end[1] - start[1]),
  })

  const beginManualRegion = (event: PointerEvent<HTMLDivElement>) => {
    if (mapInteraction !== 'vision' || visionCell !== 'manual') return
    event.preventDefault()
    manualStart.current = pointOnImage(event)
    setDraftRegion(null)
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const updateManualRegion = (event: PointerEvent<HTMLDivElement>) => {
    if (!manualStart.current) return
    setDraftRegion(regionBetween(manualStart.current, pointOnImage(event)))
  }

  const endManualRegion = (event: PointerEvent<HTMLDivElement>) => {
    if (!manualStart.current) return
    const region = regionBetween(manualStart.current, pointOnImage(event))
    manualStart.current = null
    setDraftRegion(null)
    if (region.width >= 0.01 && region.height >= 0.01) setManualRegion(region)
  }

  const chooseCategory = async (value: string) => {
    if (value !== '__new__') {
      setKind(value)
      const shape = mapCategoryShape(value)
      if (shape && shape !== drawKind) { setDrawKind(shape); setPoints([]) }
      return
    }
    const label = await dialog.prompt({ title: `新建地图类别（沿用 ${mapCategoryLabel(canonicalMapCategory(kind))} 的位置与关系规则）`, defaultValue: '' })
    if (!label?.trim()) return
    try {
      const custom = await addMapCategoryDefinition({ projectId, worldNodeId, label, baseKind: kind })
      setKind(custom.code); await refresh(); onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  const chooseEditCategory = async (value: string) => {
    if (value !== '__new__') { setEditKind(value); return }
    const label = await dialog.prompt({ title: `新建地图类别（沿用 ${mapCategoryLabel(canonicalMapCategory(editKind))} 的语义）`, defaultValue: '' })
    if (!label?.trim()) return
    try {
      const custom = await addMapCategoryDefinition({ projectId, worldNodeId, label, baseKind: editKind })
      setEditKind(custom.code); await refresh(); onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  const renameCategory = async (category: MapCategoryDefinition) => {
    const label = await dialog.prompt({ title: '修改自建类别显示名（已有标注保持关联）', defaultValue: category.label })
    if (label === null) return
    try { await renameMapCategoryDefinition(projectId, category.code, label); await refresh(); onChanged?.() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

  const save = async () => {
    if (!assetKey) return
    setBusy(true); setError(null)
    try {
      const geometry: MapGeometry = { version: 1, space: 'image', kind: drawKind, points } as MapGeometry
      if (extendFeatureKey) await addMapObservationToFeature({ projectId, worldNodeId, assetKey,
        featureKey: extendFeatureKey, geometry, description })
      else await addMapAnnotation({ projectId, worldNodeId, assetKey, geometry, name, kind, description })
      setPoints([]); setExtendFeatureKey(''); setName(''); setDescription('')
      await refresh(); onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const review = async (feature: MapFeature, status: 'confirmed' | 'rejected') => {
    setBusy(true); setError(null)
    try {
      try { await reviewMapFeature(projectId, feature.featureKey, status) }
      catch (err) {
        if (status !== 'confirmed' || !(err instanceof Error) || !err.message.startsWith('候选已过期')) throw err
        const accepted = await dialog.confirm({ title: '候选基于旧地图事实',
          message: `${err.message}。请核对它的位置和当前标注；确认后仅采纳这一条候选。`, confirmText: '已核对，仍然接受' })
        if (!accepted) return
        await reviewMapFeature(projectId, feature.featureKey, status, true)
      }
      await refresh(); onChanged?.()
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  /**
   * 批量审核：逐条写入，失败不中断。
   *
   * 关键约束：确认任意一条都会改变 `mapRevision`，于是同一批里后续候选会被判为
   * 「候选已过期」。所以批量确认前必须让作者明确一次「按当前原图证据全部接受」，
   * 之后对过期条目才用 allowStale 继续；否则批量接受只成功第一条，其余全部失败。
   */
  const batchReview = async (status: 'confirmed' | 'rejected', targets: MapFeature[]) => {
    const runnable = targets.filter(feature => feature.status === 'candidate')
    if (!runnable.length) { setError('所选条目里没有待审核候选'); return }
    if (status === 'confirmed' && runnable.length === 1) {
      // 单条走原有流程，保留「已核对，仍然接受」的逐条确认。
      await review(runnable[0], 'confirmed')
      return
    }
    if (status === 'confirmed' && !(await dialog.confirm({
      title: `批量接受 ${runnable.length} 项候选？`,
      message: '接受第一项后地图事实版本会变化，其余条目随即变为「候选已过期」。批量接受会按当前原图证据一次性接受全部所选条目；如果你需要逐条对照原图，请改用每行的「接受」。',
      confirmText: '按当前证据全部接受',
    }))) return
    setBusy(true); setError(null)
    let done = 0
    let staleAccepted = 0
    const failures: string[] = []
    try {
      for (const feature of runnable) {
        try { await reviewMapFeature(projectId, feature.featureKey, status); done++ }
        catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          if (status === 'confirmed' && message.startsWith('候选已过期')) {
            try { await reviewMapFeature(projectId, feature.featureKey, status, true); done++; staleAccepted++ }
            catch (retryErr) { failures.push(`${feature.name}：${retryErr instanceof Error ? retryErr.message : String(retryErr)}`) }
          } else {
            failures.push(`${feature.name}：${message}`)
          }
        }
      }
      setSelectedFeatureKeys(new Set())
      await refresh(); onChanged?.()
      const staleNote = staleAccepted ? `（其中 ${staleAccepted} 项按当前证据接受）` : ''
      if (failures.length) {
        setError(`已处理 ${done} 项${staleNote}，${failures.length} 项失败：${failures.slice(0, 3).join('；')}${failures.length > 3 ? '…' : ''}`)
      } else {
        setVisionSummary(`已批量${status === 'confirmed' ? '接受' : '驳回'} ${done} 项候选${staleNote}。`)
      }
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const toggleFeatureSelection = (featureKey: string) => {
    setSelectedFeatureKeys(current => {
      const next = new Set(current)
      if (next.has(featureKey)) next.delete(featureKey); else next.add(featureKey)
      return next
    })
  }

  const editFeature = async (feature: MapFeature) => {
    setBusy(true); setError(null)
    try {
      const changes = { name: editName, kind: editKind, description: editDescription }
      if (feature.status === 'candidate') await updateMapCandidate(projectId, feature.featureKey, changes)
      else await updateConfirmedMapFeature(projectId, feature.featureKey, changes)
      setEditingFeatureKey(null)
      await refresh(); onChanged?.()
    }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const changeVisibility = async (feature: MapFeature) => {
    setBusy(true); setError(null)
    try {
      if (feature.source === 'manual') await setManualMapFeatureVisible(projectId, feature.featureKey, feature.status !== 'confirmed')
      else await reviewMapFeature(projectId, feature.featureKey, 'candidate')
      await refresh(); onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const bind = async (feature: MapFeature, value: string) => {
    setBusy(true); setError(null)
    try {
      const target = value.startsWith('c:') ? { kind: 'codex' as const, id: Number(value.slice(2)) }
        : value.startsWith('l:') ? { kind: 'importantLocation' as const, id: Number(value.slice(2)) } : null
      await setMapFeatureBinding(projectId, feature.featureKey, target)
      await refresh(); onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const saveRelation = async () => {
    setBusy(true); setError(null)
    try {
      await addMapRelation({ projectId, worldNodeId, fromFeatureKey: relationFrom, toFeatureKey: relationTo, kind: relationKind, description: relationDescription })
      setRelationFrom(''); setRelationTo(''); setRelationDescription('')
      await refresh(); onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const resetLegendForm = () => {
    setEditingLegendKey(null)
    setLegendLabel(''); setLegendDescription(''); setLegendUseRegion(false)
    setLegendSampleKind('color'); setLegendColor('#808080')
  }

  const saveLegend = async () => {
    if (!legendLabel.trim()) { setError('请填写图例含义'); return }
    if (!editingLegendKey && legendUseRegion && (!assetKey || !manualRegion)) { setError('请先手动框选图上的样例区域'); return }
    setBusy(true); setError(null)
    try {
      if (editingLegendKey) {
        await updateMapLegendEntry(projectId, editingLegendKey, {
          label: legendLabel, featureKind: legendKind, description: legendDescription,
          sampleColor: legendSampleKind === 'color' ? legendColor : undefined,
          sampleKind: legendSampleKind,
        })
      } else {
        await addMapLegendEntry({ projectId, worldNodeId, label: legendLabel, featureKind: legendKind,
          description: legendDescription, sampleKind: legendSampleKind,
          sampleOrigin: legendUseRegion ? 'map-example' : 'manual',
          sampleColor: legendSampleKind === 'color' ? legendColor : undefined,
          assetKey: legendUseRegion ? assetKey! : undefined,
          sampleRegion: legendUseRegion ? manualRegion! : undefined, source: 'manual' })
      }
      resetLegendForm(); await refresh(); onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const autoLegend = async () => {
    if (!assetKey) return
    const config = resolveRequestConfig(aiConfig, { category: 'geography.world-map', projectId }).config
    if (!(await dialog.confirm({ title: '自动提取地图图例？',
      message: `将${manualRegion ? '当前手动框选区域' : '整张原图的缩略图'}发送给 ${config.provider} / ${config.model || '未设置模型'}，单次输出上限 ${mapVisionCompletionOptions(config, 'legend').max_tokens} tokens。建议先框选图例，返回条目均需逐项审核。`,
      confirmText: '发送并提取' }))) return
    const controller = new AbortController()
    visionAbort.current = controller
    setBusy(true); setError(null)
    setVisionRunning(true)
    setAnalysisStatus({ title: '正在提取地图图例', detail: manualRegion ? '分析框选图例区域' : '分析整图缩略图' })
    const correlationId = newCorrelationId()
    let saved = 0
    try {
      const region = manualRegion ?? { x: 0, y: 0, width: 1, height: 1 }
      const result = await analyzeMapLegend({ projectId, worldNodeId, assetKey, region, signal: controller.signal })
      for (const entry of result.entries) {
        if (controller.signal.aborted) throw new Error('图例识别已取消')
        await addMapLegendEntry({ projectId, worldNodeId, assetKey, label: entry.label,
          featureKind: entry.featureKind, description: entry.description, sampleKind: entry.sampleKind,
          sampleOrigin: 'printed-legend', sampleColor: entry.sampleColor,
          sampleRegion: entry.sampleRegion, source: 'vision', sourceRevision: result.baseRevision })
        saved++
      }
      logEvent({ level: 'info', tag: 'MapImage', event: 'map.legend.extracted', projectId,
        correlationId, meta: { worldNodeId, assetKey, candidates: saved, model: result.model,
          regionX: region.x, regionY: region.y, regionWidth: region.width, regionHeight: region.height } })
      setVisionSummary(`自动图例提出 ${result.entries.length} 项待审条目；确认后才会作为后续识图样例。`)
    } catch (err) {
      logEvent({ level: 'warn', tag: 'MapImage', event: 'map.legend.extract_failed', projectId,
        correlationId, meta: { worldNodeId, assetKey, saved, aborted: controller.signal.aborted }, error: err })
      setError(err instanceof Error ? err.message : String(err))
    } finally { visionAbort.current = null; setAnalysisStatus(null); setBusy(false); setVisionRunning(false); await refresh(); if (saved) onChanged?.() }
  }

  const runLocalOcr = async () => {
    if (!assetKey || !manualRegion) { setError('请先在原图框选要识别的文字区域'); return }
    const controller = new AbortController()
    visionAbort.current = controller
    setBusy(true); setError(null); setOcrText(null)
    setVisionRunning(true)
    setAnalysisStatus({ title: '正在识别地图文字', detail: '本地 OCR · 框选区域' })
    const correlationId = newCorrelationId()
    try {
      const text = await recognizeMapText({ projectId, assetKey, region: manualRegion, signal: controller.signal })
      setOcrText(text || '选区内未识别到文字；可缩小框选区或手动录入图例。')
      logEvent({ level: 'info', tag: 'MapImage', event: 'map.ocr.completed', projectId,
        correlationId, meta: { worldNodeId, assetKey, characters: text.length,
          regionX: manualRegion.x, regionY: manualRegion.y,
          regionWidth: manualRegion.width, regionHeight: manualRegion.height } })
    } catch (err) {
      logEvent({ level: 'warn', tag: 'MapImage', event: 'map.ocr.failed', projectId,
        correlationId, meta: { worldNodeId, assetKey, aborted: controller.signal.aborted }, error: err })
      setError(err instanceof Error ? err.message : String(err))
    }
    finally { visionAbort.current = null; setAnalysisStatus(null); setBusy(false); setVisionRunning(false) }
  }

  const reviewLegend = async (entry: MapLegendEntry, status: 'confirmed' | 'rejected') => {
    setBusy(true); setError(null)
    try { await reviewMapLegendEntry(projectId, entry.legendKey, status); await refresh(); onChanged?.() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const editLegend = (entry: MapLegendEntry) => {
    setEditingLegendKey(entry.legendKey)
    setLegendLabel(entry.label)
    setLegendKind(entry.featureKind)
    setLegendSampleKind(entry.sampleKind)
    setLegendColor(entry.sampleColor ?? '#808080')
    setLegendDescription(entry.description)
    // 编辑只改含义与类别；样例区域沿用原条目，避免误把它换成当前框选。
    setLegendUseRegion(false)
    setError(null)
  }

  const toggleRelation = async (relation: MapRelation) => {
    setBusy(true); setError(null)
    try { await setMapRelationVisible(projectId, relation.relationKey, relation.status !== 'confirmed'); await refresh(); onChanged?.() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const reviewRelation = async (relation: MapRelation, status: 'confirmed' | 'rejected' | 'candidate') => {
    setBusy(true); setError(null)
    try {
      try { await reviewMapRelation(projectId, relation.relationKey, status) }
      catch (err) {
        if (status !== 'confirmed' || !(err instanceof Error) || !err.message.startsWith('关系候选已过期')) throw err
        const accepted = await dialog.confirm({ title: '关系候选基于旧地图事实',
          message: `${err.message}。请对照原图重新核对边界与海陆关系；确认后只采纳这一条。`, confirmText: '已核对，仍然接受' })
        if (!accepted) return
        await reviewMapRelation(projectId, relation.relationKey, status, true)
      }
      await refresh(); onChanged?.()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const confirmCoverage = async (observation: MapObservation) => {
    setBusy(true); setError(null)
    try { await reviewMapCoverage(projectId, observation.observationKey); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const removeImage = async () => {
    if (!assetKey || !(await requireBackupBefore({ operation: '删除地图原图', projectId,
      details: '原图字节将删除；已确认的地图事实仍保留，但旧图标注将失去可查看的背景。完整项目 JSON 备份会包含图片。',
      confirmLabel: '继续删除原图' }))) return
    setBusy(true); setError(null)
    try { await removeMapAsset(projectId, assetKey); await refresh(); onChanged?.() }
    catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }

  const runVision = async () => {
    if (!assetKey) return
    if (visionCell === 'manual' && !manualRegion) { setError('请先在图上拖动框选区域'); return }
    if (visionCell === 'auto' && !tilePlan) { setError('原图超出自动分块预算，请手动框选区域'); return }
    if (visionCell !== 'auto' && !singleRegion) { setError('所选分块已失效，请重新选择区域'); return }
    setBusy(true); setError(null); setVisionSummary(null)
    setVisionRunning(true)
    const controller = new AbortController()
    const correlationId = newCorrelationId()
    visionAbort.current = controller
    let finished = 0
    let failed = 0
    let candidateCount = 0
    let imageSession: MapImageSession | null = null
    let planningWarning = ''
    try {
      setAnalysisStatus({ title: '正在规划地图查漏区域', detail: '读取原图细节并安排分块任务' })
      const asset = assets.find(row => row.assetKey === assetKey)
      if (!asset) throw new Error('原图不存在，请刷新地图')
      const sourceRevision = await mapRevision(projectId, worldNodeId)
      const keyPrefix = `${assetKey}:${sourceRevision}`
      imageSession = await openMapImageSession(projectId, asset)
      if (controller.signal.aborted) throw new Error('地图视觉分析已取消')
      // 顶部已校验非 auto 时 singleRegion 必须存在；这里再取一次局部值，
      // 让 TypeScript 能把 region 收窄成非空类型。
      const fixedRegion = visionCell === 'auto' ? null : singleRegion
      let planned: Awaited<ReturnType<typeof planAdaptiveMapScan>>
      if (visionCell === 'auto') {
        let scoringFailed = false
        const planInput = { tiles: tilePlan!, width: asset.width, height: asset.height,
          featurePageCount, maxRequests: maxScanRequests, keyPrefix,
          scoreRegion: async (region: MapVisionRegion) => {
            if (controller.signal.aborted) throw new Error('地图视觉分析已取消')
            try { return await imageSession!.score(region) }
            catch (error) { scoringFailed = true; throw error }
          } }
        try {
          planned = await planAdaptiveMapScan({ ...planInput, maxRounds: maxRefinementRounds })
        } catch (scoreError) {
          if (controller.signal.aborted || !scoringFailed) throw scoreError
          planningWarning = '原图细节评分不可用，本次只按首轮分块扫描；'
          planned = await planAdaptiveMapScan({ ...planInput, maxRounds: 0 })
        }
      } else {
        planned = { tasks: [{ taskKey: `${keyPrefix}:manual:${crypto.randomUUID()}`, round: 0,
          mission: scanMission, featurePage: effectiveFeaturePage, region: fixedRegion!,
          reason: selectedRegionLabel }], denseRegions: 0, omittedTasks: 0, truncated: false }
      }
      await imageSession.releaseBitmap()
      const rows = await ensureMapScanTasks({ projectId, worldNodeId, assetKey,
        sourceHash: asset.sha256, sourceRevision, tasks: planned.tasks })
      const byKey = new Map(rows.map(row => [row.taskKey, row]))
      const pending = planned.tasks.filter(task => byKey.get(task.taskKey)?.status !== 'completed')
      const runTasks = pending.slice(0, maxScanRequests)
      const config = resolveRequestConfig(aiConfig, { category: 'geography.world-map', projectId }).config
      if (!runTasks.length) {
        setVisionSummary('当前识图计划中的任务都已完成；可提高细分轮数，或手动框选补扫。')
        return
      }
      setAnalysisStatus(null)
      if (!(await dialog.confirm({ title: '让 AI 查看这张地图？',
        message: `${planningWarning}${selectedRegionLabel}；${config.provider} / ${config.model || '未设置模型'}。本次发送 ${runTasks.length} 次视觉请求，单次输出上限 ${mapVisionCompletionOptions(config, 'features').max_tokens} tokens，已完成 ${planned.tasks.length - pending.length} 次；计划中仍有 ${Math.max(0, pending.length - runTasks.length)} 次受本轮预算限制。细节任务会把选区放大到长边 2048 像素再发送（单张约 1MB），以提高小字与线型的可读性。检测到 ${planned.denseRegions} 个高细节区域，最多细分 ${maxRefinementRounds} 轮。${planned.truncated ? '任务队列达到 256 项上限，剩余区域须单独补扫。' : ''}候选须作者审核；空结果不代表没有地物。`,
        confirmText: '发送并分析' }))) return
      let attempted = 0
      for (const task of runTasks) {
        if (controller.signal.aborted) throw new Error('地图视觉分析已取消')
        attempted++
        setAnalysisStatus({ title: `正在查漏地图（${attempted}/${runTasks.length}）`,
          detail: `第 ${task.round} 轮 · ${task.reason} · 已完成 ${finished} 次${failed ? `，失败 ${failed} 次` : ''}` })
        await setMapScanTaskStatus(projectId, task.taskKey, 'running')
        try {
          const result = await analyzeMapImage({ projectId, worldNodeId, assetKey, region: task.region,
            mission: task.mission, featurePage: task.featurePage, signal: controller.signal, correlationId,
            session: imageSession })
          if (controller.signal.aborted) throw new Error('地图视觉分析已取消')
          candidateCount += await addMapCandidates({ projectId, worldNodeId, assetKey, assetHash: result.assetHash,
            baseRevision: result.baseRevision, suggestions: result.suggestions, relations: result.relations,
            correlationId, scanTaskKey: task.taskKey, saturated: result.suggestions.length >= 12,
            coverage: { region: task.region, expectedFeatureKeys: result.expectedFeatureKeys,
              checkedFeatureKeys: result.checkedFeatureKeys, model: result.model } })
          finished++
          logEvent({ level: 'info', tag: 'MapImage', event: 'map.scan.task_completed', projectId,
            correlationId, meta: { worldNodeId, assetKey, taskKey: task.taskKey, round: task.round,
              mission: task.mission, pixelWidth: Math.round(task.region.width * asset.width),
              pixelHeight: Math.round(task.region.height * asset.height), candidates: result.suggestions.length } })
        } catch (error) {
          // 单个分块失败（超时、429、内容校验）不应终止整批：记失败并继续下一个区域，
          // 已完成的区域会保留，再次运行只补未完成的。
          if (controller.signal.aborted) throw error
          failed++
          const failureMessage = error instanceof Error ? error.message : String(error)
          if (failed === 1) setError(failureMessage)
          await setMapScanTaskStatus(projectId, task.taskKey, 'failed', failureMessage)
          logEvent({ level: 'warn', tag: 'MapImage', event: 'map.scan.task_failed', projectId,
            correlationId, meta: { worldNodeId, assetKey, taskKey: task.taskKey,
              round: task.round, mission: task.mission, continued: true }, error })
        }
      }
      for (const task of pending.slice(runTasks.length)) {
        await setMapScanTaskStatus(projectId, task.taskKey, 'budget-exhausted')
      }
      setVisionSummary(`${planningWarning}本次完成 ${finished} 次区域分析，新增待审实体 ${candidateCount} 项${failed ? `；${failed} 次区域失败，可再次运行重试` : ''}；计划剩余 ${Math.max(0, pending.length - finished)} 次。可再次运行续扫，作者仍需逐区核对。`)
      logEvent({ level: 'info', tag: 'MapImage', event: 'map.vision.run_completed', projectId,
        correlationId, meta: { worldNodeId, assetKey, requests: runTasks.length, finished, failed,
          candidates: candidateCount, denseRegions: planned.denseRegions, maxRefinementRounds } })
    } catch (err) {
      logEvent({ level: 'warn', tag: 'MapImage', event: 'map.vision.run_failed', projectId,
        correlationId, meta: { worldNodeId, assetKey, finished, failed,
          candidates: candidateCount, aborted: controller.signal.aborted }, error: err })
      setError(`${err instanceof Error ? err.message : String(err)}；已安全保存 ${finished} 次结果${failed ? `，${failed} 次失败待重试` : ''}，再次运行会跳过已完成任务。`)
    }
    finally { imageSession?.close(); visionAbort.current = null; setAnalysisStatus(null); setBusy(false); setVisionRunning(false); await refresh(); if (finished || failed) onChanged?.() }
  }

  const selected = assets.find(asset => asset.assetKey === assetKey)
  let tilePlan: ReturnType<typeof planMapTiles> | null = null
  if (selected) {
    try { tilePlan = planMapTiles(selected.width, selected.height) }
    catch { /* Manual ROI remains usable when the automatic request budget is exceeded. */ }
  }
  const visible = observations.filter(item => item.assetKey === assetKey && item.observationKind !== 'coverage' && item.status !== 'rejected')
  const coverage = observations.filter(item => item.assetKey === assetKey && item.observationKind === 'coverage')
  const currentScanTasks = scanTasks.filter(task => task.assetKey === assetKey
    && task.sourceHash === selected?.sha256 && task.sourceRevision === revision)
  const confirmedKeys = features.filter(item => item.status === 'confirmed').map(item => item.featureKey)
  const featurePageCount = Math.max(1, Math.ceil(confirmedKeys.length / 40))
  // 事实数量会随审核减少，state 里的页码必须夹取到当前范围，
  // 否则下拉显示第 1 页而实际发送旧页码，识图会报「页码无效」。
  const effectiveFeaturePage = Math.min(featurePage, featurePageCount - 1)
  const singleRegion: MapVisionRegion | null = visionCell === 'manual' ? manualRegion
    : visionCell === 'all' ? { x: 0, y: 0, width: 1, height: 1 }
      : tilePlan?.tiles.find(tile => tile.id === visionCell)?.region ?? null
  const tileCoverage = (tilePlan?.tiles ?? []).map(tile => summarizeMapCoverageRegion({
    observations: coverage, assetHash: selected?.sha256 ?? '', revision,
    confirmedFeatureKeys: confirmedKeys, region: tile.region,
  }))
  const selectedTile = tilePlan?.tiles.find(tile => tile.id === visionCell)
  const selectedRegionLabel = visionCell === 'auto' ? `全部 ${tilePlan?.tiles.length ?? 0} 个自适应分块`
    : visionCell === 'all' ? '整图概览（缩图）' : visionCell === 'manual' ? '手动框选区域'
      : selectedTile ? `第 ${selectedTile.row + 1} 行第 ${selectedTile.column + 1} 列` : '请选择分块'
  const customCategories = categories.filter(category => category.active)
  const legacyCategories = [...new Set([...features.map(feature => feature.kind), kind, editKind,
    legendKind, ...legends.map(legend => legend.featureKind)])]
    .filter(code => code && !MAP_CATEGORIES.some(category => category.code === code)
      && !categories.some(category => category.code === code))
  const normalizedQuery = featureQuery.trim().toLowerCase()
  const matchedFeatures = useMemo(() => features.filter(feature => {
    if (featureFilter !== 'all' && feature.status !== featureFilter) return false
    if (!normalizedQuery) return true
    return `${feature.name} ${feature.description} ${mapCategoryLabel(feature.kind, categories)}`
      .toLowerCase().includes(normalizedQuery)
  }), [features, featureFilter, normalizedQuery, categories])
  const FEATURE_PAGE_SIZE = 40
  const featureListPageCount = Math.max(1, Math.ceil(matchedFeatures.length / FEATURE_PAGE_SIZE))
  const safeFeatureListPage = Math.min(featureListPage, featureListPageCount - 1)
  const pageFeatures = matchedFeatures.slice(safeFeatureListPage * FEATURE_PAGE_SIZE,
    (safeFeatureListPage + 1) * FEATURE_PAGE_SIZE)
  const pageCandidateKeys = pageFeatures.filter(feature => feature.status === 'candidate').map(feature => feature.featureKey)
  // 批量操作按「已勾选的待审候选」跨页统计，避免翻页后已勾选项被静默忽略。
  const selectedCandidates = features.filter(feature =>
    feature.status === 'candidate' && selectedFeatureKeys.has(feature.featureKey))
  const candidateTotal = features.filter(feature => feature.status === 'candidate').length
  // 换图（含删除原图后回落到上一张）会让原分块编号失效：及时退回自动分块，
  // 避免把旧编号当成本图的选区去发送。
  const tileIdsKey = (tilePlan?.tiles ?? []).map(tile => tile.id).join(',')
  useEffect(() => {
    if (featurePage > featurePageCount - 1) setFeaturePage(Math.max(0, featurePageCount - 1))
  }, [featurePage, featurePageCount])
  useEffect(() => {
    if (visionCell === 'auto' || visionCell === 'all' || visionCell === 'manual') return
    if (!tileIdsKey || !tileIdsKey.split(',').includes(visionCell)) setVisionCell('auto')
  }, [tileIdsKey, visionCell])
  useEffect(() => {
    if (featureListPage > featureListPageCount - 1) setFeatureListPage(Math.max(0, featureListPageCount - 1))
  }, [featureListPage, featureListPageCount])
  return <div className="h-full overflow-y-auto p-3 text-sm text-text-primary">
    <MapAnalysisStatusBar title={analysisStatus?.title ?? null} detail={analysisStatus?.detail}
      onCancel={() => visionAbort.current?.abort()} />
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <label className="px-3 py-1.5 rounded bg-accent text-white cursor-pointer">
        上传原图<input type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={onUpload} disabled={busy} />
      </label>
      <select value={assetKey ?? ''} onChange={event => { setAssetKey(event.target.value || null); setPoints([]); setVisionCell('auto'); setManualRegion(null); setOcrText(null) }} className="bg-bg-elevated border border-border rounded px-2 py-1.5">
        {assets.length === 0 && <option value="">尚无原图</option>}
        {assets.map(asset => <option key={asset.assetKey} value={asset.assetKey}>{asset.name} · {asset.width}×{asset.height}</option>)}
      </select>
      {selected && <button type="button" onClick={removeImage} disabled={busy} className="text-red-400">删除原图</button>}
      <span className="text-text-muted text-xs">原图保存在本机项目备份中；普通聊天不会发送原图。</span>
    </div>
    {selected && <section aria-label="AI 查漏选区" className="mb-3 rounded border border-border bg-bg-elevated/50 p-3 text-xs">
      <h3 className="font-medium text-sm mb-1">AI 查漏：先在原图上选范围</h3>
      <p className="text-text-muted mb-2">先按原图尺寸全覆盖，再对细节密集区按城市、疆界、铁路、道路和水系细分扫描。细分轮数和本轮请求上限可调整；预算中止区域可再次运行续扫。图上编号对应首轮分块，细框对应子区域。整图概览会缩小图片，不能代替分块查漏。结果只作为待审候选。</p>
      <p className="text-text-muted mb-2">细节任务（城市／疆界／铁路等）会把选区放大到长边 2048 像素再送审，最多放大 2 倍，以提高小字与线型的可读性；先在图例区框选并确认图例条目，模型才能按符号档位逐档清点，而不是靠猜。单个分块失败不会中断整批，失败区域可再次运行重试。</p>
      <div className="flex flex-wrap items-center gap-2">
      <select aria-label="AI 查漏区域" value={visionCell} onChange={event => { setVisionCell(event.target.value); setMapInteraction('vision') }} className="bg-bg-elevated border border-border rounded px-2 py-1">
        <option value="auto">AI 查漏：全部自适应分块</option>
        <option value="all">整图概览（缩图）</option>
        <option value="manual">手动框选区域</option>
        {tilePlan?.tiles.map(tile => <option key={tile.id} value={tile.id}>第 {tile.row + 1} 行第 {tile.column + 1} 列</option>)}
      </select>
      {featurePageCount > 1 && <select aria-label="已确认地图事实清单页" value={effectiveFeaturePage}
        onChange={event => setFeaturePage(Number(event.target.value))} className="bg-bg-elevated border border-border rounded px-2 py-1">
        {Array.from({ length: featurePageCount }, (_, index) => <option key={index} value={index}>事实清单 {index + 1}/{featurePageCount}（每页最多 40 项）</option>)}
      </select>}
      {visionCell !== 'auto' && <select aria-label="单区域识图类别" value={scanMission}
        onChange={event => setScanMission(event.target.value as MapScanTask['mission'])}
        className="bg-bg-elevated border border-border rounded px-2 py-1">
        <option value="overview">概览</option><option value="borders">国界与区界</option>
        <option value="cities">城市与聚落</option><option value="railways">铁路</option>
        <option value="roads">道路</option><option value="waters">海陆与水系</option>
      </select>}
      {visionCell === 'auto' && <>
        <label>细分轮数 <input aria-label="地图细分轮数" type="number" min="0" max="3" value={maxRefinementRounds}
          onChange={event => setMaxRefinementRounds(Math.max(0, Math.min(3, Number(event.target.value) || 0)))}
          className="w-12 bg-bg-elevated border border-border rounded px-1" /></label>
        <label>本轮请求上限 <input aria-label="地图视觉请求上限" type="number" min="1" max="128" value={maxScanRequests}
          onChange={event => setMaxScanRequests(Math.max(1, Math.min(128, Number(event.target.value) || 1)))}
          className="w-16 bg-bg-elevated border border-border rounded px-1" /></label>
      </>}
      <button type="button" onClick={runVision} disabled={busy || visionCell === 'manual' && !manualRegion || visionCell === 'auto' && !tilePlan} className="px-3 py-1 rounded border border-accent text-accent disabled:opacity-50">{analysisStatus ? '分析中…' : '发送选定区域给 AI'}</button>
      <span className="font-medium text-accent">本次发送：{selectedRegionLabel}</span>
      {visionCell === 'manual' && <span>在图片上按住并拖动，框选后可重新画。</span>}
      </div>
      <p className="text-text-muted mt-2">灰色＝未检查；紫色＝事实清单尚未逐页发送；黄色＝AI 已扫、作者待审；绿色＝作者已核对。检查状态只说明范围和核对过程，不保证 AI 识别了图上全部内容。未审核候选不会用于问答或写作。</p>
      {currentScanTasks.length > 0 && <p aria-label="地图细分扫描进度" className="mt-2">
        细分任务 {currentScanTasks.length} 项：已完成 {currentScanTasks.filter(task => task.status === 'completed').length}，
        待扫 {currentScanTasks.filter(task => task.status === 'pending' || task.status === 'running').length}，
        失败 {currentScanTasks.filter(task => task.status === 'failed').length}，
        预算中止 {currentScanTasks.filter(task => task.status === 'budget-exhausted').length}，
        候选满额 {currentScanTasks.filter(task => task.saturated).length}。
        下方原图细框显示细分区域；预算中止、失败和候选满额区域尚未充分检查。
      </p>}
    </section>}
    {error && <p role="alert" className="text-red-400 mb-2">{error}</p>}
    {visionSummary && <p className="text-emerald-400 mb-2">{visionSummary}</p>}
    {selected && <div aria-label="地图分块覆盖审计" className="grid gap-1 max-w-lg mb-3 text-xs"
      style={{ gridTemplateColumns: `repeat(${tilePlan?.columns ?? 1}, minmax(0, 1fr))` }}>
      {tilePlan?.tiles.map((tile, index) => <button type="button" key={tile.id} onClick={() => { setVisionCell(tile.id); setMapInteraction('vision') }}
        aria-pressed={visionCell === tile.id} title={`第 ${tile.row + 1} 行第 ${tile.column + 1} 列`}
        className={`rounded border px-2 py-1 text-left ${coverageTone(tileCoverage[index])} ${visionCell === tile.id ? 'ring-2 ring-accent ring-offset-1 ring-offset-bg-primary' : ''}`}>
        {index + 1} · 第 {tile.row + 1} 行第 {tile.column + 1} 列：{tileCoverage[index]}
      </button>)}
    </div>}
    {coverage.length > 0 && <div className="mb-3 rounded border border-border p-2 text-xs">
      <h3 className="font-medium mb-1">图片分区检查记录（{coverage.length}）</h3>
      {coverage.map(row => <div key={row.observationKey} className="flex flex-wrap items-center gap-2 py-1">
        <span>{row.status === 'confirmed' ? '作者已审' : 'AI 已扫待审'}</span>
        <span>范围 {row.geometry.points[0].map(value => Math.round(value * 100)).join('% / ')}%</span>
        {(row.sourceHash !== selected?.sha256 || row.sourceRevision !== revision) && <span className="text-amber-400">已过期，需重查</span>}
        <span>模型报告 ID {row.checkedFeatureKeys?.length ?? 0}/{row.expectedFeatureKeys?.length ?? 0}</span>
        {row.status !== 'confirmed' && <button type="button" disabled={busy || row.sourceHash !== selected?.sha256 || row.sourceRevision !== revision} onClick={() => confirmCoverage(row)} className="text-accent disabled:opacity-50">我已核对该区域</button>}
      </div>)}
      <p className="text-text-muted">每个分区须逐页送出已确认清单并由作者核对；「清单未全」表示仍有页面未送达该分区。模型报告的 ID 可能少于送出 ID，不能推断图上没有其他地点。换图或修改已确认事实后需重新检查。</p>
    </div>}
    {selected && imageUrl && <>
      <div className="flex flex-wrap items-center gap-2 mb-2 text-xs">
        <button type="button" aria-pressed={mapInteraction === 'vision'} onClick={() => setMapInteraction('vision')}
          className={`rounded border px-2 py-1 ${mapInteraction === 'vision' ? 'border-accent text-accent' : 'border-border text-text-muted'}`}>
          在图上选 AI 区域
        </button>
        <button type="button" aria-pressed={mapInteraction === 'annotation'} onClick={() => setMapInteraction('annotation')}
          className={`rounded border px-2 py-1 ${mapInteraction === 'annotation' ? 'border-accent text-accent' : 'border-border text-text-muted'}`}>
          在图上手动标注
        </button>
        <label>缩放 <select aria-label="地图缩放" value={zoom} onChange={event => setZoom(Number(event.target.value))} className="bg-bg-elevated border border-border rounded px-1 py-0.5">
          <option value={100}>100%</option><option value={150}>150%</option><option value={200}>200%</option><option value={300}>300%</option>
        </select></label>
        <span className="text-text-muted">{mapInteraction === 'vision' ? '点击分块编号或切换手动框选；当前标注不会改变。' : '点击原图添加标注点；要查漏请切回 AI 区域。'}</span>
      </div>
      <div className="max-h-[70vh] overflow-auto border border-border">
      <div aria-label="带 AI 查漏分区的原图" className={`relative inline-block select-none ${mapInteraction === 'annotation' || visionCell === 'manual' ? 'cursor-crosshair' : ''} ${mapInteraction === 'vision' && visionCell === 'all' ? 'ring-2 ring-accent' : ''}`}
        onClick={addPoint} onPointerDown={beginManualRegion} onPointerMove={updateManualRegion} onPointerUp={endManualRegion}>
        <img src={imageUrl} alt={selected.name} style={{ width: `${Math.min(selected.width, 900) * zoom / 100}px`, maxWidth: zoom === 100 ? '100%' : 'none' }} className="block h-auto" draggable={false} />
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 100 100" preserveAspectRatio="none">
          {visible.map(observation => {
            const coordinates = observation.geometry.points.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')
            const feature = features.find(row => row.featureKey === observation.featureKey)
            const style = observationStyle(feature?.kind ?? 'place', observation.status)
            return observation.geometry.kind === 'point'
              ? <circle key={observation.observationKey} cx={observation.geometry.points[0][0] * 100} cy={observation.geometry.points[0][1] * 100} r="0.9" fill={style.color} fillOpacity={style.opacity} stroke="white" strokeWidth="0.25" />
              : observation.geometry.kind === 'polygon'
                ? <polygon key={observation.observationKey} points={coordinates} fill={style.color} fillOpacity={observation.status === 'candidate' ? 0.1 : 0.18} stroke={style.color} strokeDasharray={style.dash} strokeWidth="0.55" />
                : <polyline key={observation.observationKey} points={coordinates} fill="none" stroke={style.color} strokeOpacity={style.opacity} strokeDasharray={style.dash} strokeWidth={style.width} />
          })}
          {points.map(([x, y], index) => <circle key={index} cx={x * 100} cy={y * 100} r="0.65" fill="#3b82f6" />)}
          {points.length > 1 && <polyline points={points.map(([x, y]) => `${x * 100},${y * 100}`).join(' ')} fill="none" stroke="#3b82f6" strokeWidth="0.35" />}
        </svg>
        {mapInteraction === 'vision' && visionCell !== 'manual' && <div aria-label="原图自适应分块选区" className="absolute inset-0 grid"
          style={{ gridTemplateColumns: `repeat(${tilePlan?.columns ?? 1}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${tilePlan?.rows ?? 1}, minmax(0, 1fr))` }}>
          {tilePlan?.tiles.map((tile, index) => <button type="button" key={tile.id}
            aria-label={`选中第 ${tile.row + 1} 行第 ${tile.column + 1} 列；${tileCoverage[index]}`} aria-pressed={visionCell === tile.id}
            title={`第 ${tile.row + 1} 行第 ${tile.column + 1} 列：${tileCoverage[index]}`} onClick={event => { event.stopPropagation(); setVisionCell(tile.id) }}
            className={`relative flex items-start justify-start border transition-colors ${coverageTone(tileCoverage[index], 'overlay')} ${visionCell === tile.id ? 'ring-2 ring-inset ring-accent bg-accent/25' : 'hover:bg-accent/20'}`}>
            <span className="m-1 rounded bg-black/70 px-1 text-[10px] font-semibold leading-4 text-white">{index + 1}</span>
          </button>)}
        </div>}
        {mapInteraction === 'vision' && visionCell === 'auto' && currentScanTasks.filter(task => task.round > 0
          && task.mission === 'cities' && task.featurePage === 0).map(task => <div key={task.taskKey}
          aria-label={`第 ${task.round} 轮细分区域：${task.status}`} title={`${task.reason}；${task.status}`}
          className={`absolute pointer-events-none border ${task.saturated ? 'border-orange-400'
            : task.status === 'completed' ? 'border-amber-300/80'
            : task.status === 'failed' ? 'border-red-400' : task.status === 'budget-exhausted'
              ? 'border-orange-400' : 'border-cyan-300/80'}`}
          style={{ left: `${task.region.x * 100}%`, top: `${task.region.y * 100}%`,
            width: `${task.region.width * 100}%`, height: `${task.region.height * 100}%` }} />)}
        {mapInteraction === 'vision' && visionCell === 'manual' && (draftRegion ?? manualRegion) && <div aria-label="手动识图框选范围" className="absolute border-2 border-cyan-300 bg-cyan-300/15 pointer-events-none"
          style={{ left: `${(draftRegion ?? manualRegion)!.x * 100}%`, top: `${(draftRegion ?? manualRegion)!.y * 100}%`,
            width: `${(draftRegion ?? manualRegion)!.width * 100}%`, height: `${(draftRegion ?? manualRegion)!.height * 100}%` }} />}
      </div>
      </div>
      {mapInteraction === 'vision' && <div className="flex flex-wrap items-center gap-2 my-2 text-xs">
        <span>已选：<strong className="text-accent">{selectedRegionLabel}</strong></span>
        <button type="button" onClick={runVision} disabled={busy || visionCell === 'manual' && !manualRegion || visionCell === 'auto' && !tilePlan} className="rounded bg-accent px-2.5 py-1.5 text-white disabled:opacity-50">
          {analysisStatus ? '分析中…' : '发送此区域给 AI 查漏'}
        </button>
        <span className="text-text-muted">发送前会再次显示图片范围和模型供确认。</span>
      </div>}
      {mapInteraction === 'annotation' && <div className="flex flex-wrap items-center gap-2 my-3">
        <select aria-label="标注形状" value={drawKind} onChange={event => { setDrawKind(event.target.value as DrawKind); setExtendFeatureKey(''); setPoints([]) }} className="bg-bg-elevated border border-border rounded px-2 py-1">
          <option value="point">点位</option><option value="polyline">折线</option><option value="polygon">闭合区域</option>
        </select>
        {drawKind === 'polygon' && <select aria-label="附加到已有手工实体" value={extendFeatureKey} onChange={event => { setExtendFeatureKey(event.target.value); setPoints([]) }} className="bg-bg-elevated border border-border rounded px-2 py-1">
          <option value="">新建实体</option>
          {features.filter(row => row.source === 'manual' && row.status === 'confirmed').map(row => <option key={row.featureKey} value={row.featureKey}>追加疆域：{row.name}</option>)}
        </select>}
        {!extendFeatureKey && <><input value={name} onChange={event => setName(event.target.value)} placeholder="标注名称" maxLength={120} className="bg-bg-elevated border border-border rounded px-2 py-1" />
        <select aria-label="标注类别" value={kind} onChange={event => { void chooseCategory(event.target.value) }} className="bg-bg-elevated border border-border rounded px-2 py-1 max-w-44">
          {MAP_CATEGORIES.map(category => <option key={category.code} value={category.code}>{category.label}</option>)}
          {customCategories.map(category => <option key={category.code} value={category.code}>{category.label}（自建）</option>)}
          {legacyCategories.map(code => <option key={code} value={code}>{code}（旧类别）</option>)}
          <option value="__new__">＋ 新建类别…</option>
        </select></>}
        <input value={description} onChange={event => setDescription(event.target.value)} placeholder="描述（可选）" className="bg-bg-elevated border border-border rounded px-2 py-1" />
        <button type="button" onClick={save} disabled={busy || !extendFeatureKey && !name.trim() || points.length < (drawKind === 'point' ? 1 : drawKind === 'polyline' ? 2 : 3)} className="px-3 py-1 rounded bg-accent text-white disabled:opacity-50">{extendFeatureKey ? '保存附加疆域' : '保存标注'}</button>
        <button type="button" onClick={() => setPoints(old => old.slice(0, -1))} disabled={!points.length} className="text-text-muted">撤销上一个点</button>
        <button type="button" onClick={() => setPoints([])} disabled={!points.length} className="text-text-muted">清空绘制</button>
        <span className="text-text-muted text-xs">河流用蓝色实线、路线用琥珀虚线、疆域用紫色边界与浅填色显示。类别会建议对应形状；分离领土可追加区域。边界仅为近似，图上不清楚处请注明。</span>
      </div>}
    </>}
    {selected && customCategories.length > 0 && <section aria-label="自建地图类别" className="border-t border-border py-2 text-xs">
      <h3 className="font-medium mb-1">自建地图类别</h3>
      <p className="text-text-muted mb-1">类别名称可改，点位／线／区域及基础语义保持不变；刷新和项目备份会保留。</p>
      {customCategories.map(category => <div key={category.code} className="flex items-center gap-2 py-0.5">
        <strong>{category.label}</strong><span>基础类别：{mapCategoryLabel(category.baseKind)}</span>
        <button type="button" disabled={busy} onClick={() => { void renameCategory(category) }} className="text-accent">改名</button>
      </div>)}
    </section>}
    {selected && <section aria-label="地图图例与识图样例" className="border-t border-border py-3 text-xs">
      <h3 className="font-medium text-sm mb-1">图例与给 AI 的识别样例</h3>
      <p className="text-text-muted mb-2">可框选原图图例自动提取，也可圈出一段边界、河线或色块作为样例。仅作者确认的条目会在下次识图时发送；图例本身不等于地图事实。</p>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <button type="button" disabled={busy} onClick={() => { void autoLegend() }} className="rounded border border-accent px-2 py-1 text-accent disabled:opacity-50">自动提取图例{manualRegion ? '（框选区）' : '（整图缩略）'}</button>
        <button type="button" onClick={() => { setVisionCell('manual'); setMapInteraction('vision'); setLegendUseRegion(true) }} className="text-accent">去图上框选样例</button>
        <button type="button" disabled={busy || !manualRegion} onClick={() => { void runLocalOcr() }} className="rounded border border-border px-2 py-1 disabled:opacity-50">本地 OCR 识别框选文字</button>
        <span>当前框选：{manualRegion ? `${Math.round(manualRegion.width * selected.width)}×${Math.round(manualRegion.height * selected.height)} 像素` : '无'}</span>
      </div>
      {ocrText && <div className="mb-2"><p className="text-text-muted">本地识字线索仅供核对，不会自动写入地图事实或发送给视觉模型。</p>
        <textarea aria-label="本地识字结果" readOnly value={ocrText} rows={4} className="w-full rounded border border-border bg-bg-elevated p-2" /></div>}
      {editingLegendKey && (
        <p className="mb-2 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-[11px] text-text-secondary">
          正在修改图例「{legends.find(entry => entry.legendKey === editingLegendKey)?.label ?? editingLegendKey}」：
          只改含义、类别、样式与说明，样例区域保持不变。保存后会标记为作者确认。
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <input aria-label="图例含义" value={legendLabel} onChange={event => setLegendLabel(event.target.value)} placeholder="如：蓝色细线表示河流" maxLength={120} className="bg-bg-elevated border border-border rounded px-2 py-1" />
        <select aria-label="图例对应类别" value={legendKind} onChange={event => setLegendKind(event.target.value)} className="bg-bg-elevated border border-border rounded px-2 py-1">
          {MAP_CATEGORIES.map(category => <option key={category.code} value={category.code}>{category.label}</option>)}
          {customCategories.map(category => <option key={category.code} value={category.code}>{category.label}（自建）</option>)}
          {legacyCategories.map(code => <option key={code} value={code}>{code}（旧类别）</option>)}
        </select>
        <select aria-label="图例样式" value={legendSampleKind} onChange={event => setLegendSampleKind(event.target.value as MapLegendEntry['sampleKind'])} className="bg-bg-elevated border border-border rounded px-2 py-1">
          <option value="color">颜色</option><option value="line">线型</option><option value="symbol">符号</option><option value="text">文字</option>
        </select>
        {legendSampleKind === 'color' && <input aria-label="图例颜色" type="color" value={legendColor} onChange={event => setLegendColor(event.target.value)} />}
        <label className={editingLegendKey ? 'opacity-50' : ''}>
          <input type="checkbox" checked={legendUseRegion} disabled={Boolean(editingLegendKey)}
            onChange={event => setLegendUseRegion(event.target.checked)} /> 使用图上框选样例
        </label>
        <input aria-label="图例识图说明" value={legendDescription} onChange={event => setLegendDescription(event.target.value)} placeholder="适用范围、易混符号（可选）" className="bg-bg-elevated border border-border rounded px-2 py-1" />
        <button type="button" disabled={busy || !legendLabel.trim() || (!editingLegendKey && legendUseRegion && !manualRegion)}
          onClick={() => { void saveLegend() }} className="rounded bg-accent px-2 py-1 text-white disabled:opacity-50">
          {editingLegendKey ? '保存修改' : '手动添加样例'}
        </button>
        {editingLegendKey && <button type="button" disabled={busy} onClick={resetLegendForm} className="text-text-muted">取消修改</button>}
      </div>
      {legends.filter(row => !row.assetKey || row.assetKey === assetKey).map(entry => <div key={entry.legendKey} className="flex flex-wrap items-center gap-2 border-b border-border/50 py-1">
        <span className={entry.status === 'confirmed' ? 'text-emerald-400' : entry.status === 'candidate' ? 'text-amber-400' : 'text-text-muted'}>{entry.status === 'confirmed' ? '已确认' : entry.status === 'candidate' ? '待审核' : '停用'}</span>
        {entry.sampleColor && <span className="inline-block h-4 w-4 rounded border border-white/30" style={{ backgroundColor: entry.sampleColor }} />}
        <strong>{entry.label}</strong><span>→ {mapCategoryLabel(entry.featureKind, categories)}</span>
        <span className="text-text-muted">{entry.sampleOrigin === 'printed-legend' ? '原图图例' : entry.sampleOrigin === 'map-example' ? '图上样例' : '手工输入'}{entry.sampleRegion ? ' · 有样本区域' : ''}</span>
        {entry.assetKey && entry.sourceHash !== selected.sha256 && <span className="text-amber-400">原图版本已变</span>}
        <button type="button" disabled={busy} onClick={() => editLegend(entry)} className="text-accent">修改</button>
        {entry.status !== 'confirmed' && <button type="button" disabled={busy} onClick={() => { void reviewLegend(entry, 'confirmed') }} className="text-emerald-400">确认</button>}
        {entry.status !== 'rejected' && <button type="button" disabled={busy} onClick={() => { void reviewLegend(entry, 'rejected') }} className="text-red-400">停用</button>}
      </div>)}
    </section>}
    <div className="border-t border-border pt-2">
      <h3 className="font-medium mb-2">地图事实与候选（共 {features.length}，待审 {candidateTotal}）</h3>
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <select aria-label="地图事实筛选" value={featureFilter}
          onChange={event => { setFeatureFilter(event.target.value as 'all' | 'candidate' | 'confirmed'); setFeatureListPage(0) }}
          className="bg-bg-elevated border border-border rounded px-2 py-1">
          <option value="all">全部状态</option>
          <option value="candidate">仅待审核</option>
          <option value="confirmed">仅已确认</option>
        </select>
        <input aria-label="搜索地图事实" value={featureQuery}
          onChange={event => { setFeatureQuery(event.target.value); setFeatureListPage(0) }}
          placeholder="搜索名称、说明或类别" maxLength={60}
          className="bg-bg-elevated border border-border rounded px-2 py-1 min-w-40" />
        <span className="text-text-muted">匹配 {matchedFeatures.length} 项 · 第 {safeFeatureListPage + 1}/{featureListPageCount} 页</span>
        <button type="button" disabled={busy || !pageCandidateKeys.length}
          onClick={() => setSelectedFeatureKeys(current => new Set([...current, ...pageCandidateKeys]))}
          className="text-accent disabled:opacity-50">全选本页待审（{pageCandidateKeys.length}）</button>
        <button type="button" disabled={busy || !selectedFeatureKeys.size}
          onClick={() => setSelectedFeatureKeys(new Set())}
          className="text-text-muted disabled:opacity-50">清除选择</button>
        <button type="button" disabled={busy || !selectedCandidates.length}
          onClick={() => { void batchReview('confirmed', selectedCandidates) }}
          className="rounded border border-emerald-500/60 px-2 py-0.5 text-emerald-400 disabled:opacity-50">接受所选（{selectedCandidates.length}）</button>
        <button type="button" disabled={busy || !selectedCandidates.length}
          onClick={() => { void batchReview('rejected', selectedCandidates) }}
          className="rounded border border-red-500/60 px-2 py-0.5 text-red-400 disabled:opacity-50">驳回所选</button>
        <button type="button" disabled={busy || safeFeatureListPage === 0}
          onClick={() => setFeatureListPage(safeFeatureListPage - 1)} className="text-text-muted disabled:opacity-40">上一页</button>
        <button type="button" disabled={busy || safeFeatureListPage >= featureListPageCount - 1}
          onClick={() => setFeatureListPage(safeFeatureListPage + 1)} className="text-text-muted disabled:opacity-40">下一页</button>
      </div>
      {matchedFeatures.length === 0 && <p className="text-text-muted text-xs py-2">没有符合筛选条件的地图事实。</p>}
      {pageFeatures.map(feature => <div key={feature.featureKey} className="flex items-center gap-2 py-1 border-b border-border/50">
        {feature.status === 'candidate'
          ? <input type="checkbox" aria-label={`选择候选 ${feature.name}`} checked={selectedFeatureKeys.has(feature.featureKey)}
              onChange={() => toggleFeatureSelection(feature.featureKey)} className="shrink-0" />
          : <span className="w-3 shrink-0" aria-hidden="true" />}
        <span className={feature.status === 'confirmed' ? 'text-emerald-400' : feature.status === 'candidate' ? 'text-amber-400' : 'text-text-muted'}>{feature.status === 'confirmed' ? '已确认' : feature.status === 'candidate' ? '待审核' : '已驳回'}</span>
        <strong>{feature.name}</strong><span className="text-text-muted">{mapCategoryLabel(feature.kind, categories)}</span>
        {['country', 'empire', 'kingdom', 'state'].includes(canonicalMapCategory(feature.kind).toLowerCase()) && <span className="text-xs text-text-muted">
          {(() => { const pieces = observations.filter(row => row.featureKey === feature.featureKey && row.geometry.kind === 'polygon').length
            return pieces ? `${pieces} 块近似疆域` : '仅位置，未标疆域' })()}
        </span>}
        <span className="text-text-muted truncate">{feature.description}</span>
        {feature.status === 'candidate' && !!feature.possibleDuplicateFeatureKeys?.length
          && <span className="text-amber-400 text-xs">可能与 {feature.possibleDuplicateFeatureKeys.length} 项同名，请逐条核对</span>}
        {(feature.status === 'candidate' || feature.status === 'confirmed') && <button type="button" disabled={busy} onClick={() => {
          setEditingFeatureKey(feature.featureKey); setEditName(feature.name); setEditKind(feature.kind); setEditDescription(feature.description)
        }} className="text-accent">修改</button>}
        {editingFeatureKey === feature.featureKey && <div className="flex flex-wrap items-center gap-1 rounded border border-border p-1">
          <input aria-label={`修改 ${feature.name} 名称`} value={editName} onChange={event => setEditName(event.target.value)} maxLength={120} className="bg-bg-elevated border border-border rounded px-1" />
          <select aria-label={`修改 ${feature.name} 类别`} value={editKind} onChange={event => { void chooseEditCategory(event.target.value) }} className="bg-bg-elevated border border-border rounded px-1">
            {MAP_CATEGORIES.map(category => <option key={category.code} value={category.code}>{category.label}</option>)}
            {customCategories.map(category => <option key={category.code} value={category.code}>{category.label}（自建）</option>)}
            {legacyCategories.map(code => <option key={code} value={code}>{code}（旧类别）</option>)}
            <option value="__new__">＋ 新建类别…</option>
          </select>
          <input aria-label={`修改 ${feature.name} 说明`} value={editDescription} onChange={event => setEditDescription(event.target.value)} className="bg-bg-elevated border border-border rounded px-1" />
          <button type="button" disabled={busy || !editName.trim()} onClick={() => { void editFeature(feature) }} className="text-accent">保存</button>
          <button type="button" onClick={() => setEditingFeatureKey(null)} className="text-text-muted">取消</button>
        </div>}
        {feature.status === 'candidate' && <><button type="button" disabled={busy} onClick={() => review(feature, 'confirmed')} className="text-emerald-400">接受</button><button type="button" disabled={busy} onClick={() => review(feature, 'rejected')} className="text-red-400">驳回</button></>}
        {feature.source === 'manual' && <button type="button" disabled={busy} onClick={() => changeVisibility(feature)} className="text-text-muted">{feature.status === 'confirmed' ? '隐藏标注' : '恢复标注'}</button>}
        {feature.source === 'vision' && feature.status !== 'candidate' && feature.previousStatus === 'candidate' && <button type="button" disabled={busy} onClick={() => changeVisibility(feature)} className="text-text-muted">撤销审核</button>}
        {feature.status === 'confirmed' && <select aria-label={`关联 ${feature.name} 到现有设定`} disabled={busy}
          value={feature.codexEntryId ? `c:${feature.codexEntryId}` : feature.importantLocationId ? `l:${feature.importantLocationId}` : ''}
          onChange={event => bind(feature, event.target.value)} className="bg-bg-elevated border border-border rounded px-1 py-0.5 text-xs">
          <option value="">未关联既有资料</option>
          {linkOptions.codex.map(row => <option key={`c:${row.id}`} value={`c:${row.id}`}>词条：{row.name}</option>)}
          {linkOptions.locations.map(row => <option key={`l:${row.id}`} value={`l:${row.id}`}>地点：{row.name}</option>)}
        </select>}
        {feature.status === 'confirmed' && (() => {
          const linkedName = feature.codexEntryId ? linkOptions.codex.find(row => row.id === feature.codexEntryId)?.name
            : feature.importantLocationId ? linkOptions.locations.find(row => row.id === feature.importantLocationId)?.name : null
          return linkedName && linkedName !== feature.name ? <span className="text-amber-400 text-xs">关联名称不同，请核对</span> : null
        })()}
      </div>)}
    </div>
    <div className="border-t border-border mt-3 pt-2 text-xs">
      <h3 className="font-medium mb-2">地图实体间关系（已确认 {relations.filter(row => row.status === 'confirmed').length}，待审核 {relations.filter(row => row.status === 'candidate').length}）</h3>
      <div className="flex flex-wrap items-center gap-2 mb-2">
        <select aria-label="关系起点" value={relationFrom} onChange={event => setRelationFrom(event.target.value)} className="bg-bg-elevated border border-border rounded px-2 py-1">
          <option value="">起点</option>{features.filter(row => row.status === 'confirmed').map(row => <option key={row.featureKey} value={row.featureKey}>{row.name}</option>)}
        </select>
        <select aria-label="关系类型" value={relationKind} onChange={event => setRelationKind(event.target.value as MapRelation['kind'])} className="bg-bg-elevated border border-border rounded px-2 py-1">
          <option value="north-of">位于北侧</option><option value="south-of">位于南侧</option><option value="east-of">位于东侧</option><option value="west-of">位于西侧</option><option value="adjacent">相邻（未区分海陆）</option><option value="land-border">陆上接壤</option><option value="across-water">隔水相望</option><option value="coast-of">濒临海域</option><option value="route">有路线</option>
        </select>
        <select aria-label="关系终点" value={relationTo} onChange={event => setRelationTo(event.target.value)} className="bg-bg-elevated border border-border rounded px-2 py-1">
          <option value="">终点</option>{features.filter(row => row.status === 'confirmed').map(row => <option key={row.featureKey} value={row.featureKey}>{row.name}</option>)}
        </select>
        <input aria-label="关系图像依据" value={relationDescription} onChange={event => setRelationDescription(event.target.value)} placeholder="图上依据或不确定性" className="bg-bg-elevated border border-border rounded px-2 py-1" />
        <button type="button" disabled={busy || !relationFrom || !relationTo || relationFrom === relationTo} onClick={saveRelation} className="text-accent disabled:opacity-50">保存关系</button>
      </div>
      {relations.map(relation => <p key={relation.relationKey} className="text-text-muted py-0.5">
        <span className={relation.status === 'candidate' ? 'text-amber-400' : relation.status === 'confirmed' ? 'text-emerald-400' : ''}>{relation.status === 'candidate' ? '待审核' : relation.status === 'confirmed' ? '已确认' : '已驳回'}：</span>{' '}
        {features.find(row => row.featureKey === relation.fromFeatureKey)?.name ?? '已删除'} {RELATION_LABELS[relation.kind]} {features.find(row => row.featureKey === relation.toFeatureKey)?.name ?? '已删除'}
        {relation.description && <span> · {relation.description}</span>}
        {relation.source === 'manual'
          ? <button type="button" disabled={busy} onClick={() => toggleRelation(relation)} className="ml-2 text-accent">{relation.status === 'confirmed' ? '隐藏' : '恢复'}</button>
          : relation.status === 'candidate'
            ? <><button type="button" disabled={busy || !features.some(row => row.featureKey === relation.fromFeatureKey && row.status === 'confirmed') || !features.some(row => row.featureKey === relation.toFeatureKey && row.status === 'confirmed')} onClick={() => reviewRelation(relation, 'confirmed')} className="ml-2 text-emerald-400 disabled:opacity-50">接受关系</button><button type="button" disabled={busy} onClick={() => reviewRelation(relation, 'rejected')} className="ml-2 text-red-400">驳回关系</button></>
            : <button type="button" disabled={busy} onClick={() => reviewRelation(relation, 'candidate')} className="ml-2 text-accent">撤销审核</button>}
      </p>)}
      <p className="text-text-muted">AI 关系需先审核两端实体，再逐条核对图像后接受。陆上接壤、隔水相望与一般相邻分别存储；未审核关系不会进入创作上下文。</p>
    </div>
    {portals.length > 0 && <div className="border-t border-border mt-3 pt-2 text-xs">
      <h3 className="font-medium mb-1">已有传送门声明</h3>
      {portals.map((portal, index) => <p key={`${portal.targetWorldId}-${index}`} className="text-text-muted">
        {portal.name} → {portal.targetName ?? '目标世界已缺失'}{portal.linked ? '（已登记连接，尚未绑定原图点位）' : '（缺少有效的世界连接，请核对）'}
      </p>)}
    </div>}
  </div>
}
