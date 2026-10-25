import type { GenerationGateIssue } from '../generation/generation-node'
import { checkHeldItemAcquisition, readProjectHeldItems } from '../consistency/held-items'
import type { DomainAgentId } from './orchestrator'

/**
 * 当前可对领域候选直接做出的零 token 硬判决。
 *
 * 这里只复用已有确定性机制；需要 LLM 提取引用的认知/存亡审计不在这里冒充硬判决。
 */
export async function validateDomainCandidateCanon(input: {
  agentId: DomainAgentId
  projectId: number
  worldGroupId: number | null
  outlineNodeId?: number | null
  outputText: string
}): Promise<GenerationGateIssue[]> {
  if (input.agentId !== 'outline' && input.agentId !== 'prose') return []
  const heldItems = await readProjectHeldItems(
    input.projectId,
    null,
    input.worldGroupId,
    null,
    input.outlineNodeId ?? null,
  )
  return checkHeldItemAcquisition(
    input.outputText,
    heldItems,
    [],
    heldItems.map(item => item.heldByName),
  ).map((finding, index) => ({
    code: `held-item:${index}`,
    message: `${finding.reason} 引文：“${finding.quote}”`,
  }))
}
