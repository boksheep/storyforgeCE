import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleStop,
  Database,
  History,
  Loader2,
  Plus,
  Save,
  Trash2,
  Workflow,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { nanoid } from 'nanoid'
import type { Project, NodeFlow, NodeFlowGraph, NodeFlowKind, NodeFlowNode, NodeRunRecord } from '../../lib/types'
import { EMPTY_NODE_FLOW_GRAPH, parseNodeFlowGraph } from '../../lib/types'
import {
  adoptNodeRunOutput,
  runNodeFlow,
  updateNodeRunOutput,
  type NodeExecutionResultMap,
  type NodeInputSnapshotMap,
} from '../../lib/node-flow/executor'
import {
  addNodeEdge,
  NODE_KIND_BY_ID,
  NODE_KIND_DEFINITIONS,
  removeNodeFromGraph,
  validateNodeFlowGraph,
} from '../../lib/node-flow/graph'
import { useNodeFlowStore } from '../../stores/node-flow'
import { useCharacterStore } from '../../stores/character'
import { useWorldviewStore } from '../../stores/worldview'
import { useDialog } from '../shared/Dialog'
import { useToast } from '../shared/Toast'
import NodeFlowCanvas from './NodeFlowCanvas'
import NodeInspector from './NodeInspector'

function defaultNode(kind: NodeFlowKind, index: number): NodeFlowNode {
  const definition = NODE_KIND_BY_ID.get(kind)!
  const base = {
    id: nanoid(),
    kind,
    title: definition.label,
    x: 100 + (index % 4) * 330,
    y: 90 + Math.floor(index / 4) * 250,
  }
  if (kind === 'input.text') return { ...base, config: { text: '' }, inputSlots: [] }
  if (kind === 'source.context') {
    return {
      ...base,
      config: {
        selectionMode: 'exact',
        ragEntryKeys: [],
        sourceKeys: [],
        inputBudgetTokens: 12_000,
        chapterId: 0,
        include: '',
        exclude: '',
      },
      inputSlots: [],
    }
  }
  const slot = {
    id: nanoid(),
    label: '创作材料',
    type: 'any' as const,
    required: kind !== 'transform.compose',
    priority: 100,
    maxTokens: 12_000,
  }
  if (kind === 'transform.compose') {
    return { ...base, config: { template: '' }, inputSlots: [{ ...slot, required: false }] }
  }
  if (kind === 'generation.freeform') {
    return {
      ...base,
      config: { instruction: '', systemPrompt: '', maxTokens: 6000 },
      inputSlots: [slot],
    }
  }
  if (kind === 'validation.required') {
    return {
      ...base,
      config: { requiredTerms: '', forbiddenTerms: '' },
      inputSlots: [{ ...slot, label: '待校验内容', type: 'candidate' }],
    }
  }
  return {
    ...base,
    config: { adoptTarget: 'none' },
    inputSlots: [{ ...slot, label: '最终内容' }],
  }
}

function parseRunData(run: NodeRunRecord | null): {
  snapshots: NodeInputSnapshotMap
  results: NodeExecutionResultMap
} {
  if (!run) return { snapshots: {}, results: {} }
  try {
    return {
      snapshots: JSON.parse(run.inputSnapshotsJson || '{}') as NodeInputSnapshotMap,
      results: JSON.parse(run.nodeResultsJson || '{}') as NodeExecutionResultMap,
    }
  } catch {
    return { snapshots: {}, results: {} }
  }
}

