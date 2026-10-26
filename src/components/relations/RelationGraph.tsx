import { useRef, useEffect, useCallback, useMemo, useState, type ComponentRef } from 'react'
import ForceGraph2D from 'react-force-graph-2d'

type ForceGraphHandle = ComponentRef<typeof ForceGraph2D>
import type { Character, CharacterRelation } from '../../lib/types'
import { buildRelationGraphData, type RelationGraphLink, type RelationGraphNode } from '../../lib/relations/relation-graph-model'
import { layoutRelationLabels, type PositionedRelationLink, type PositionedRelationNode } from '../../lib/relations/relation-label-layout'

// 关系类型对应颜色
const RELATION_COLORS: Record<string, string> = {
  family:     '#f59e0b',
  lover:      '#ec4899',
  friend:     '#22c55e',
  rival:      '#f97316',
  enemy:      '#ef4444',
  master:     '#a78bfa',
  student:    '#60a5fa',
  ally:       '#14b8a6',
  subordinate:'#94a3b8',
  other:      '#6b7280',
}

const RELATION_LABELS: Record<string, string> = {
  family:'亲属', lover:'恋人', friend:'朋友', rival:'对手',
  enemy:'敌人', master:'师父', student:'弟子', ally:'盟友',
  subordinate:'上下级', other:'其他',
}

// react-force-graph-2d 在运行时会把 GraphNode / GraphLink 附加上 x/y 坐标属性
type PositionedNode = PositionedRelationNode
type PositionedLink = PositionedRelationLink

interface Props {
  characters: Character[]
  relations: CharacterRelation[]
  width?: number
  height?: number
}

