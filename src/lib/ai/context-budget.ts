/**
 * 上下文窗口预算管理
 *
 * Phase 21.3：
 * - 模型上下文窗口预设（各平台/模型的 maxContext）
 * - Token 估算（中文 ≈ 1.5 token/字）
 * - 分层注入策略（L0 常驻 → L1 核心 → L2 扩展 → L3 增强）
 * - 预算计算与自动裁剪
 */

import type { AIProvider, ChatMessage } from '../types'
import { log } from '../logging/logger'
import {
  CONTINUITY_CORE_END,
  CONTINUITY_CORE_START,
} from './chapter-memory/continuity-envelope'

// ── 模型上下文窗口预设 ──────────────────────────────

export interface ModelContextPreset {
  label: string
  maxContext: number // 最大上下文 token
  maxOutput: number  // 最大输出 token
}

/**
 * 各服务商的默认上下文窗口（键 = provider）。
 *
 * 这里**不再登记具体模型名**：模型名更新频繁，精确键必然过期。
 * 具体型号的差异由 `MODEL_WINDOW_RULES` 按名称族匹配；作者的「上下文窗口」设置优先于两者。
 */
export const MODEL_CONTEXT_PRESETS: Record<string, ModelContextPreset> = {
  deepseek: { label: 'DeepSeek 默认', maxContext: 64_000, maxOutput: 8_192 },
  gemini: { label: 'Gemini 默认', maxContext: 1_000_000, maxOutput: 65_536 },
  openai: { label: 'OpenAI 默认', maxContext: 128_000, maxOutput: 16_384 },
  claude: { label: 'Claude 默认', maxContext: 200_000, maxOutput: 8_192 },
  qwen: { label: 'Qwen 默认', maxContext: 32_000, maxOutput: 8_192 },
  kimi: { label: 'Kimi 默认', maxContext: 8_000, maxOutput: 4_096 },
  doubao: { label: '豆包默认', maxContext: 32_000, maxOutput: 4_096 },
  glm: { label: 'GLM 默认', maxContext: 128_000, maxOutput: 4_096 },
  minimax: { label: 'MiniMax 默认', maxContext: 245_000, maxOutput: 16_384 },
  nvidia: { label: 'NVIDIA NIM 默认', maxContext: 128_000, maxOutput: 4_096 },
  agnes: { label: 'Agnes 默认', maxContext: 1_000_000, maxOutput: 8_192 },
  longcat: { label: 'LongCat 默认', maxContext: 1_000_000, maxOutput: 128_000 },
  opencode: { label: 'OpenCode Go 默认', maxContext: 128_000, maxOutput: 8_192 },
  modelscope: { label: 'ModelScope 默认', maxContext: 32_000, maxOutput: 8_192 },
  ollama: { label: 'Ollama 默认', maxContext: 8_000, maxOutput: 4_096 },
  poe: { label: 'Poe 默认', maxContext: 128_000, maxOutput: 4_096 },
  wenxin: { label: '文心默认', maxContext: 8_000, maxOutput: 4_096 },
}

/**
 * 按模型名称族推断窗口大小；规则自上而下匹配，先命中者胜。
 *
 * 只写名字里稳定存在的部分（flash / pro / 128k / claude ...），不写具体版本号，
 * 因此上游发布新版本时无需改代码。作者仍可用设置里的「上下文窗口」覆盖推断结果。
 */
