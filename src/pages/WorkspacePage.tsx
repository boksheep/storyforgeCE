import { useEffect, useState, useMemo, lazy, Suspense } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useProjectStore } from '../stores/project'
import { useWorldviewStore } from '../stores/worldview'
import { useCharacterStore } from '../stores/character'
import { useOutlineStore } from '../stores/outline'
import { useChapterStore } from '../stores/chapter'
import { useForeshadowStore } from '../stores/foreshadow'
import { useGeographyStore } from '../stores/project-singletons'
import { useHistoryStore } from '../stores/project-singletons'
import { useCreativeRulesStore } from '../stores/project-singletons'
import { useCharacterRelationStore } from '../stores/character-relation'
import { useReferenceStore } from '../stores/reference'
import { useEmotionBeatStore } from '../stores/emotion-beat'
import { useWorldRulesStore } from '../stores/world-rules'
import { useAutoBackup } from '../hooks/useAutoBackup'
import { useGistAutoBackup } from '../hooks/useGistAutoBackup'
import { useFolderAutoBackup } from '../hooks/useFolderAutoBackup'
import { MessageSquare, PanelRight } from 'lucide-react'
import StepHistoryButtons from '../components/agent/StepHistoryButtons'
import WorkspaceAgentRuntime from '../components/agent/WorkspaceAgentRuntime'
import {
  clampDockHeight,
  clampDockWidth,
  clampInputHeight,
  nextCopilotPlacement,
  type CopilotPlacement,
} from '../lib/agent/copilot-layout'

