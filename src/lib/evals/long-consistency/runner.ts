import { buildChapterContentPrompt, buildContinuePrompt, buildExpandPrompt } from '../../ai/adapters/chapter-adapter'
import { prepareChapterMemoryRequest, parseChapterMemoryOutput } from '../../ai/adapters/chapter-memory-adapter'
import { formatHandoff } from '../../ai/chapter-memory/handoff-format'
import { estimateTokens } from '../../ai/context-budget'
import type { AIConfig, ChatMessage } from '../../types'
import type { TokenUsage } from '../../ai/logger'
import type {
  AggregateScore,
  BuiltEvalCase,
  CaseScore,
  EvalBudgetMode,
  EvalRunRecord,
  EvalSplit,
  EvalVariant,
  LongConsistencyFixture,
} from './types'

export const NS1_ACCEPTANCE_THRESHOLDS = Object.freeze({
  futureLeakageRate: 0,
  wrongWorldLeakageRate: 0,
  minimumRequiredFactRecall: 0.85,
  minimumConstraintRecall: 0.85,
  minimumEvidenceCitationRecall: 0.9,
  maximumEstimatedInputTokenMultiplierVsLegacy: 1.6,
  minimumFactRecallImprovementVsLegacy: 0.1,
})

export const NS0_FIXED_MAX_TOKENS = 1200
export const NS0_RESULTS_STORAGE_KEY = 'storyforge-ns0-long-consistency-results-v5'
// Bump this key for each sealed held-out attempt. Earlier versions remain in
// browser storage as audit records and are never reused for tuning.
export const NS0_PAIRED_RESULTS_STORAGE_KEY = 'storyforge-ns0-long-consistency-paired-v5'

export interface Ns1GateResult {
  passed: boolean
  failures: string[]
}

export function evaluateNs1Gate(
  legacy: EvalRunRecord,
  candidate: EvalRunRecord,
  options: { requireFactImprovement?: boolean } = {},
): Ns1GateResult {
  const failures: string[] = []
  const metrics = candidate.aggregate
  if (metrics.futureLeakageRate > NS1_ACCEPTANCE_THRESHOLDS.futureLeakageRate) failures.push('future-leakage')
  if (metrics.wrongWorldLeakageRate > NS1_ACCEPTANCE_THRESHOLDS.wrongWorldLeakageRate) failures.push('wrong-world-leakage')
  if (metrics.requiredFactRecall < NS1_ACCEPTANCE_THRESHOLDS.minimumRequiredFactRecall) failures.push('fact-recall')
  if (metrics.constraintRecall < NS1_ACCEPTANCE_THRESHOLDS.minimumConstraintRecall) failures.push('constraint-recall')
  if (
    metrics.evidenceCitationRecall != null
    && metrics.evidenceCitationRecall < NS1_ACCEPTANCE_THRESHOLDS.minimumEvidenceCitationRecall
  ) failures.push('evidence-citation')
  if (
    metrics.estimatedInputTokens
    > legacy.aggregate.estimatedInputTokens * NS1_ACCEPTANCE_THRESHOLDS.maximumEstimatedInputTokenMultiplierVsLegacy
  ) failures.push('input-cost')
  if (
    options.requireFactImprovement !== false
    &&
    metrics.requiredFactRecall - legacy.aggregate.requiredFactRecall
    < NS1_ACCEPTANCE_THRESHOLDS.minimumFactRecallImprovementVsLegacy
  ) failures.push('fact-improvement')
  return { passed: failures.length === 0, failures }
}

/**
 * 候选变体喂给模型的"历史记忆"——由生产抽取器从【上一章真实正文】现抽，
 * 绝不注入夹具的 requiredFacts/requiredConstraints（那是评分答案）。
 * 这样 A/B 测的才是"从正文抽 handoff/摘要到底有没有把该带的事实带过去"，
 * 而不是"把答案抄给模型它会不会复述"。
 */
export interface ExtractedEvalMemory {
  handoffText: string
  summaryText: string
  extractionInputTokens: number | null
  extractionOutputTokens: number | null
  extractionInputChars: number
  extractionOutputChars: number
}

export const EMPTY_EVAL_MEMORY: ExtractedEvalMemory = {
  handoffText: '',
  summaryText: '',
  extractionInputTokens: null,
  extractionOutputTokens: null,
  extractionInputChars: 0,
  extractionOutputChars: 0,
}