const MODEL_WINDOW_RULES: Array<{ test: (model: string) => boolean; preset: ModelContextPreset }> = [
  { test: m => /(^|[-_])1m($|[-_])/i.test(m), preset: { label: '百万级上下文模型', maxContext: 1_000_000, maxOutput: 65_536 } },
  { test: m => /(^|[-_])256k($|[-_])/i.test(m), preset: { label: '256K 窗口', maxContext: 256_000, maxOutput: 8_192 } },
  { test: m => /(^|[-_])128k($|[-_])/i.test(m), preset: { label: '128K 窗口', maxContext: 128_000, maxOutput: 8_192 } },
  { test: m => /(^|[-_])32k($|[-_])/i.test(m), preset: { label: '32K 窗口', maxContext: 32_000, maxOutput: 4_096 } },
  { test: m => /(^|[-_])8k($|[-_])/i.test(m), preset: { label: '8K 窗口', maxContext: 8_000, maxOutput: 4_096 } },
  { test: m => /gemini|longcat|agnes/i.test(m), preset: { label: '百万级上下文模型', maxContext: 1_000_000, maxOutput: 65_536 } },
  { test: m => /claude|opus|sonnet|haiku/i.test(m), preset: { label: 'Claude 家族', maxContext: 200_000, maxOutput: 8_192 } },
  { test: m => /gpt-4o-mini|4o-mini/i.test(m), preset: { label: 'GPT-4o Mini', maxContext: 128_000, maxOutput: 16_384 } },
  { test: m => /gpt-|chatgpt|^o[1-9](-|$)/i.test(m), preset: { label: 'OpenAI 家族', maxContext: 128_000, maxOutput: 16_384 } },
  // DeepSeek：只有带现代版本标记的名字才按 128K，其余交给 provider 保守默认（64K）。
  // 注意顺序：`flash` 必须排在 `v\d` 之前，否则 `deepseek-v4-flash` 会先命中推理分支，
  // 拿到推理模型才需要的 16K 输出预留（窗口相同，但输出预算被白白吃掉一半）。
  { test: m => /deepseek.*(flash|chat-v\d)/i.test(m), preset: { label: 'DeepSeek 家族', maxContext: 128_000, maxOutput: 8_192 } },
  { test: m => /deepseek.*(v\d|pro|reasoner|r1)/i.test(m), preset: { label: 'DeepSeek 推理模型', maxContext: 128_000, maxOutput: 16_384 } },
  { test: m => /llama|mistral|nemotron|gemma|kimi|moonshot|glm|mimo/i.test(m), preset: { label: '通用开源模型', maxContext: 128_000, maxOutput: 8_192 } },
]

/** 获取模型的上下文窗口预设：名称族规则 → provider 默认 → 兜底。 */
export function getModelPreset(provider: AIProvider, model: string): ModelContextPreset {
  const name = (model ?? '').trim()
  if (name) {
    const rule = MODEL_WINDOW_RULES.find(candidate => candidate.test(name))
    if (rule) return rule.preset
  }
  const fallback = MODEL_CONTEXT_PRESETS[provider]
  if (fallback) return fallback
  return { label: '未知模型', maxContext: 8_000, maxOutput: 4_096 }
}

/** 窗口数字的来源，决定界面上那句"这个数是怎么来的"。 */
export type ModelWindowSource = 'manual' | 'detected' | 'name-rule' | 'provider-default' | 'fallback'

export interface ResolvedModelWindow extends ModelContextPreset {
  source: ModelWindowSource
  /** 面向作者的一句话说明，直接显示在底栏 tooltip 与设置页。 */
  description: string
}

/**
 * AI 配置 store 写入的「当前生效窗口」。
 *
 * 为什么需要它：`contextWindow` 是**当前所选模型**的配置，但上下文装配
 * （`assemble-context.ts`）只拿到 provider/model，拿不到配置对象。若不在这里共享，
 * 作者为 1M 窗口模型填的值会被名称族规则（如 DeepSeek 家族 128K）压回去，
 * 表现为"设置里填了 1M，实际仍按 128K 裁剪"。
 */
let activeContextWindowOverride: number | undefined

export function setActiveContextWindowOverride(value?: number): void {
  activeContextWindowOverride = value && value > 0 ? Math.floor(value) : undefined
}

export function getActiveContextWindowOverride(): number | undefined {
  return activeContextWindowOverride
}

