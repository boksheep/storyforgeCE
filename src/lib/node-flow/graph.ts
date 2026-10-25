import type {
  NodeFlowEdge,
  NodeFlowGraph,
  NodeFlowNode,
  NodeValueType,
} from '../types'

export interface NodeFlowIssue {
  code: string
  message: string
  nodeId?: string
  edgeId?: string
}

export interface NodeKindDefinition {
  kind: NodeFlowNode['kind']
  label: string
  description: string
  outputType: NodeValueType
  acceptsInput: boolean
}

export const NODE_KIND_DEFINITIONS: readonly NodeKindDefinition[] = [
  {
    kind: 'input.text',
    label: '自由文本',
    description: '作者要求、临时设定、禁写事项或任意文字。',
    outputType: 'text',
    acceptsInput: false,
  },
  {
    kind: 'source.context',
    label: '项目元素',
    description: '从登记上下文中选择设定、角色、前文、物品或事实。',
    outputType: 'context',
    acceptsInput: false,
  },
  {
    kind: 'transform.compose',
    label: '整理与合并',
    description: '按动态输入槽、优先级与模板组合上游内容。',
    outputType: 'text',
    acceptsInput: true,
  },
  {
    kind: 'generation.freeform',
    label: '自由创作',
    description: '用作者自定指令和任意上游内容生成文本或 JSON。',
    outputType: 'candidate',
    acceptsInput: true,
  },
  {
    kind: 'validation.required',
    label: '内容校验',
    description: '检查必含词、禁用词和空输出；不调用模型。',
    outputType: 'candidate',
    acceptsInput: true,
  },
  {
    kind: 'output.preview',
    label: '内容输出',
    description: '保存、查看、编辑并按明确目标确认写入项目。',
    outputType: 'candidate',
    acceptsInput: true,
  },
] as const

export const NODE_KIND_BY_ID = new Map(
  NODE_KIND_DEFINITIONS.map(definition => [definition.kind, definition] as const),
)

function canConnect(source: NodeValueType, target: NodeValueType): boolean {
  return source === 'any' || target === 'any' || source === target
    || (source === 'context' && target === 'text')
    || (source === 'candidate' && target === 'text')
    || (source === 'text' && target === 'candidate')
    || (source === 'context' && target === 'candidate')
}

export function validateNodeFlowGraph(graph: NodeFlowGraph): NodeFlowIssue[] {
  const issues: NodeFlowIssue[] = []
  if (graph.version !== 1) issues.push({ code: 'version', message: '节点图版本不受支持。' })
  const nodes = new Map<string, NodeFlowNode>()
  for (const node of graph.nodes) {
    if (!node.id.trim()) {
      issues.push({ code: 'empty-node-id', message: '节点 ID 不能为空。' })
      continue
    }
    if (nodes.has(node.id)) {
      issues.push({ code: 'duplicate-node', nodeId: node.id, message: `节点 ID 重复：${node.id}` })
    }
    if (!NODE_KIND_BY_ID.has(node.kind)) {
      issues.push({ code: 'unknown-kind', nodeId: node.id, message: `未知节点类型：${node.kind}` })
    }
    if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) {
      issues.push({ code: 'position', nodeId: node.id, message: `节点坐标无效：${node.title}` })
    }
    const slotIds = new Set<string>()
    for (const slot of node.inputSlots) {
      if (!slot.id.trim() || slotIds.has(slot.id)) {
        issues.push({ code: 'slot', nodeId: node.id, message: `节点“${node.title}”包含无效或重复输入槽。` })
      }
      slotIds.add(slot.id)
    }
    nodes.set(node.id, node)
  }

  const edgeIds = new Set<string>()
  const edgeKeys = new Set<string>()
  const adjacency = new Map(graph.nodes.map(node => [node.id, [] as string[]]))
  for (const edge of graph.edges) {
    if (!edge.id.trim() || edgeIds.has(edge.id)) {
      issues.push({ code: 'edge-id', edgeId: edge.id, message: '连线 ID 为空或重复。' })
    }
    edgeIds.add(edge.id)
    const source = nodes.get(edge.sourceNodeId)
    const target = nodes.get(edge.targetNodeId)
    if (!source || !target) {
      issues.push({ code: 'dangling-edge', edgeId: edge.id, message: '连线引用了不存在的节点。' })
      continue
    }
    if (source.id === target.id) {
      issues.push({ code: 'self-edge', edgeId: edge.id, message: '节点不能连接自己。' })
      continue
    }
    const slot = target.inputSlots.find(item => item.id === edge.targetSlotId)
    if (!slot) {
      issues.push({
        code: 'unknown-slot',
        edgeId: edge.id,
        message: `连线目标槽不存在：${target.title}.${edge.targetSlotId}`,
      })
      continue
    }
    const outputType = NODE_KIND_BY_ID.get(source.kind)?.outputType ?? 'any'
    if (!canConnect(outputType, slot.type)) {
      issues.push({
        code: 'type-mismatch',
        edgeId: edge.id,
        message: `${source.title}(${outputType}) 不能接入 ${target.title}.${slot.label}(${slot.type})。`,
      })
    }
    const key = `${source.id}\u0000${target.id}\u0000${slot.id}`
    if (edgeKeys.has(key)) {
      issues.push({ code: 'duplicate-edge', edgeId: edge.id, message: '存在重复连线。' })
    }
    edgeKeys.add(key)
    adjacency.get(source.id)?.push(target.id)
  }

  const state = new Map<string, 0 | 1 | 2>()
  let cycle = false
  const visit = (nodeId: string) => {
    if (cycle) return
    const current = state.get(nodeId) ?? 0
    if (current === 1) {
      cycle = true
      return
    }
    if (current === 2) return
    state.set(nodeId, 1)
    for (const target of adjacency.get(nodeId) ?? []) visit(target)
    state.set(nodeId, 2)
  }
  graph.nodes.forEach(node => visit(node.id))
  if (cycle) issues.push({ code: 'cycle', message: '节点图包含循环，已阻止运行。' })

  for (const node of graph.nodes) {
    for (const slot of node.inputSlots.filter(item => item.required)) {
      if (!graph.edges.some(edge => edge.targetNodeId === node.id && edge.targetSlotId === slot.id)) {
        issues.push({
          code: 'required-slot',
          nodeId: node.id,
          message: `节点“${node.title}”缺少必需输入“${slot.label}”。`,
        })
      }
    }
  }
  return issues
}

