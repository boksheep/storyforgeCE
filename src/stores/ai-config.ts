import { create } from 'zustand'
import type { AIConfig, AIProvider, AIConfigPreset, EmbeddingConfig } from '../lib/types'
import { PROVIDER_PRESETS } from '../lib/types'
import { createLog, updateLog } from '../lib/ai/logger'
import { log } from '../lib/logging/logger'
import { nanoid } from '../lib/utils/id'
import { buildOpenAIEndpoint, normalizeOpenAIBaseUrl } from '../lib/ai/openai-endpoint'
import { setActiveContextWindowOverride } from '../lib/ai/context-budget'
import {
  sanitizeAITaskRoutes,
  type AITaskKind,
  type AITaskRoutes,
} from '../lib/ai/task-routing'
import {
  sanitizeAgentContextProfiles,
  type AgentContextProfile,
  type AgentContextProfiles,
  type AgentContextTaskKind,
} from '../lib/agent/context-policy'
import {
  sanitizeAgentTeamBudgetProfile,
  clampTeamBudgetTokens,
  AGENT_TEAM_BUDGET_PRESET_META,
  type AgentTeamBudgetProfile,
} from '../lib/agent/team-budget'
import { allocateContextBudgetOverrides } from '../lib/registry/context-budget-policy'
import { DEFAULT_NATIVE_AGENT_LIMITS, resolveNativeAgentLimits } from '../lib/agent/native-agent-limits'
import {
  CONTEXT_BUDGET_POLICY_KEY,
  saveContextBudgetPolicy,
  sanitizeContextBudgetPolicy,
  type ContextBudgetPolicy,
  type ContextSourceBudgetPolicy,
} from '../lib/registry/context-budget-policy'

const STORAGE_KEY = 'storyforge-ai-config'
const PRESETS_KEY = 'storyforge-ai-presets'
const SESSION_API_KEY = 'storyforge-ai-api-key-session'
const REMEMBER_API_KEY = 'storyforge-ai-api-key-remember'
const EMBEDDING_KEY = 'storyforge-embedding-config'
const EMBEDDING_SESSION_KEY = 'storyforge-embedding-key-session'
export const TASK_ROUTES_KEY = 'storyforge-ai-task-routes'
export const AGENT_CONTEXT_PROFILES_KEY = 'storyforge-agent-context-profiles'
export const AGENT_TEAM_BUDGET_PROFILE_KEY = 'storyforge-agent-team-budget-profile'

const TEAM_BUDGET_TOKENS_KEY = 'storyforge-agent-team-budget-tokens'
const CONTEXT_BUDGET_PRESETS_KEY = 'storyforge-context-budget-presets'
export const MAP_VISION_OUTPUT_BUDGET_KEY = 'storyforge-map-vision-output-budget'

export interface MapVisionOutputBudget {
  features: number
  legend: number
}

export const DEFAULT_MAP_VISION_OUTPUT_BUDGET: MapVisionOutputBudget = { features: 8192, legend: 4096 }
export const MAP_VISION_OUTPUT_BUDGET_LIMITS = { min: 1024, max: 16384 } as const

function clampMapVisionOutputTokens(value: unknown, fallback: number): number {
  const tokens = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(tokens)
    ? Math.max(MAP_VISION_OUTPUT_BUDGET_LIMITS.min, Math.min(MAP_VISION_OUTPUT_BUDGET_LIMITS.max, Math.floor(tokens)))
    : fallback
}

function sanitizeMapVisionOutputBudget(value: unknown): MapVisionOutputBudget {
  const input = value && typeof value === 'object' ? value as Partial<MapVisionOutputBudget> : {}
  return {
    features: clampMapVisionOutputTokens(input.features, DEFAULT_MAP_VISION_OUTPUT_BUDGET.features),
    legend: clampMapVisionOutputTokens(input.legend, DEFAULT_MAP_VISION_OUTPUT_BUDGET.legend),
  }
}

function loadMapVisionOutputBudget(): MapVisionOutputBudget {
  try {
    const value = localStorage.getItem(MAP_VISION_OUTPUT_BUDGET_KEY)
    return sanitizeMapVisionOutputBudget(value ? JSON.parse(value) : {})
  } catch { return { ...DEFAULT_MAP_VISION_OUTPUT_BUDGET } }
}