// 尺寸规则已收口到 lib/agent/copilot-layout（面板与页面共用一份夹取逻辑）。
// 这里按既有名字再导出，保持外部引用（含测试）稳定。
export {
  DEFAULT_DOCK_HEIGHT as DEFAULT_COPILOT_DOCK_HEIGHT,
  DEFAULT_PANEL_WIDTH as DEFAULT_COPILOT_DOCK_WIDTH,
  DEFAULT_INPUT_HEIGHT as DEFAULT_COPILOT_INPUT_HEIGHT,
  clampDockHeight,
  clampDockWidth,
  clampInputHeight,
  nextCopilotPlacement,
} from '../lib/agent/copilot-layout'
export type { CopilotPlacement } from '../lib/agent/copilot-layout'
import Sidebar, { type SidebarModule } from '../components/layout/Sidebar'
import ContentTypeBadge from '../components/layout/ContentTypeBadge'
import { Button } from '../components/shared/Button'
import { getModuleContentType } from '../components/layout/sidebar-tree'
import PropertiesPanel from '../components/layout/PropertiesPanel'
import ProjectInfoPanel from '../components/project/ProjectInfoPanel'
// 旧「作品学习」面板已整合进 ReferencePanel（Phase 20，子系统于 v32 下线）
const ReferencePanel = lazy(() => import('../components/project/ReferencePanel'))
const SettingsPage = lazy(() => import('../components/settings/SettingsPage'))
const UsageStatsPage = lazy(() => import('../components/settings/UsageStatsPage'))
const VersionHistoryPanel = lazy(() => import('../components/system/VersionHistoryPanel'))
const ImportDocPanel = lazy(() => import('../components/system/ImportDocPanel'))
const PromptManagerPanel = lazy(() => import('../components/settings/prompt/PromptManagerPanel'))
const NodeModeWorkspace = lazy(() => import('../components/node-flow/NodeModeWorkspace'))
const RagLibraryPanel = lazy(() => import('../components/retrieval/RagLibraryPanel'))
const SimulationRuntimePanel = lazy(() => import('../components/simulation/SimulationRuntimePanel'))
const DataManagementPanel = lazy(() => import('../components/data/DataManagementPanel'))
const WorldRulesPanel = lazy(() => import('../components/worldview/WorldRulesPanel'))
const StoryCorePanel = lazy(() => import('../components/worldview/StoryCorePanel'))
const PowerSystemPanel = lazy(() => import('../components/worldview/PowerSystemPanel'))
const WorldviewOriginPanel = lazy(() => import('../components/worldview/WorldviewOriginPanel'))
const WorldviewNaturalPanel = lazy(() => import('../components/worldview/WorldviewNaturalPanel'))
const WorldviewHumanityPanel = lazy(() => import('../components/worldview/WorldviewHumanityPanel'))
const CharacterPanel = lazy(() => import('../components/character/CharacterPanel'))
const CharacterMainPanel = lazy(() => import('../components/character/CharacterMainPanel'))
const CharacterMinorPanel = lazy(() => import('../components/character/CharacterMinorPanel'))
const CharacterNPCPanel = lazy(() => import('../components/character/CharacterNPCPanel'))
const CharacterExtraPanel = lazy(() => import('../components/character/CharacterExtraPanel'))
const OutlinePanel = lazy(() => import('../components/outline/OutlinePanel'))
const DetailedOutlinePanel = lazy(() => import('../components/outline/DetailedOutlinePanel'))
const ChaptersListPanel = lazy(() => import('../components/editor/ChaptersListPanel'))
const ForeshadowPanel = lazy(() => import('../components/foreshadow/ForeshadowPanel'))
const StyleLearningPanel = lazy(() => import('../components/style/StyleLearningPanel'))
const GeographyPanel = lazy(() => import('../components/geography/GeographyPanel'))
const HistoryPanel = lazy(() => import('../components/history/HistoryPanel'))
const CreativeRulesPanel = lazy(() => import('../components/rules/CreativeRulesPanel'))
const CharacterRelationPanel = lazy(() => import('../components/relations/CharacterRelationPanel'))
const WorldMapPanel = lazy(() => import('../components/geography/WorldMapPanel'))
const StatePanel = lazy(() => import('../components/state/StatePanel'))
const StoryArcPanel = lazy(() => import('../components/outline/StoryArcPanel'))
const CharacterDrivenPlotPanel = lazy(() => import('../components/outline/CharacterDrivenPlotPanel'))
const InspirationPanel = lazy(() => import('../components/project/InspirationPanel'))
const LocationPanel = lazy(() => import('../components/location/LocationPanel'))
const InventoryPanel = lazy(() => import('../components/items/InventoryPanel'))
const FactLibraryPanel = lazy(() => import('../components/facts/FactLibraryPanel'))
const UnifiedTimelinePanel = lazy(() => import('../components/timeline/UnifiedTimelinePanel'))
const CultivationProgressPanel = lazy(() => import('../components/cultivation/CultivationProgressPanel'))
const SceneVerifyPanel = lazy(() => import('../components/scene/SceneVerifyPanel'))
const WorldGroupOverview = lazy(() => import('../components/world-group/WorldGroupOverview'))
const ChatCopilotPanel = lazy(() => import('../components/agent/ChatCopilotPanel').then(module => ({ default: module.ChatCopilotPanelView })))
import { useLocationStore } from '../stores/location'
import { useWorldGroupStore } from '../stores/world-group'
import { log } from '../lib/logging/logger'

const COPILOT_PLACEMENT_KEY = 'storyforge-copilot-placement'
const COPILOT_DOCK_HEIGHT_KEY = 'storyforge-copilot-dock-height'
const COPILOT_DOCK_WIDTH_KEY = 'storyforge-copilot-dock-width'
const COPILOT_INPUT_HEIGHT_KEY = 'storyforge-copilot-input-height'

