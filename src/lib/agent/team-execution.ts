import type {
  GenerationGateIssue,
  GenerationGateResult,
  GenerationNode,
  GenerationNodeRunResult,
  PreparedGenerationNode,
} from '../generation/generation-node'
import { runGenerationNode } from '../generation/generation-node'
import type { ChatMessage } from '../types'
import {
  AgentTeamBudgetTracker,
  type AgentTeamCallReservation,
} from './team-budget'

function mergeIssues(
  gate: GenerationGateResult | null,
  extra: readonly GenerationGateIssue[],
): GenerationGateIssue[] {
  const issues = [...(gate?.issues ?? []), ...extra]
  return [...new Map(issues.map(issue => [`${issue.code}:${issue.message}`, issue])).values()]
}

function correctionMessage(issues: readonly GenerationGateIssue[]): ChatMessage {
  return {
    role: 'user',
    content: [
      '【确定性 Canon 校验打回】上一版不会进入候选，也没有写入项目。',
      ...issues.map(issue => `- ${issue.code}: ${issue.message}`),
      '只修复这些明确问题，继续遵守原任务、原输出格式和所有已提供的项目事实；不要解释。',
    ].join('\n'),
  }
}

async function runOnce<TInput, TOutput, TAdoption>(input: {
  node: GenerationNode<TInput, TOutput, TAdoption>
  prepared: PreparedGenerationNode
  messages: ChatMessage[]
  budget: AgentTeamBudgetTracker
  callLabel: string
  maxOutputTokens: number
  validate?: (output: TOutput) => Promise<GenerationGateIssue[]> | GenerationGateIssue[]
}): Promise<{
  result: GenerationNodeRunResult<TOutput, TAdoption>
  issues: GenerationGateIssue[]
}> {
  let reservation: AgentTeamCallReservation | null = null
  let settled = false
  try {
    reservation = input.budget.reserveCall({
      label: input.callLabel,
      messages: input.messages,
      maxOutputTokens: input.maxOutputTokens,
    })
    const result = await runGenerationNode(input.node, input.prepared, { messages: input.messages })
    input.budget.settleCall(reservation, result.output)
    settled = true
    const extra = result.gate?.status === 'blocked'
      ? []
      : await input.validate?.(result.output) ?? []
    return { result, issues: mergeIssues(result.gate, extra) }
  } catch (error) {
    if (reservation && !settled) input.budget.settleFailedCall(reservation)
    throw error
  }
}

/**
 * 一个领域调用只允许确定性 gate 触发一次受预算打回。
 * 网络错误、解析异常和普通模型错误不会在这里自动重试。
 */
export async function runBudgetedGenerationNode<TInput, TOutput, TAdoption>(input: {
  node: GenerationNode<TInput, TOutput, TAdoption>
  prepared: PreparedGenerationNode
  budget: AgentTeamBudgetTracker
  callLabel: string
  maxOutputTokens: number
  validate?: (output: TOutput) => Promise<GenerationGateIssue[]> | GenerationGateIssue[]
}): Promise<GenerationNodeRunResult<TOutput, TAdoption>> {
  const first = await runOnce({
    ...input,
    messages: input.prepared.messages,
  })
  if (first.issues.length === 0) return first.result

  input.budget.claimCanonRetry(first.issues)
  const retry = await runOnce({
    ...input,
    callLabel: `${input.callLabel}（Canon 打回）`,
    messages: [...input.prepared.messages, correctionMessage(first.issues)],
  })
  if (retry.issues.length > 0) {
    throw new Error(`确定性 Canon 校验打回后仍未通过：${retry.issues.map(issue => issue.message).join('；')}`)
  }
  return retry.result
}