export function topologicalNodeOrder(
  graph: NodeFlowGraph,
  targetNodeId?: string | null,
): NodeFlowNode[] {
  const issues = validateNodeFlowGraph(graph)
  if (issues.length) throw new Error(issues.map(issue => issue.message).join('；'))

  let included = new Set(graph.nodes.map(node => node.id))
  if (targetNodeId) {
    if (!included.has(targetNodeId)) throw new Error('要运行的节点不存在。')
    const incoming = new Map<string, string[]>()
    graph.edges.forEach(edge => {
      const values = incoming.get(edge.targetNodeId) ?? []
      values.push(edge.sourceNodeId)
      incoming.set(edge.targetNodeId, values)
    })
    included = new Set<string>()
    const collect = (nodeId: string) => {
      if (included.has(nodeId)) return
      included.add(nodeId)
      for (const source of incoming.get(nodeId) ?? []) collect(source)
    }
    collect(targetNodeId)
  }

  const indegree = new Map<string, number>()
  const outgoing = new Map<string, string[]>()
  graph.nodes.filter(node => included.has(node.id)).forEach(node => {
    indegree.set(node.id, 0)
    outgoing.set(node.id, [])
  })
  graph.edges.filter(edge => included.has(edge.sourceNodeId) && included.has(edge.targetNodeId)).forEach(edge => {
    indegree.set(edge.targetNodeId, (indegree.get(edge.targetNodeId) ?? 0) + 1)
    outgoing.get(edge.sourceNodeId)?.push(edge.targetNodeId)
  })
  const queue = graph.nodes.filter(node => included.has(node.id) && indegree.get(node.id) === 0)
  const ordered: NodeFlowNode[] = []
  while (queue.length) {
    const node = queue.shift()!
    ordered.push(node)
    for (const target of outgoing.get(node.id) ?? []) {
      const value = (indegree.get(target) ?? 0) - 1
      indegree.set(target, value)
      if (value === 0) queue.push(graph.nodes.find(node => node.id === target)!)
    }
  }
  return ordered
}

export function removeNodeFromGraph(graph: NodeFlowGraph, nodeId: string): NodeFlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.filter(node => node.id !== nodeId),
    edges: graph.edges.filter(edge => edge.sourceNodeId !== nodeId && edge.targetNodeId !== nodeId),
  }
}

export function removeSlotFromGraph(
  graph: NodeFlowGraph,
  nodeId: string,
  slotId: string,
): NodeFlowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map(node => node.id === nodeId
      ? { ...node, inputSlots: node.inputSlots.filter(slot => slot.id !== slotId) }
      : node),
    edges: graph.edges.filter(edge => !(edge.targetNodeId === nodeId && edge.targetSlotId === slotId)),
  }
}

export function addNodeEdge(graph: NodeFlowGraph, edge: NodeFlowEdge): NodeFlowGraph {
  return { ...graph, edges: [...graph.edges, edge] }
}
