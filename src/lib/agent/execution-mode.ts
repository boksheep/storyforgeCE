import type { AIConfig, MasterAgentExecutionMode } from '../types'

export const DEFAULT_MASTER_AGENT_EXECUTION_MODE: MasterAgentExecutionMode = 'route-first'

export function resolveMasterAgentExecutionMode(config: Pick<AIConfig, 'masterAgentExecutionMode'>): MasterAgentExecutionMode {
  return config.masterAgentExecutionMode === 'agent-first' ? 'agent-first' : DEFAULT_MASTER_AGENT_EXECUTION_MODE
}

export function masterAgentExecutionModeLabel(mode: MasterAgentExecutionMode): string {
  return mode === 'agent-first' ? '主 Agent 优先' : '现有路由优先'
}