export default function WorkspacePage() {
  const { projectId } = useParams()
  const navigate = useNavigate()
  const { loadProject, projects, currentProjectId } = useProjectStore()
  const [activeModule, setActiveModule] = useState<SidebarModule>('info')
  const [loading, setLoading] = useState(true)
  const [editorNodeId, setEditorNodeId] = useState<number | null>(null)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [showProperties, setShowProperties] = useState(false)
  const [showCopilot, setShowCopilot] = useState(false)
  // 副驾布局：右侧竖窗（默认）/ 底部横窗 / 全屏；尺寸可拖，三者都随本机记住。
  const [copilotPlacement, setCopilotPlacement] = useState<CopilotPlacement>(() => {
    const saved = localStorage.getItem(COPILOT_PLACEMENT_KEY)
    return saved === 'bottom' || saved === 'full' ? saved : 'right'
  })
  const [copilotDockHeight, setCopilotDockHeight] = useState<number>(() =>
    clampDockHeight(Number(localStorage.getItem(COPILOT_DOCK_HEIGHT_KEY))))
  const [copilotDockWidth, setCopilotDockWidth] = useState<number>(() =>
    clampDockWidth(Number(localStorage.getItem(COPILOT_DOCK_WIDTH_KEY))))
  const [copilotInputHeight, setCopilotInputHeight] = useState<number>(() =>
    clampInputHeight(Number(localStorage.getItem(COPILOT_INPUT_HEIGHT_KEY))))
  const activeWorldGroupId = useWorldGroupStore(state => state.activeGroupId)
  const worldGroups = useWorldGroupStore(state => state.groups)

  // 布局与高度随本机记住，下次打开保持作者习惯。
  useEffect(() => {
    localStorage.setItem(COPILOT_PLACEMENT_KEY, copilotPlacement)
  }, [copilotPlacement])
  useEffect(() => {
    localStorage.setItem(COPILOT_DOCK_HEIGHT_KEY, String(clampDockHeight(copilotDockHeight)))
  }, [copilotDockHeight])
  useEffect(() => {
    localStorage.setItem(COPILOT_DOCK_WIDTH_KEY, String(clampDockWidth(copilotDockWidth)))
  }, [copilotDockWidth])
  useEffect(() => {
    localStorage.setItem(COPILOT_INPUT_HEIGHT_KEY, String(clampInputHeight(copilotInputHeight)))
  }, [copilotInputHeight])

  // 从 Zustand Store 中动态获取当前项目，实现全局响应式更新
  const project = useMemo(() => {
    if (!currentProjectId) return null
    return projects.find(p => p.id === currentProjectId) || null
  }, [projects, currentProjectId])

  // STEP-1 撤回/重做按钮已抽成自带订阅的组件（StepHistoryButtons）：
  // 它监听步骤历史变化，采纳候选/应用正文后按钮会立刻可用，不必刷新页面。
  const stepProjectId = project?.id ?? null


  // 侧栏隐藏模块（多世界关闭时隐藏世界总览）。必须在所有提前 return 之前调用，
  // 否则 hook 数量在不同渲染间不一致，会报 "Rendered more hooks than..."
  const hiddenModules = useMemo(() => {
    const hidden = new Set<SidebarModule>()
    if (!project?.enableMultiWorld) hidden.add('world-overview')
    return hidden
  }, [project?.enableMultiWorld])

  // 自动定时备份（每 5 分钟本地快照）
  useAutoBackup(project?.id ?? null)
  // 云自动备份（开关开启时每 10 分钟推 GitHub Gist）
  useGistAutoBackup(project?.id ?? null)
  // 本地文件夹自动备份（绑过文件夹且授权有效时，进入即写 + 每 5 分钟写 JSON 落盘）
  useFolderAutoBackup(project?.id ?? null)

  // 加载项目 + 所有关联数据
  useEffect(() => {
    const load = async () => {
      if (!projectId || isNaN(Number(projectId))) {
        navigate('/')
        return
      }
      setLoading(true)
      let p
      try {
        p = await loadProject(Number(projectId))
      } catch (err) {
        log.error('Workspace', 'workspace', '[Workspace] loadProject 抛错:', undefined, err)
        setLoading(false)
        return
      }
      if (!p) {
        navigate('/')
        return
      }

      // 修复:直链/刷新进入工作区时 projects 列表可能为空(没经首页加载过),
      // 导致 `project = projects.find(...)` 恒为 null、永久卡"加载中"。这里补加载项目列表。
      if (useProjectStore.getState().projects.length === 0) {
        await useProjectStore.getState().loadProjects().catch(() => {})
      }

      // 并行加载所有数据。用 allSettled:任一 store 加载失败也不连累整体、
      // 不会让 setLoading(false) 漏执行而永久卡"加载中"(健壮性,防单点 store 抛错锁死工作区)。
      const pid = p.id!
      const loaders: { name: string; run: () => Promise<unknown> }[] = [
        { name: 'worldview', run: () => useWorldviewStore.getState().loadAll(pid) },
        { name: 'character', run: () => useCharacterStore.getState().loadAll(pid) },
        { name: 'outline', run: () => useOutlineStore.getState().loadAll(pid) },
        { name: 'chapter', run: () => useChapterStore.getState().loadAll(pid) },
        { name: 'foreshadow', run: () => useForeshadowStore.getState().loadAll(pid) },
        { name: 'geography', run: () => useGeographyStore.getState().loadAll(pid) },
        { name: 'history', run: () => useHistoryStore.getState().loadAll(pid) },
        { name: 'creativeRules', run: () => useCreativeRulesStore.getState().loadAll(pid) },
        { name: 'characterRelation', run: () => useCharacterRelationStore.getState().loadAll(pid) },
        { name: 'reference', run: () => useReferenceStore.getState().loadAll(pid) },
        { name: 'emotionBeat', run: () => useEmotionBeatStore.getState().loadAll(pid) },
        { name: 'location', run: () => useLocationStore.getState().loadAll(pid) },
        { name: 'worldRules', run: () => useWorldRulesStore.getState().loadProfile(pid) },
        { name: 'worldGroup', run: () => useWorldGroupStore.getState().loadAll(pid) },
      ]
      const results = await Promise.allSettled(loaders.map(l => l.run()))
      results.forEach((r, i) => {
        if (r.status === 'rejected') log.error('Workspace', 'workspace', `[Workspace] ${loaders[i].name} 加载失败:`, undefined, r.reason)
      })

      setLoading(false)
    }
    load()
  }, [projectId, loadProject, navigate])

  if (loading || !project) {
    return (
      <div className="min-h-screen bg-bg-base flex items-center justify-center">
        <span className="text-text-muted">加载中...</span>
      </div>
    )
  }

  const handleOpenChapter = (nodeId: number) => {
    setEditorNodeId(nodeId)
    setActiveModule('chapters-list')
  }

  const immersiveModules = new Set<SidebarModule>([
    'chapters-list',
    'editor',
    'foreshadow',
    'visual-workflows',
    'simulation-runtime',
  ])
  const isImmersiveModule = immersiveModules.has(activeModule)
  const copilotWorldGroupId = project.enableMultiWorld ? activeWorldGroupId : null
  const copilotWorldName = project.enableMultiWorld
    ? (worldGroups.find(group => group.id === activeWorldGroupId)?.name ?? '未选择世界')
    : '单世界'

  /** 根据当前模块渲染主面板内容 */
  const renderMainPanel = () => {
    switch (activeModule) {
      case 'info':
        return <ProjectInfoPanel project={project} onUpdate={() => useProjectStore.getState().loadProjects()} />
      case 'references':
        return <ReferencePanel project={project} />
      case 'inspiration':
        return <InspirationPanel project={project} />

      // ── 设定库 - 多世界 ─────────────────────────────────────────────
      case 'world-overview':
        return <WorldGroupOverview project={project} />

      // ── 设定库 - 世界观 ─────────────────────────────────────────────
      case 'world-rules':
        return <WorldRulesPanel project={project} />
      case 'worldview-origin':
        return <WorldviewOriginPanel project={project} />
      case 'worldview-natural':
        return <WorldviewNaturalPanel project={project} />
      case 'worldview-humanity':
        return <WorldviewHumanityPanel project={project} onOpenHistory={() => setActiveModule('history')} />
      case 'geography':
        return <GeographyPanel project={project} />
      case 'world-map':
        return <WorldMapPanel project={project} />
      case 'history':
        return <HistoryPanel project={project} />
      case 'power-system':
        return <PowerSystemPanel project={project} />

      // ── 设定库 - 故事设计 ─────────────────────────────────────────
      case 'story-design':
      case 'story-core':
        return <StoryCorePanel project={project} />

      // ── 设定库 - 角色设计 ──────────────────────────────────────────
      case 'characters':
        return <CharacterPanel project={project} />
      case 'characters-main':
        return <CharacterMainPanel project={project} />
      case 'characters-minor':
        return <CharacterMinorPanel project={project} />
      case 'characters-npc':
        return <CharacterNPCPanel project={project} />
      case 'characters-extra':
        return <CharacterExtraPanel project={project} />
      case 'relations':
        return <CharacterRelationPanel project={project} />

      // ── 创作区 ─────────────────────────────────────────────────────
      case 'rules':
        return <CreativeRulesPanel project={project} />
      case 'outline':
        return <OutlinePanel project={project} onOpenChapter={handleOpenChapter} />
      case 'character-driven-plot':
        return <CharacterDrivenPlotPanel project={project} />
      case 'visual-workflows':
        return <NodeModeWorkspace project={project} worldGroupId={copilotWorldGroupId} />
      case 'rag-library':
        return <RagLibraryPanel project={project} />
      case 'simulation-runtime':
        return <SimulationRuntimePanel project={project} worldGroupId={copilotWorldGroupId} />
      case 'detailed-outline':
        return <DetailedOutlinePanel project={project} />
      case 'chapters-list':
        return <ChaptersListPanel project={project} initialNodeId={editorNodeId} />
      case 'editor':
        return <ChaptersListPanel project={project} initialNodeId={editorNodeId} />
      case 'foreshadow':
        return <ForeshadowPanel project={project} />
      case 'style-learning':
        return <StyleLearningPanel project={project} />
      case 'locations':
        return <LocationPanel project={project} />
      case 'story-arc':
        return <StoryArcPanel project={project} />
      case 'state-table':
        return <StatePanel project={project} onOpenInventory={() => setActiveModule('inventory')} />
      case 'inventory':
        return <InventoryPanel project={project} />
      case 'fact-library':
        return <FactLibraryPanel project={project} />
      case 'story-timeline':
        return <UnifiedTimelinePanel
          project={project}
          onOpenChapter={(chapterId) => {
            const chapter = useChapterStore.getState().chapters.find(item => item.id === chapterId)
            if (chapter) handleOpenChapter(chapter.outlineNodeId)
          }}
        />
      case 'cultivation-progress':
        return <CultivationProgressPanel project={project} />
      case 'scene-verify':
        return <SceneVerifyPanel project={project} />

      // 作品学习已整合进项目参考 → 深度分析 tab（Phase 20）
      case 'master-studies':
        return <ReferencePanel project={project} />

      // ── 提示词库（一级） ───────────────────────────────────────────
      case 'prompts':
        return <PromptManagerPanel project={project} />

      // ── 设置区 ─────────────────────────────────────────────────────
      case 'version-history':
        return <VersionHistoryPanel project={project} />
      case 'import-doc':
        return <ImportDocPanel project={project} onNavigate={(m) => { setActiveModule(m); setEditorNodeId(null) }} />
      case 'settings':
        return <SettingsPage />
      case 'usage-stats':
        return <UsageStatsPage project={project} />
      case 'data-management':
      case 'backup':
      case 'export':
        return <DataManagementPanel project={project} onImported={(newId) => navigate(`/workspace/${newId}`)} />
      default:
        return null
    }
  }

  return <WorkspaceAgentRuntime project={project} worldGroupId={copilotWorldGroupId}>
    {copilot => (
    <div className="h-screen bg-bg-base flex overflow-hidden">
      {/* 左侧导航 */}
      <Sidebar
        active={activeModule}
        onSelect={(m) => { setActiveModule(m); if (m !== 'editor') setEditorNodeId(null) }}
        onBack={() => navigate('/')}
        projectName={project.name}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(v => !v)}
        hiddenModules={hiddenModules}
      />

      {/* 主面板 + 底部横窗副驾（bottom 模式两者纵向排列） */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
      <main
        className={`relative flex min-w-0 flex-1 flex-col overflow-hidden ${
          isImmersiveModule
            ? 'bg-[radial-gradient(circle_at_top_left,var(--border-subtle)_1px,transparent_1px)] [background-size:32px_32px]'
            : ''
        }`}
      >
        <div className="flex h-11 shrink-0 items-center justify-between gap-3 border-b border-border/70 bg-bg-surface/70 px-4">
          <ContentTypeBadge contentType={getModuleContentType(activeModule)} showDescription />
          <div className="flex items-center gap-1">
            {/* STEP-1：AI 修改的撤回/重做（主 Agent 采纳、卷纲生成、正文 AI 应用共用一条历史） */}
            <StepHistoryButtons projectId={stepProjectId} />
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              pressed={showCopilot}
              onClick={() => {
                setShowCopilot(value => {
                  if (!value) setShowProperties(false)
                  return !value
                })
              }}
              title={showCopilot ? '关闭 AI 对话副驾' : '打开 AI 对话副驾'}
              aria-label={showCopilot ? '关闭 AI 对话副驾' : '打开 AI 对话副驾'}
              className="shrink-0"
            >
              <MessageSquare />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              iconOnly
              pressed={showProperties}
              onClick={() => {
                setShowProperties(value => {
                  if (!value) setShowCopilot(false)
                  return !value
                })
              }}
              title={showProperties ? '关闭属性面板' : '打开属性面板'}
              aria-label={showProperties ? '关闭属性面板' : '打开属性面板'}
              className="shrink-0"
            >
              <PanelRight />
            </Button>
          </div>
        </div>
        <div className={`min-h-0 flex-1 overflow-y-auto ${isImmersiveModule ? '' : 'p-6'}`}>
          {/* Phase 3.5: 懒加载面板(地图类)加载时显示 fallback */}
          <Suspense fallback={<div className="flex items-center justify-center h-64 text-text-muted text-sm">面板加载中…</div>}>
            {renderMainPanel()}
          </Suspense>
        </div>
      </main>

      {/* 右侧属性面板 */}
      {showProperties && (
        <PropertiesPanel
          activeModule={activeModule}
          onClose={() => setShowProperties(false)}
        />
      )}
      {showCopilot && copilotPlacement === 'right' && (
        <Suspense fallback={(
          <aside className="fixed inset-y-0 right-0 z-30 flex h-full w-[min(24rem,calc(100vw-3rem))] shrink-0 items-center justify-center border-l border-border bg-bg-surface text-xs text-text-muted shadow-xl lg:static lg:z-auto lg:w-[24rem] lg:shadow-none">
            AI 对话副驾加载中…
          </aside>
        )}>
          <ChatCopilotPanel
            copilot={copilot}
            project={project}
            worldGroupId={copilotWorldGroupId}
            worldName={copilotWorldName}
            onClose={() => setShowCopilot(false)}
            placement="right"
            onTogglePlacement={() => setCopilotPlacement(nextCopilotPlacement('right'))}
            dockWidth={copilotDockWidth}
            onDockWidthChange={setCopilotDockWidth}
            inputHeight={copilotInputHeight}
            onInputHeightChange={setCopilotInputHeight}
          />
        </Suspense>
      )}
      {showCopilot && copilotPlacement === 'full' && (
        <Suspense fallback={(
          <aside className="fixed inset-0 z-40 flex items-center justify-center bg-bg-surface text-xs text-text-muted">
            AI 对话副驾加载中…
          </aside>
        )}>
          <ChatCopilotPanel
            copilot={copilot}
            project={project}
            worldGroupId={copilotWorldGroupId}
            worldName={copilotWorldName}
            onClose={() => setShowCopilot(false)}
            placement="full"
            onTogglePlacement={() => setCopilotPlacement(nextCopilotPlacement('full'))}
            inputHeight={copilotInputHeight}
            onInputHeightChange={setCopilotInputHeight}
          />
        </Suspense>
      )}
      </div>

      {/* 底部横窗副驾：高度可拖动，双击手柄恢复默认 */}
      {showCopilot && copilotPlacement === 'bottom' && (
        <Suspense fallback={(
          <aside className="z-30 flex h-40 w-full shrink-0 items-center justify-center border-t border-border bg-bg-surface text-xs text-text-muted">
            AI 对话副驾加载中…
          </aside>
        )}>
          <ChatCopilotPanel
            copilot={copilot}
            project={project}
            worldGroupId={copilotWorldGroupId}
            worldName={copilotWorldName}
            onClose={() => setShowCopilot(false)}
            placement="bottom"
            onTogglePlacement={() => setCopilotPlacement(nextCopilotPlacement('bottom'))}
            dockHeight={copilotDockHeight}
            onDockHeightChange={setCopilotDockHeight}
            inputHeight={copilotInputHeight}
            onInputHeightChange={setCopilotInputHeight}
          />
        </Suspense>
      )}
      </div>
    </div>
    )}
  </WorkspaceAgentRuntime>
}
