/**
 * Phase 25.3 — 重要地点面板
 * 树状图 / 列表双视图 + 多标签组合 + 树状父子层级
 */
import { useState, useEffect, useCallback } from 'react'
import {
  Plus, Trash2, ChevronDown, ChevronRight, MapPin,
  GitBranch, List, Sparkles,
} from 'lucide-react'
import { useLocationStore } from '../../stores/location'
import type { Project, ImportantLocation, LocationTag } from '../../lib/types'
import { TAG_EMOJI } from '../../lib/types/location'
import LocationTagPicker from './LocationTagPicker'
import LocationTreeView from './LocationTreeView'
import { useChapterStore } from '../../stores/chapter'
import { useAIConfigStore } from '../../stores/ai-config'
import { chat, resolveRequestConfig } from '../../lib/ai/client'
import { getAIConfigRequiredMessage, isAIConfigReady } from '../../lib/ai/config-readiness'
import {
  buildLocationExtractPrompt, parseLocations, splitExtractionText, type ExtractedLocation,
} from '../../lib/ai/adapters/structured-extract-adapter'
import { htmlToPlainText } from '../../lib/utils/html'
import { uniqueBy } from '../../lib/ai/structured-extraction'
import { adopt } from '../../lib/registry/adopt'
import ExtractionReviewPanel from '../shared/ExtractionReviewPanel'
import AliasChipsField from '../shared/AliasChipsField'
import { assembleContext } from '../../lib/registry/assemble-context'
import { Button } from '../shared/Button'
import { useWorldGroupStore } from '../../stores/world-group'
import { chaptersInWorld } from '../../lib/location/scope'
import { useDialog } from '../shared/Dialog'

interface Props {
  project: Project
}