function persistMapVisionOutputBudget(budget: MapVisionOutputBudget): void {
  localStorage.setItem(MAP_VISION_OUTPUT_BUDGET_KEY, JSON.stringify(budget))
}

export interface ContextBudgetPreset {
  id: string
  name: string
  totalTokens: number
  sources: Record<string, ContextSourceBudgetPolicy>
  mapVisionOutput?: MapVisionOutputBudget
}

function loadTeamBudgetTokens(): number {
  try {
    const value = localStorage.getItem(TEAM_BUDGET_TOKENS_KEY)
    return clampTeamBudgetTokens(value == null ? AGENT_TEAM_BUDGET_PRESET_META.balanced.maxTokens : Number(value))
  } catch { return AGENT_TEAM_BUDGET_PRESET_META.balanced.maxTokens }
}

function loadContextBudgetPresets(): ContextBudgetPreset[] {
  try {
    const value = localStorage.getItem(CONTEXT_BUDGET_PRESETS_KEY)
    const parsed = value ? JSON.parse(value) : []
    return Array.isArray(parsed) ? parsed.filter(item => item && typeof item.id === 'string' && typeof item.name === 'string') : []
  } catch { return [] }
}

function saveContextBudgetPresets(presets: ContextBudgetPreset[]): void {
  localStorage.setItem(CONTEXT_BUDGET_PRESETS_KEY, JSON.stringify(presets))
}

const DEFAULT_CONFIG: AIConfig = {
  provider: 'deepseek',
  apiKey: '',
  // 不预置模型名：模型名更新频繁，硬编码会过期。作者填 Key 后面板自动获取可用模型，
  // 也可以直接手填；空模型名会被 isAIConfigReady 如实判为「未就绪」。
  model: '',
  baseUrl: 'https://api.deepseek.com/v1',
  temperature: 0.7,
  maxTokens: 0,
  masterAgentExecutionMode: 'route-first',
  masterAgentMaxSteps: DEFAULT_NATIVE_AGENT_LIMITS.maxSteps,
  masterAgentMaxToolCalls: DEFAULT_NATIVE_AGENT_LIMITS.maxToolCalls,
}

/** NS-5 默认：关闭；隐私首选本地 Ollama + bge-m3（手稿不出本机）。 */
const DEFAULT_EMBEDDING: EmbeddingConfig = {
  enabled: false,
  provider: 'ollama',
  apiKey: '',
  baseUrl: 'http://localhost:11434/v1',
  model: 'bge-m3',
}

/** embedding 配置加载：key 复用与聊天 key 相同的「记住」开关（不记住→sessionStorage）。 */
function loadEmbeddingConfig(rememberApiKey: boolean): EmbeddingConfig {
  let saved: Partial<EmbeddingConfig> = {}
  try { const raw = localStorage.getItem(EMBEDDING_KEY); if (raw) saved = JSON.parse(raw) } catch { /* ignore */ }
  const sessionKey = sessionStorage.getItem(EMBEDDING_SESSION_KEY) || ''
  return { ...DEFAULT_EMBEDDING, ...saved, apiKey: rememberApiKey ? (saved.apiKey || '') : sessionKey }
}

function persistEmbeddingConfig(cfg: EmbeddingConfig, rememberApiKey: boolean): void {
  const persisted: EmbeddingConfig = rememberApiKey ? cfg : { ...cfg, apiKey: '' }
  localStorage.setItem(EMBEDDING_KEY, JSON.stringify(persisted))
  if (rememberApiKey) sessionStorage.removeItem(EMBEDDING_SESSION_KEY)
  else if (cfg.apiKey) sessionStorage.setItem(EMBEDDING_SESSION_KEY, cfg.apiKey)
  else sessionStorage.removeItem(EMBEDDING_SESSION_KEY)
}

/** 从 localStorage 加载预设列表 */
function loadPresets(): AIConfigPreset[] {
  try {
    const saved = localStorage.getItem(PRESETS_KEY)
    if (saved) {
      const arr = JSON.parse(saved)
      if (Array.isArray(arr)) return arr
    }
  } catch { /* ignore */ }
  return []
}

function savePresets(presets: AIConfigPreset[]) {
  localStorage.setItem(PRESETS_KEY, JSON.stringify(presets))
}

