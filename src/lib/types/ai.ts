/** AI 提供商 */
export type AIProvider =
  | 'deepseek'
  | 'openai'
  | 'qwen'
  | 'doubao'
  | 'minimax'
  | 'glm'
  | 'wenxin'
  | 'gemini'
  | 'poe'
  | 'kimi'
  | 'claude'
  | 'modelscope'
  | 'nvidia'
  | 'agnes'
  | 'longcat'
  | 'opencode'
  | 'ollama'
  | 'custom'

/** 主 Agent 请求入口模式。默认保留历史关键词/领域路由。 */
export type MasterAgentExecutionMode = 'route-first' | 'agent-first'

/** AI 配置 */
export interface AIConfig {
  provider: AIProvider
  apiKey: string
  model: string
  baseUrl: string
  temperature: number
  maxTokens: number
  /** 主 Agent 入口策略；缺失旧配置按 route-first 兼容。 */
  masterAgentExecutionMode?: MasterAgentExecutionMode
  /** 原生主 Agent 一轮最多请求模型多少次（含协议修正与最终回答）。 */
  masterAgentMaxSteps?: number
  /** 原生主 Agent 一轮最多执行多少次只读工具调用。 */
  masterAgentMaxToolCalls?: number
  /**
   * FB-8:用户手填的「上下文窗口大小」(token),用于本地/自定义模型(LM Studio/Ollama/中转/新模型)。
   * 设了就以它为准,否则按内置预设、再否则 8K 兜底。0/undefined = 用预设。
   */
  contextWindow?: number
  /**
   * 这个窗口数字是怎么来的。`detected` = 服务端 `/v1/models` 报告并自动应用；
   * `manual` = 作者手填。用于在设置页和底栏说清"这个数别是猜的"。
   */
  contextWindowSource?: 'manual' | 'detected'
  /** 服务端报告值的应用时间（仅 source='detected' 时有意义）。 */
  contextWindowDetectedAt?: number
}

/**
 * NS-5 · Embedding（语义检索通道）配置。与聊天 AIConfig 分开存——换写作模型不影响向量。
 * enabled=false（默认）时检索只走关键词通道（优雅降级）。走 OpenAI 兼容 /embeddings 端点。
 */
export interface EmbeddingConfig {
  /** 是否启用语义检索通道（默认 false = 纯关键词，零额外成本/不外传） */
  enabled: boolean
  provider: AIProvider
  apiKey: string
  baseUrl: string
  model: string
}

/** API 配置预设（多套配置一键切换） */
export interface AIConfigPreset {
  id: string
  name: string
  config: AIConfig
}

/** 聊天消息 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** AI 错误 */
export class AIError extends Error {
  status: number
  body: string

  constructor(status: number, body: string) {
    const hint = status === 504 ? '上游网关等待模型响应超时，已自动重试；请稍后再试或切换更快的模型。'
      : status === 502 || status === 503 ? '模型服务暂时不可用，已自动重试；请稍后再试。' : ''
    super(hint ? `AI API Error (${status}): ${hint}` : `AI API Error (${status}): ${body}`)
    this.name = 'AIError'
    this.status = status
    this.body = body
  }
}

/**
 * 提供商预设只描述「端点」，不再内置任何模型名。
 *
 * 模型名（尤其带日期的版本号）更新频繁，写死在代码里必然过期，还会诱导作者选到已下线的型号。
 * 可用模型改由 `fetchOpenAIModels` 从服务端 /v1/models 实时获取（见 lib/ai/model-list.ts），
 * 面板在作者切换服务商/端点/Key 后自动刷新，同时始终允许手动填写。
 * 切换服务商时模型名会被清空，由自动获取或作者手填，避免沿用上一个服务商的型号。
 */
export const PROVIDER_PRESETS: Record<string, Partial<AIConfig>> = {
  deepseek: {
    baseUrl: 'https://api.deepseek.com/v1',
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  doubao: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  minimax: {
    baseUrl: 'https://api.minimax.chat/v1',
  },
  glm: {
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  },
  wenxin: {
    baseUrl: 'https://qianfan.baidubce.com/v2',
  },
  gemini: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  },
  poe: {
    baseUrl: 'https://api.poe.com/v1',
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
  },
  kimi: {
    baseUrl: 'https://api.moonshot.cn/v1',
  },
  claude: {
    baseUrl: 'https://api.anthropic.com/v1',
  },
  nvidia: {
    baseUrl: 'https://integrate.api.nvidia.com/v1',
  },
  modelscope: {
    baseUrl: 'https://api-inference.modelscope.cn/v1',
  },
  agnes: {
    baseUrl: 'https://apihub.agnes-ai.com/v1',
  },
  longcat: {
    baseUrl: 'https://api.longcat.chat/openai/v1',
  },
  opencode: {
    baseUrl: 'https://opencode.ai/zen/go/v1',
  },
  ollama: {
    baseUrl: 'http://localhost:11434/v1',
    apiKey: 'ollama',
  },
}
