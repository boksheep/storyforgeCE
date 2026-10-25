import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { Eye, EyeOff, CheckCircle, RotateCcw, RefreshCw } from 'lucide-react'
import { useAIConfigStore, type TestResult } from '../../stores/ai-config'
import EmbeddingConfigCard from './EmbeddingConfigCard'
import type { AIProvider } from '../../lib/types'
import { isAIConfigReady } from '../../lib/ai/config-readiness'
import { getLogs, subscribeLogs, clearLogs } from '../../lib/ai/logger'
import { log } from '../../lib/logging/logger'
import { applyStoryForgeTheme, resolveStoryForgeTheme, type StoryForgeTheme } from '../../lib/theme'
import { useDialog } from '../shared/Dialog'
import { Button } from '../shared/Button'
import { parseContextWindowInput } from '../../lib/ai/context-window-input'
import { fetchOpenAIModelCatalog } from '../../lib/ai/model-list'
import { resolveModelWindow } from '../../lib/ai/context-budget'
import { normalizeOpenAIBaseUrl } from '../../lib/ai/openai-endpoint'
import { AI_PROXY_ENDPOINTS } from '../../lib/ai/proxy-endpoints'
import AIConfigPresetSection from './AIConfigPresetSection'
import AITaskRoutingSection from './AITaskRoutingSection'
import AIConnectionLogPanel from './AIConnectionLogPanel'
import AIConnectionTestSection from './AIConnectionTestSection'
import ThemeSelector from './ThemeSelector'
import MasterAgentExecutionModeSection from './MasterAgentExecutionModeSection'
import { DEFAULT_NATIVE_AGENT_LIMITS } from '../../lib/agent/native-agent-limits'

export const PROVIDER_OPTIONS: { value: AIProvider; label: string; cors: boolean; hint: string }[] = [
  { value: 'deepseek', label: 'DeepSeek', cors: false, hint: '获取 Key: platform.deepseek.com → API Keys（需点击下方「切换到本地代理」）' },
  { value: 'qwen', label: '通义千问', cors: true, hint: '获取 Key: dashscope.console.aliyun.com → API-KEY 管理' },
  { value: 'doubao', label: '豆包', cors: false, hint: '获取 Key: console.volcengine.com → 模型推理 → API Key（火山引擎不支持浏览器直连，需点击下方「切换到本地代理」）' },
  { value: 'minimax', label: 'MiniMax', cors: true, hint: '获取 Key: platform.minimaxi.com → API Keys' },
  { value: 'glm', label: '智谱 GLM', cors: true, hint: '获取 Key: open.bigmodel.cn → API Keys' },
  { value: 'wenxin', label: '文心一言', cors: true, hint: '获取 Key: console.bce.baidu.com → 千帆大模型 → API Key' },
  { value: 'gemini', label: 'Gemini', cors: true, hint: '获取 Key: aistudio.google.com → API Keys' },
  { value: 'poe', label: 'Poe', cors: true, hint: '获取 Key: poe.com → Settings → API → API Key' },
  { value: 'openai', label: 'OpenAI', cors: false, hint: '获取 Key: platform.openai.com → API Keys（需点击下方「切换到本地代理」）' },
  { value: 'kimi', label: 'Kimi', cors: false, hint: '获取 Key: platform.moonshot.cn → API Key 管理（需点击下方「切换到本地代理」）' },
  { value: 'claude', label: 'Claude', cors: false, hint: '获取 Key: console.anthropic.com → API Keys（需点击下方「切换到本地代理」）' },
  { value: 'nvidia', label: 'NVIDIA NIM', cors: false, hint: '获取 Key: build.nvidia.com → 登录后获取 API Key（需点击下方「切换到本地代理」）' },
  { value: 'modelscope', label: '魔搭社区', cors: true, hint: '获取 Key: modelscope.cn → 我的 → Access Token' },
  { value: 'agnes', label: 'Agnes AI（免费）', cors: true, hint: '清华系免费全模态 · 获取 Key: platform.agnes-ai.com（若连不上可点下方「切换到本地代理」）' },
  { value: 'longcat', label: 'LongCat（美团）', cors: false, hint: '获取 Key: longcat.chat 平台控制台；OpenAI 兼容接口（若浏览器直连 CORS 失败可切换本地代理）' },
  { value: 'opencode', label: 'OpenCode Go（月付）', cors: false, hint: '获取 Key: opencode.ai → Zen → Go API Key（需点击下方「切换到本地代理」）' },
  { value: 'ollama', label: '本地模型 (Ollama / LM Studio 等)', cors: true, hint: '本地 OpenAI-compatible /v1 接口；Ollama 常用 http://localhost:11434/v1，LM Studio 常用 http://localhost:1234/v1；通常无需 API Key。' },
  { value: 'custom', label: '自定义', cors: true, hint: '填写任何兼容 OpenAI 格式的 API' },
]