function loadTaskRoutes(): AITaskRoutes {
  try {
    const saved = localStorage.getItem(TASK_ROUTES_KEY)
    return saved ? sanitizeAITaskRoutes(JSON.parse(saved)) : {}
  } catch {
    return {}
  }
}

function saveTaskRoutes(routes: AITaskRoutes): void {
  localStorage.setItem(TASK_ROUTES_KEY, JSON.stringify(routes))
}

function loadAgentContextProfiles(): AgentContextProfiles {
  try {
    const saved = localStorage.getItem(AGENT_CONTEXT_PROFILES_KEY)
    return sanitizeAgentContextProfiles(saved ? JSON.parse(saved) : {})
  } catch {
    return sanitizeAgentContextProfiles({})
  }
}

function saveAgentContextProfiles(profiles: AgentContextProfiles): void {
  localStorage.setItem(AGENT_CONTEXT_PROFILES_KEY, JSON.stringify(profiles))
}

function loadAgentTeamBudgetProfile(): AgentTeamBudgetProfile {
  return sanitizeAgentTeamBudgetProfile(localStorage.getItem(AGENT_TEAM_BUDGET_PROFILE_KEY))
}

function saveAgentTeamBudgetProfile(profile: AgentTeamBudgetProfile): void {
  localStorage.setItem(AGENT_TEAM_BUDGET_PROFILE_KEY, profile)
}

/**
 * BUDGET-1: 读取本机上下文预算策略。读的是与 `assembleContext` 同一个
 * localStorage 键，保证「设置里看到的」就是「装配时用的」。
 *
 * 注意：这里不校验源键——`ai-config` 不能 import `context-sources`（后者反向依赖本模块，
 * 会形成 ESM 循环）。源键的合法性由「设置 UI 只列出登记源」+ `assembleContext` 只按
 * `CONTEXT_SOURCES` 取源共同保证；残留的未知键不会生效，也不会被 UI 显示。
 */
function loadBudgetPolicy(): ContextBudgetPolicy {
  try {
    const stored = localStorage.getItem(CONTEXT_BUDGET_POLICY_KEY)
    return sanitizeContextBudgetPolicy(stored ? JSON.parse(stored) : {})
  } catch {
    return sanitizeContextBudgetPolicy({})
  }
}

function persistBudgetPolicy(policy: ContextBudgetPolicy): void {
  saveContextBudgetPolicy(policy)
}

/** 根据 HTTP 状态码和英文错误信息，返回中文解释 */
function getChineseExplanation(status: number, msg: string): string {
  const lower = msg.toLowerCase()

  // 按 HTTP 状态码
  if (status === 401) return 'API Key 无效或已过期'
  if (status === 402) return '账户余额不足，请充值后使用'
  if (status === 403) return 'API Key 权限不足，无权访问该模型'
  if (status === 404) return 'API 地址或模型名称错误，请检查 Base URL 和模型名'
  if (status === 429) return '请求频率超限，请稍后再试'
  if (status === 500) return '服务器内部错误，请稍后重试'
  if (status === 502) return '网关错误，服务暂时不可用'
  if (status === 503) return '服务暂时不可用，可能正在维护'
  if (status === 504) return '上游网关等待模型响应超时，请稍后重试或切换模型'

  // 按错误信息关键词匹配
  if (lower.includes('insufficient balance') || lower.includes('insufficient_balance'))
    return '账户余额不足，请充值'
  if (lower.includes('invalid api key') || lower.includes('invalid_api_key'))
    return 'API Key 无效，请检查是否填写正确'
  if (lower.includes('authentication') || lower.includes('unauthorized'))
    return '认证失败，API Key 无效或已过期'
  if (lower.includes('rate limit') || lower.includes('rate_limit'))
    return '请求频率超限，请稍后再试'
  if (lower.includes('model not found') || lower.includes('model_not_found'))
    return '模型不存在，请检查模型名称是否正确'
  if (lower.includes('context length') || lower.includes('context_length'))
    return '输入内容超过模型最大上下文长度'
  if (lower.includes('quota exceeded') || lower.includes('quota_exceeded'))
    return '配额已用完'
  if (lower.includes('server error') || lower.includes('internal error'))
    return '服务器内部错误'
  if (lower.includes('timeout'))
    return '请求超时'
  if (lower.includes('bad request'))
    return '请求格式错误，请检查参数'
  if (lower.includes('not found'))
    return '接口不存在，请检查 Base URL'
  if (lower.includes('permission denied'))
    return '权限不足'
  if (lower.includes('billing') || lower.includes('payment'))
    return '账单/付款问题，请检查账户'
  if (lower.includes('overloaded') || lower.includes('capacity'))
    return '服务过载，请稍后重试'
  if (lower.includes('thinking') && lower.includes('budget'))
    return '思考模式参数冲突，请不要手动传 thinking 相关参数'

  return ''
}