/**
 * 解析实际生效的上下文窗口。
 *
 * 优先级（高 → 低）：
 *   1. 本次调用显式传入的覆盖值（设置页手填 / 服务端报告并已应用）；
 *   2. 配置 store 的当前生效值（同一份设置，供只拿到 provider/model 的调用点使用）；
 *   3. 模型名称里的稳定标记（`1m` / `128k` / `256k` …）；
 *   4. 模型名称族（claude / gpt / deepseek …）；
 *   5. 服务商默认；
 *   6. 8K 兜底。
 *
 * 名称族只是**猜测**：服务端 `/v1/models` 报告了真实窗口时（`detected`）它必须让位，
 * 否则会出现"选了 1M 模型、底栏却显示 128K"这类误导（真实事故）。
 */
export function resolveModelWindow(
  provider: AIProvider,
  model: string,
  override?: number,
  overrideSource: 'manual' | 'detected' = 'manual',
): ResolvedModelWindow {
  const preset = getModelPreset(provider, model)
  const explicit = override && override > 0 ? Math.floor(override) : undefined
  if (explicit) {
    return {
      ...preset,
      maxContext: explicit,
      maxOutput: Math.min(preset.maxOutput, Math.floor(explicit * 0.5)),
      source: overrideSource,
      description: overrideSource === 'detected'
        ? `服务端报告的窗口 ${explicit.toLocaleString()} token`
        : `按你的设置使用 ${explicit.toLocaleString()} token`,
    }
  }
  const name = (model ?? '').trim()
  const named = name ? MODEL_WINDOW_RULES.find(rule => rule.test(name)) : undefined
  if (named) {
    return { ...preset, source: 'name-rule', description: `按模型名推断（${preset.label}）` }
  }
  if (MODEL_CONTEXT_PRESETS[provider]) {
    return { ...preset, source: 'provider-default', description: `按服务商默认（${preset.label}）` }
  }
  return { ...preset, source: 'fallback', description: '无法识别该模型，按 8K 保守计算' }
}
// ── Token 估算 ──────────────────────────────────────

/**
 * 估算中文文本的 token 数
 * 中文约 1.5 token/字（BPE 编码特性），英文约 1.3 token/word
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  // 粗略区分中英文
  const cjkCount = (text.match(/[一-鿿㐀-䶿]/g) || []).length
  const otherLen = text.length - cjkCount
  // CJK: ~1.5 token/字; ASCII: ~0.25 token/char (4 chars ≈ 1 token)
  return Math.round(cjkCount * 1.5 + otherLen * 0.25)
}

// ── 上下文分层策略 ──────────────────────────────────

/**
 * 注入层级定义：
 * - L0 常驻：system prompt 基础指令（不可裁剪）
 * - L1 核心：故事核心 + 当前章节细纲 + 上一章结尾
 * - L2 扩展：世界观 + 角色 + 伏笔
 * - L3 增强：参考作品风格 + few-shot 示例 + 记忆系统
 */
export type ContextLayer = 'L0' | 'L1' | 'L2' | 'L3'

export interface ContextSegment {
  /** 段落标签（显示用） */
  label: string
  /** 注入层级 */
  layer: ContextLayer
  /** 内容文本 */
  content: string
  /** 估算的 token 数 */
  tokens: number
  /** 是否可裁剪 */
  trimmable: boolean
}

/** 从 prompt messages 解析上下文段 */
export function analyzeContextSegments(
  parts: { label: string; content: string; layer: ContextLayer }[],
): ContextSegment[] {
  return parts.map(p => ({
    ...p,
    tokens: estimateTokens(p.content),
    trimmable: p.layer !== 'L0',
  }))
}

/** 上下文预算计算结果 */
export interface ContextBudget {
  /** 模型最大上下文 */
  maxContext: number
  /** 模型最大输出 */
  maxOutput: number
  /** 可用于输入的 token（= maxContext - maxOutput - 安全边际） */
  inputBudget: number
  /** 各段的 token 占用 */
  segments: ContextSegment[]
  /** 总输入 token */
  totalInputTokens: number
  /** 使用率 (0-1) */
  usageRatio: number
  /** 是否超窗口 */
  overBudget: boolean
  /** 安全边际 token（预留 5%） */
  safetyMargin: number
}

/** 计算上下文预算
 * @param contextWindowOverride FB-8:用户为本地/自定义模型手填的上下文窗口(token)。
 *   优先级:用户显式设置(>0) > 内置预设 > 8K 兜底。修复"本地256K模型被当8K、误报超窗"。
 */
