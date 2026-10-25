import type { AIConfigPreset } from '../../lib/types'
import {
  AGENT_ROLE_TASK_KINDS,
  GENERAL_AI_TASK_KINDS,
  type AITaskKind,
  type AITaskRoutes,
} from '../../lib/ai/task-routing'
import {
  AGENT_CONTEXT_TASK_KINDS,
  type AgentContextProfile,
  type AgentContextProfiles,
  type AgentContextTaskKind,
} from '../../lib/agent/context-policy'

import { TASK_ROUTE_META } from '../../lib/ai/task-routing'

// 任务种类标签已上移到 src/lib/ai/task-routing.ts（生成中的状态提示与日志共用同一份）。

interface Props {
  presets: AIConfigPreset[]
  routes: AITaskRoutes
  contextProfiles: AgentContextProfiles
  onSetRoute: (taskKind: AITaskKind, presetId: string | null) => void
  onSetContextProfile: (taskKind: AgentContextTaskKind, profile: AgentContextProfile) => void
}

const CONTEXT_PROFILE_META: Record<AgentContextProfile, { label: string; description: string }> = {
  lean: { label: '精简', description: '约 45% 登记源预算，优先节省输入' },
  balanced: { label: '均衡（推荐）', description: '约 72% 登记源预算，兼顾质量与成本' },
  full: { label: '完整', description: '沿用登记源完整预算，适合高风险长上下文任务' },
}


function isContextTaskKind(taskKind: AITaskKind): taskKind is AgentContextTaskKind {
  return AGENT_CONTEXT_TASK_KINDS.includes(taskKind as AgentContextTaskKind)
}

export default function AITaskRoutingSection({
  presets,
  routes,
  contextProfiles,
  onSetRoute,
  onSetContextProfile,
}: Props) {
  const renderRoutes = (taskKinds: readonly AITaskKind[]) => (
    <div className="grid gap-2 sm:grid-cols-2">
      {taskKinds.map(taskKind => {
        const selectedPreset = presets.find(preset => preset.id === routes[taskKind])
        const routeMeta = TASK_ROUTE_META[taskKind]
        const contextTask = isContextTaskKind(taskKind)
        return (
          <label key={taskKind} className="block rounded border border-border bg-bg-base p-2.5">
            <span className="block text-xs font-medium text-text-primary">{routeMeta.label}</span>
            <span className="mb-2 block min-h-8 text-[11px] leading-4 text-text-muted">{routeMeta.description}</span>
            <select value={selectedPreset?.id ?? ''}
              onChange={event => onSetRoute(taskKind, event.target.value || null)}
              aria-label={`${routeMeta.label}模型预设`}
              className="w-full rounded border border-border bg-bg-surface px-2 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none">
              <option value="">使用当前全局模型</option>
              {presets.map(preset => (
                <option key={preset.id} value={preset.id}>{preset.name} · {preset.config.provider}/{preset.config.model}</option>
              ))}
            </select>
            {contextTask && (
              <>
                <span className="mb-1 mt-2 block text-[10px] text-text-muted">上下文输入档位</span>
                <select
                  value={contextProfiles[taskKind]}
                  onChange={event => onSetContextProfile(taskKind, event.target.value as AgentContextProfile)}
                  aria-label={`${routeMeta.label}上下文输入档位`}
                  className="w-full rounded border border-border bg-bg-surface px-2 py-1.5 text-xs text-text-primary focus:border-accent focus:outline-none"
                >
                  {(Object.entries(CONTEXT_PROFILE_META) as Array<[AgentContextProfile, typeof CONTEXT_PROFILE_META[AgentContextProfile]]>)
                    .map(([profile, meta]) => (
                      <option key={profile} value={profile}>{meta.label} · {meta.description}</option>
                    ))}
                </select>
              </>
            )}
          </label>
        )
      })}
    </div>
  )

  return (
    <div className="mb-4 border-b border-border/50 pb-4">
      <div className="mb-2">
        <h4 className="text-sm font-medium text-text-secondary">任务模型路由</h4>
        <p className="mt-1 text-[11px] text-text-muted">
          按任务自动使用已保存预设；未绑定、预设被删除或专用预设缺少 API Key 时，回退到当前全局模型。云端预设会接收对应任务的提示词与上下文。
        </p>
      </div>
      {renderRoutes(GENERAL_AI_TASK_KINDS)}
      <div className="mb-2 mt-4">
        <h5 className="text-xs font-medium text-text-secondary">主 Agent 团队角色</h5>
        <p className="mt-1 text-[11px] text-text-muted">
          只影响主 Agent 幕后执行；手工面板仍使用上方四类路由。未绑定的角色沿用当前全局模型。
          五个领域还可独立收窄登记源预算；“完整”保持原上下文上限。
        </p>
      </div>

      {renderRoutes(AGENT_ROLE_TASK_KINDS)}
      {presets.length === 0 && (
        <p className="mt-2 text-[11px] text-amber-400">先保存至少一个配置预设，才能给任务绑定专用模型。</p>
      )}
    </div>
  )
}
