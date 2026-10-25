import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import type { PromptWorkflow } from '../lib/types/workflow'
import { SYSTEM_WORKFLOW_SEEDS } from '../lib/ai/workflow-seeds'
import { validateWorkflowGraph } from '../lib/workflow/graph'

interface WorkflowStore {
  workflows: PromptWorkflow[]
  loaded: boolean

  init(): Promise<void>
  reload(): Promise<void>
  save(w: PromptWorkflow): Promise<number>
  remove(id: number): Promise<void>
  clone(id: number, newName?: string): Promise<number>
}

export const useWorkflowStore = create<WorkflowStore>((set, get) => ({
  workflows: [],
  loaded: false,

  init: async () => {
    if (get().loaded) return
    const existing = await db.promptWorkflows.toArray()
    const now = Date.now()

    if (existing.length === 0) {
      const rows: PromptWorkflow[] = SYSTEM_WORKFLOW_SEEDS.map(s => ({
        ...s, createdAt: now, updatedAt: now,
      }))
      await db.promptWorkflows.bulkAdd(rows)
    } else {
      // 用 name 作 unique key 刷新 system 工作流
      const existingMap = new Map(
        existing.filter(w => w.scope === 'system').map(w => [w.name, w]),
      )
      for (const seed of SYSTEM_WORKFLOW_SEEDS) {
        const old = existingMap.get(seed.name)
        if (!old) {
          await db.promptWorkflows.add({ ...seed, createdAt: now, updatedAt: now })
        } else {
          await db.promptWorkflows.update(old.id!, {
            description: seed.description,
            steps: seed.steps,
            isDefault: seed.isDefault,
            genres: seed.genres,
            updatedAt: now,
          })
        }
      }
    }

    const all = await db.promptWorkflows.toArray()
    set({ workflows: all, loaded: true })
    log.info('WorkflowStore', 'workflow.init.completed', '工作流种子已同步', { previousCount: existing.length, currentCount: all.length, seedCount: SYSTEM_WORKFLOW_SEEDS.length })
  },

  reload: async () => {
    const all = await db.promptWorkflows.toArray()
    set({ workflows: all })
  },

  save: async (w) => {
    const graphIssues = validateWorkflowGraph(w)
    if (graphIssues.length) {
      log.warn('WorkflowStore', 'workflow.save.invalid', '工作流图校验失败', { workflowId: w.id, issueCount: graphIssues.length, scope: w.scope })
      throw new Error(`工作流图无效：${graphIssues.map(issue => issue.message).join('；')}`)
    }
    const now = Date.now()
    const row: PromptWorkflow = { ...w, updatedAt: now, createdAt: w.createdAt || now }
    const id = await db.promptWorkflows.put(row)
    log.info('WorkflowStore', 'workflow.saved', '工作流已保存', { workflowId: id, scope: w.scope, stepCount: w.steps.length })
    await get().reload()
    return id as number
  },

  remove: async (id) => {
    await db.promptWorkflows.delete(id)
    log.info('WorkflowStore', 'workflow.deleted', '工作流删除已执行', { workflowId: id })
    await get().reload()
  },

  clone: async (id, newName) => {
    const src = await db.promptWorkflows.get(id)
    if (!src) {
      log.warn('WorkflowStore', 'workflow.clone.missing', '工作流复制源不存在', { workflowId: id })
      throw new Error(`workflow ${id} not found`)
    }
    const now = Date.now()
    const { id: _drop, ...rest } = src
    void _drop
    const cloneRow: PromptWorkflow = {
      ...rest,
      scope: 'user',
      name: newName || `${src.name} (副本)`,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    }
    const newId = await db.promptWorkflows.add(cloneRow)
    log.info('WorkflowStore', 'workflow.cloned', '工作流已复制', { sourceWorkflowId: id, workflowId: newId, stepCount: cloneRow.steps.length })
    await get().reload()
    return newId as number
  },
}))
