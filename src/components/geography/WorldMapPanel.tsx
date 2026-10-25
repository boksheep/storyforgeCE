/**
 * WorldMapPanel — 世界地图主面板
 * 顶层容器：世界树导航 + AI 生成按钮 + Voronoi/2D/3D 切换 + Canvas + 属性编辑器
 */

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react'
import { Sparkles, Loader2, RefreshCw, Map, Box, Globe } from 'lucide-react'
import { useWorldNodeStore } from '../../stores/world-node'
import { useWorldGroupStore } from '../../stores/world-group'
import { useAIStream } from '../../hooks/useAIStream'
import { createAISessionKey } from '../../stores/ai-generation-session'
import { logEvent } from '../../lib/logging/logger'
import WorldGroupSwitcher from '../world-group/WorldGroupSwitcher'
import {
  buildVoronoiMapPrompt,
  parseVoronoiMapConfig,
} from '../../lib/ai/adapters/voronoi-map-adapter'
import { assembleContext } from '../../lib/registry/assemble-context'
import type { Project } from '../../lib/types'
import type { MapGenConfig } from '../../lib/world-map/engine'
import WorldTreeSidebar from './WorldTreeSidebar'
import { mapRevision } from '../../lib/world-map/map-data'
import { mergeConfirmedMapConstraints } from '../../lib/world-map/confirmed-constraints'
import MapAnalysisStatusBar from './MapAnalysisStatusBar'
import { useDialog } from '../shared/Dialog'

// Voronoi 地图引擎组件懒加载
const WorldMapVoronoi = lazy(() => import('./WorldMapVoronoi'))
const MapImageWorkspace = lazy(() => import('./MapImageWorkspace'))

interface Props {
  project: Project
}

type ViewMode = '3d' | 'voronoi' | 'image' | 'compare'
const MAP_EXPERIMENT_KEY = 'storyforge_experimental_image_map'

