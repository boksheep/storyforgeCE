import type { UseAIStreamReturn } from '../../hooks/useAIStream'
import type { ChatMessage } from '../types'
import type { GenerationNode } from './generation-node'

/**
 * 既有 PromptWorkflow 步骤到 GenerationNode 的兼容适配器。
 * category 仍来自已登记的 promptModuleKey；写回继续由 WorkflowRunner 的
 * 作者确认按钮触发，不在节点 run 阶段自动执行。
 */
export function createWorkflowGenerationNode(input: {
  workflowId: number | string
  stepId: string
  category: string
  projectId?: number
  ai: Pick<UseAIStreamReturn, 'start'>
}): GenerationNode<ChatMessage[], string> {
  const { workflowId, stepId, category, projectId, ai } = input
  return {
    id: `workflow.${workflowId}.${stepId}`,
    kind: category,
    editableInput: true,
    assembleInput: messages => messages.map(message => ({ ...message })),
    run: messages => ai.start(messages, undefined, {
      category: category,
      projectId,
    }),
  }
}