function evalExtractionSource(fixture: LongConsistencyFixture): string {
  return fixture.previousChapterText || fixture.existingContent || fixture.selectedText || ''
}

/**
 * 对非 legacy 变体，调真实 chapter.memory 抽取器从上一章正文产出 handoff/摘要。
 * 抽取本身要花一次模型调用——其 token 必须计入候选成本，A/B 成本比较才诚实。
 */
export async function extractEvalMemory(
  fixture: LongConsistencyFixture,
  variant: EvalVariant,
  call: (messages: ChatMessage[], config: AIConfig) => Promise<{ output: string; usage?: TokenUsage }>,
  config: AIConfig,
): Promise<ExtractedEvalMemory> {
  if (variant === 'legacy-500-tail') return EMPTY_EVAL_MEMORY
  const source = evalExtractionSource(fixture)
  if (!source.trim()) return EMPTY_EVAL_MEMORY

  const prepared = await prepareChapterMemoryRequest(fixture.title, source)
  const response = await call(prepared.messages, { ...config, temperature: 0.1 })
  const extractionInputChars = prepared.messages.reduce((sum, message) => sum + message.content.length, 0)
  const extractionOutputChars = response.output.length
  const parsed = parseChapterMemoryOutput({
    raw: response.output,
    chapterId: 0,
    normalizedText: prepared.normalizedText,
    sourceTextHash: prepared.sourceTextHash,
  })
  if (!parsed) {
    // 抽取失败是真实信号（handoff 可能抽不出）——候选此时退化为 tail-only。
    return {
      ...EMPTY_EVAL_MEMORY,
      extractionInputTokens: response.usage?.inputTokens ?? null,
      extractionOutputTokens: response.usage?.outputTokens ?? null,
      extractionInputChars,
      extractionOutputChars,
    }
  }
  return {
    handoffText: variant === 'handoff-tail-summary' ? formatHandoff(parsed.handoff).join('\n') : '',
    summaryText: parsed.summary,
    extractionInputTokens: response.usage?.inputTokens ?? null,
    extractionOutputTokens: response.usage?.outputTokens ?? null,
    extractionInputChars,
    extractionOutputChars,
  }
}

function buildEvalContinuity(fixture: LongConsistencyFixture, variant: EvalVariant, memory: ExtractedEvalMemory) {
  if (variant === 'legacy-500-tail') return undefined
  return {
    handoff: memory.handoffText || undefined,
    previousTail: fixture.task === 'completion'
      ? fixture.previousChapterText.slice(-500)
      : undefined,
    recentSummaries: memory.summaryText
      ? `【当前世界最近已验证章节摘要】\n${memory.summaryText}`
      : undefined,
  }
}

/** expansion 任务的 builder 不吃 continuity 选项，对它把真实抽取记忆追加到末尾（非答案）。 */
function appendRealContinuity(messages: ChatMessage[], memory: ExtractedEvalMemory): ChatMessage[] {
  const extras = [memory.summaryText, memory.handoffText].filter(Boolean)
  if (!extras.length) return messages
  return messages.map((message, index) => {
    if (index !== messages.length - 1 || message.role !== 'user') return message
    return { ...message, content: `${message.content}\n\n【前文连续性记忆】\n${extras.join('\n')}` }
  })
}