export default function WorldMapPanel({ project }: Props) {
  const dialog = useDialog()
  const { nodes, activeWorldId, loadNodes, ensureRootWorld, updateNode } = useWorldNodeStore()
  const activeGroupId = useWorldGroupStore(s => s.activeGroupId)
  const ai = useAIStream(createAISessionKey(
    project.id!,
    'geography.world-map',
    activeWorldId ?? activeGroupId ?? 'root',
  ))

  const [viewMode, setViewMode] = useState<ViewMode>('voronoi')
  const [imageMapEnabled, setImageMapEnabled] = useState(() =>
    typeof window !== 'undefined' && window.localStorage.getItem(MAP_EXPERIMENT_KEY) === '1')

  // 当前活跃世界的 Voronoi 配置
  const [voronoiConfig, setVoronoiConfig] = useState<Partial<MapGenConfig> | undefined>(undefined)
  const [parseError, setParseError] = useState<string | null>(null)
  const [currentMapRevision, setCurrentMapRevision] = useState<string | null>(null)
  // 原图面板里有识图任务在跑：切换视图会卸载组件并中止任务，必须先确认。
  const [imageBusy, setImageBusy] = useState(false)
  const mapGenerationRun = useRef(0)

  const switchView = useCallback(async (next: ViewMode) => {
    if (next === viewMode) return
    if (imageBusy && !(await dialog.confirm({
      title: '识图任务正在进行',
      message: '切换视图会中止当前正在进行的识图任务。已完成的区域会保留，再次运行只补未完成的部分。是否继续切换？',
      confirmText: '中止并切换',
    }))) return
    setViewMode(next)
  }, [dialog, imageBusy, viewMode])

  const toggleImageExperiment = useCallback(async () => {
    const next = !imageMapEnabled
    if (!next && imageBusy && !(await dialog.confirm({
      title: '识图任务正在进行',
      message: '关闭原图实验会中止当前识图任务。已完成的区域会保留。是否继续？',
      confirmText: '中止并关闭',
    }))) return
    window.localStorage.setItem(MAP_EXPERIMENT_KEY, next ? '1' : '0')
    setImageMapEnabled(next)
    if (!next) setViewMode('voronoi')
  }, [dialog, imageBusy, imageMapEnabled])

  // 多世界模式下世界树按世界组隔离；单世界传 null 走原逻辑
  const scopedGroupId = project.enableMultiWorld ? activeGroupId : null

  // ── 初始化世界树（按世界组作用域） ──
  useEffect(() => {
    if (!project.id) return
    ensureRootWorld(project.id, scopedGroupId).then(() => loadNodes(project.id!, scopedGroupId))
  }, [project.id, scopedGroupId, ensureRootWorld, loadNodes])

  // ── 切换世界时加载该世界的地图配置 ──
  const activeNode = nodes.find(n => n.id === activeWorldId)

  useEffect(() => {
    if (!activeNode) {
      setVoronoiConfig(undefined)
      return
    }
    // 从世界节点加载地图配置
    if (activeNode.mapConfigJSON) {
      try {
        setVoronoiConfig(JSON.parse(activeNode.mapConfigJSON))
      } catch {
        setVoronoiConfig(undefined)
      }
    } else {
      setVoronoiConfig(undefined)
    }
  }, [activeNode])

  useEffect(() => {
    if (!activeWorldId || !project.id) { setCurrentMapRevision(null); return }
    let cancelled = false
    mapRevision(project.id, activeWorldId).then(revision => { if (!cancelled) setCurrentMapRevision(revision) })
      .catch(() => { if (!cancelled) setCurrentMapRevision(null) })
    return () => { cancelled = true }
  }, [project.id, activeWorldId])

  // ── AI 生成地图 ─────────────────────────────────────────
  const handleGenerate = async () => {
    if (!activeWorldId) return
    const runId = ++mapGenerationRun.current
    const targetWorldId = activeWorldId
    const baseMapRevision = await mapRevision(project.id!, targetWorldId)
    setParseError(null)
    // 世界观、地理、地点和地图事实均由注册源按同一世界组装配。
    const sourceKeys = ['worldview', 'geography', 'codex', 'locations', 'mapFacts']
    const context = await assembleContext({
      projectId: project.id!,
      worldGroupId: scopedGroupId,
      sourceKeys,
    })
    if (context.trimmed.length) {
      // 成熟项目里 codex/地点几乎必然被预算截断；直接拒绝等于让地图功能对它们不可用。
      const proceed = await dialog.confirm({
        title: '地图生成资料被预算截断',
        message: `以下资料因上下文预算被截断：${context.trimmed.join('、')}。用截断资料生成的地图可能缺少部分设定。可以先到「设置 → 团队总预算与上下文预算」提高预算，或直接用当前资料生成。`,
        confirmText: '用截断资料生成',
      })
      if (!proceed) {
        setParseError(`已取消地图生成：请先提高上下文预算（${context.trimmed.join('、')}）后重试。`)
        return
      }
    }
    const messages = buildVoronoiMapPrompt(null, '', [], `${context.text}\n\n【地图生成时段】当前未选择特定时代；带有效起止时段的地图事实不能视为永久地理约束。`)
    const result = await ai.start(messages, undefined, { category: 'geography.world-map', projectId: project.id! })
    if (!result || runId !== mapGenerationRun.current) return

    try {
      // 证据只能命中用户资料，不能借用 system prompt 中的示例文字。
      const sourceText = messages
        .filter(message => message.role === 'user')
        .map(message => message.content)
        .join('\n\n')
      const parsed = parseVoronoiMapConfig(result, sourceText)
      const latestContext = await assembleContext({ projectId: project.id!, worldGroupId: scopedGroupId, sourceKeys })
      if (useWorldNodeStore.getState().activeWorldId !== targetWorldId
        || await mapRevision(project.id!, targetWorldId) !== baseMapRevision
        || latestContext.text !== context.text) {
        throw new Error('分析期间已切换世界或地图/设定资料已变化，请重新生成当前世界地图')
      }
      const config = await mergeConfirmedMapConstraints(project.id!, targetWorldId, parsed, voronoiConfig)
      if (activeNode) {
        config.mapName = activeNode.name
      }
      setVoronoiConfig(config)

      // 持久化到世界节点
      if (activeWorldId) {
        await updateNode(targetWorldId, {
          mapConfigJSON: JSON.stringify(config),
        })
      }
      setCurrentMapRevision(config.mapFactsRevision ?? null)
    } catch (err) {
      logEvent({ level: 'error', tag: 'WorldMapVoronoi', event: 'worldmapvoronoi', message: 'Failed to parse AI Voronoi config:', error: err })
      setParseError(`AI 返回的地图参数解析失败，请重试。错误：${err instanceof Error ? err.message : '未知错误'}`)
    }
  }

  const handleMapConfigChange = useCallback(async (patch: Partial<MapGenConfig>) => {
    const nextConfig = { ...(voronoiConfig ?? {}), ...patch }
    setVoronoiConfig(nextConfig)
    if (activeWorldId) {
      await updateNode(activeWorldId, {
        mapConfigJSON: JSON.stringify(nextConfig),
      })
    }
  }, [activeWorldId, updateNode, voronoiConfig])

  // ── 渲染 ─────────────────────────────────────────────────
  const generateButtonLabel = voronoiConfig ? 'AI 重新生成' : 'AI 生成地图'
  const imageWorkspace = imageMapEnabled && activeWorldId
    ? <MapImageWorkspace key={activeWorldId} projectId={project.id!} worldNodeId={activeWorldId}
        onRunningChange={setImageBusy}
        onChanged={() => {
      const worldId = activeWorldId
      mapRevision(project.id!, worldId).then(revision => {
        if (useWorldNodeStore.getState().activeWorldId === worldId) setCurrentMapRevision(revision)
      }).catch(() => { if (useWorldNodeStore.getState().activeWorldId === worldId) setCurrentMapRevision(null) })
    }} />
    : null
  const generatedMap = <WorldMapVoronoi
    key={activeWorldId ?? 'default'} config={voronoiConfig} onConfigChange={handleMapConfigChange}
  />

  return (
    <div className="h-full flex flex-col">
      <MapAnalysisStatusBar title={ai.isStreaming ? '正在分析世界设定并生成地图' : null}
        detail="等待模型返回地图参数"
        onCancel={() => { mapGenerationRun.current++; ai.stop() }} />
      {/* 工具栏 */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <h2 className="text-xl font-bold text-text-primary flex items-center gap-2">
          <Map className="w-5 h-5" />
          世界地图
          {activeNode && (
            <span className="text-sm font-normal text-text-muted ml-1">
              — {activeNode.icon} {activeNode.name}
            </span>
          )}
        </h2>
        <div className="flex items-center gap-2">
          {/* 多世界：世界组切换（切换后整套世界树+地图跟随） */}
          {project.enableMultiWorld && <WorldGroupSwitcher />}
          <button type="button" onClick={() => { void toggleImageExperiment() }} className="text-xs text-text-muted hover:text-text-primary">
            {imageMapEnabled ? '关闭原图实验' : '试用原图标注（实验性）'}
          </button>
          {/* 视图切换 */}
          <div className="flex bg-bg-elevated rounded-lg p-0.5 border border-border">
            {imageMapEnabled && <button
              type="button"
              onClick={() => { void switchView('image') }}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded transition-colors ${viewMode === 'image' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}
            >
              <Map className="w-3 h-3" /> 原图与标注
            </button>}
            <button
              type="button"
              onClick={() => { void switchView('voronoi') }}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded transition-colors ${
                viewMode === 'voronoi'
                  ? 'bg-accent text-white'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <Globe className="w-3 h-3" /> 奇幻
            </button>
            {imageMapEnabled && <button
              type="button"
              onClick={() => { void switchView('compare') }}
              className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded transition-colors ${viewMode === 'compare' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'}`}
            >对比</button>}
            <button
              type="button"
              disabled
              title="3D 地图仍处于 Labs 阶段，当前不可用"
              className="flex items-center gap-1 px-2.5 py-1 text-xs rounded transition-colors text-text-muted/50 cursor-not-allowed"
            >
              <Box className="w-3 h-3" /> 3D Labs
            </button>
          </div>

          <button
            onClick={handleGenerate}
            disabled={ai.isStreaming}
            className="flex items-center gap-1.5 px-4 py-2 bg-accent text-white text-sm rounded-lg hover:bg-accent-hover disabled:opacity-50 transition-colors"
          >
            {ai.isStreaming ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                AI 分析中...
              </>
            ) : voronoiConfig ? (
              <>
                <RefreshCw className="w-4 h-4" />
                {generateButtonLabel}
              </>
            ) : (
              <>
                <Sparkles className="w-4 h-4" />
                AI 生成地图
              </>
            )}
          </button>
        </div>
      </div>

      {/* AI 错误提示 */}
      {(ai.error || parseError) && (
        <div className="mb-3 p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          {ai.error || parseError}
        </div>
      )}
      {voronoiConfig?.mapFactsRevision && currentMapRevision && voronoiConfig.mapFactsRevision !== currentMapRevision && (
        <div className="mb-2 p-2 text-xs rounded border border-amber-500/30 text-amber-400">已确认地图事实已变化，生成图待更新。旧图仍可查看；重新生成会保留手动比例尺和布局种子。</div>
      )}

      {ai.tokenUsage && !ai.isStreaming && (
        <div className="mb-2 text-[10px] text-text-muted">
          Token: ↑{ai.tokenUsage.inputTokens.toLocaleString()} ↓{ai.tokenUsage.outputTokens.toLocaleString()}
        </div>
      )}

      {/* 主内容区域：世界树 + 地图 */}
      <div className="flex-1 flex min-h-0 rounded-lg overflow-hidden border border-border">
        {/* 世界树侧边栏 */}
        <WorldTreeSidebar projectId={project.id!} />

        {/* 地图区域 — 奇幻 Voronoi 地图 */}
        <div className="flex-1 min-w-0">
          <Suspense fallback={
            <div className="w-full h-full flex items-center justify-center bg-[#1a1f2e]">
              <div className="text-center text-text-muted">
                <Loader2 className="w-8 h-8 animate-spin mx-auto mb-2 text-accent" />
                <p className="text-sm">加载地图引擎...</p>
              </div>
            </div>
          }>
            {viewMode === 'image' ? (imageWorkspace ?? generatedMap)
              : viewMode === 'compare' && imageWorkspace
                ? <div className="grid grid-cols-1 xl:grid-cols-2 h-full min-h-0">
                    <section className="min-w-0 overflow-hidden border-r border-border" aria-label="上传原图与标注">{imageWorkspace}</section>
                    <section className="min-w-0 overflow-hidden" aria-label="可重建生成图">{generatedMap}</section>
                  </div>
                : generatedMap}
          </Suspense>
        </div>
      </div>
    </div>
  )
}
