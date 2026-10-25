import { useEffect, useState } from 'react'
import { NATIVE_AGENT_LIMIT_BOUNDS, resolveNativeAgentLimits } from '../../lib/agent/native-agent-limits'
import type { MasterAgentExecutionMode } from '../../lib/types'

export interface MasterAgentExecutionModeSectionProps {
  value: MasterAgentExecutionMode
  onChange: (mode: MasterAgentExecutionMode) => void
  maxSteps: number
  maxToolCalls: number
  onLimitsChange: (limits: { maxSteps?: number; maxToolCalls?: number }) => void
}

export default function MasterAgentExecutionModeSection({
  value, onChange, maxSteps, maxToolCalls, onLimitsChange,
}: MasterAgentExecutionModeSectionProps) {
  const [stepsDraft, setStepsDraft] = useState(String(maxSteps))
  const [toolsDraft, setToolsDraft] = useState(String(maxToolCalls))
  useEffect(() => setStepsDraft(String(maxSteps)), [maxSteps])
  useEffect(() => setToolsDraft(String(maxToolCalls)), [maxToolCalls])

  const saveSteps = () => {
    const next = resolveNativeAgentLimits({ masterAgentMaxSteps: stepsDraft.trim() || NaN }).maxSteps
    setStepsDraft(String(next))
    if (next !== maxSteps) onLimitsChange({ maxSteps: next })
  }
  const saveTools = () => {
    const next = resolveNativeAgentLimits({ masterAgentMaxToolCalls: toolsDraft.trim() || NaN }).maxToolCalls
    setToolsDraft(String(next))
    if (next !== maxToolCalls) onLimitsChange({ maxToolCalls: next })
  }

  return (
    <div className="rounded-lg border border-border bg-bg-surface p-3">
      <label className="block text-sm text-text-secondary mb-1.5" htmlFor="master-agent-execution-mode">
        主 Agent 执行模式
      </label>
      <select
        id="master-agent-execution-mode"
        value={value}
        onChange={event => onChange(event.target.value as MasterAgentExecutionMode)}
        aria-label="主 Agent 执行模式"
        className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent transition-colors"
      >
        <option value="route-first">现有路由优先（默认）</option>
        <option value="agent-first">主 Agent 优先</option>
      </select>
      <p className="mt-1.5 text-xs text-text-muted">
        主 Agent 优先会多步读取项目证据，自主回答、澄清或生成多项修改候选；作者确认后才会写入。专门领域任务继续使用现有采纳入口，模型失败时不会切回关键词路由。
      </p>
      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <label htmlFor="master-agent-max-steps" className="block text-sm text-text-secondary mb-1.5">最大模型步骤</label>
          <input id="master-agent-max-steps" aria-label="最大模型步骤" type="number" step="1"
            min={NATIVE_AGENT_LIMIT_BOUNDS.maxSteps.min} max={NATIVE_AGENT_LIMIT_BOUNDS.maxSteps.max}
            value={stepsDraft} onChange={event => setStepsDraft(event.target.value)} onBlur={saveSteps}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
            className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
        <div>
          <label htmlFor="master-agent-max-tools" className="block text-sm text-text-secondary mb-1.5">最大工具调用</label>
          <input id="master-agent-max-tools" aria-label="最大工具调用" type="number" step="1"
            min={NATIVE_AGENT_LIMIT_BOUNDS.maxToolCalls.min} max={NATIVE_AGENT_LIMIT_BOUNDS.maxToolCalls.max}
            value={toolsDraft} onChange={event => setToolsDraft(event.target.value)} onBlur={saveTools}
            onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur() }}
            className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent"
          />
        </div>
      </div>
      <p className="mt-1.5 text-xs text-text-muted">
        每次模型回复计一步，协议修正也计入；一次回复可触发多个只读工具调用。范围分别为 2–20 步、1–40 次。达到上限会停止本轮并保留安全断点；token 预算和协议错误次数仍分别生效。
      </p>
    </div>
  )
}
