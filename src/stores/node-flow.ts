import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { NodeFlow, NodeRunRecord } from '../lib/types'
import { EMPTY_NODE_FLOW_GRAPH, parseNodeFlowGraph } from '../lib/types'
import { log } from '../lib/logging/logger'

interface NodeFlowStore {
  projectId: number | null
  flows: NodeFlow[]
  runs: NodeRunRecord[]
  loading: boolean
  load(projectId: number): Promise<void>
  createFlow(projectId: number, worldGroupId: number | null): Promise<number>
  saveFlow(flow: NodeFlow): Promise<number>
  removeFlow(flowId: number): Promise<void>
  loadRuns(projectId: number, flowId?: number): Promise<void>
}

export const useNodeFlowStore = create<NodeFlowStore>((set, get) => ({
  projectId: null,
  flows: [],
  runs: [],
  loading: false,

  load: async projectId => {
    set({ loading: true })
    const flows = await db.nodeFlows.where('projectId').equals(projectId).toArray()
    flows.sort((left, right) => right.updatedAt - left.updatedAt)
    set({ projectId, flows, loading: false })
  },

  createFlow: async (projectId, worldGroupId) => {
    const now = Date.now()
    const row: NodeFlow = {
      projectId,
      worldGroupId,
      name: '未命名节点图',
      description: '',
      graphJson: JSON.stringify(EMPTY_NODE_FLOW_GRAPH),
      createdAt: now,
      updatedAt: now,
    }
    const id = await db.nodeFlows.add(row) as number
    await get().load(projectId)
    return id
  },

  saveFlow: async flow => {
    // 草稿阶段允许缺少连线、必需输入或暂时存在循环；运行前会进行完整图校验。
    // 这里只验证 JSON 外壳，避免作者尚未完成的节点图无法被持久化。
    parseNodeFlowGraph(flow.graphJson)
    const now = Date.now()
    const id = await db.nodeFlows.put({ ...flow, updatedAt: now }) as number
    await get().load(flow.projectId)
    return id
  },

  removeFlow: async flowId => {
    const flow = await db.nodeFlows.get(flowId)
    if (!flow) return
    const runCount = await db.nodeRuns.where('flowId').equals(flowId).count()
    await db.transaction('rw', db.nodeFlows, db.nodeRuns, async () => {
      await db.nodeRuns.where('flowId').equals(flowId).delete()
      await db.nodeFlows.delete(flowId)
    })
    await get().load(flow.projectId)
    // 删除节点图会连带清空它的运行历史：不可逆级联删除，记录规模。
    log.warn(
      'NodeFlowStore',
      'node.flow.deleted',
      `已删除节点图 #${flowId}，连带清除运行记录 ${runCount} 条`,
      { projectId: flow.projectId, flowId, runCount, count: 1 },
    )
  },

  loadRuns: async (projectId, flowId) => {
    const rows = flowId == null
      ? await db.nodeRuns.where('projectId').equals(projectId).toArray()
      : await db.nodeRuns.where('flowId').equals(flowId).toArray()
    rows.sort((left, right) => right.startedAt - left.startedAt)
    set({ runs: rows })
  },
}))