export default function LocationPanel({ project }: Props) {
  const {
    locations: allLocations, loading, loadAll,
    addLocation, updateLocation, deleteLocation,
    getTree,
  } = useLocationStore()
  const { chapters, loadAll: loadChapters } = useChapterStore()
  const aiConfig = useAIConfigStore(s => s.config)
  const activeGroupId = useWorldGroupStore(s => s.activeGroupId)
  const dialog = useDialog()
  const locations = allLocations.filter(location => !project.enableMultiWorld
    || location.scope !== 'world' || location.worldGroupId === activeGroupId)

  const [view, setView] = useState<'tree' | 'list'>('tree')
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null)
  const [extracting, setExtracting] = useState(false)
  const [extractError, setExtractError] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<ExtractedLocation[]>([])
  const [selectedCandidates, setSelectedCandidates] = useState<Set<number>>(new Set())

  useEffect(() => {
    loadAll(project.id!)
    loadChapters(project.id!)
  }, [project.id, loadAll, loadChapters])

  const tree = getTree(location => !project.enableMultiWorld
    || location.scope !== 'world' || location.worldGroupId === activeGroupId)

  const handleAdd = useCallback(async (parentId: number | null = null) => {
    const parent = parentId == null ? null : locations.find(location => location.id === parentId)
    const id = await addLocation({
      projectId: project.id!,
      scope: parent?.scope ?? (project.enableMultiWorld && activeGroupId != null ? 'world' : 'unassigned'),
      worldGroupId: parent ? parent.worldGroupId ?? null : (project.enableMultiWorld ? activeGroupId : null),
      name: '新地点',
      tags: '[]',
      description: '',
      significance: '',
      parentId,
      sortOrder: locations.length,
    })
    setExpandedId(id)
  }, [project.id, project.enableMultiWorld, activeGroupId, addLocation, locations])

  const handleDelete = useCallback(async (id: number) => {
    await deleteLocation(id)
    if (expandedId === id) setExpandedId(null)
    setConfirmDeleteId(null)
  }, [deleteLocation, expandedId])

  const handleUpdateTags = useCallback((id: number, tags: LocationTag[]) => {
    updateLocation(id, { tags: JSON.stringify(tags) })
  }, [updateLocation])

  const parseTags = (tagsStr: string): LocationTag[] => {
    try { return JSON.parse(tagsStr || '[]') } catch { return [] }
  }

  const handleExtractLocations = async () => {
    const effectiveConfig = resolveRequestConfig(aiConfig, { category: 'location.extract' }).config
    if (!isAIConfigReady(effectiveConfig)) {
      setExtractError(getAIConfigRequiredMessage(effectiveConfig))
      return
    }
    const scopedChapters = project.enableMultiWorld
      ? await chaptersInWorld(project.id!, chapters, activeGroupId)
      : chapters
    const written = scopedChapters.filter(chapter => htmlToPlainText(chapter.content || '').trim().length > 50)
    if (written.length === 0) {
      setExtractError('还没有已写正文的章节')
      return
    }
    setExtracting(true)
    setExtractError(null)
    setCandidates([])
    try {
      const found: ExtractedLocation[] = []
      for (const chapter of written) {
        const chapterSource = await assembleContext({
          projectId: project.id!,
          chapterId: chapter.id,
          sourceKeys: ['chapterContent'],
        })
        for (const chunk of splitExtractionText(chapterSource.text)) {
          const raw = await chat(
            buildLocationExtractPrompt(chunk, [...locations.map(location => location.name), ...found.map(item => item.name)]),
            aiConfig,
            { category: 'location.extract', projectId: project.id! },
          )
          found.push(...parseLocations(raw))
        }
      }
      const existing = new Set(locations.map(location => location.name.trim().toLocaleLowerCase()))
      const unique = uniqueBy(
        found.filter(item => !existing.has(item.name.toLocaleLowerCase())),
        item => item.name.toLocaleLowerCase(),
      )
      setCandidates(unique)
      setSelectedCandidates(new Set(unique.map((_, index) => index)))
    } catch (error) {
      setExtractError(error instanceof Error ? error.message : '地点提取失败')
    } finally {
      setExtracting(false)
    }
  }

  const handleAdoptLocations = async () => {
    const selected = candidates.filter((_, index) => selectedCandidates.has(index))
    const result = await adopt({
      projectId: project.id!,
      worldGroupId: project.enableMultiWorld ? activeGroupId : null,
      target: 'importantLocations',
      mode: 'add-many',
      data: selected.map((item, index) => ({
        name: item.name,
        scope: project.enableMultiWorld && activeGroupId != null ? 'world' : 'unassigned',
        tags: item.tags,
        description: item.description,
        significance: item.significance,
        parentId: null,
        sortOrder: locations.length + index,
      })),
    })
    if (!result.written.length && result.skipped.length) {
      setExtractError(result.skipped.map(item => item.reason).join('；'))
      return
    }
    await loadAll(project.id!)
    setCandidates([])
    setSelectedCandidates(new Set())
  }

  const unassignedLocations = allLocations.filter(location =>
    location.scope !== 'world' && location.scope !== 'shared')

  /**
   * 改归属。父地点若不在新范围内，层级会被解除——必须让作者知道并确认，
   * 不能像以前那样在下拉 onChange 里静默把 parentId 置空。
   */
  const changeScope = async (loc: ImportantLocation, scope: 'world' | 'shared' | 'unassigned') => {
    const nextWorld = scope === 'world' ? activeGroupId : null
    const parent = loc.parentId == null ? null : allLocations.find(row => row.id === loc.parentId)
    const keepsParent = parent == null
      || ((parent.scope ?? 'unassigned') === scope && (parent.worldGroupId ?? null) === (nextWorld ?? null))
    if (!keepsParent) {
      const ok = await dialog.confirm({
        title: '改归属会解除父地点层级',
        message: `父地点「${parent!.name}」不在新的归属范围内，继续会把「${loc.name}」移到顶级；它的子地点仍跟随它。是否继续？`,
        confirmText: '解除层级并改归属',
      })
      if (!ok) return
    }
    await updateLocation(loc.id!, {
      scope, worldGroupId: nextWorld, parentId: keepsParent ? loc.parentId ?? null : null,
    })
  }

  /** 一次性把待归属地点归入当前世界：迁移后逐个下拉修改不现实。 */
  const assignAllUnassigned = async () => {
    if (activeGroupId == null || unassignedLocations.length === 0) return
    const ok = await dialog.confirm({
      title: `把 ${unassignedLocations.length} 个待归属地点归入当前世界？`,
      message: '待归属地点目前不会进入多世界 AI 上下文，也不参与地图关联。归入后它们只属于当前世界组；不属于本世界的父地点会自动断开。',
      confirmText: '全部归入当前世界',
    })
    if (!ok) return
    const assigning = new Set(unassignedLocations.map(location => location.id!))
    for (const location of unassignedLocations) {
      const parent = location.parentId == null ? null : allLocations.find(row => row.id === location.parentId)
      const parentKeeps = parent == null || assigning.has(parent.id!) || parent.scope === 'shared'
        || (parent.scope === 'world' && parent.worldGroupId === activeGroupId)
      await updateLocation(location.id!, {
        scope: 'world', worldGroupId: activeGroupId,
        ...(parentKeeps ? {} : { parentId: null }),
      })
    }
  }

  // 递归渲染列表项
  const renderListItem = (loc: ImportantLocation, depth: number = 0) => {    const isExpanded = expandedId === loc.id
    const tags = parseTags(loc.tags)
    const children = locations.filter(l => l.parentId === loc.id)
    const isConfirmingDelete = confirmDeleteId === loc.id

    return (
      <div key={loc.id}>
        <div
          className="border border-border rounded-lg bg-bg-surface overflow-hidden mb-2"
          style={{ marginLeft: depth * 24 }}
        >
          {/* 头部 */}
          <button
            onClick={() => setExpandedId(isExpanded ? null : loc.id!)}
            className="w-full flex items-center gap-2 px-4 py-3 hover:bg-bg-hover transition-colors"
          >
            {isExpanded
              ? <ChevronDown className="w-4 h-4 text-text-muted shrink-0" />
              : <ChevronRight className="w-4 h-4 text-text-muted shrink-0" />}
            <MapPin className="w-4 h-4 text-accent shrink-0" />
            <span className="text-sm font-medium text-text-primary flex-1 text-left truncate">
              {loc.name}
            </span>
            {project.enableMultiWorld && <span className="text-[10px] text-text-muted">{loc.scope === 'shared' ? '共享' : loc.scope === 'world' ? '本世界' : '待归属'}</span>}
            {/* 标签预览 */}
            <div className="flex items-center gap-1 shrink-0">
              {tags.slice(0, 3).map(tag => (
                <span
                  key={tag}
                  className="text-[10px] px-1.5 py-0.5 bg-bg-elevated text-text-muted rounded"
                  title={tag}
                >
                  {TAG_EMOJI[tag] || '📍'} {tag}
                </span>
              ))}
              {tags.length > 3 && (
                <span className="text-[10px] text-text-muted">+{tags.length - 3}</span>
              )}
            </div>
            {children.length > 0 && (
              <span className="text-[10px] text-text-muted bg-bg-elevated px-1.5 py-0.5 rounded shrink-0">
                {children.length} 子地点
              </span>
            )}
          </button>

          {/* 展开编辑 */}
          {isExpanded && (
            <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
              {project.enableMultiWorld && <div>
                <label className="block text-xs text-text-muted mb-1">地点归属</label>
                <select value={loc.scope ?? 'unassigned'} onChange={event => {
                  void changeScope(loc, event.target.value as 'world' | 'shared' | 'unassigned')
                }} className="bg-bg-base border border-border rounded px-2 py-1.5 text-sm">
                  <option value="unassigned">待归属（不进入多世界 AI 上下文）</option>
                  <option value="world" disabled={activeGroupId == null}>当前世界专属</option>
                  <option value="shared">跨世界共享</option>
                </select>
              </div>}
              {/* 名称 + 父地点 */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-text-muted mb-1">名称</label>
                  <input
                    value={loc.name}
                    onChange={e => updateLocation(loc.id!, { name: e.target.value })}
                    className="w-full px-2 py-1.5 bg-bg-base border border-border rounded text-sm text-text-primary focus:outline-none focus:border-accent"
                  />
                </div>
                <div>
                  <label className="block text-xs text-text-muted mb-1">上级地点</label>
                  <select
                    value={loc.parentId ?? ''}
                    onChange={e => updateLocation(loc.id!, { parentId: e.target.value ? Number(e.target.value) : null })}
                    className="w-full px-2 py-1.5 bg-bg-base border border-border rounded text-sm text-text-primary focus:outline-none focus:border-accent"
                  >
                    <option value="">（顶级）</option>
                    {locations
                      .filter(l => l.id !== loc.id && l.scope === loc.scope && l.worldGroupId === loc.worldGroupId)
                      .map(l => (
                        <option key={l.id} value={l.id}>{l.name}</option>
                      ))}
                  </select>
                </div>
              </div>

              {/* ALIAS-1：地点旧称/俗称。正文写到旧称时也能解析到同一地点。 */}
              <AliasChipsField
                canonicalName={loc.name}
                aliases={loc.aliases ?? []}
                onChange={aliases => updateLocation(loc.id!, { aliases })}
              />

              {/* 标签 */}
              <div>
                <label className="block text-xs text-text-muted mb-1">地点标签（可多选组合）</label>
                <LocationTagPicker
                  selected={tags}
                  onChange={newTags => handleUpdateTags(loc.id!, newTags)}
                />
              </div>

              {/* 描述 */}
              <div>
                <label className="block text-xs text-text-muted mb-1">描述</label>
                <textarea
                  value={loc.description}
                  onChange={e => updateLocation(loc.id!, { description: e.target.value })}
                  placeholder="地点的详细描述、外观、氛围…"
                  className="w-full h-20 p-2 bg-bg-base border border-border rounded text-sm text-text-primary resize-y focus:outline-none focus:border-accent"
                />
              </div>

              {/* 剧情重要性 */}
              <div>
                <label className="block text-xs text-text-muted mb-1">剧情重要性</label>
                <textarea
                  value={loc.significance}
                  onChange={e => updateLocation(loc.id!, { significance: e.target.value })}
                  placeholder="此地点在故事中的作用、关键事件、与角色的关联…"
                  className="w-full h-16 p-2 bg-bg-base border border-border rounded text-sm text-text-primary resize-y focus:outline-none focus:border-accent"
                />
              </div>

              {/* 操作栏 */}
              <div className="flex items-center justify-between">
                <button
                  onClick={() => handleAdd(loc.id!)}
                  className="flex items-center gap-1 px-3 py-1.5 text-accent hover:bg-accent/10 text-xs rounded transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  添加子地点
                </button>
                {isConfirmingDelete ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-red-400">确认删除？子地点也会一并删除</span>
                    <Button
                      variant="danger"
                      size="xs"
                      onClick={() => handleDelete(loc.id!)}
                    >
                      确认
                    </Button>
                    <button
                      onClick={() => setConfirmDeleteId(null)}
                      className="px-2 py-1 text-xs text-text-muted hover:text-text-primary transition-colors"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmDeleteId(loc.id!)}
                    className="flex items-center gap-1 px-3 py-1.5 text-red-400 hover:bg-red-500/10 text-xs rounded transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    删除地点
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 子地点递归渲染 */}
        {children.map(child => renderListItem(child, depth + 1))}
      </div>
    )
  }

  // 顶层地点
  const topLevelLocations = locations.filter(l => l.parentId === null)

  if (loading) {
    return (
      <div className="max-w-4xl animate-pulse">
        <div className="h-8 bg-bg-elevated rounded w-48 mb-6" />
        <div className="h-64 bg-bg-elevated rounded" />
      </div>
    )
  }

  return (
    <div className="max-w-4xl">
      <h2 className="text-xl font-bold text-text-primary mb-1">📍 重要地点</h2>
      <p className="text-sm text-text-muted mb-4">
        管理故事中的重要场景地点，支持标签组合与树状层级
      </p>

      {/* 工具栏 */}
      <div className="mb-4 flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-text-secondary">
          共 <span className="text-text-primary font-medium">{locations.length}</span> 个地点
          {project.enableMultiWorld && unassignedLocations.length > 0 && (
            <span className="ml-2 text-xs text-amber-400">待归属 {unassignedLocations.length}（不进入 AI 上下文）</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {project.enableMultiWorld && unassignedLocations.length > 0 && (
            <Button variant="outline" size="sm" onClick={() => { void assignAllUnassigned() }}
              disabled={activeGroupId == null} title={activeGroupId == null ? '请先选择世界组' : '把待归属地点归入当前世界组'}>
              全部归入当前世界
            </Button>
          )}
          {/* 视图切换 */}
          <div className="flex bg-bg-elevated rounded-lg p-0.5">
            <button
              onClick={() => setView('tree')}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm transition-colors ${
                view === 'tree' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <GitBranch className="w-3.5 h-3.5" /> 树状图
            </button>
            <button
              onClick={() => setView('list')}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-md text-sm transition-colors ${
                view === 'list' ? 'bg-accent text-white' : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <List className="w-3.5 h-3.5" /> 列表
            </button>
          </div>
          <Button
            variant="primary"
            size="sm"
            onClick={() => handleAdd(null)}
            icon={<Plus />}
          >
            添加地点
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExtractLocations}
            disabled={extracting}
            loading={extracting}
            loadingText="正在分析正文…"
            icon={<Sparkles />}
          >
            AI 从正文提取
          </Button>
        </div>
      </div>

      {(extracting || extractError || candidates.length > 0) && (
        <ExtractionReviewPanel
          title="地点候选"
          items={candidates}
          selected={selectedCandidates}
          loading={extracting}
          error={extractError}
          onToggle={index => setSelectedCandidates(prev => {
            const next = new Set(prev)
            if (next.has(index)) next.delete(index)
            else next.add(index)
            return next
          })}
          onConfirm={handleAdoptLocations}
          onClose={() => { setCandidates([]); setExtractError(null) }}
          renderItem={item => (
            <div>
              <div className="font-medium text-sm text-text-primary">{item.name}</div>
              <p className="text-xs text-text-muted mt-0.5">{item.significance || item.description}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {item.tags.map(tag => <span key={tag} className="px-1.5 py-0.5 rounded bg-bg-elevated text-[10px] text-text-muted">{TAG_EMOJI[tag]} {tag}</span>)}
              </div>
            </div>
          )}
        />
      )}

      {/* 树状图视图 */}
      {view === 'tree' && (
        <div className="mb-6">
          <LocationTreeView
            tree={tree}
            onSelect={id => {
              setView('list')
              setExpandedId(id)
            }}
          />
          {locations.length > 0 && (
            <p className="text-xs text-text-muted mt-2 text-center">点击节点可跳转到列表编辑</p>
          )}
        </div>
      )}

      {/* 列表视图 */}
      {view === 'list' && (
        <div>
          {locations.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-text-muted">
              <MapPin className="w-12 h-12 mb-3 opacity-30" />
              <p className="text-sm mb-3">暂无地点</p>
              <Button
                variant="primary"
                size="md"
                onClick={() => handleAdd(null)}
                icon={<Plus />}
              >
                添加第一个地点
              </Button>
            </div>
          ) : (
            topLevelLocations.map(loc => renderListItem(loc))
          )}
        </div>
      )}
    </div>
  )
}
