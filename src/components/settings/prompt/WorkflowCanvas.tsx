import { useMemo, useRef, useState } from 'react'
import {
  CircleDot,
  Link2,
  Maximize2,
  Plus,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type {
  PromptWorkflow,
  PromptWorkflowGraph,
  PromptWorkflowGraphEdge,
} from '../../../lib/types/workflow'
import {
  WORKFLOW_NODE_HEIGHT,
  WORKFLOW_NODE_WIDTH,
  workflowGraphFor,
} from '../../../lib/workflow/graph'

interface Props {
  workflow: PromptWorkflow
  selectedStepId: string | null
  onSelectStep: (stepId: string) => void
  onAddStep: () => void
  onMoveNode: (stepId: string, x: number, y: number) => void
  onAddEdge: (sourceStepId: string, targetStepId: string) => void
  onRemoveEdge: (edgeId: string) => void
  onRemoveStep: (stepId: string) => void
  onViewportChange: (viewport: NonNullable<PromptWorkflowGraph['viewport']>) => void
}

interface DragState {
  stepId: string
  clientX: number
  clientY: number
  x: number
  y: number
}

const STATUS_CLASS = {
  confirm: 'border-warning/60',
  normal: 'border-border',
}

function edgePath(edge: PromptWorkflowGraphEdge, graph: PromptWorkflowGraph): string | null {
  const source = graph.nodes.find(node => node.stepId === edge.sourceStepId)
  const target = graph.nodes.find(node => node.stepId === edge.targetStepId)
  if (!source || !target) return null
  const x1 = source.x + WORKFLOW_NODE_WIDTH
  const y1 = source.y + WORKFLOW_NODE_HEIGHT / 2
  const x2 = target.x
  const y2 = target.y + WORKFLOW_NODE_HEIGHT / 2
  const bend = Math.max(72, Math.abs(x2 - x1) * 0.45)
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`
}

export default function WorkflowCanvas({
  workflow,
  selectedStepId,
  onSelectStep,
  onAddStep,
  onMoveNode,
  onAddEdge,
  onRemoveEdge,
  onRemoveStep,
  onViewportChange,
}: Props) {
  const graph = useMemo(() => workflowGraphFor(workflow), [workflow])
  const stepById = useMemo(
    () => new Map(workflow.steps.map(step => [step.stepId, step])),
    [workflow.steps],
  )
  const [connectionSource, setConnectionSource] = useState<string | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const viewport = graph.viewport ?? { x: 0, y: 0, zoom: 1 }
  const zoom = Math.min(1.5, Math.max(0.6, viewport.zoom || 1))
  const maxX = Math.max(1200, ...graph.nodes.map(node => node.x + WORKFLOW_NODE_WIDTH + 160))
  const maxY = Math.max(720, ...graph.nodes.map(node => node.y + WORKFLOW_NODE_HEIGHT + 160))

  const updateZoom = (next: number) => {
    onViewportChange({ ...viewport, zoom: Math.min(1.5, Math.max(0.6, next)) })
  }

  const handleInputPort = (targetStepId: string) => {
    if (!connectionSource || connectionSource === targetStepId) return
    onAddEdge(connectionSource, targetStepId)
    setConnectionSource(null)
  }

  return (
    <div className="flex h-full min-h-[620px] flex-col rounded-xl border border-border bg-bg-base">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-bg-surface px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onAddStep}
            className="flex items-center gap-1.5 rounded bg-accent px-3 py-1.5 text-xs text-white hover:bg-accent-hover"
          >
            <Plus className="h-3.5 w-3.5" /> 添加节点
          </button>
          <span className="text-xs text-text-muted">
            {connectionSource
              ? `正在连接「${stepById.get(connectionSource)?.label ?? connectionSource}」：请选择目标节点左侧输入端口`
              : '拖动节点调整布局；点击右侧输出端口，再点目标输入端口建立连线'}
          </span>
          {connectionSource && (
            <button
              type="button"
              onClick={() => setConnectionSource(null)}
              className="rounded px-2 py-1 text-xs text-warning hover:bg-warning/10"
            >
              取消连线
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label="缩小画布"
            onClick={() => updateZoom(zoom - 0.1)}
            className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <span className="w-12 text-center text-[11px] text-text-secondary">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            aria-label="放大画布"
            onClick={() => updateZoom(zoom + 0.1)}
            className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            aria-label="重置画布缩放"
            onClick={() => onViewportChange({ x: 0, y: 0, zoom: 1 })}
            className="rounded p-1.5 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="relative flex-1 overflow-auto" data-testid="workflow-canvas-scroll">
        <div
          className="relative origin-top-left"
          data-testid="workflow-canvas"
          style={{
            width: maxX,
            height: maxY,
            transform: `scale(${zoom})`,
            backgroundImage:
              'radial-gradient(circle, color-mix(in srgb, var(--color-border, #64748b) 45%, transparent) 1px, transparent 1px)',
            backgroundSize: '22px 22px',
          }}
        >
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
            aria-hidden="true"
          >
            {graph.edges.map(edge => {
              const path = edgePath(edge, graph)
              if (!path) return null
              return (
                <g key={edge.edgeId}>
                  <path
                    d={path}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3"
                    className="text-accent/70"
                  />
                </g>
              )
            })}
          </svg>

          {graph.nodes.map(node => {
            const step = stepById.get(node.stepId)
            if (!step) return null
            const selected = selectedStepId === step.stepId
            const incoming = graph.edges.filter(edge => edge.targetStepId === step.stepId)
            const outgoing = graph.edges.filter(edge => edge.sourceStepId === step.stepId)
            return (
              <div
                key={step.stepId}
                data-testid={`workflow-node-${step.stepId}`}
                className={`absolute rounded-xl border-2 bg-bg-surface shadow-lg ${
                  selected ? 'border-accent ring-2 ring-accent/20' : STATUS_CLASS[step.userConfirmRequired ? 'confirm' : 'normal']
                }`}
                style={{
                  left: node.x,
                  top: node.y,
                  width: WORKFLOW_NODE_WIDTH,
                  height: WORKFLOW_NODE_HEIGHT,
                }}
                onClick={() => onSelectStep(step.stepId)}
              >
                <button
                  type="button"
                  aria-label={`连接到 ${step.label}`}
                  title="输入端口"
                  onClick={event => {
                    event.stopPropagation()
                    handleInputPort(step.stepId)
                  }}
                  className={`absolute -left-3 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-bg-base ${
                    connectionSource && connectionSource !== step.stepId
                      ? 'border-accent text-accent'
                      : 'border-border text-text-muted'
                  }`}
                >
                  <CircleDot className="h-3 w-3" />
                </button>

                <button
                  type="button"
                  aria-label={`从 ${step.label} 输出`}
                  title="输出端口"
                  onClick={event => {
                    event.stopPropagation()
                    setConnectionSource(step.stepId)
                  }}
                  className={`absolute -right-3 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border-2 bg-bg-base ${
                    connectionSource === step.stepId
                      ? 'border-accent bg-accent text-white'
                      : 'border-border text-text-muted'
                  }`}
                >
                  <Link2 className="h-3 w-3" />
                </button>

                <div
                  className="flex cursor-grab items-center justify-between gap-2 rounded-t-[10px] border-b border-border bg-bg-elevated px-3 py-2 active:cursor-grabbing"
                  onPointerDown={event => {
                    if (event.button !== 0) return
                    event.currentTarget.setPointerCapture(event.pointerId)
                    dragRef.current = {
                      stepId: step.stepId,
                      clientX: event.clientX,
                      clientY: event.clientY,
                      x: node.x,
                      y: node.y,
                    }
                    onSelectStep(step.stepId)
                  }}
                  onPointerMove={event => {
                    const drag = dragRef.current
                    if (!drag || drag.stepId !== step.stepId) return
                    const x = Math.max(12, drag.x + (event.clientX - drag.clientX) / zoom)
                    const y = Math.max(12, drag.y + (event.clientY - drag.clientY) / zoom)
                    onMoveNode(step.stepId, Math.round(x), Math.round(y))
                  }}
                  onPointerUp={event => {
                    if (dragRef.current?.stepId === step.stepId) {
                      dragRef.current = null
                      event.currentTarget.releasePointerCapture(event.pointerId)
                    }
                  }}
                >
                  <span className="truncate text-xs font-semibold text-text-primary">{step.label}</span>
                  <button
                    type="button"
                    aria-label={`删除节点 ${step.label}`}
                    onPointerDown={event => event.stopPropagation()}
                    onClick={event => {
                      event.stopPropagation()
                      onRemoveStep(step.stepId)
                    }}
                    className="rounded p-1 text-text-muted hover:bg-error/10 hover:text-error"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>

                <div className="space-y-2 px-3 py-2">
                  <div className="rounded bg-bg-base px-2 py-1 text-[10px] text-text-secondary">
                    {step.promptModuleKey}
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-text-muted">
                    <span>输入 {incoming.length}</span>
                    <span>输出 {outgoing.length}</span>
                    <span>{step.userConfirmRequired ? '需确认' : '自动推进'}</span>
                  </div>
                  {step.saveTarget && (
                    <div className="truncate text-[10px] text-success">
                      可确认写入：{step.saveTarget.type}
                    </div>
                  )}
                </div>
              </div>
            )
          })}

          {graph.edges.length > 0 && (
            <div className="absolute bottom-4 left-4 max-w-sm rounded-lg border border-border bg-bg-surface/95 p-2 shadow">
              <p className="mb-1 text-[10px] font-medium text-text-secondary">连线</p>
              <div className="max-h-28 space-y-1 overflow-y-auto">
                {graph.edges.map(edge => (
                  <div key={edge.edgeId} className="flex items-center gap-2 text-[10px] text-text-muted">
                    <span className="min-w-0 flex-1 truncate">
                      {stepById.get(edge.sourceStepId)?.label ?? edge.sourceStepId}
                      {' → '}
                      {stepById.get(edge.targetStepId)?.label ?? edge.targetStepId}
                      .{edge.targetVariable}
                    </span>
                    <button
                      type="button"
                      aria-label={`删除连线 ${edge.edgeId}`}
                      onClick={() => onRemoveEdge(edge.edgeId)}
                      className="rounded p-0.5 hover:bg-error/10 hover:text-error"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
