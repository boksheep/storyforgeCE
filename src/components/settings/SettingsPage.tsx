import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Button } from '../shared/Button'
import AIConfigPanel from './AIConfigPanel'
import ContextBudgetSection from './ContextBudgetSection'
import { useAIConfigStore } from '../../stores/ai-config'
import {
  DEFAULT_STEP_HISTORY_LIMIT,
  MAX_STEP_HISTORY_LIMIT,
  MIN_STEP_HISTORY_LIMIT,
  getStepHistoryLimit,
  setStepHistoryLimit,
} from '../../lib/history/step-recorder'
import { resetWelcomeGuide } from '../guide/WelcomeGuide'
import NS0EvalPanel from './NS0EvalPanel'

/**
 * 设置页（Phase 4 之后）：
 * 「提示词管理」已升级为侧边栏一级菜单，所以这里只剩 AI 配置。
 * 保留这个外壳是为了未来可能再加其他「设置」类目（快捷键、语言、备份策略等）。
 */
export default function SettingsPage() {
  const [guideReset, setGuideReset] = useState(false)
  const [stepLimitDraft, setStepLimitDraft] = useState(() => String(getStepHistoryLimit()))
  const contextBudgetPolicy = useAIConfigStore(state => state.contextBudgetPolicy)
  const setContextTruncationEnabled = useAIConfigStore(state => state.setContextTruncationEnabled)
  const setContextSourceBudget = useAIConfigStore(state => state.setContextSourceBudget)
  const resetContextBudgetPolicy = useAIConfigStore(state => state.resetContextBudgetPolicy)
  const agentTeamBudgetProfile = useAIConfigStore(state => state.agentTeamBudgetProfile)
  const agentTeamBudgetTokens = useAIConfigStore(state => state.agentTeamBudgetTokens)
  const contextBudgetPresets = useAIConfigStore(state => state.contextBudgetPresets)
  const setAgentTeamBudgetTokens = useAIConfigStore(state => state.setAgentTeamBudgetTokens)
  const applyContextBudgetPreset = useAIConfigStore(state => state.applyContextBudgetPreset)
  const saveContextBudgetPreset = useAIConfigStore(state => state.saveContextBudgetPreset)
  const deleteContextBudgetPreset = useAIConfigStore(state => state.deleteContextBudgetPreset)
  const mapVisionOutputBudget = useAIConfigStore(state => state.mapVisionOutputBudget)
  const setMapVisionOutputBudget = useAIConfigStore(state => state.setMapVisionOutputBudget)
  const resetMapVisionOutputBudget = useAIConfigStore(state => state.resetMapVisionOutputBudget)

  return (
    <div className="h-full overflow-auto p-6">
      <AIConfigPanel />

      {/* BUDGET-1: 上下文预算（每源预算 / 字数上限 / 关闭自动截断） */}
      <ContextBudgetSection
        truncationEnabled={contextBudgetPolicy.truncationEnabled}
        overrides={contextBudgetPolicy.sources}
        onSetTruncationEnabled={setContextTruncationEnabled}
        onSetSourceBudget={setContextSourceBudget}
        onReset={() => { resetContextBudgetPolicy(); resetMapVisionOutputBudget() }}
         teamBudgetProfile={agentTeamBudgetProfile}
         teamBudgetTokens={agentTeamBudgetTokens}
         contextBudgetPresets={contextBudgetPresets}
         onSetTeamBudgetTokens={setAgentTeamBudgetTokens}
         onApplyPreset={applyContextBudgetPreset}
         onSavePreset={saveContextBudgetPreset}
         onDeletePreset={deleteContextBudgetPreset}
         mapVisionOutputBudget={mapVisionOutputBudget}
         onSetMapVisionOutputBudget={setMapVisionOutputBudget}
         onResetMapVisionOutputBudget={resetMapVisionOutputBudget}
      />

      {import.meta.env.DEV && <NS0EvalPanel />}

      {/* STEP-1: 步骤记录器（撤回/重做）上限 */}
      <div className="max-w-2xl mt-6 p-4 bg-bg-surface border border-border rounded-xl">
        <h3 className="text-sm font-semibold text-text-primary mb-1">步骤记录（撤回 / 重做）</h3>
        <p className="mb-3 text-xs text-text-muted">
          主 Agent 采纳、卷纲生成、正文 AI 应用都会记一步，可在工作区顶栏用「上一步 / 下一步」回退。
          历史只保存在本机，不随导出或导入迁移；超出上限时从最旧的步骤开始丢弃。
        </p>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-text-secondary">最大步骤数</p>
            <p className="text-xs text-text-muted">
              默认 {DEFAULT_STEP_HISTORY_LIMIT} 步；范围 {MIN_STEP_HISTORY_LIMIT}–{MAX_STEP_HISTORY_LIMIT}
            </p>
          </div>
          <input
            type="number"
            min={MIN_STEP_HISTORY_LIMIT}
            max={MAX_STEP_HISTORY_LIMIT}
            step={1}
            value={stepLimitDraft}
            aria-label="最大步骤数"
            onChange={event => {
              setStepLimitDraft(event.target.value)
              const parsed = Number(event.target.value)
              if (Number.isFinite(parsed)) setStepHistoryLimit(parsed)
            }}
            onBlur={() => setStepLimitDraft(String(getStepHistoryLimit()))}
            className="w-24 shrink-0 rounded-lg border border-border bg-bg-base px-3 py-1.5 text-sm text-text-primary focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {/* 其他设置 */}
      <div className="max-w-2xl mt-6 p-4 bg-bg-surface border border-border rounded-xl">
        <h3 className="text-sm font-semibold text-text-primary mb-3">其他</h3>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-text-secondary">新手引导</p>
            <p className="text-xs text-text-muted">重新显示首次使用时的新手引导教程</p>
          </div>
          <Button
            variant="secondary"
            size="md"
            onClick={() => { resetWelcomeGuide(); setGuideReset(true) }}
            disabled={guideReset}
            icon={<BookOpen />}
          >
            {guideReset ? '已重置（刷新生效）' : '重新引导'}
          </Button>
        </div>
      </div>
    </div>
  )
}