export function calculateBudget(
  provider: AIProvider,
  model: string,
  segments: ContextSegment[],
  contextWindowOverride?: number,
): ContextBudget {
  const preset = getModelPreset(provider, model)
  // 显式参数 > store 写入的当前生效值 > 名称族/服务商预设。
  const effectiveOverride = (contextWindowOverride && contextWindowOverride > 0)
    ? contextWindowOverride
    : getActiveContextWindowOverride()
  const maxContext = effectiveOverride ?? preset.maxContext
  // 输出预留不超过窗口一半(用户填的窗口若较小时收敛,避免 inputBudget 变负)
  const maxOutput = Math.min(preset.maxOutput, Math.floor(maxContext * 0.5))
  const safetyMargin = Math.round(maxContext * 0.05) // 5% 安全边际
  // 夹到 0：窗口极小时（例如手填 7000 且模型输出预留 4096）公式会算出负数，
  // 负数预算会让使用率/超窗判定失去意义。
  const inputBudget = Math.max(0, maxContext - maxOutput - safetyMargin)
  const totalInputTokens = segments.reduce((sum, s) => sum + s.tokens, 0)

  return {
    maxContext,
    maxOutput,
    inputBudget,
    segments,
    totalInputTokens,
    usageRatio: inputBudget > 0 ? totalInputTokens / inputBudget : 0,
    overBudget: totalInputTokens > inputBudget,
    safetyMargin,
  }
}

/**
 * 自动裁剪：从 L3 → L2 逐层删除，直到 fit
 * 返回新的 segments 列表（不修改原数组）
 */
export function autoTrimToFit(
  budget: ContextBudget,
): { segments: ContextSegment[]; trimmedLayers: ContextLayer[] } {
  if (!budget.overBudget) {
    return { segments: budget.segments, trimmedLayers: [] }
  }

  const trimmedLayers: ContextLayer[] = []
  let remaining = [...budget.segments]
  let total = budget.totalInputTokens

  // L3 → L2 → L1 按优先级裁剪
  for (const layer of ['L3', 'L2', 'L1'] as ContextLayer[]) {
    if (total <= budget.inputBudget) break
    const layerSegments = remaining.filter(s => s.layer === layer && s.trimmable)
    if (layerSegments.length > 0) {
      const trimmedTokens = layerSegments.reduce((sum, s) => sum + s.tokens, 0)
      remaining = remaining.filter(s => s.layer !== layer || !s.trimmable)
      total -= trimmedTokens
      trimmedLayers.push(layer)
    }
  }

  return { segments: remaining, trimmedLayers }
}

export interface TrimmedMessagesResult {
  messages: ChatMessage[]
  trimmed: boolean
  totalInputTokens: number
  inputBudget: number
  protectedEnvelopePreserved: boolean
}

