export const NODE_FLOW_KINDS = [
  'input.text',
  'source.context',
  'transform.compose',
  'generation.freeform',
  'validation.required',
  'output.preview',
] as const

export type NodeFlowKind = typeof NODE_FLOW_KINDS[number]
export type NodeValueType = 'text' | 'context' | 'json' | 'candidate' | 'any'

export interface NodeFlowInputSlot {
  id: string
  label: string
  type: NodeValueType
  required: boolean
  priority: number
  maxTokens?: number
  instruction?: string
}

export interface NodeFlowNode {
  id: string
  kind: NodeFlowKind
  title: string
  x: number
  y: number
  config: Record<string, unknown>
  inputSlots: NodeFlowInputSlot[]
}

export interface NodeFlowEdge {
  id: string
  sourceNodeId: string
  targetNodeId: string
  targetSlotId: string
}

export interface NodeFlowGraph {
  version: 1
  nodes: NodeFlowNode[]
  edges: NodeFlowEdge[]
  viewport: { x: number; y: number; zoom: number }
}

export interface NodeFlow {
  id?: number
  projectId: number
  worldGroupId?: number | null
  name: string
  description: string
  graphJson: string
  createdAt: number
  updatedAt: number
}

export type NodeRunStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled'

export interface NodeRunRecord {
  id?: number
  projectId: number
  flowId: number
  status: NodeRunStatus
  /** 冻结每个节点的实际入参、来源与 token 估算，保证“输入可见”。 */
  inputSnapshotsJson: string
  /** 每个节点的输出、错误与 gate，保证刷新后“输出可见”。 */
  nodeResultsJson: string
  startedAt: number
  updatedAt: number
  completedAt?: number | null
}

export const EMPTY_NODE_FLOW_GRAPH: NodeFlowGraph = {
  version: 1,
  nodes: [],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
}

export function parseNodeFlowGraph(value: string | null | undefined): NodeFlowGraph {
  if (!value?.trim()) return structuredClone(EMPTY_NODE_FLOW_GRAPH)
  const parsed = JSON.parse(value) as Partial<NodeFlowGraph>
  if (parsed.version !== 1 || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) {
    throw new Error('节点图不是受支持的 version=1 结构。')
  }
  return {
    version: 1,
    nodes: parsed.nodes as NodeFlowNode[],
    edges: parsed.edges as NodeFlowEdge[],
    viewport: parsed.viewport ?? { x: 0, y: 0, zoom: 1 },
  }
}
