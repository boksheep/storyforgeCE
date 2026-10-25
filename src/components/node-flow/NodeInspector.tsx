import { Plus, Trash2 } from 'lucide-react'
import { nanoid } from 'nanoid'
import { CONTEXT_SOURCES } from '../../lib/registry/context-sources'
import type { NodeFlowGraph, NodeFlowNode, NodeValueType } from '../../lib/types'
import { removeSlotFromGraph } from '../../lib/node-flow/graph'
import RagEntrySelector from '../retrieval/RagEntrySelector'

const VALUE_TYPES: NodeValueType[] = ['any', 'text', 'context', 'json', 'candidate']

function TextArea(props: {
  label: string
  value: string
  rows?: number
  onChange: (value: string) => void
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] font-medium text-text-secondary">{props.label}</span>
      <textarea
        value={props.value}
        rows={props.rows ?? 4}
        onChange={event => props.onChange(event.target.value)}
        className="w-full resize-y rounded border border-border bg-bg-base px-2 py-1.5 text-[11px] leading-4 text-text-primary outline-none focus:border-accent"
      />
    </label>
  )
}

export default function NodeInspector(props: {
  projectId: number
  worldGroupId: number | null
  graph: NodeFlowGraph
  node: NodeFlowNode | null
  onGraphChange: (graph: NodeFlowGraph) => void
}) {
  const { node } = props
  if (!node) {
    return (
      <aside className="flex h-full items-center justify-center border-l border-border bg-bg-surface p-6 text-center text-xs text-text-muted">
        选择节点后，可在这里编辑来源、字段范围、动态输入槽、创作指令和输出目标。
      </aside>
    )
  }

  const updateNode = (patch: Partial<NodeFlowNode>) => {
    props.onGraphChange({
      ...props.graph,
      nodes: props.graph.nodes.map(item => item.id === node.id ? { ...item, ...patch } : item),
    })
  }
  const updateConfig = (key: string, value: unknown) => {
    updateNode({ config: { ...node.config, [key]: value } })
  }
  const sourceKeys = Array.isArray(node.config.sourceKeys)
    ? node.config.sourceKeys.filter((value): value is string => typeof value === 'string')
    : []
  const ragEntryKeys = Array.isArray(node.config.ragEntryKeys)
    ? node.config.ragEntryKeys.filter((value): value is string => typeof value === 'string')
    : []
  const selectionMode = node.config.selectionMode === 'registered'
    || (node.config.selectionMode == null && sourceKeys.length > 0)
    ? 'registered'
    : 'exact'

  return (
    <aside className="h-full overflow-y-auto border-l border-border bg-bg-surface p-4">
      <div className="space-y-4">
        <label className="block">
          <span className="mb-1 block text-[10px] font-medium text-text-secondary">节点名称</span>
          <input
            value={node.title}
            onChange={event => updateNode({ title: event.target.value })}
            className="w-full rounded border border-border bg-bg-base px-2 py-1.5 text-xs text-text-primary outline-none focus:border-accent"
          />
        </label>

        {node.kind === 'input.text' && (
          <TextArea
            label="作者输入"
            value={String(node.config.text ?? '')}
            rows={10}
            onChange={value => updateConfig('text', value)}
          />
        )}

        {node.kind === 'source.context' && (
          <>
            <div className="grid grid-cols-2 rounded border border-border bg-bg-base p-0.5 text-[10px]">
              <button
                type="button"
                onClick={() => updateConfig('selectionMode', 'exact')}
                className={`rounded px-2 py-1 ${selectionMode === 'exact' ? 'bg-accent text-white' : 'text-text-muted hover:bg-bg-hover'}`}
              >
                精确资料
              </button>
              <button
                type="button"
                onClick={() => updateConfig('selectionMode', 'registered')}
                className={`rounded px-2 py-1 ${selectionMode === 'registered' ? 'bg-accent text-white' : 'text-text-muted hover:bg-bg-hover'}`}
              >
                注册来源
              </button>
            </div>
            {selectionMode === 'exact' ? (
              <RagEntrySelector
                projectId={props.projectId}
                worldGroupId={props.worldGroupId}
                selectedKeys={ragEntryKeys}
                onChange={keys => updateConfig('ragEntryKeys', keys)}
              />
            ) : <section>
              <div className="mb-2">
                <p className="text-[10px] font-medium text-text-secondary">项目元素来源</p>
                <p className="text-[9px] leading-4 text-text-muted">
                  可同时接入多个登记来源；只选本次创作真正需要的材料。
                </p>
              </div>
              <div className="max-h-64 space-y-1 overflow-y-auto rounded border border-border bg-bg-base p-2">
                {CONTEXT_SOURCES.filter(source => source.key !== 'ragSelection').map(source => (
                  <label key={source.key} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-bg-hover">
                    <input
                      type="checkbox"
                      checked={sourceKeys.includes(source.key)}
                      onChange={() => {
                        updateConfig(
                          'sourceKeys',
                          sourceKeys.includes(source.key)
                            ? sourceKeys.filter(key => key !== source.key)
                            : [...sourceKeys, source.key],
                        )
                      }}
                      className="mt-0.5 accent-[var(--color-accent)]"
                    />
                    <span>
                      <span className="block text-[10px] text-text-secondary">{source.label}</span>
                      <span className="block text-[9px] text-text-muted">{source.key} · {source.scope}</span>
                    </span>
                  </label>
                ))}
              </div>
            </section>}
            <div className={selectionMode === 'registered' ? 'grid grid-cols-2 gap-2' : ''}>
              {selectionMode === 'registered' && (
                <label>
                  <span className="mb-1 block text-[10px] text-text-secondary">章节 ID</span>
                  <input
                    type="number"
                    min={0}
                    value={Number(node.config.chapterId ?? 0)}
                    onChange={event => updateConfig('chapterId', Number(event.target.value) || 0)}
                    className="w-full rounded border border-border bg-bg-base px-2 py-1 text-[11px]"
                  />
                </label>
              )}
              <label>
                <span className="mb-1 block text-[10px] text-text-secondary">Token 上限</span>
                <input
                  type="number"
                  min={100}
                  value={Number(node.config.inputBudgetTokens ?? 12000)}
                  onChange={event => updateConfig('inputBudgetTokens', Number(event.target.value) || 12000)}
                  className="w-full rounded border border-border bg-bg-base px-2 py-1 text-[11px]"
                />
              </label>
            </div>
            {selectionMode === 'registered' && (
              <>
                <TextArea
                  label="只保留包含这些关键词的行（逗号或换行）"
                  value={String(node.config.include ?? '')}
                  rows={3}
                  onChange={value => updateConfig('include', value)}
                />
                <TextArea
                  label="排除包含这些关键词的行"
                  value={String(node.config.exclude ?? '')}
                  rows={2}
                  onChange={value => updateConfig('exclude', value)}
                />
              </>
            )}
          </>
        )}

        {node.kind === 'transform.compose' && (
          <TextArea
            label="组合模板（可用 {{输入槽名称}}；留空则按优先级自动分段）"
            value={String(node.config.template ?? '')}
            rows={9}
            onChange={value => updateConfig('template', value)}
          />
        )}

        {node.kind === 'generation.freeform' && (
          <>
            <TextArea
              label="创作指令"
              value={String(node.config.instruction ?? '')}
              rows={7}
              onChange={value => updateConfig('instruction', value)}
            />
            <TextArea
              label="节点系统约束"
              value={String(node.config.systemPrompt ?? '')}
              rows={5}
              onChange={value => updateConfig('systemPrompt', value)}
            />
            <label className="block">
              <span className="mb-1 block text-[10px] text-text-secondary">最大输出 Tokens</span>
              <input
                type="number"
                min={100}
                value={Number(node.config.maxTokens ?? 6000)}
                onChange={event => updateConfig('maxTokens', Number(event.target.value) || 6000)}
                className="w-full rounded border border-border bg-bg-base px-2 py-1.5 text-[11px]"
              />
            </label>
          </>
        )}

        {node.kind === 'validation.required' && (
          <>
            <TextArea
              label="必含内容（逗号或换行）"
              value={String(node.config.requiredTerms ?? '')}
              rows={3}
              onChange={value => updateConfig('requiredTerms', value)}
            />
            <TextArea
              label="禁用内容"
              value={String(node.config.forbiddenTerms ?? '')}
              rows={3}
              onChange={value => updateConfig('forbiddenTerms', value)}
            />
          </>
        )}

        {node.kind === 'output.preview' && (
          <label className="block">
            <span className="mb-1 block text-[10px] text-text-secondary">确认写入目标</span>
            <select
              value={String(node.config.adoptTarget ?? 'none')}
              onChange={event => updateConfig('adoptTarget', event.target.value)}
              className="w-full rounded border border-border bg-bg-base px-2 py-1.5 text-[11px]"
            >
              <option value="none">仅保存为节点输出</option>
              <option value="world-origin">世界观 · 世界来源</option>
              <option value="create-character">新增角色（输出须为角色 JSON）</option>
            </select>
          </label>
        )}

        {node.inputSlots.length > 0 || node.kind !== 'input.text' && node.kind !== 'source.context' ? (
          <section className="border-t border-border/70 pt-4">
            <div className="mb-2 flex items-center justify-between">
              <div>
                <p className="text-[10px] font-medium text-text-secondary">动态输入槽</p>
                <p className="text-[9px] text-text-muted">每条路径可独立命名、定优先级和预算。</p>
              </div>
              <button
                type="button"
                onClick={() => updateNode({
                  inputSlots: [...node.inputSlots, {
                    id: nanoid(),
                    label: `输入 ${node.inputSlots.length + 1}`,
                    type: 'any',
                    required: false,
                    priority: 50,
                    maxTokens: 6000,
                  }],
                })}
                className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-accent hover:bg-accent/10"
              >
                <Plus className="h-3 w-3" /> 添加
              </button>
            </div>
            <div className="space-y-2">
              {node.inputSlots.map(slot => (
                <div key={slot.id} className="rounded border border-border bg-bg-base p-2">
                  <div className="flex gap-1">
                    <input
                      value={slot.label}
                      onChange={event => updateNode({
                        inputSlots: node.inputSlots.map(item => item.id === slot.id
                          ? { ...item, label: event.target.value }
                          : item),
                      })}
                      className="min-w-0 flex-1 rounded border border-border bg-bg-surface px-1.5 py-1 text-[10px]"
                    />
                    <button
                      type="button"
                      aria-label={`删除输入槽 ${slot.label}`}
                      onClick={() => props.onGraphChange(removeSlotFromGraph(props.graph, node.id, slot.id))}
                      className="rounded p-1 text-text-muted hover:text-error"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                  <div className="mt-1 grid grid-cols-3 gap-1">
                    <select
                      value={slot.type}
                      onChange={event => updateNode({
                        inputSlots: node.inputSlots.map(item => item.id === slot.id
                          ? { ...item, type: event.target.value as NodeValueType }
                          : item),
                      })}
                      className="rounded border border-border bg-bg-surface px-1 py-1 text-[9px]"
                    >
                      {VALUE_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
                    </select>
                    <input
                      type="number"
                      title="优先级"
                      value={slot.priority}
                      onChange={event => updateNode({
                        inputSlots: node.inputSlots.map(item => item.id === slot.id
                          ? { ...item, priority: Number(event.target.value) || 0 }
                          : item),
                      })}
                      className="rounded border border-border bg-bg-surface px-1 py-1 text-[9px]"
                    />
                    <input
                      type="number"
                      title="Token 上限"
                      value={slot.maxTokens ?? 0}
                      onChange={event => updateNode({
                        inputSlots: node.inputSlots.map(item => item.id === slot.id
                          ? { ...item, maxTokens: Number(event.target.value) || undefined }
                          : item),
                      })}
                      className="rounded border border-border bg-bg-surface px-1 py-1 text-[9px]"
                    />
                  </div>
                  <label className="mt-1 flex items-center gap-1 text-[9px] text-text-muted">
                    <input
                      type="checkbox"
                      checked={slot.required}
                      onChange={event => updateNode({
                        inputSlots: node.inputSlots.map(item => item.id === slot.id
                          ? { ...item, required: event.target.checked }
                          : item),
                      })}
                    />
                    运行时必需
                  </label>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="border-t border-border/70 pt-3">
          <p className="text-[10px] font-medium text-text-secondary">当前连线</p>
          <div className="mt-1 space-y-1">
            {props.graph.edges.filter(edge => edge.targetNodeId === node.id).map(edge => {
              const source = props.graph.nodes.find(item => item.id === edge.sourceNodeId)
              const slot = node.inputSlots.find(item => item.id === edge.targetSlotId)
              return (
                <div key={edge.id} className="flex items-center justify-between gap-2 rounded bg-bg-base px-2 py-1 text-[9px]">
                  <span className="truncate">{source?.title ?? edge.sourceNodeId} → {slot?.label ?? edge.targetSlotId}</span>
                  <button
                    type="button"
                    aria-label="删除连线"
                    onClick={() => props.onGraphChange({
                      ...props.graph,
                      edges: props.graph.edges.filter(item => item.id !== edge.id),
                    })}
                    className="text-text-muted hover:text-error"
                  >
                    ×
                  </button>
                </div>
              )
            })}
            {!props.graph.edges.some(edge => edge.targetNodeId === node.id) && (
              <p className="text-[9px] text-text-muted">暂无输入连线。</p>
            )}
          </div>
        </section>
      </div>
    </aside>
  )
}