/** True request-side trimming used before fetch, not only for the UI budget preview. */
export function trimMessagesToFit(
  messages: ChatMessage[],
  provider: AIProvider,
  model: string,
  maxOutput?: number,
  contextWindowOverride?: number,
): TrimmedMessagesResult {
  const preset = getModelPreset(provider, model)
  const effectiveOverride = (contextWindowOverride && contextWindowOverride > 0)
    ? contextWindowOverride
    : getActiveContextWindowOverride()
  const maxContext = effectiveOverride ?? preset.maxContext
  // 作者手填的 maxTokens 可能比窗口还大（例如窗口 7000、maxTokens 8192）：
  // 此时输出预留不能把输入预算吃成负数，至少给输入留出窗口的一部分。
  const requestedOutput = maxOutput && maxOutput > 0 ? maxOutput : Math.min(preset.maxOutput, Math.floor(maxContext * 0.5))
  const outputBudget = Math.min(requestedOutput, Math.max(0, maxContext - Math.floor(maxContext * 0.2)))
  const safetyMargin = Math.round(maxContext * 0.05)
  const inputBudget = Math.max(0, maxContext - outputBudget - safetyMargin)
  if (requestedOutput > outputBudget || inputBudget <= 0) {
    log.warn('AI', 'ai.context.budget.exhausted', '上下文窗口装不下请求的输出预留：已压缩输出并保证输入预算非负', {
      provider,
      model,
      maxContext,
      requestedOutput,
      outputBudget,
      safetyMargin,
      inputBudget,
    })
  }
  const copy = messages.map(message => ({ ...message }))
  let total = copy.reduce((sum, message) => sum + estimateTokens(message.content), 0)
  let trimmed = false

  let guard = 0
  while (total > inputBudget && guard++ < copy.length * 3) {
    const index = copy.findIndex(message =>
      message.role !== 'system' && message.content !== '（此段因上下文窗口限制已裁剪）')
    if (index < 0) break
    const tokens = estimateTokens(copy[index].content)
    const overflow = total - inputBudget
    if (tokens <= overflow + 128) {
      copy[index].content = '（此段因上下文窗口限制已裁剪）'
    } else {
      const keepTokens = Math.max(64, tokens - overflow - 128)
      copy[index].content = trimTextToApproxTokensPreservingContinuity(copy[index].content, keepTokens)
    }
    total = copy.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    trimmed = true
  }

  const protectedBlocks = messages.flatMap(message => extractContinuityBlocks(message.content))
  const protectedEnvelopePreserved = total <= inputBudget && protectedBlocks.every(block =>
    copy.some(message => message.content.includes(block))
  )
  return { messages: copy, trimmed, totalInputTokens: total, inputBudget, protectedEnvelopePreserved }
}

function extractContinuityBlocks(text: string): string[] {
  const blocks: string[] = []
  let searchFrom = 0
  while (searchFrom < text.length) {
    const start = text.indexOf(CONTINUITY_CORE_START, searchFrom)
    if (start < 0) break
    const end = text.indexOf(CONTINUITY_CORE_END, start)
    if (end < 0) break
    const block = text.slice(start, end + CONTINUITY_CORE_END.length)
    blocks.push(block)
    searchFrom = end + CONTINUITY_CORE_END.length
  }
  return blocks
}

function trimTextToApproxTokensPreservingContinuity(text: string, keepTokens: number): string {
  const blocks = extractContinuityBlocks(text)
  if (!blocks.length) return trimTextToApproxTokens(text, keepTokens)
  const protectedBlock = blocks[blocks.length - 1]
  const protectedTokens = estimateTokens(protectedBlock)
  if (protectedTokens > keepTokens) {
    // 调用方会通过 protectedEnvelopePreserved=false 明确拒绝该物理窗口。
    return trimTextToApproxTokens(protectedBlock, keepTokens)
  }
  const prefix = text.slice(0, text.lastIndexOf(protectedBlock))
  const remainingTokens = Math.max(0, keepTokens - protectedTokens - 16)
  const keptPrefix = remainingTokens > 0 ? trimTextToApproxTokens(prefix, remainingTokens) : ''
  return [keptPrefix, protectedBlock].filter(Boolean).join('\n')
}

function trimTextToApproxTokens(text: string, keepTokens: number): string {
  if (estimateTokens(text) <= keepTokens) return text
  let lo = 0
  let hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate = text.slice(text.length - mid)
    if (estimateTokens(candidate) <= keepTokens) lo = mid
    else hi = mid - 1
  }
  return `（前文因上下文窗口限制已裁剪）\n${text.slice(text.length - lo)}`
}

/** 格式化 token 数为人类可读 */
export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

/** 获取使用率对应的颜色等级 */
export function getBudgetColorClass(ratio: number): string {
  if (ratio >= 0.95) return 'text-error'
  if (ratio >= 0.8) return 'text-warning'
  if (ratio >= 0.6) return 'text-yellow-400'
  return 'text-success'
}

export function getBudgetBgClass(ratio: number): string {
  if (ratio >= 0.95) return 'bg-error'
  if (ratio >= 0.8) return 'bg-warning'
  if (ratio >= 0.6) return 'bg-yellow-400'
  return 'bg-success'
}
