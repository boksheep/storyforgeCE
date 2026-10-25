import type { UseAIStreamReturn } from '../../hooks/useAIStream'
import type { GenerationNode } from '../generation/generation-node'
import type { AssembleContextResult } from '../registry/types'
import type { OutlineNode, Project } from '../types'
import type { RunOptions } from '../ai/adapters/outline-adapter'
import { log } from '../logging/logger'
import { buildOutlineGenerationPlan } from './generation-plan'
import {
  encodeGenerationOperation,
  outlineGenerationModuleKey,
  type OutlineGenerationRequest,
} from './generation-request'

type OutlineGenerationAI = Pick<UseAIStreamReturn, 'start'>

export class OutlineGenerationSkipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutlineGenerationSkipError'
  }
}

export function createOutlineGenerationNode(input: {
  request: OutlineGenerationRequest
  project: Project
  nodes: OutlineNode[]
  volumes: OutlineNode[]
  hint: string
  runOptions: RunOptions
  ai: OutlineGenerationAI
}): GenerationNode<AssembleContextResult, string> {
  const { request, project, nodes, volumes, hint, runOptions, ai } = input
  const category = outlineGenerationModuleKey(request)
  return {
    id: encodeGenerationOperation(request),
    kind: category,
    editableInput: true,
    assembleInput: assembled => {
      const plan = buildOutlineGenerationPlan({
        request,
        project,
        nodes,
        volumes,
        assembled,
        hint,
        options: runOptions,
      })
      if (plan.status === 'skip') throw new OutlineGenerationSkipError(plan.reason)
      return plan.messages
    },
    run: messages => {
      // 触发模型生成的那一刻：记录模式 + 操作 id，便于对照后续采纳是否正确落地。
      log.info('OutlineDomain', 'outline.generation.node.started', category === 'outline.volume' ? '开始生成卷纲' : '开始生成章纲', {
        projectId: project.id!,
        category,
        operation: encodeGenerationOperation(request),
      })
      return category === 'outline.volume'
        ? ai.start(messages, undefined, {
          category: 'outline.volume',
          projectId: project.id!,
        })
        : ai.start(messages, undefined, {
          category: 'outline.chapter',
          projectId: project.id!,
        })
    },
  }
}