/**
 * 从服务端返回的模型列表里挑一个默认项。
 * 优先「便宜/快」档（flash / mini / lite / chat / turbo），否则取字母序第一个。
 * 这里不写死任何具体型号，只看命名族的通用后缀。
 */
export function preferredModel(models: string[]): string {
  const cheap = models.find(model => /flash|mini|lite|turbo|chat|small|8b|7b/i.test(model))
  return cheap ?? models[0]
}

export default function AIConfigPanel() {
  const { config, setConfig, switchProvider, testConnection,
    rememberApiKey, setRememberApiKey,
    presets, taskRoutes, agentContextProfiles,
    setTaskRoute, setAgentContextProfile,
    activePresetId, editingPresetId, saveAsPreset, applyPreset, updatePresetFromCurrent,
    renamePreset, deletePreset } = useAIConfigStore()
  const dialog = useDialog()
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [showLogs, setShowLogs] = useState(false)
  const [savingPreset, setSavingPreset] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [contextWindowDraft, setContextWindowDraft] = useState(() => config.contextWindow ? String(config.contextWindow) : '')
  const [contextWindowError, setContextWindowError] = useState('')
  const [fetchedModels, setFetchedModels] = useState<string[]>([])
  /** 服务端在 /v1/models 里报告的上下文窗口（模型 id → token）。 */
  const [detectedWindows, setDetectedWindows] = useState<Record<string, number>>({})
  const [appliedDetectedWindow, setAppliedDetectedWindow] = useState<number | null>(null)
  const [refreshingModels, setRefreshingModels] = useState(false)
  const [modelListError, setModelListError] = useState('')
  const [modelListFetchedAt, setModelListFetchedAt] = useState<number | null>(null)
  // 自动选型只在「服务商/端点/Key 变化后」允许一次，避免每轮刷新都覆盖作者手填的模型名。
  const autoPickModelRef = useRef(true)
  const submittedContextWindowRef = useRef(config.contextWindow)
  const [currentTheme, setCurrentTheme] = useState<StoryForgeTheme>(() =>
    resolveStoryForgeTheme(localStorage.getItem('storyforge-theme')),
  )

  const handleSavePreset = () => {
    if (!presetName.trim()) return
    saveAsPreset(presetName.trim())
    setPresetName('')
    setSavingPreset(false)
  }

  // 订阅日志变化
  const logs = useSyncExternalStore(subscribeLogs, getLogs)

  const currentProviderInfo = PROVIDER_OPTIONS.find((p) => p.value === config.provider)
  const editingPreset = editingPresetId ? presets.find(p => p.id === editingPresetId) : null
  /** 当前真正生效的窗口（手填 > 服务端报告 > 名称族/服务商预设），与底栏同一套解析。 */
  const effectiveWindow = resolveModelWindow(
    config.provider,
    config.model,
    config.contextWindow,
    config.contextWindowSource === 'detected' ? 'detected' : 'manual',
  )

  useEffect(() => {
    if (config.contextWindow === submittedContextWindowRef.current) return
    submittedContextWindowRef.current = config.contextWindow
    setContextWindowDraft(config.contextWindow ? String(config.contextWindow) : '')
    setContextWindowError('')
  }, [config.contextWindow])

  const handleContextWindowChange = (raw: string) => {
    setContextWindowDraft(raw)
    const parsed = parseContextWindowInput(raw)
    if (parsed.kind === 'invalid') {
      setContextWindowError(parsed.message)
      return
    }

    const next = parsed.kind === 'valid' ? parsed.value : undefined
    setContextWindowError('')
    submittedContextWindowRef.current = next
    setAppliedDetectedWindow(null)
    setConfig({
      contextWindow: next,
      // 留空 = 回到预设/服务端报告；填了 = 作者手动值，之后自动应用不会覆盖它。
      contextWindowSource: next ? 'manual' : undefined,
      contextWindowDetectedAt: undefined,
    })
  }

  const handleRefreshModels = async (options: { auto?: boolean } = {}) => {
    setRefreshingModels(true)
    if (!options.auto) setModelListError('')
    try {
      // 读取"此刻"的配置，而不是闭包里的旧值：这个函数要在 600ms 防抖后才跑，
      // 期间作者可能已经改了模型名或 Key；用旧闭包写回会把它覆盖掉（真实缺陷）。
      const latest = useAIConfigStore.getState().config
      const identity = `${latest.provider}|${latest.baseUrl}|${latest.apiKey}`
      const normalized = normalizeOpenAIBaseUrl(latest.baseUrl)
      if (normalized.changed) setConfig({ baseUrl: normalized.baseUrl })
      const catalog = await fetchOpenAIModelCatalog({
        baseUrl: normalized.baseUrl,
        apiKey: latest.apiKey,
      })
      // 请求期间作者又改了端点/服务商 → 这份结果已经不属于当前配置，丢弃。
      const afterFetch = useAIConfigStore.getState().config
      if (`${afterFetch.provider}|${afterFetch.baseUrl}|${afterFetch.apiKey}` !== identity
        && `${afterFetch.provider}|${normalized.baseUrl}|${afterFetch.apiKey}` !== identity) {
        return
      }
      const models = catalog.map(entry => entry.id)
      const windows: Record<string, number> = {}
      for (const entry of catalog) {
        if (entry.contextWindow) windows[entry.id] = entry.contextWindow
      }
      setDetectedWindows(windows)
      setFetchedModels(models)
      setModelListFetchedAt(Date.now())
      if (models.length === 0) setModelListError('服务返回了空模型列表；仍可手动填写模型名')
      else setModelListError('')
      // 自动选型：**只在模型名为空时**介入一次。
      // 作者已经填了名字（哪怕是服务端列表里没有的自定义/中转名）就绝不覆盖——
      // 覆盖手填值是真实缺陷（防抖/规范化写回会让它在作者打字后悄悄发生）。
      let nextModel = afterFetch.model
      if (models.length > 0 && autoPickModelRef.current) {
        autoPickModelRef.current = false
        if (!afterFetch.model) {
          nextModel = preferredModel(models)
          setConfig({ model: nextModel })
        }
      }
      // 自动应用服务端报告的上下文窗口（作者手填过则不覆盖，只在界面上提示）。
      const reported = windows[nextModel]
      if (reported && afterFetch.contextWindowSource !== 'manual') {
        if (afterFetch.contextWindow !== reported || afterFetch.contextWindowSource !== 'detected') {
          setConfig({
            contextWindow: reported,
            contextWindowSource: 'detected',
            contextWindowDetectedAt: Date.now(),
          })
        }
        setAppliedDetectedWindow(reported)
      } else {
        setAppliedDetectedWindow(null)
      }
      log.info('AIConfig', 'ai.config.models.refreshed', `已获取 ${models.length} 个模型`, {
        provider: latest.provider,
        count: models.length,
        auto: Boolean(options.auto),
        reportedWindows: Object.keys(windows).length,
      })
    } catch (error) {
      setFetchedModels([])
      setDetectedWindows({})
      setAppliedDetectedWindow(null)
      const message = error instanceof Error ? error.message : '刷新模型列表失败'
      setModelListError(message)
      log.warn('AIConfig', 'ai.config.models.failed', `获取模型列表失败：${message}`, {
        provider: config.provider,
        baseUrl: config.baseUrl,
      })
    } finally {
      setRefreshingModels(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testConnection()
      setTestResult(result)
    } finally {
      setTesting(false)
    }
  }

  const handleThemeChange = (theme: StoryForgeTheme) => {
    setCurrentTheme(theme)
    applyStoryForgeTheme(theme)
  }

  const handleRenamePreset = async (id: string, currentName: string) => {
    const name = await dialog.prompt({
      title: '重命名预设',
      defaultValue: currentName,
      placeholder: '输入新的预设名称',
    })
    if (name?.trim()) renamePreset(id, name.trim())
  }

  const handleDeletePreset = async (id: string, name: string) => {
    const ok = await dialog.confirm({
      title: `删除预设「${name}」？`,
      message: '此操作不可恢复。',
      confirmText: '删除',
      tone: 'danger',
    })
    if (ok) deletePreset(id)
  }

  // 切换 provider 时清空测试结果
  useEffect(() => {
    setTestResult(null)
  }, [config.provider])

  // 服务商变化才算"换了一套候选"：此时清空已获取列表并允许一次自动选型。
  // 单独成一个 effect，是为了让 baseUrl/Key 的变化（含 handleRefreshModels 里的
  // URL 规范化写回）只触发重新拉取，**不清空**列表、也不重置 autoPick 标志——
  // 否则规范化 → 依赖变化 → effect 重跑 → 重置 → 第二次覆盖作者手填的模型名（真实缺陷）。
  useEffect(() => {
    setFetchedModels([])
    setDetectedWindows({})
    setAppliedDetectedWindow(null)
    setModelListError('')
    setModelListFetchedAt(null)
    autoPickModelRef.current = true
  }, [config.provider])

  // 端点/服务商/Key 变化后自动拉取可用模型（防抖），作者不必先点“刷新模型”。
  // 依赖 config.model 之外的三项，因此填写模型名的输入不会触发网络请求。
  useEffect(() => {
    if (!/^https?:\/\//i.test(config.baseUrl.trim())) return
    // 没填 Key 时多为 401，避免刚进设置页就冒红；本地/自定义端点通常无需 Key。
    const keyless = config.provider === 'ollama' || config.provider === 'custom'
    if (!config.apiKey.trim() && !keyless) return
    const timer = setTimeout(() => { void handleRefreshModels({ auto: true }) }, 600)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在端点/服务商/Key 变化时自动获取
  }, [config.baseUrl, config.provider, config.apiKey])

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold text-text-primary mb-6">设置</h2>

      {/* AI 配置 */}
      <div className="bg-bg-surface border border-border rounded-xl p-5 mb-6">
        <h3 className="text-base font-semibold text-text-primary mb-4">AI 模型配置</h3>
        <p className="text-[11px] text-text-muted mb-4 rounded-lg border border-border bg-bg-base px-3 py-2">
          API Key 默认仅保存在本次浏览器会话；勾选“记住在本机”才会写入 localStorage。发起 AI 生成、测试连接或使用自定义 baseUrl 时，相关提示词和上下文会发送到你配置的模型服务。
        </p>

        <AIConfigPresetSection
          presets={presets}
          activePresetId={activePresetId}
          editingPreset={editingPreset ?? null}
          savingPreset={savingPreset}
          presetName={presetName}
          onPresetNameChange={setPresetName}
          onStartSaving={() => setSavingPreset(true)}
          onCancelSaving={() => setSavingPreset(false)}
          onSavePreset={handleSavePreset}
          onApplyPreset={applyPreset}
          onUpdatePreset={updatePresetFromCurrent}
          onRenamePreset={(id, name) => { void handleRenamePreset(id, name) }}
          onDeletePreset={(id, name) => { void handleDeletePreset(id, name) }}
        />

        <AITaskRoutingSection
          presets={presets}
          routes={taskRoutes}
          contextProfiles={agentContextProfiles}
          onSetRoute={setTaskRoute}
          onSetContextProfile={setAgentContextProfile}
        />

        <div className="space-y-4">
          <MasterAgentExecutionModeSection
            value={config.masterAgentExecutionMode ?? 'route-first'}
            onChange={masterAgentExecutionMode => setConfig({ masterAgentExecutionMode })}
            maxSteps={config.masterAgentMaxSteps ?? DEFAULT_NATIVE_AGENT_LIMITS.maxSteps}
            maxToolCalls={config.masterAgentMaxToolCalls ?? DEFAULT_NATIVE_AGENT_LIMITS.maxToolCalls}
            onLimitsChange={limits => setConfig({
              ...(limits.maxSteps != null ? { masterAgentMaxSteps: limits.maxSteps } : {}),
              ...(limits.maxToolCalls != null ? { masterAgentMaxToolCalls: limits.maxToolCalls } : {}),
            })}
          />

          <div>
            <label className="block text-sm text-text-secondary mb-1.5">提供商</label>
            <select
              value={config.provider}
              onChange={(e) => switchProvider(e.target.value as AIProvider)}
              className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary focus:outline-none focus:border-accent transition-colors"
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}{!opt.cors ? ' ⚠️' : ''}
                </option>
              ))}
            </select>
            {/* 配置提示 */}
            {currentProviderInfo && (
              <p className={`mt-1.5 text-xs ${currentProviderInfo.cors ? 'text-text-muted' : 'text-amber-500'}`}>
                {currentProviderInfo.hint}
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm text-text-secondary mb-1.5">API Key</label>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={config.apiKey}
                onChange={(e) => setConfig({ apiKey: e.target.value })}
                placeholder={config.provider === 'ollama' ? '不需要 Key' : '输入 API Key...'}
                className="w-full px-3 py-2 pr-10 bg-bg-base border border-border rounded-lg text-text-primary placeholder-text-muted focus:outline-none focus:border-accent transition-colors"
              />
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                aria-label={showKey ? '隐藏 API Key' : '显示 API Key'}
                onClick={() => setShowKey(!showKey)}
                className="absolute right-2 top-1/2 -translate-y-1/2"
              >
                {showKey ? <EyeOff /> : <Eye />}
              </Button>
            </div>
            <label className="mt-2 flex items-start gap-2 text-[11px] text-text-secondary cursor-pointer">
              <input
                type="checkbox"
                checked={rememberApiKey}
                onChange={e => setRememberApiKey(e.target.checked)}
                className="mt-0.5 accent-accent"
              />
              <span>
                在本机记住 API Key（写入 localStorage）。不勾选时仅本次浏览器会话有效。
              </span>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1.5">Base URL</label>
              <input
                type="text"
                value={config.baseUrl}
                onChange={(e) => setConfig({ baseUrl: e.target.value })}
                className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent transition-colors"
              />
              {['custom', 'ollama'].includes(config.provider) && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setConfig({ provider: 'custom', baseUrl: 'http://localhost:1234/v1', apiKey: config.apiKey || 'lm-studio', model: 'qwen3-14b' })}
                  >
                    LM Studio
                  </Button>
                  <Button
                    variant="secondary"
                    size="xs"
                    onClick={() => setConfig({ provider: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: config.apiKey || 'ollama', model: 'qwen2.5:7b' })}
                  >
                    本地 Ollama
                  </Button>
                </div>
              )}
              {['custom', 'ollama'].includes(config.provider) && (
                <p className="mt-1 text-[11px] text-text-muted">
                  本地模型请选择 OpenAI 兼容接口，Base URL 填到 /v1；Ollama 常用 :11434/v1，LM Studio 常用 :1234/v1。不要填 /v1/models 或 /chat/completions，测试时会自动修正常见误填。
                </p>
              )}
              {(() => {
                const pm = AI_PROXY_ENDPOINTS[config.provider]
                if (!pm) return null
                const isProxy = config.baseUrl.startsWith('/' + config.provider)
                return (
                  <div className="mt-1.5 flex gap-2">
                    {!isProxy ? (
                      <Button
                        variant="warning-soft"
                        size="xs"
                        onClick={() => setConfig({ baseUrl: pm.proxy })}
                      >
                        🔄 切换到本地代理
                      </Button>
                    ) : (
                      <Button
                        variant="info-soft"
                        size="xs"
                        onClick={() => setConfig({ baseUrl: pm.direct })}
                      >
                        🔗 恢复直连
                      </Button>
                    )}
                  </div>
                )
              })()}
            </div>
            <div>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <label className="block text-sm text-text-secondary">模型</label>
                <Button
                  type="button"
                  variant="ghost-accent"
                  size="xs"
                  loading={refreshingModels}
                  loadingText="获取中"
                  disabled={!config.baseUrl.trim()}
                  onClick={() => { void handleRefreshModels() }}
                  title="从当前服务端点自动获取可用模型"
                  icon={<RefreshCw />}
                >
                  获取可用模型
                </Button>
              </div>
              {/* 模型名不再硬编码：服务端列表可自动获取，也始终允许手填。 */}
              {fetchedModels.length > 0 && (
                <select
                  value={fetchedModels.includes(config.model) ? config.model : ''}
                  onChange={(e) => { if (e.target.value) setConfig({ model: e.target.value }) }}
                  aria-label="服务返回的模型列表"
                  className="mb-1.5 w-full rounded-lg border border-border bg-bg-base px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
                >
                  <option value="">从服务返回的 {fetchedModels.length} 个模型中选一个…</option>
                  {fetchedModels.map(model => <option key={model} value={model}>{model}</option>)}
                </select>
              )}
              <input
                type="text"
                value={config.model}
                onChange={(e) => setConfig({ model: e.target.value })}
                placeholder={fetchedModels.length > 0 ? '也可直接填写列表外的型号' : '模型名（可自动获取，也可手填）'}
                aria-label="模型名"
                className="w-full px-3 py-2 bg-bg-base border border-border rounded-lg text-text-primary text-sm focus:outline-none focus:border-accent transition-colors"
              />
              {!config.model.trim() && (
                <p className="mt-1 text-[11px] text-amber-400">
                  尚未确定模型名：等自动获取完成，或点「获取可用模型」，也可以直接手填。
                </p>
              )}
              {refreshingModels && (
                <p className="mt-1 text-[11px] text-text-muted">正在从 {config.baseUrl} 获取可用模型…</p>
              )}
              {!refreshingModels && modelListFetchedAt != null && fetchedModels.length > 0 && (
                <p className="mt-1 text-[11px] text-text-muted">
                  已获取 {fetchedModels.length} 个可用模型（{new Date(modelListFetchedAt).toLocaleTimeString('zh-CN')}）
                </p>
              )}
              {modelListError && <p className="mt-1 text-[11px] text-amber-400">{modelListError}</p>}              {config.provider === 'ollama' && (
                <p className="mt-1 text-[11px] text-text-muted">未安装的模型请先在 Ollama 中拉取，完成后回到这里刷新。</p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm text-text-secondary mb-1.5">
                Temperature: {config.temperature}
              </label>
              <input
                type="range"
                min={0}
                max={2}
                step={0.1}
                value={config.temperature}
                onChange={(e) => setConfig({ temperature: Number(e.target.value) })}
                className="w-full accent-accent"
              />
            </div>
            <div>
              <label className="block text-sm text-text-secondary mb-1.5">
                Max Tokens:
                {config.maxTokens === 0
                  ? <span className="text-accent font-normal ml-1">不限制（模型最大）</span>
                  : <><span className="ml-1">{config.maxTokens}</span><span className="text-text-muted font-normal ml-1">（≈{Math.round(config.maxTokens * 0.6)}字）</span></>
                }
              </label>
              <div className="flex items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-text-secondary whitespace-nowrap cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.maxTokens === 0}
                    onChange={(e) => setConfig({ maxTokens: e.target.checked ? 0 : 8192 })}
                    className="accent-accent"
                  />
                  不限
                </label>
                {config.maxTokens > 0 && (
                  <input
                    type="range"
                    min={1024}
                    max={65536}
                    step={1024}
                    value={config.maxTokens}
                    onChange={(e) => setConfig({ maxTokens: Number(e.target.value) })}
                    className="w-full accent-accent"
                  />
                )}
              </div>
              {config.maxTokens > 0 && (
                <div className="flex justify-between text-[10px] text-text-muted mt-0.5">
                  <span>1K</span><span>16K</span><span>32K</span><span>64K</span>
                </div>
              )}
              <p className="mt-1 text-[10px] text-text-muted">地图视觉请求的输出上限在下方「团队总预算与上下文预算」单独设置。</p>
            </div>
          </div>

          {/* FB-8: 上下文窗口(高级·可选) — 本地/自定义模型按实际填写,修"误报超出窗口" */}
          <div className="mb-4">
            <label className="block text-sm text-text-secondary mb-1.5">
              上下文窗口 <span className="text-text-muted font-normal">(高级 · 可选)</span>
              {config.contextWindow
                ? <span className="text-accent ml-1">{config.contextWindow.toLocaleString()} token</span>
                : <span className="text-text-muted ml-1">按模型预设</span>}
            </label>
            {/* 当前实际生效的窗口与来源：避免"我选了 1M 模型，底栏却按 128K 算"这类无解释的数字 */}
            <p className="mb-2 text-[11px] text-text-muted" aria-label="当前生效上下文窗口">
              当前生效：<span className="text-text-secondary">{effectiveWindow.maxContext.toLocaleString()} token</span>
              <span className="ml-1">· {effectiveWindow.description}</span>
            </p>
            <div className="flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                value={contextWindowDraft}
                onChange={(e) => handleContextWindowChange(e.target.value)}
                aria-invalid={Boolean(contextWindowError)}
                placeholder="本地/自定义模型请按实际填写，如 131072；留空 = 用内置预设"
                className={`min-w-0 flex-1 px-3 py-2 bg-bg-base border rounded text-sm text-text-primary focus:outline-none ${contextWindowError ? 'border-red-400 focus:border-red-400' : 'border-border focus:border-accent'}`}
              />
              <Button
                type="button"
                variant="secondary"
                size="md"
                iconOnly
                onClick={() => handleContextWindowChange('')}
                disabled={!contextWindowDraft && !contextWindowError}
                title="重置为模型预设"
                aria-label="重置上下文窗口为模型预设"
              >
                <RotateCcw />
              </Button>
            </div>
            {contextWindowError ? (
              <p className="mt-1 text-[11px] text-red-400">{contextWindowError}；已保存值未改变。</p>
            ) : (
              <p className="mt-1 flex items-center gap-1 text-[11px] text-green-400/80">
                <CheckCircle className="w-3 h-3" />
                {editingPreset && activePresetId === null
                  ? `已自动保存到当前配置，尚未写回「${editingPreset.name}」`
                  : '已自动保存到当前配置'}
              </p>
            )}
            {appliedDetectedWindow != null && (
              <p className="mt-1 text-[11px] text-accent" aria-label="已应用服务端上下文窗口">
                服务端报告该模型窗口为 {appliedDetectedWindow.toLocaleString()} token，已自动应用。
              </p>
            )}
            {detectedWindows[config.model] != null
              && config.contextWindowSource === 'manual'
              && detectedWindows[config.model] !== config.contextWindow && (
              <p className="mt-1 text-[11px] text-yellow-400/90" aria-label="服务端窗口被手填值覆盖">
                服务端报告该模型窗口为 {detectedWindows[config.model]!.toLocaleString()} token，但你手填了{' '}
                {config.contextWindow?.toLocaleString()} token；手填值优先。
                {' '}
                <button
                  type="button"
                  className="underline hover:text-yellow-300"
                  onClick={() => {
                    submittedContextWindowRef.current = detectedWindows[config.model]!
                    setContextWindowDraft(String(detectedWindows[config.model]))
                    setConfig({
                      contextWindow: detectedWindows[config.model],
                      contextWindowSource: 'detected',
                      contextWindowDetectedAt: Date.now(),
                    })
                    setAppliedDetectedWindow(detectedWindows[config.model]!)
                  }}
                >
                  改用服务端值
                </button>
              </p>
            )}
            <p className="text-[11px] text-text-muted mt-1">
              点「刷新模型列表」时会自动读取服务端 `/v1/models` 报告的上下文窗口并应用（OpenRouter 的
              <code className="mx-0.5">context_length</code>、vLLM/LM Studio 的
              <code className="mx-0.5">max_model_len</code> 等）。服务端不报告时按模型名推断，可能偏小，
              本地模型请在此填真实窗口，如 128000 / 262144 / 1000000。
            </p>
          </div>

          {/* 测试连接 */}
          <AIConnectionTestSection
            testing={testing}
            result={testResult}
            configReady={isAIConfigReady(config)}
            provider={config.provider}
            logCount={logs.length}
            showLogs={showLogs}
            isDevelopment={import.meta.env.DEV}
            onTest={() => { void handleTest() }}
            onToggleLogs={() => setShowLogs(!showLogs)}
          />
        </div>
      </div>

      {/* NS-5 · 语义检索(embedding) 配置卡 */}
      <EmbeddingConfigCard />

      {/* 日志面板 */}
      {showLogs && <AIConnectionLogPanel logs={logs} onClear={clearLogs} />}

      {/* 主题切换 */}
      <ThemeSelector value={currentTheme} onChange={handleThemeChange} />
    </div>
  )
}