export default function NodeModeWorkspace(props: {
  project: Project
  worldGroupId: number | null
}) {
  const projectId = props.project.id!
  const toast = useToast()
  const dialog = useDialog()
  const flows = useNodeFlowStore(state => state.flows)
  const runs = useNodeFlowStore(state => state.runs)
  const loading = useNodeFlowStore(state => state.loading)
  const [selectedFlowId, setSelectedFlowId] = useState<number | null>(null)
  const [draft, setDraft] = useState<NodeFlow | null>(null)
  const [graph, setGraph] = useState<NodeFlowGraph>(structuredClone(EMPTY_NODE_FLOW_GRAPH))
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null)
  const [connectingFrom, setConnectingFrom] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [run, setRun] = useState<NodeRunRecord | null>(null)
  const [snapshots, setSnapshots] = useState<NodeInputSnapshotMap>({})
  const [results, setResults] = useState<NodeExecutionResultMap>({})
  const [showRunDetails, setShowRunDetails] = useState(true)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    void useNodeFlowStore.getState().load(projectId)
  }, [projectId])

  useEffect(() => {
    if (selectedFlowId == null && flows.length) setSelectedFlowId(flows[0].id!)
  }, [flows, selectedFlowId])

  useEffect(() => {
    if (selectedFlowId == null) {
      setDraft(null)
      setGraph(structuredClone(EMPTY_NODE_FLOW_GRAPH))
      return
    }
    let active = true
    void (async () => {
      const flow = flows.find(item => item.id === selectedFlowId)
      if (!flow || !active) return
      setDraft(flow)
      setGraph(parseNodeFlowGraph(flow.graphJson))
      setSelectedNodeId(null)
      setConnectingFrom(null)
      setDirty(false)
      await useNodeFlowStore.getState().loadRuns(projectId, selectedFlowId)
    })()
    return () => { active = false }
    // Deliberately reload only when the selected identity changes. Store refreshes after
    // autosave must not replace newer local edits with the just-returned row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFlowId, projectId])

  useEffect(() => {
    const latest = runs.find(item => item.flowId === selectedFlowId) ?? null
    setRun(latest)
    const parsed = parseRunData(latest)
    setSnapshots(parsed.snapshots)
    setResults(parsed.results)
  }, [runs, selectedFlowId])

  const save = async (notify = false): Promise<NodeFlow | null> => {
    if (!draft) return null
    setSaving(true)
    try {
      const next: NodeFlow = { ...draft, graphJson: JSON.stringify(graph), updatedAt: Date.now() }
      const id = await useNodeFlowStore.getState().saveFlow(next)
      const saved = { ...next, id }
      setDraft(saved)
      setDirty(false)
      if (notify) toast.success('节点图已保存。')
      return saved
    } catch (error) {
      toast.error(`保存失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    } finally {
      setSaving(false)
    }
  }

  useEffect(() => {
    if (!dirty || !draft) return
    const timer = window.setTimeout(() => { void save(false) }, 700)
    return () => window.clearTimeout(timer)
    // save is intentionally captured as the current draft snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draft?.name, draft?.description, graph])

  const changeGraph = (next: NodeFlowGraph) => {
    setGraph(next)
    setDirty(true)
  }

  const createFlow = async () => {
    const id = await useNodeFlowStore.getState().createFlow(projectId, props.worldGroupId)
    setSelectedFlowId(id)
  }

  const removeFlow = async () => {
    if (!draft?.id) return
    const confirmed = await dialog.confirm({
      title: `删除节点图“${draft.name}”？`,
      message: '节点图及其所有运行输入、输出记录将一并删除，且不可恢复。',
      confirmText: '删除',
      tone: 'danger',
    })
    if (!confirmed) return
    await useNodeFlowStore.getState().removeFlow(draft.id)
    setSelectedFlowId(null)
    setDraft(null)
    setRun(null)
    setSnapshots({})
    setResults({})
    toast.success('节点图及运行记录已删除。')
  }

  const runGraph = async (targetNodeId?: string) => {
    if (abortRef.current) return
    const issues = validateNodeFlowGraph(graph)
    if (issues.length) {
      toast.error(issues[0].message)
      return
    }
    const saved = await save(false)
    if (!saved?.id) return
    const controller = new AbortController()
    abortRef.current = controller
    setShowRunDetails(true)
    try {
      const outcome = await runNodeFlow({
        flow: saved,
        targetNodeId,
        signal: controller.signal,
        onUpdate: (nextRun, nextSnapshots, nextResults) => {
          setRun(nextRun)
          setSnapshots({ ...nextSnapshots })
          setResults({ ...nextResults })
        },
      })
      if (outcome.run.status === 'completed') toast.success('节点运行完成，实际输入与输出已保存。')
      else if (outcome.run.status === 'cancelled') toast.info('节点运行已停止，已完成部分仍已保存。')
      else toast.error('节点运行失败，请查看下方执行记录。')
      await useNodeFlowStore.getState().loadRuns(projectId, saved.id)
    } finally {
      abortRef.current = null
    }
  }

  const selectedNode = graph.nodes.find(node => node.id === selectedNodeId) ?? null
  const selectedSnapshot = selectedNodeId ? snapshots[selectedNodeId] : undefined
  const selectedResult = selectedNodeId ? results[selectedNodeId] : undefined
  const runningNodeId = useMemo(() => (
    Object.keys(snapshots).find(nodeId => !results[nodeId]) ?? null
  ), [snapshots, results])

  const finishConnection = (targetNodeId: string, targetSlotId: string) => {
    if (!connectingFrom) {
      toast.info('请先点击上游节点右侧的输出端口。')
      return
    }
    const edgeId = nanoid()
    const next = addNodeEdge(graph, {
      id: edgeId,
      sourceNodeId: connectingFrom,
      targetNodeId,
      targetSlotId,
    })
    const hardIssue = validateNodeFlowGraph(next).find(issue => (
      issue.edgeId === edgeId || issue.code === 'cycle'
    ))
    if (hardIssue) {
      toast.error(hardIssue.message)
      return
    }
    changeGraph(next)
    setConnectingFrom(null)
  }

  if (loading && !flows.length) {
    return <div className="flex h-full items-center justify-center text-sm text-text-muted"><Loader2 className="mr-2 h-4 w-4 animate-spin" />加载节点图…</div>
  }

  if (!draft) {
    return (
      <div className="flex h-full min-h-[720px] items-center justify-center bg-[radial-gradient(circle,var(--border-subtle)_1px,transparent_1px)] [background-size:28px_28px]">
        <div className="max-w-lg rounded-2xl border border-border bg-bg-surface p-8 text-center shadow-xl">
          <Workflow className="mx-auto mb-4 h-10 w-10 text-accent" />
          <h2 className="text-lg font-semibold text-text-primary">独立节点模式</h2>
          <p className="mt-2 text-sm leading-6 text-text-secondary">
            自由添加项目元素、作者输入、整理、生成、校验与输出节点。每条路径的真实输入和输出都会保存在本地，只有你确认后才写入项目 Canon。
          </p>
          <button type="button" onClick={() => void createFlow()} className="mt-5 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover">
            创建第一张节点图
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-[720px] flex-col overflow-hidden bg-bg-base">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-bg-surface px-3">
        <Workflow className="h-4 w-4 text-accent" />
        <input
          aria-label="节点图名称"
          value={draft.name}
          onChange={event => {
            setDraft({ ...draft, name: event.target.value })
            setDirty(true)
          }}
          className="w-56 rounded border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-text-primary hover:border-border focus:border-accent focus:outline-none"
        />
        <span className="text-[10px] text-text-muted">
          {saving ? '保存中…' : dirty ? '待保存' : '已保存到本地'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button type="button" title="缩小" onClick={() => changeGraph({ ...graph, viewport: { ...graph.viewport, zoom: Math.max(0.5, graph.viewport.zoom - 0.1) } })} className="rounded p-1.5 text-text-muted hover:bg-bg-hover"><ZoomOut className="h-4 w-4" /></button>
          <span className="w-10 text-center text-[10px] text-text-muted">{Math.round(graph.viewport.zoom * 100)}%</span>
          <button type="button" title="放大" onClick={() => changeGraph({ ...graph, viewport: { ...graph.viewport, zoom: Math.min(1.5, graph.viewport.zoom + 0.1) } })} className="rounded p-1.5 text-text-muted hover:bg-bg-hover"><ZoomIn className="h-4 w-4" /></button>
          <button type="button" onClick={() => void save(true)} className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"><Save className="h-3.5 w-3.5" />保存</button>
          {abortRef.current ? (
            <button type="button" onClick={() => abortRef.current?.abort()} className="flex items-center gap-1 rounded bg-error/10 px-3 py-1.5 text-xs text-error"><CircleStop className="h-3.5 w-3.5" />停止</button>
          ) : (
            <button type="button" onClick={() => void runGraph()} className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover"><Workflow className="h-3.5 w-3.5" />运行全部</button>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-52 shrink-0 overflow-y-auto border-r border-border bg-bg-surface p-3">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">节点图</p>
            <button type="button" aria-label="新建节点图" onClick={() => void createFlow()} className="rounded p-1 text-accent hover:bg-accent/10"><Plus className="h-3.5 w-3.5" /></button>
          </div>
          <div className="space-y-1">
            {flows.map(flow => (
              <button
                key={flow.id}
                type="button"
                onClick={() => setSelectedFlowId(flow.id!)}
                className={`w-full truncate rounded px-2 py-1.5 text-left text-[11px] ${flow.id === selectedFlowId ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:bg-bg-hover'}`}
              >
                {flow.name}
              </button>
            ))}
          </div>
          <button type="button" onClick={() => void removeFlow()} className="mt-2 flex w-full items-center gap-1 rounded px-2 py-1.5 text-[10px] text-text-muted hover:bg-error/10 hover:text-error"><Trash2 className="h-3 w-3" />删除当前节点图</button>

          <div className="mb-2 mt-6 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-text-muted">添加节点</p>
            <Plus className="h-3 w-3 text-text-muted" />
          </div>
          <div className="space-y-1.5">
            {NODE_KIND_DEFINITIONS.map(definition => (
              <button
                key={definition.kind}
                type="button"
                onClick={() => {
                  const node = defaultNode(definition.kind, graph.nodes.length)
                  changeGraph({ ...graph, nodes: [...graph.nodes, node] })
                  setSelectedNodeId(node.id)
                }}
                className="w-full rounded border border-border bg-bg-base p-2 text-left hover:border-accent hover:bg-bg-hover"
              >
                <span className="block text-[11px] font-medium text-text-primary">{definition.label}</span>
                <span className="mt-0.5 block text-[9px] leading-3 text-text-muted">{definition.description}</span>
              </button>
            ))}
          </div>
        </aside>

        <section className="min-w-0 flex-1">
          <NodeFlowCanvas
            graph={graph}
            selectedNodeId={selectedNodeId}
            connectingFrom={connectingFrom}
            results={results}
            runningNodeId={runningNodeId}
            onSelectNode={setSelectedNodeId}
            onMoveNode={(nodeId, x, y) => changeGraph({
              ...graph,
              nodes: graph.nodes.map(node => node.id === nodeId ? { ...node, x, y } : node),
            })}
            onStartConnection={nodeId => setConnectingFrom(current => current === nodeId ? null : nodeId)}
            onFinishConnection={finishConnection}
            onRemoveNode={nodeId => {
              changeGraph(removeNodeFromGraph(graph, nodeId))
              if (selectedNodeId === nodeId) setSelectedNodeId(null)
            }}
            onRunNode={nodeId => void runGraph(nodeId)}
          />
        </section>

        <div className="w-80 shrink-0">
          <NodeInspector
            projectId={projectId}
            worldGroupId={props.worldGroupId}
            graph={graph}
            node={selectedNode}
            onGraphChange={changeGraph}
          />
        </div>
      </div>

      <section className="shrink-0 border-t border-border bg-bg-surface">
        <button type="button" onClick={() => setShowRunDetails(value => !value)} className="flex h-9 w-full items-center gap-2 px-4 text-left text-[11px] text-text-secondary hover:bg-bg-hover">
          <History className="h-3.5 w-3.5" />
          执行记录
          <span className="text-text-muted">{run ? `${run.status} · ${new Date(run.startedAt).toLocaleString()}` : '尚未运行'}</span>
          <span className="ml-auto">{showRunDetails ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}</span>
        </button>
        {showRunDetails && (
          <div className="grid max-h-64 grid-cols-2 gap-0 overflow-y-auto border-t border-border">
            <div className="border-r border-border p-3">
              <div className="mb-2 flex items-center gap-1 text-[10px] font-semibold text-text-secondary"><Database className="h-3 w-3" />实际输入快照</div>
              {!selectedSnapshot ? (
                <p className="text-[10px] text-text-muted">选择一个已运行节点查看实际输入。</p>
              ) : (
                <div className="space-y-2 text-[10px] text-text-secondary">
                  <p>估算输入：{selectedSnapshot.totalTokens.toLocaleString()} tokens</p>
                  {selectedSnapshot.inputs.map(item => (
                    <details key={`${item.sourceNodeId}:${item.targetSlotId}`} className="rounded border border-border bg-bg-base p-2">
                      <summary className="cursor-pointer">{item.targetSlotLabel} ← {item.sourceTitle} · {item.tokens} tokens</summary>
                      <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap text-[9px] text-text-muted">{item.content}</pre>
                    </details>
                  ))}
                  {selectedSnapshot.sourceEvidence && (
                    <div className="rounded border border-border bg-bg-base p-2">
                      <p>已纳入：{selectedSnapshot.sourceEvidence.included.join('、') || '无'}</p>
                      <p>省略：{selectedSnapshot.sourceEvidence.omitted.join('、') || '无'}</p>
                      <p>裁剪：{selectedSnapshot.sourceEvidence.trimmed.join('、') || '无'}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[10px] font-semibold text-text-secondary">节点输出</span>
                {selectedResult?.adoptedAt && (
                  <span className="flex items-center gap-1 text-[9px] text-success"><Check className="h-3 w-3" />已采纳 {new Date(selectedResult.adoptedAt).toLocaleString()}</span>
                )}
              </div>
              {!selectedResult ? (
                <p className="text-[10px] text-text-muted">选择一个已运行节点查看输出或错误。</p>
              ) : (
                <>
                  {selectedResult.error && <p className="mb-2 rounded bg-error/10 p-2 text-[10px] text-error">{selectedResult.error}</p>}
                  <textarea
                    aria-label="节点输出内容"
                    value={selectedResult.output}
                    onChange={event => setResults({
                      ...results,
                      [selectedResult.nodeId]: { ...selectedResult, output: event.target.value, adoptedAt: undefined, adoptionTarget: undefined },
                    })}
                    onBlur={() => {
                      if (run?.id) void updateNodeRunOutput({
                        runId: run.id,
                        nodeId: selectedResult.nodeId,
                        output: results[selectedResult.nodeId].output,
                      }).catch(error => toast.error(error instanceof Error ? error.message : String(error)))
                    }}
                    className="h-28 w-full resize-y rounded border border-border bg-bg-base p-2 text-[10px] leading-4 text-text-primary outline-none focus:border-accent"
                  />
                  {selectedNode?.kind === 'output.preview' && selectedNode.config.adoptTarget !== 'none' && (
                    <button
                      type="button"
                      onClick={() => {
                        if (!run?.id) return
                        void adoptNodeRunOutput({
                          runId: run.id,
                          nodeId: selectedResult.nodeId,
                          output: results[selectedResult.nodeId].output,
                        }).then(async outcome => {
                          setResults(outcome.results)
                          await Promise.all([
                            useWorldviewStore.getState().loadAll(projectId, props.worldGroupId),
                            useCharacterStore.getState().loadAll(projectId),
                          ])
                          toast.success(outcome.message)
                        }).catch(error => toast.error(error instanceof Error ? error.message : String(error)))
                      }}
                      className="mt-2 rounded bg-accent px-3 py-1.5 text-[10px] font-medium text-white hover:bg-accent-hover"
                    >
                      确认采纳到项目
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