export default function RelationGraph({ characters, relations, width = 700, height = 480 }: Props) {
  const graphRef = useRef<ForceGraphHandle | undefined>(undefined)
  const fitOnStopRef = useRef(true)
  const [focusedId, setFocusedId] = useState<string | null>(null)
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const [hoveredLinkId, setHoveredLinkId] = useState<number | null>(null)
  const graphData = useMemo(() => buildRelationGraphData(characters, relations), [characters, relations])
  const activeId = hoveredId ?? focusedId
  const fitPadding = Math.min(100, width * 0.12)
  const neighborIds = useMemo(() => {
    const ids = new Set<string>()
    if (!activeId) return ids
    ids.add(activeId)
    for (const link of graphData.links) {
      const source = typeof link.source === 'string' ? link.source : (link.source as PositionedNode).id
      const target = typeof link.target === 'string' ? link.target : (link.target as PositionedNode).id
      if (source === activeId) ids.add(target)
      if (target === activeId) ids.add(source)
    }
    return ids
  }, [activeId, graphData.links])

  useEffect(() => {
    fitOnStopRef.current = true
    graphRef.current?.d3Force('charge')?.strength(-450)
    graphRef.current?.d3Force('link')?.distance(145)
    const timer = setTimeout(() => graphRef.current?.zoomToFit(400, fitPadding), 700)
    return () => clearTimeout(timer)
  }, [graphData, fitPadding])

  const drawNode = useCallback((rawNode: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const node = rawNode as PositionedNode
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return
    const highlighted = !activeId || neighborIds.has(node.id)
    const radius = (node.kind === 'group' ? 9 : 8) / globalScale
    ctx.globalAlpha = highlighted ? 1 : 0.16
    ctx.beginPath()
    if (node.kind === 'group') {
      ctx.moveTo(node.x, node.y - radius)
      ctx.lineTo(node.x + radius, node.y)
      ctx.lineTo(node.x, node.y + radius)
      ctx.lineTo(node.x - radius, node.y)
      ctx.closePath()
    } else ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI)
    ctx.fillStyle = node.color
    ctx.fill()
    ctx.strokeStyle = node.id === activeId ? '#ffffff' : 'rgba(255,255,255,0.4)'
    ctx.lineWidth = (node.id === activeId ? 2 : 1) / globalScale
    ctx.stroke()
    ctx.globalAlpha = 1
  }, [activeId, neighborIds])

  const drawLink = useCallback((rawLink: unknown, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const link = rawLink as PositionedLink
    const start = link.source
    const end = link.target
    if (!start || !end || !Number.isFinite(start.x) || !Number.isFinite(end.x)) return

    const selected = activeId && (start.id === activeId || end.id === activeId)
    ctx.globalAlpha = activeId ? selected ? 0.9 : 0.08 : 0.45
    ctx.beginPath()
    ctx.moveTo(start.x, start.y)
    ctx.lineTo(end.x, end.y)
    ctx.strokeStyle = link.color
    ctx.lineWidth = (selected ? 2 : 1) / globalScale
    ctx.stroke()
    ctx.globalAlpha = 1
  }, [activeId])

  const drawLabels = useCallback((ctx: CanvasRenderingContext2D, globalScale: number) => {
    if (!Number.isFinite(globalScale) || globalScale <= 0) return
    ctx.save()
    ctx.font = `${14 / globalScale}px PingFang SC, Microsoft YaHei, sans-serif`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    const labels = layoutRelationLabels(graphData.nodes as PositionedNode[], graphData.links as PositionedLink[],
      globalScale, text => ctx.measureText(text).width, activeId, hoveredLinkId)
    for (const label of labels) {
      ctx.globalAlpha = label.related ? 1 : 0.55
      ctx.fillStyle = 'rgba(8,10,18,0.94)'
      ctx.fillRect(label.x, label.y, label.width, label.height)
      ctx.fillStyle = label.color
      ctx.fillRect(label.x, label.y, 2 / globalScale, label.height)
      ctx.fillStyle = '#f8fafc'
      label.lines.forEach((line, index) => {
        ctx.fillText(line, label.x + 8 / globalScale, label.y + (index * 18 + 14) / globalScale)
      })
    }
    ctx.restore()
  }, [activeId, graphData, hoveredLinkId])

  const focusedNode = graphData.nodes.find(node => node.id === focusedId)
  const focusedRelations = focusedId ? relations.filter(relation => focusedId.startsWith('group:')
    ? relation.id === focusedNode?.relationId
    : (relation.participantCharacterIds?.length && relation.participantCharacterIds.length > 2
      ? relation.participantCharacterIds : [relation.fromCharacterId, relation.toCharacterId]).includes(Number(focusedId))) : []
  const names = new Map(characters.map(character => [character.id, character.name]))

  if (characters.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-text-muted">
        <p className="text-sm">暂无角色数据，请先在「角色」模块添加角色</p>
      </div>
    )
  }

  if (relations.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-text-muted">
        <p className="text-sm">暂无关系数据，请在下方添加角色关系</p>
      </div>
    )
  }

  return (
    <div className="rounded-lg overflow-hidden border border-border bg-bg-base">
      <div className="px-3 py-2 text-xs text-text-muted border-b border-border flex items-center justify-between gap-2">
        <span>人物与关系名称显示在图中；点击角色或菱形多人关系可查看完整详情。</span>
        {focusedId && <button className="text-accent hover:underline" onClick={() => setFocusedId(null)}>清除聚焦</button>}
      </div>
      <ForceGraph2D
        ref={graphRef}
        graphData={graphData}
        width={width}
        height={height}
        backgroundColor="#0a0a0f"
        nodeCanvasObject={drawNode}
        nodeCanvasObjectMode={() => 'replace'}
        nodeLabel={(node: object) => (node as RelationGraphNode).name}
        nodeRelSize={8}
        onNodeHover={(node: object | null) => setHoveredId(node ? (node as RelationGraphNode).id : null)}
        onNodeClick={(node: object) => setFocusedId((node as RelationGraphNode).id)}
        linkCanvasObject={drawLink}
        linkCanvasObjectMode={() => 'replace'}
        linkLabel={(link: object) => (link as RelationGraphLink).labels.join('、')}
        onLinkHover={(link: object | null) => setHoveredLinkId(link ? ((link as RelationGraphLink).relationIds[0] ?? null) : null)}
        onRenderFramePost={drawLabels}
        linkDirectionalArrowLength={(link: object) => ((link as RelationGraphLink).bidirectional ? 0 : 5)}
        linkDirectionalArrowRelPos={0.85}
        cooldownTicks={140}
        onEngineStop={() => {
          if (fitOnStopRef.current) {
            fitOnStopRef.current = false
            graphRef.current?.zoomToFit(400, fitPadding)
          }
        }}
        enableNodeDrag
        enableZoomInteraction
      />

      <div className="p-3 border-t border-border text-xs text-text-secondary">
        {focusedNode ? <div className="space-y-1">
          <div className="font-medium text-text-primary">{focusedNode.kind === 'group' ? '多人关系' : '角色'}：{focusedNode.name}</div>
          {focusedRelations.map((relation, index) => {
            const participants = relation.participantCharacterIds?.length && relation.participantCharacterIds.length > 2
              ? relation.participantCharacterIds : [relation.fromCharacterId, relation.toCharacterId]
            return <div key={relation.id ?? index}>
              {participants.map(id => names.get(id) ?? `角色#${id}`).join(' · ')}：{relation.label || RELATION_LABELS[relation.relationType]}
            </div>
          })}
        </div> : <div className="flex flex-wrap gap-2">
          {graphData.nodes.map(node => <button key={node.id} onClick={() => setFocusedId(node.id)}
            className="px-2 py-1 rounded bg-bg-elevated hover:text-text-primary" title={node.kind === 'group' ? '多人关系' : '角色'}>
            {node.kind === 'group' ? '◇ ' : ''}{node.name}
          </button>)}
        </div>}
      </div>

      {/* 图例 */}
      <div className="p-3 border-t border-border flex flex-wrap gap-x-4 gap-y-1">
        {Object.entries(RELATION_COLORS).map(([key, color]) => (
          <div key={key} className="flex items-center gap-1 text-xs text-text-muted">
            <span className="w-3 h-0.5 inline-block rounded" style={{ backgroundColor: color }} />
            {RELATION_LABELS[key]}
          </div>
        ))}
      </div>
    </div>
  )
}