/** 从 localStorage 加载配置 */
function loadInitialConfig(): { config: AIConfig; rememberApiKey: boolean } {
  let savedConfig: Partial<AIConfig> = {}
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved) savedConfig = JSON.parse(saved)
  } catch { /* ignore */ }

  const rememberRaw = localStorage.getItem(REMEMBER_API_KEY)
  const legacyHasLocalKey = typeof savedConfig.apiKey === 'string' && savedConfig.apiKey.length > 0
  const rememberApiKey = rememberRaw == null ? legacyHasLocalKey : rememberRaw === 'true'
  const sessionKey = sessionStorage.getItem(SESSION_API_KEY) || ''
  const limits = resolveNativeAgentLimits(savedConfig)

  return {
    config: {
      ...DEFAULT_CONFIG,
      ...savedConfig,
      masterAgentMaxSteps: limits.maxSteps,
      masterAgentMaxToolCalls: limits.maxToolCalls,
      apiKey: rememberApiKey ? (savedConfig.apiKey || '') : sessionKey,
    },
    rememberApiKey,
  }
}

function persistConfig(config: AIConfig, rememberApiKey: boolean): void {
  const persisted: AIConfig = rememberApiKey ? config : { ...config, apiKey: '' }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted))
  localStorage.setItem(REMEMBER_API_KEY, String(rememberApiKey))
  if (rememberApiKey) {
    sessionStorage.removeItem(SESSION_API_KEY)
  } else if (config.apiKey) {
    sessionStorage.setItem(SESSION_API_KEY, config.apiKey)
  } else {
    sessionStorage.removeItem(SESSION_API_KEY)
  }
}

function presetConfig(config: AIConfig, rememberApiKey: boolean): AIConfig {
  return rememberApiKey ? { ...config } : { ...config, apiKey: '' }
}

export interface TestResult {
  ok: boolean
  message: string
  statusCode?: number
  duration?: number
}

interface AIConfigStore {
  config: AIConfig
  rememberApiKey: boolean
  presets: AIConfigPreset[]
  taskRoutes: AITaskRoutes
  agentContextProfiles: AgentContextProfiles
  agentTeamBudgetProfile: AgentTeamBudgetProfile
  agentTeamBudgetTokens: number
  contextBudgetPresets: ContextBudgetPreset[]
  mapVisionOutputBudget: MapVisionOutputBudget
  setMapVisionOutputBudget: (kind: keyof MapVisionOutputBudget, tokens: number) => void
  resetMapVisionOutputBudget: () => void
  setAgentTeamBudgetTokens: (tokens: number, sources?: readonly { key: string; layer: string; budgetTokens: number }[]) => void
  applyContextBudgetPreset: (preset: 'economy' | 'balanced' | 'expanded' | string, sources?: readonly { key: string; layer: string; budgetTokens: number }[]) => void
  saveContextBudgetPreset: (name: string) => string
  deleteContextBudgetPreset: (id: string) => void
  /** BUDGET-1: 作者可调的上下文预算策略（本机偏好,不进项目数据）。 */
  contextBudgetPolicy: ContextBudgetPolicy
  /** 当前生效的预设 id（null = 未对应任何预设/已改动） */
  activePresetId: string | null
  /** 最近一次应用/保存的预设 id；表单改动后仍保留,用于显式覆盖当前预设。 */
  editingPresetId: string | null
  /** NS-5 语义检索（embedding）配置 */
  embedding: EmbeddingConfig
  setEmbeddingConfig: (partial: Partial<EmbeddingConfig>) => void
  setConfig: (config: Partial<AIConfig>) => void
  setRememberApiKey: (remember: boolean) => void
  switchProvider: (provider: AIProvider) => void
  testConnection: () => Promise<TestResult>
  // ── 预设管理 ──
  saveAsPreset: (name: string) => string
  applyPreset: (id: string) => void
  updatePresetFromCurrent: (id: string) => void
  renamePreset: (id: string, name: string) => void
  deletePreset: (id: string) => void
  setTaskRoute: (taskKind: AITaskKind, presetId: string | null) => void
  setAgentContextProfile: (taskKind: AgentContextTaskKind, profile: AgentContextProfile) => void
  setAgentTeamBudgetProfile: (profile: AgentTeamBudgetProfile) => void
  // ── BUDGET-1 上下文预算策略 ──
  setContextTruncationEnabled: (enabled: boolean) => void
  setContextSourceBudget: (sourceKey: string, override: ContextSourceBudgetPolicy | null) => void
  resetContextBudgetPolicy: () => void
}