export function buildEvalCase(
  fixture: LongConsistencyFixture,
  variant: EvalVariant,
  memory: ExtractedEvalMemory = EMPTY_EVAL_MEMORY,
): BuiltEvalCase {
  let messages: ChatMessage[]
  let builder: BuiltEvalCase['productionSnapshot']['builder']
  let previousTailChars = 0

  if (fixture.task === 'completion') {
    const previousTail = fixture.previousChapterText.slice(-500)
    previousTailChars = previousTail.length
    builder = 'chapter.content'
    messages = buildChapterContentPrompt(
      fixture.title,
      fixture.chapterSummary,
      fixture.worldContext,
      fixture.characterContext,
      previousTail,
      '',
      fixture.userHint,
      {
        parameterValues: { chapterLength: 800, pace: '中', tone: '严肃' },
        continuity: buildEvalContinuity(fixture, variant, memory),
        continuityBudgetTokens: 3000,
        skipContinuityEnvelope: variant === 'legacy-500-tail',
      },
    )
  } else if (fixture.task === 'continuation') {
    builder = 'chapter.continue'
    messages = buildContinuePrompt(
      fixture.existingContent,
      fixture.chapterSummary,
      `${fixture.worldContext}\n\n涉及角色：\n${fixture.characterContext}`,
      fixture.userHint,
      {
        parameterValues: { continueLength: 800, pace: '中', tone: '严肃' },
        continuity: buildEvalContinuity(fixture, variant, memory),
        continuityBudgetTokens: 3000,
        skipContinuityEnvelope: variant === 'legacy-500-tail',
      },
    )
  } else {
    builder = 'chapter.expand'
    messages = buildExpandPrompt(
      fixture.selectedText,
      fixture.userHint,
      { parameterValues: { expandRatio: '1.5x', addType: '动作细节' } },
    )
  }

  const finalMessages = fixture.task === 'expansion' && variant !== 'legacy-500-tail'
    ? appendRealContinuity(messages, memory)
    : messages
  return {
    fixtureId: fixture.id,
    variant,
    messages: finalMessages,
    inputChars: finalMessages.reduce((sum, message) => sum + message.content.length, 0),
    productionSnapshot: {
      task: fixture.task,
      previousTailChars,
      builder,
    },
  }
}

function findMatches(text: string, entries: Array<{ id: string; aliases: string[] }>): string[] {
  const normalized = text.toLocaleLowerCase()
  return entries
    .filter(entry => entry.aliases.some(alias => normalized.includes(alias.toLocaleLowerCase())))
    .map(entry => entry.id)
}

export function scoreOutput(fixture: LongConsistencyFixture, output: string): CaseScore {
  const matchedRequiredFacts = findMatches(output, fixture.requiredFacts)
  const matchedConstraints = findMatches(output, fixture.requiredConstraints)
  const leakedFutureFacts = findMatches(output, fixture.forbiddenFutureFacts)
  const leakedForeignWorldFacts = findMatches(output, fixture.forbiddenForeignWorldFacts)
  const citedEvidenceIds = fixture.evidenceIds.filter(id => output.includes(`[证据:${id}]`))

  return {
    fixtureId: fixture.id,
    requiredFactRecall: fixture.requiredFacts.length === 0 ? 1 : matchedRequiredFacts.length / fixture.requiredFacts.length,
    constraintRecall: fixture.requiredConstraints.length === 0 ? 1 : matchedConstraints.length / fixture.requiredConstraints.length,
    futureLeakage: leakedFutureFacts.length > 0,
    wrongWorldLeakage: leakedForeignWorldFacts.length > 0,
    evidenceCitationRecall: fixture.evidenceIds.length === 0 ? null : citedEvidenceIds.length / fixture.evidenceIds.length,
    matchedRequiredFacts,
    matchedConstraints,
    leakedFutureFacts,
    leakedForeignWorldFacts,
    citedEvidenceIds,
  }
}

export function aggregateScores(
  results: EvalRunRecord['results'],
): AggregateScore {
  const evidenceScores = results
    .map(result => result.score.evidenceCitationRecall)
    .filter((value): value is number => value !== null)
  const count = results.length || 1

  return {
    caseCount: results.length,
    requiredFactRecall: results.reduce((sum, result) => sum + result.score.requiredFactRecall, 0) / count,
    constraintRecall: results.reduce((sum, result) => sum + result.score.constraintRecall, 0) / count,
    futureLeakageRate: results.filter(result => result.score.futureLeakage).length / count,
    wrongWorldLeakageRate: results.filter(result => result.score.wrongWorldLeakage).length / count,
    evidenceCitationRecall: evidenceScores.length === 0
      ? null
      : evidenceScores.reduce((sum, value) => sum + value, 0) / evidenceScores.length,
    estimatedInputTokens: results.reduce(
      (sum, result) => sum + (result.inputTokens ?? Math.round(result.inputChars * 0.75)),
      0,
    ),
    estimatedOutputTokens: results.reduce(
      (sum, result) => sum + (result.outputTokens ?? estimateTokens(result.output)),
      0,
    ),
  }
}

/** 两段 token 用量相加；只有都缺失才返回 null（用于把抽取调用成本并入候选）。 */
function combineTokens(a: number | null, b: number | null): number | null {
  if (a == null && b == null) return null
  return (a ?? 0) + (b ?? 0)
}

