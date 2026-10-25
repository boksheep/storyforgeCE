import { useMemo, useRef } from 'react'
import { CheckCircle2, Circle, Loader2, Play, Trash2 } from 'lucide-react'
import type {
  NodeExecutionResultMap,
} from '../../lib/node-flow/executor'
import { NODE_KIND_BY_ID } from '../../lib/node-flow/graph'
import type { NodeFlowGraph } from '../../lib/types'

const NODE_WIDTH = 248
const NODE_HEIGHT = 176

export default function NodeFlowCanvas(props: {
  graph: NodeFlowGraph
  selectedNodeId: string | null
  connectingFrom: string | null
  results: NodeExecutionResultMap
  runningNodeId: string | null
  onSelectNode: (nodeId: string | null) => void
  onMoveNode: (nodeId: string, x: number, y: number) => void
  onStartConnection: (nodeId: string) => void
  onFinishConnection: (targetNodeId: string, targetSlotId: string) => void
  onRemoveNode: (nodeId: string) => void
  onRunNode: (nodeId: string) => void
}) {
  const dragRef = useRef<{
    nodeId: string
    startX: number
    startY: number
    nodeX: number
    nodeY: number
  } | null>(null)
  const byId = useMemo(() => new Map(props.graph.nodes.map(node => [node.id, node])), [props.graph.nodes])
  const zoom = props.graph.viewport.zoom

  return (
    <div
      className="relative h-full min-h-[680px] w-full overflow-auto bg-[radial-gradient(circle,var(--border-subtle)_1px,transparent_1px)] [background-size:24px_24px]"
      onPointerDown={event => {
        if (event.target === event.currentTarget) props.onSelectNode(null)
      }}
    >
      <div
        className="relative h-[1800px] w-[2800px] origin-top-left"
        style={{ transform: `scale(${zoom})` }}
      >
        <svg
          aria-label="节点连线"
          className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        >
          {props.graph.edges.map(edge => {
            const source = byId.get(edge.sourceNodeId)
            const target = byId.get(edge.targetNodeId)
            if (!source || !target) return null
            const slotIndex = Math.max(0, target.inputSlots.findIndex(slot => slot.id === edge.targetSlotId))
            const x1 = source.x + NODE_WIDTH
            const y1 = source.y + NODE_HEIGHT / 2
            const x2 = target.x
            const y2 = target.y + 58 + slotIndex * 26
            const control = Math.max(80, Math.abs(x2 - x1) * 0.45)
            return (
              <path
                key={edge.id}
                d={`M ${x1} ${y1} C ${x1 + control} ${y1}, ${x2 - control} ${y2}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--color-accent)"
                strokeOpacity="0.65"
                strokeWidth="2"
              />
            )
          })}
        </svg>

        {props.graph.nodes.map(node => {
          const definition = NODE_KIND_BY_ID.get(node.kind)
          const selected = props.selectedNodeId === node.id
          const result = props.results[node.id]
          const running = props.runningNodeId === node.id
          const preview = result?.output
            || (typeof node.config.text === 'string' ? node.config.text : '')
            || (typeof node.config.instruction === 'string' ? node.config.instruction : '')
          return (
            <article
              key={node.id}
              className={`absolute flex h-44 w-[248px] flex-col rounded-xl border bg-bg-surface shadow-lg transition-shadow ${
                selected ? 'border-accent ring-2 ring-accent/20' : 'border-border'
              }`}
              style={{ left: node.x, top: node.y }}
              onPointerDown={() => props.onSelectNode(node.id)}
            >
              <header
                className="flex cursor-grab items-center justify-between gap-2 rounded-t-xl border-b border-border/70 bg-bg-elevated px-3 py-2 active:cursor-grabbing"
                onPointerDown={event => {
                  event.stopPropagation()
                  event.currentTarget.setPointerCapture(event.pointerId)
                  dragRef.current = {
                    nodeId: node.id,
                    startX: event.clientX,
                    startY: event.clientY,
                    nodeX: node.x,
                    nodeY: node.y,
                  }
                  props.onSelectNode(node.id)
                }}
                onPointerMove={event => {
                  const drag = dragRef.current
                  if (!drag || drag.nodeId !== node.id) return
                  props.onMoveNode(
                    node.id,
                    Math.max(0, drag.nodeX + (event.clientX - drag.startX) / zoom),
                    Math.max(0, drag.nodeY + (event.clientY - drag.startY) / zoom),
                  )
                }}
                onPointerUp={() => { dragRef.current = null }}
              >
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-text-primary">{node.title}</p>
                  <p className="truncate text-[9px] text-text-muted">{definition?.label ?? node.kind}</p>
                </div>
                <div className="flex items-center gap-1">
                  {running && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
                  {result?.status === 'completed' && <CheckCircle2 className="h-3.5 w-3.5 text-success" />}
                  {result?.status === 'failed' && <Circle className="h-3.5 w-3.5 fill-error text-error" />}
                </div>
              </header>

              <div className="relative min-h-0 flex-1 px-3 py-2">
                {node.inputSlots.map((slot, index) => (
                  <button
                    key={slot.id}
                    type="button"
                    aria-label={`连接到 ${node.title}.${slot.label}`}
                    title={`${slot.label} · ${slot.type}${slot.required ? ' · 必需' : ''}`}
                    onClick={event => {
                      event.stopPropagation()
                      props.onFinishConnection(node.id, slot.id)
                    }}
                    className={`absolute -left-2 flex h-4 w-4 items-center justify-center rounded-full border ${
                      props.connectingFrom
                        ? 'border-accent bg-accent/20 hover:bg-accent'
                        : 'border-border bg-bg-surface'
                    }`}
                    style={{ top: 10 + index * 26 }}
                  >
                    <span className="sr-only">{slot.label}</span>
                  </button>
                ))}
                <div className="mb-1 flex flex-wrap gap-1">
                  {node.inputSlots.slice(0, 3).map(slot => (
                    <span key={slot.id} className="rounded bg-bg-base px-1.5 py-0.5 text-[9px] text-text-muted">
                      {slot.label}
                    </span>
                  ))}
                </div>
                <div className="line-clamp-4 whitespace-pre-wrap text-[10px] leading-4 text-text-secondary">
                  {result?.error || preview || definition?.description || '在右侧检查器配置节点'}
                </div>
                <button
                  type="button"
                  aria-label={`从 ${node.title} 开始连线`}
                  title="点击后再点击目标输入端口"
                  onClick={event => {
                    event.stopPropagation()
                    props.onStartConnection(node.id)
                  }}
                  className={`absolute -right-2 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full border ${
                    props.connectingFrom === node.id
                      ? 'border-accent bg-accent'
                      : 'border-accent bg-bg-surface hover:bg-accent/20'
                  }`}
                >
                  <span className="sr-only">输出端口</span>
                </button>
              </div>

              <footer className="flex items-center justify-between border-t border-border/60 px-2 py-1.5">
                <span className="text-[9px] text-text-muted">{definition?.outputType ?? 'any'}</span>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`运行到 ${node.title}`}
                    onClick={event => {
                      event.stopPropagation()
                      props.onRunNode(node.id)
                    }}
                    className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-accent"
                  >
                    <Play className="h-3 w-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`删除节点 ${node.title}`}
                    onClick={event => {
                      event.stopPropagation()
                      props.onRemoveNode(node.id)
                    }}
                    className="rounded p-1 text-text-muted hover:bg-error/10 hover:text-error"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              </footer>
            </article>
          )
        })}
      </div>
    </div>
  )
}