const initial = loadInitialConfig()

/**
 * 让「只拿到 provider/model」的调用点（`assembleContext` 的输入预算）与底栏、
 * 消息裁剪共用同一个窗口数字。
 *
 * 为什么放在 store 而不是逐个调用点传参：`contextWindow` 是当前所选模型的配置，
 * 但上下文装配有近百个调用点只传 provider/model。订阅一次即可全量生效，且任何
 * 修改路径（setConfig / applyPreset / switchProvider）都自动覆盖。
 */
setActiveContextWindowOverride(initial.config.contextWindow)

export const useAIConfigStore = create<AIConfigStore>((set, get) => ({
  config: initial.config,
  rememberApiKey: initial.rememberApiKey,
  presets: loadPresets(),
  taskRoutes: loadTaskRoutes(),
  agentContextProfiles: loadAgentContextProfiles(),
  agentTeamBudgetProfile: loadAgentTeamBudgetProfile(),
  agentTeamBudgetTokens: loadTeamBudgetTokens(),
  contextBudgetPresets: loadContextBudgetPresets(),
  mapVisionOutputBudget: loadMapVisionOutputBudget(),
  contextBudgetPolicy: loadBudgetPolicy(),
  activePresetId: null,
  editingPresetId: null,
  embedding: loadEmbeddingConfig(initial.rememberApiKey),

  setEmbeddingConfig: (partial: Partial<EmbeddingConfig>) => {
    const next = { ...get().embedding, ...partial }
    persistEmbeddingConfig(next, get().rememberApiKey)
    set({ embedding: next })
    log.info('AIConfig', 'ai.config.embedding.updated', 'Embedding 配置已更新', { provider: next.provider, model: next.model, enabled: next.enabled, baseUrl: next.baseUrl })
  },

  setConfig: (partial: Partial<AIConfig>) => {
    const newConfig = { ...get().config, ...partial }
    const limits = resolveNativeAgentLimits(newConfig)
    newConfig.masterAgentMaxSteps = limits.maxSteps
    newConfig.masterAgentMaxToolCalls = limits.maxToolCalls
    persistConfig(newConfig, get().rememberApiKey)
    // 手动改动配置后，与已选预设脱钩（除非改动等于该预设）
    set({ config: newConfig, activePresetId: null })
    const changedKeys = Object.keys(partial).filter(key => key !== 'apiKey')
    log.info('AIConfig', 'ai.config.updated', 'AI 模型配置已更新', { provider: newConfig.provider, model: newConfig.model, baseUrl: newConfig.baseUrl, changedKeys: changedKeys.join(',') })
  },

  setRememberApiKey: (remember: boolean) => {
    persistConfig(get().config, remember)
    persistEmbeddingConfig(get().embedding, remember)
    set({ rememberApiKey: remember })
  },

  saveAsPreset: (name: string) => {
    const id = nanoid()
    const preset: AIConfigPreset = {
      id,
      name: name.trim() || '未命名配置',
      config: presetConfig(get().config, get().rememberApiKey),
    }
    const presets = [...get().presets, preset]
    savePresets(presets)
    set({ presets, activePresetId: id, editingPresetId: id })
    return id
  },

  applyPreset: (id: string) => {
    const preset = get().presets.find(p => p.id === id)
    if (!preset) return
    const newConfig = { ...preset.config, apiKey: preset.config.apiKey || get().config.apiKey }
    const limits = resolveNativeAgentLimits(newConfig)
    newConfig.masterAgentMaxSteps = limits.maxSteps
    newConfig.masterAgentMaxToolCalls = limits.maxToolCalls
    persistConfig(newConfig, get().rememberApiKey)
    set({ config: newConfig, activePresetId: id, editingPresetId: id })
    log.info('AIConfig', 'ai.config.preset.applied', 'AI 配置预设已应用', { presetId: id, provider: newConfig.provider, model: newConfig.model })
  },

  updatePresetFromCurrent: (id: string) => {
    const presets = get().presets.map(p => p.id === id ? {
      ...p,
      config: presetConfig(get().config, get().rememberApiKey),
    } : p)
    savePresets(presets)
    set({ presets, activePresetId: id, editingPresetId: id })
  },

  renamePreset: (id: string, name: string) => {
    const presets = get().presets.map(p => p.id === id ? { ...p, name: name.trim() || p.name } : p)
    savePresets(presets)
    set({ presets })
  },

  deletePreset: (id: string) => {
    const presets = get().presets.filter(p => p.id !== id)
    const taskRoutes = Object.fromEntries(
      Object.entries(get().taskRoutes).filter(([, presetId]) => presetId !== id),
    ) as AITaskRoutes
    savePresets(presets)
    saveTaskRoutes(taskRoutes)
    set({
      presets,
      taskRoutes,
      activePresetId: get().activePresetId === id ? null : get().activePresetId,
      editingPresetId: get().editingPresetId === id ? null : get().editingPresetId,
    })
  },

  setTaskRoute: (taskKind, presetId) => {
    const taskRoutes = { ...get().taskRoutes }
    if (presetId && get().presets.some(preset => preset.id === presetId)) {
      taskRoutes[taskKind] = presetId
    } else {
      delete taskRoutes[taskKind]
    }
    saveTaskRoutes(taskRoutes)
    set({ taskRoutes })
  },

  setAgentContextProfile: (taskKind, profile) => {
    const agentContextProfiles = sanitizeAgentContextProfiles({
      ...get().agentContextProfiles,
      [taskKind]: profile,
    })
    saveAgentContextProfiles(agentContextProfiles)
    set({ agentContextProfiles })
  },

  setAgentTeamBudgetProfile: profile => {
    const agentTeamBudgetProfile = sanitizeAgentTeamBudgetProfile(profile)
    const agentTeamBudgetTokens = agentTeamBudgetProfile === 'custom'
      ? get().agentTeamBudgetTokens
      : AGENT_TEAM_BUDGET_PRESET_META[agentTeamBudgetProfile].maxTokens
    localStorage.setItem(TEAM_BUDGET_TOKENS_KEY, String(agentTeamBudgetTokens))
    saveAgentTeamBudgetProfile(agentTeamBudgetProfile)
    set({ agentTeamBudgetProfile, agentTeamBudgetTokens })
  },

  setAgentTeamBudgetTokens: (tokens, sources = []) => {
    const agentTeamBudgetTokens = clampTeamBudgetTokens(tokens)
    localStorage.setItem(TEAM_BUDGET_TOKENS_KEY, String(agentTeamBudgetTokens))
    const agentTeamBudgetProfile = 'custom' as const
    localStorage.setItem(AGENT_TEAM_BUDGET_PROFILE_KEY, agentTeamBudgetProfile)
    const current = get().contextBudgetPolicy
    const contextBudgetPolicy = sanitizeContextBudgetPolicy({ ...current, sources: allocateContextBudgetOverrides(agentTeamBudgetTokens, sources) })
    persistBudgetPolicy(contextBudgetPolicy)
    set({ agentTeamBudgetProfile, agentTeamBudgetTokens, contextBudgetPolicy })
  },

  applyContextBudgetPreset: (presetId, sources = []) => {
    const customPreset = get().contextBudgetPresets.find(item => item.id === presetId)
    const totalTokens = customPreset?.totalTokens ?? (
      presetId in AGENT_TEAM_BUDGET_PRESET_META
        ? AGENT_TEAM_BUDGET_PRESET_META[presetId as keyof typeof AGENT_TEAM_BUDGET_PRESET_META].maxTokens
        : get().agentTeamBudgetTokens
    )
    const sourceOverrides = customPreset?.sources ?? allocateContextBudgetOverrides(totalTokens, sources)
    const current = get().contextBudgetPolicy
    const contextBudgetPolicy = sanitizeContextBudgetPolicy({ ...current, sources: sourceOverrides })
    persistBudgetPolicy(contextBudgetPolicy)
    const agentTeamBudgetProfile = (presetId in AGENT_TEAM_BUDGET_PRESET_META ? presetId : 'custom') as AgentTeamBudgetProfile
    const agentTeamBudgetTokens = clampTeamBudgetTokens(totalTokens)
    localStorage.setItem(TEAM_BUDGET_TOKENS_KEY, String(agentTeamBudgetTokens))
    localStorage.setItem(AGENT_TEAM_BUDGET_PROFILE_KEY, agentTeamBudgetProfile)
    const mapVisionOutputBudget = customPreset?.mapVisionOutput
      ? sanitizeMapVisionOutputBudget(customPreset.mapVisionOutput)
      : get().mapVisionOutputBudget
    persistMapVisionOutputBudget(mapVisionOutputBudget)
    set({ contextBudgetPolicy, agentTeamBudgetProfile, agentTeamBudgetTokens, mapVisionOutputBudget })
  },

  saveContextBudgetPreset: name => {
    const id = nanoid()
    const preset: ContextBudgetPreset = {
      id,
      name: name.trim() || '自定义预算',
      totalTokens: get().agentTeamBudgetTokens,
      sources: get().contextBudgetPolicy.sources,
      mapVisionOutput: get().mapVisionOutputBudget,
    }
    const contextBudgetPresets = [...get().contextBudgetPresets, preset]
    saveContextBudgetPresets(contextBudgetPresets)
    localStorage.setItem(AGENT_TEAM_BUDGET_PROFILE_KEY, 'custom')
    set({ contextBudgetPresets, agentTeamBudgetProfile: 'custom' })
    return id
  },

  deleteContextBudgetPreset: id => {
    const contextBudgetPresets = get().contextBudgetPresets.filter(item => item.id !== id)
    saveContextBudgetPresets(contextBudgetPresets)
    set({ contextBudgetPresets })
  },

  setMapVisionOutputBudget: (kind, tokens) => {
    const mapVisionOutputBudget = sanitizeMapVisionOutputBudget({ ...get().mapVisionOutputBudget, [kind]: tokens })
    persistMapVisionOutputBudget(mapVisionOutputBudget)
    set({ mapVisionOutputBudget })
  },

  resetMapVisionOutputBudget: () => {
    const mapVisionOutputBudget = { ...DEFAULT_MAP_VISION_OUTPUT_BUDGET }
    persistMapVisionOutputBudget(mapVisionOutputBudget)
    set({ mapVisionOutputBudget })
  },

  setContextTruncationEnabled: (enabled: boolean) => {
    const contextBudgetPolicy = sanitizeContextBudgetPolicy({
      ...get().contextBudgetPolicy,
      truncationEnabled: enabled,
    })
    persistBudgetPolicy(contextBudgetPolicy)
    set({ contextBudgetPolicy })
  },

  setContextSourceBudget: (sourceKey: string, override: ContextSourceBudgetPolicy | null) => {
    const current = get().contextBudgetPolicy
    const sources = { ...current.sources }
    // null / 全空 = 恢复该源的注册表默认值（不留空对象,便于「已改动」判定）。
    if (override && Object.keys(override).length > 0) sources[sourceKey] = override
    else delete sources[sourceKey]
    const contextBudgetPolicy = sanitizeContextBudgetPolicy({ ...current, sources })
    persistBudgetPolicy(contextBudgetPolicy)
    localStorage.setItem(AGENT_TEAM_BUDGET_PROFILE_KEY, 'custom')
    set({ contextBudgetPolicy, agentTeamBudgetProfile: 'custom' })
  },

  resetContextBudgetPolicy: () => {
    const contextBudgetPolicy = sanitizeContextBudgetPolicy({})
    persistBudgetPolicy(contextBudgetPolicy)
    set({ contextBudgetPolicy })
  },

  switchProvider: (provider: AIProvider) => {
    const preset = PROVIDER_PRESETS[provider] || {}
    const providerChanged = provider !== get().config.provider
    const newConfig: AIConfig = {
      ...get().config,
      provider,
      ...preset,
      // 模型名不硬编码：换服务商时清空，由面板自动获取列表或作者手填，
      // 避免沿用上一个服务商的型号名（换过去必然 404）。
      model: providerChanged ? '' : get().config.model,
      apiKey: providerChanged ? (preset.apiKey || '') : get().config.apiKey,
    }
    persistConfig(newConfig, get().rememberApiKey)
    set({ config: newConfig, activePresetId: null, editingPresetId: null })
  },

  testConnection: async (): Promise<TestResult> => {
    const { config } = get()
    const normalized = normalizeOpenAIBaseUrl(config.baseUrl)
    if (normalized.changed) {
      const newConfig = { ...config, baseUrl: normalized.baseUrl }
      persistConfig(newConfig, get().rememberApiKey)
      set({ config: newConfig, activePresetId: null })
    }
    const url = buildOpenAIEndpoint(normalized.baseUrl, 'chat/completions')
    const startTime = Date.now()
    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), 15_000)

    // 创建日志
    const log = createLog({
      type: 'test',
      provider: config.provider,
      url,
      model: config.model,
      status: 'pending',
    })

    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          messages: [{ role: 'user', content: '请回复"连接成功"' }],
        }),
      })

      const duration = Date.now() - startTime
      const bodyText = await response.text()

      if (response.ok) {
        updateLog(log.id, { status: 'success', statusCode: response.status, duration, responseBody: bodyText.slice(0, 200) })
        const prefix = normalized.warnings.length ? `${normalized.warnings.join(' ')} ` : ''
        return { ok: true, message: `✅ ${prefix}连接成功`, statusCode: response.status, duration }
      }

      // 解析错误信息
      let rawErrorMsg = `HTTP ${response.status}`
      try {
        const errJson = JSON.parse(bodyText)
        if (errJson.error?.message) rawErrorMsg = errJson.error.message
        else if (errJson.message) rawErrorMsg = errJson.message
        else if (errJson.error_msg) rawErrorMsg = errJson.error_msg
      } catch {
        if (bodyText.length < 200) rawErrorMsg += ': ' + bodyText
      }

      // 常见英文错误 → 中文翻译映射
      const cnExplanation = getChineseExplanation(response.status, rawErrorMsg)

      // HTTP 402 = 余额不足，但说明连接和认证都成功了
      if (response.status === 402) {
        const msg = `${rawErrorMsg}（${cnExplanation}）`
        updateLog(log.id, { status: 'success', statusCode: response.status, duration, responseBody: bodyText.slice(0, 200) })
        const prefix = normalized.warnings.length ? `${normalized.warnings.join(' ')} ` : ''
        return { ok: true, message: `✅ ${prefix}连接成功 — ${msg}`, statusCode: response.status, duration }
      }

      const urlHint = normalized.warnings.length
        ? `；${normalized.warnings.join(' ')}`
        : ''
      const localHint = ['custom', 'ollama'].includes(config.provider)
        ? '；本地 OpenAI 兼容服务的 Base URL 通常应填到 /v1，例如 LM Studio: http://主机:1234/v1，Ollama: http://localhost:11434/v1'
        : ''
      const errorMsg = `${cnExplanation ? `${rawErrorMsg}（${cnExplanation}）` : rawErrorMsg}${urlHint}${localHint}`

      updateLog(log.id, { status: 'error', statusCode: response.status, duration, errorMessage: errorMsg, responseBody: bodyText.slice(0, 500) })
      return { ok: false, message: `❌ ${errorMsg}`, statusCode: response.status, duration }

    } catch (err: unknown) {
      const duration = Date.now() - startTime
      const error = err as Error
      let errorMsg: string

      if (error.name === 'TypeError' && error.message.includes('Failed to fetch')) {
        errorMsg = '网络错误 — 可能原因：1) 网络不通 2) 该平台不支持浏览器直接调用(CORS) 3) Base URL 错误'
      } else if (error.name === 'AbortError') {
        errorMsg = '请求超时'
      } else {
        errorMsg = error.message || '未知错误'
      }

      updateLog(log.id, { status: 'error', duration, errorMessage: errorMsg })
      return { ok: false, message: `❌ ${errorMsg}`, duration }
    } finally {
      window.clearTimeout(timeoutId)
    }
  },
}))

// 任何配置变更都同步一次「当前生效窗口」；幂等，不触发额外渲染。
useAIConfigStore.subscribe(state => setActiveContextWindowOverride(state.config.contextWindow))