export async function runEvalInBrowser(args: {
  fixtures: LongConsistencyFixture[]
  split: EvalSplit
  variant: EvalVariant
  budgetMode: EvalBudgetMode
  config: AIConfig
  call: (
    messages: ChatMessage[],
    config: AIConfig,
  ) => Promise<{ output: string; usage?: TokenUsage }>
  judge?: (
    fixture: LongConsistencyFixture,
    output: string,
    config: AIConfig,
  ) => Promise<CaseScore>
  onProgress?: (completed: number, total: number) => void
  persistStandalone?: boolean
}): Promise<EvalRunRecord> {
  const results: EvalRunRecord['results'] = []
  const runConfig = {
    ...args.config,
    maxTokens: args.budgetMode === 'fixed' ? NS0_FIXED_MAX_TOKENS : args.config.maxTokens,
    temperature: 0.2,
  }

  for (const fixture of args.fixtures) {
    const startedAt = performance.now()
    // 候选变体先从上一章真实正文抽 handoff/摘要（真实管线，不喂答案），再生成。
    const memory = await extractEvalMemory(fixture, args.variant, args.call, runConfig)
    const built = buildEvalCase(fixture, args.variant, memory)
    const response = await args.call(built.messages, runConfig)
    const score = args.judge
      ? await args.judge(fixture, response.output, runConfig)
      : scoreOutput(fixture, response.output)
    results.push({
      fixtureId: fixture.id,
      messages: built.messages,
      productionSnapshot: built.productionSnapshot,
      output: response.output,
      // 候选成本诚实计入抽取那次调用（输入正文 + 输出 handoff JSON）。
      inputChars: built.inputChars + memory.extractionInputChars,
      outputChars: response.output.length + memory.extractionOutputChars,
      inputTokens: combineTokens(response.usage?.inputTokens ?? null, memory.extractionInputTokens),
      outputTokens: combineTokens(response.usage?.outputTokens ?? null, memory.extractionOutputTokens),
      durationMs: Math.round(performance.now() - startedAt),
      score,
    })
    args.onProgress?.(results.length, args.fixtures.length)
  }

  const record: EvalRunRecord = {
    schemaVersion: 1,
    runId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    provider: args.config.provider,
    model: args.config.model,
    variant: args.variant,
    split: args.split,
    budgetMode: args.budgetMode,
    configuredMaxTokens: runConfig.maxTokens,
    results,
    aggregate: aggregateScores(results),
  }
  if (args.persistStandalone !== false) {
    localStorage.setItem(NS0_RESULTS_STORAGE_KEY, JSON.stringify(record))
  }
  return record
}

export async function runPairedEvalInBrowser(args: {
  fixtures: LongConsistencyFixture[]
  split: EvalSplit
  variants: [EvalVariant, EvalVariant]
  config: AIConfig
  call: (
    messages: ChatMessage[],
    config: AIConfig,
  ) => Promise<{ output: string; usage?: TokenUsage }>
  judge?: (
    fixture: LongConsistencyFixture,
    output: string,
    config: AIConfig,
  ) => Promise<CaseScore>
  onRunComplete?: (record: EvalRunRecord, completed: number, total: number) => void
  onCaseProgress?: (
    completedRuns: number,
    totalRuns: number,
    completedCases: number,
    totalCases: number,
  ) => void
}): Promise<EvalRunRecord[]> {
  const records: EvalRunRecord[] = []
  const modes: EvalBudgetMode[] = ['fixed', 'natural']
  const total = args.variants.length * modes.length

  for (const budgetMode of modes) {
    for (const variant of args.variants) {
      const record = await runEvalInBrowser({
        fixtures: args.fixtures,
        split: args.split,
        variant,
        budgetMode,
        config: args.config,
        call: args.call,
        judge: args.judge,
        persistStandalone: false,
        onProgress: (completedCases, totalCases) => {
          args.onCaseProgress?.(records.length, total, completedCases, totalCases)
        },
      })
      records.push(record)
      // 逐条持久化：agnes 免费版慢 + 面板卸载/超时易中断整轮，每完成一个变体就落盘，
      // 中断也保住已完成的，避免整轮白跑。
      localStorage.setItem(NS0_PAIRED_RESULTS_STORAGE_KEY, JSON.stringify(records))
      args.onRunComplete?.(record, records.length, total)
    }
  }

  localStorage.setItem(NS0_PAIRED_RESULTS_STORAGE_KEY, JSON.stringify(records))
  return records
}
