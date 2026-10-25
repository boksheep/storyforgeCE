/**
 * PROMPT-PLAN-1 · 生成前协商面板。
 *
 * 两步（与计划一致）：
 *   ① 摘要：读本章大纲 + 前情，产出一段可编辑的"本章打算怎么写"；
 *   ② 需求 + 计划：依据确认后的摘要，让模型申报所需上下文并给出写作计划；
 *      面板把申报与闭集目录比对，逐项显示"已接受 / 未登记（拒绝）/ 不可用 / 被截断"，
 *      并给出真实装配的 token 预估。
 *
 * 边界：
 * - 两次调用都经 `GenerationNode`（冻结输入快照）+ `AgentTeamBudgetTracker`（记账与硬闸），
 *   模型调用由父级注入（`call`），本组件不自己读 AI 配置。
 * - 产物全部是组件 state：不落库、不写模板、不写作品资料（与 PromptPreviewGate 同型）。
 * - 未知源/未知记录字段是"报告并继续"，不是阻断；解析彻底失败才停下并让作者选择。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, Edit3, Eye, HelpCircle, Loader2, RefreshCw, X } from 'lucide-react'
import type { ChatMessage } from '../../lib/types'
import { log } from '../../lib/logging/logger'
import { useAIConfigStore } from '../../stores/ai-config'
import { AgentTeamBudgetTracker } from '../../lib/agent/team-budget'
import { assembleContext } from '../../lib/registry/assemble-context'
import { CONTEXT_SOURCE_BY_KEY } from '../../lib/registry/context-sources'
import { prepareGenerationNode, runGenerationNode, type GenerationNode } from '../../lib/generation/generation-node'
import {
  createChapterPlanAskNode,
  createChapterPlanNeedsNode,
  createChapterPlanSummaryNode,
  preparePlanBasis,
  preparePlanNeedsCatalogs,
  type PlanNegotiationBasis,
  type PlanNegotiationCatalogs,
  type PlanNegotiationRuntime,
} from '../../lib/generation/plan-negotiation-node'
import {
  applyAuthorEdits,
  isEmptyPlanSelection,
  parsePlanNeedsPayload,
  validatePlanNeeds,
  PLAN_FLOOR_SOURCES,
  type PlanSelection,
} from '../../lib/generation/plan-needs'
import {
  PLAN_ASK_DETAIL_DEFAULT,
  PLAN_ASK_DETAIL_LABELS,
  PLAN_ASK_MAX_ANSWER_CHARS,
  collectPlanAskAnswers,
  mergeAuthorHint,
  parsePlanAskPayload,
  validatePlanAsk,
  type PlanAskAnswer,
  type PlanAskPayload,
  type PlanAskDetail,
} from '../../lib/generation/plan-ask'
import PlanRequestedFields from '../shared/PlanRequestedFields'
import { parsePlanSummaryResult } from '../../lib/ai/adapters/chapter-plan-adapter'

export type PlanCallCategory = 'chapter.plan.summary' | 'chapter.plan.ask' | 'chapter.plan.needs'

interface Props {
  runtime: PlanNegotiationRuntime
  chapterTitle: string
  chapterSummary: string
  userHint?: string
  /**
   * 父级注入的模型调用（负责配置就绪检查、分类记账与错误文案）。
   * `signal` 用于**真正取消**在途请求：面板卸载（作者点取消协商）时中止它，
   * 否则请求会继续跑到超时，既烧钱又让"取消了"变成假象。
   */
  call: (messages: ChatMessage[], category: PlanCallCategory, signal?: AbortSignal) => Promise<string>
  onConfirm: (selection: PlanSelection | null) => void
  onCancel: () => void
  /**
   * **一次章节生成正在跑**（含"点击后到第一个 token"的装配窗口）。
   *
   * ⚠️ 语义边界（真实事故）：它表示"已经有生成在跑"，**不是**"本面板正在被使用"。
   * 早先实现把"面板已占位"当成在途传进来，于是面板自己的按钮全被自己禁用，
   * 作者卡在协商里点不动任何东西（下一步/跳过/确认全灰）。协商期间它必须是 false。
   */
  generationBusy?: boolean
  /**
   * 把"本面板正在跑模型调用"上报给父级。
   *
   * 为什么必须有：协商用的是**非流式** `chat()`，父级的 `isStreaming` 与在途闸门在这一阶段
   * 都是 false —— 于是"协商正在跑"在外观上等于"什么都没发生"，作者看不到圆环也找不到取消
   * （真实事故原话："取消生成在哪呢，没看见，加载中的动画也没看见"）。
   */
  onBusyChange?: (busy: boolean, hint?: string) => void
}

interface PreviewEvidence {
  included: string[]
  omitted: string[]
  trimmed: string[]
  unknownSourceKeys: string[]
  totalInputTokens: number
  inputBudget: number
}

type Step = 'basis' | 'summary' | 'ask' | 'needs' | 'review'

function labelOf(key: string): string {
  return CONTEXT_SOURCE_BY_KEY.get(key)?.label ?? key
}

/**
 * 同一章的同一次协商**并发去重**（模块级，跨组件实例）。
 *
 * 事故日志：21:09:42 与 21:09:56 两次 `[AI] chat 请求开始` 并发，其中一次的结果到达时
 * 面板早已卸载 —— 白花一次钱，还让"协商到底跑了几次"无从判断。触发方式不止一种：
 * `<React.StrictMode>` 在开发模式下 mount → unmount → mount（`startedRef` 是实例级的，
 * 重挂后失效），或者作者取消后马上再点一次。
 */
const planNegotiationInflight = new Map<string, { promise: Promise<unknown>; signal?: AbortSignal }>()

export default function ChapterPlanPanel({
  runtime, chapterTitle, chapterSummary, userHint, call, onConfirm, onCancel, generationBusy = false, onBusyChange,
}: Props) {
  const trackerRef = useRef<AgentTeamBudgetTracker | null>(null)
  if (!trackerRef.current) {
    trackerRef.current = new AgentTeamBudgetTracker(useAIConfigStore.getState().agentTeamBudgetProfile)
  }
  const tracker = trackerRef.current

  const [step, setStep] = useState<Step>('basis')
  /**
   * 每一步的取消控制器：**作者点「取消协商」必须真的中止在途请求**。
   * 只卸载面板而不中止请求的话，那次调用会继续跑到超时（烧钱），"已取消"也只是假象。
   */
  const stepAbortRef = useRef<AbortController | null>(null)
  /** 最近一次请求的自证摘要（面板上显示，配合日志回答"到底有没有调 API"）。 */
  const [lastRequest, setLastRequest] = useState('')
  /** 已经等了多久（秒）：让"长期加载"有解释有预期，而不是静默转圈。 */
  const [waitedSeconds, setWaitedSeconds] = useState(0)
  /**
   * 协商未完成时，「仍按默认清单生成」需要作者点**第二下**才生效。
   * 事故教训：协商失败/被打断后，一次误点就直接开写正文 —— 作者以为协商还没结束。
   */
  const [giveUpConfirmed, setGiveUpConfirmed] = useState(false)
  const [basis, setBasis] = useState<PlanNegotiationBasis | null>(null)
  const [catalogs, setCatalogs] = useState<PlanNegotiationCatalogs | null>(null)
  const [summary, setSummary] = useState('')
  const [ask, setAsk] = useState<PlanAskPayload | null>(null)
  /** 作者对每个问题的原始输入（选项或自写文本）；未出现 = 未回答。 */
  const [askInput, setAskInput] = useState<Record<string, { value: string; source: 'option' | 'text' }>>({})
  const [editingOption, setEditingOption] = useState<{ questionId: string; option: string } | null>(null)
  const [editedOptions, setEditedOptions] = useState<Record<string, Record<string, string>>>({})
  const [askDetail, setAskDetail] = useState<PlanAskDetail>(PLAN_ASK_DETAIL_DEFAULT)
  /** 已确认过的答案（供"重新申报"复用，避免作者重复回答）。 */
  const answersRef = useRef<PlanAskAnswer[]>([])
  const [selection, setSelection] = useState<PlanSelection | null>(null)
  const [preview, setPreview] = useState<PreviewEvidence | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [budgetEvidence, setBudgetEvidence] = useState(() => tracker.snapshot())

  const chapterIdentity = runtime.chapterId ?? runtime.outlineNodeId ?? 'unselected'

  /** 等久了要说清"在等什么、等了多久"，别让作者对着一个转圈干等。 */
  const busyHint = busy && waitedSeconds >= 10
    ? `已等待 ${waitedSeconds} 秒，模型还没返回（可点「取消协商」中止）`
    : ''

  /** 秒表：每个步骤开始计时、结束归零。 */
  useEffect(() => {
    if (!busy) {
      setWaitedSeconds(0)
      return
    }
    const timer = setInterval(() => { setWaitedSeconds(current => current + 1) }, 1_000)
    return () => clearInterval(timer)
  }, [busy])

  // 上报给父级：协商阶段也要在悬浮状态条上显示圆环与取消（非流式调用父级看不见）。
  useEffect(() => { onBusyChange?.(busy, busyHint) }, [busy, busyHint, onBusyChange])
  // 卸载（= 作者取消协商 / 关闭面板）时中止在途请求：否则它会继续跑到超时，既烧钱又让'取消了'变假象。
  useEffect(() => () => {
    stepAbortRef.current?.abort()
    onBusyChange?.(false)
  }, [onBusyChange])
  const summaryAi = useMemo(
    () => ({ start: (messages: ChatMessage[]) => call(messages, 'chapter.plan.summary', stepAbortRef.current?.signal) }),
    [call],
  )
  const needsAi = useMemo(
    () => ({ start: (messages: ChatMessage[]) => call(messages, 'chapter.plan.needs', stepAbortRef.current?.signal) }),
    [call],
  )
  const summaryNode = useMemo(
    () => createChapterPlanSummaryNode({ projectId: runtime.projectId, chapterIdentity, ai: summaryAi }),
    [runtime.projectId, chapterIdentity, summaryAi],
  )
  const needsNode = useMemo(
    () => createChapterPlanNeedsNode({ projectId: runtime.projectId, chapterIdentity, ai: needsAi }),
    [runtime.projectId, chapterIdentity, needsAi],
  )
  const askAi = useMemo(
    () => ({ start: (messages: ChatMessage[]) => call(messages, 'chapter.plan.ask', stepAbortRef.current?.signal) }),
    [call],
  )
  const askNode = useMemo(
    () => createChapterPlanAskNode({ projectId: runtime.projectId, chapterIdentity, ai: askAi }),
    [runtime.projectId, chapterIdentity, askAi],
  )

  /**
   * 发请求前的**自证**：把这次到底发了什么记进日志、也显示在面板上。
   *
   * 为什么需要：作者问"是不是根本没调用 API"时，此前只能靠猜。现在日志里有
   * `[PromptPlan] summary → 发起请求：messages=N chars=X roles=…`，面板上写着同一份数字；
   * 提示词为空则**直接抛错、不发请求**（空请求只会换来一次莫名其妙的空回答）。
   */
  const describeRequest = useCallback((step: 'summary' | 'ask' | 'needs', messages: ChatMessage[]): string => {
    const chars = messages.reduce((sum, message) => sum + message.content.length, 0)
    const roles = messages.map(message => message.role).join('+')
    const summary = `messages=${messages.length} chars=${chars} roles=${roles}`
    setLastRequest(`${step} ${summary}`)
    if (!messages.length || chars === 0) {
      log.error('PromptPlan', 'promptplan', '[PromptPlan] 提示词为空，已阻止空请求', { step, summary })
      return `协商的「${step}」提示词为空（${summary}）：模板或变量渲染异常，未发起请求。`
    }
    log.info('PromptPlan', 'promptplan', `[PromptPlan] ${step} → 发起请求：${summary}`, { step, chars })
    return ''
  }, [])

  /** 走节点管线 + 预算记账的确定性调用封装（节点负责冻结快照与"不自动采纳"）。 */
  const runNode = useCallback(async <TInput,>(
    node: GenerationNode<TInput, string>,
    input: TInput,
    label: string,
    maxOutputTokens: number,
  ): Promise<string> => {
    const prepared = prepareGenerationNode(node, input)
    // 发请求前自证：提示词为空就**不发**。
    const step = node.kind.endsWith('.summary') ? 'summary' : node.kind.endsWith('.ask') ? 'ask' : 'needs'
    const problem = describeRequest(step, prepared.messages)
    if (problem) throw new Error(problem)
    const reservation = tracker.reserveCall({ label, messages: prepared.messages, maxOutputTokens })
    try {
      const result = await runGenerationNode(node, prepared)
      tracker.settleCall(reservation, result.output)
      return result.output
    } catch (reason) {
      tracker.settleFailedCall(reservation)
      throw reason
    } finally {
      setBudgetEvidence(tracker.snapshot())
    }
  }, [describeRequest, tracker])

  /**
   * 同一章的同一次调用**并发去重**。
   *
   * `mode`：
   * - `'reuse'`（自动路径，如面板打开即跑摘要）：已有在途调用就挂上去 —— 这正是要治的
   *   "StrictMode 重挂 / 取消后马上再点导致并发发两次、白花钱"；
   * - `'fresh'`（作者显式点击，如「重新生成摘要」「下一步」「重新申报」）：**总是新发**并顶掉旧条目。
   *   否则上游那次调用若卡住不返回，作者点多少次重试都会被那个永远 pending 的 Promise 挡住。
   *
   * 注意：预算记账在真正发起的那次完成，复用的调用不重复记账（钱只花一次）。
   */
  const runOnce = useCallback(async <T,>(
    key: string,
    factory: () => Promise<T>,
    mode: 'reuse' | 'fresh' = 'fresh',
  ): Promise<T> => {
    const signal = stepAbortRef.current?.signal
    if (mode === 'reuse') {
      const existing = planNegotiationInflight.get(key)
      if (existing && !existing.signal?.aborted) return await existing.promise as T
    }
    const promise = factory()
    const entry = { promise: promise as Promise<unknown>, signal }
    planNegotiationInflight.set(key, entry)
    try {
      return await promise
    } finally {
      // 只在仍是自己那一条时删除，避免误删后来者的 Promise
      if (planNegotiationInflight.get(key) === entry) planNegotiationInflight.delete(key)
    }
  }, [])

  /** 每一步开始时换一个新的取消控制器，并中止上一步的残留请求。 */
  const beginStep = useCallback((): AbortSignal => {
    stepAbortRef.current?.abort()
    stepAbortRef.current = new AbortController()
    return stepAbortRef.current.signal
  }, [])

  const runSummary = useCallback(async (
    currentBasis: PlanNegotiationBasis,
    /** 面板打开时的自动那一次用 'reuse'（去重 StrictMode 重挂）；作者点「重新生成摘要」用 'fresh'。 */
    mode: 'reuse' | 'fresh' = 'fresh',
  ) => {
    beginStep()
    setBusy(true)
    setError('')
    setGiveUpConfirmed(false)
    setNotice('')
    try {
      const raw = await runOnce(`${runtime.projectId}:${chapterIdentity}:summary`, () => runNode(summaryNode, {
        chapterTitle,
        chapterSummary,
        detailedOutline: currentBasis.detailedOutline,
        previousContext: currentBasis.previousContext,
        userHint,
      }, '生成前协商 · 本章摘要', 900), mode)
      const text = parsePlanSummaryResult(raw)
      if (!text) {
        setError('模型没有返回可用的摘要，请重试；空摘要不会进入下一步。')
        setStep('summary')
        return
      }
      setSummary(text)
      setStep('summary')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setStep('summary')
    } finally {
      setBusy(false)
    }
  }, [beginStep, chapterTitle, chapterSummary, userHint, runNode, summaryNode, runOnce, chapterIdentity, runtime.projectId])

  /**
   * 打开面板即开始：装配登记上下文（读）+ 摘要调用（1 次模型调用）。
   * StrictMode 会在开发环境重复执行 effect setup/cleanup；每次 setup 都必须有有效运行，
   * 并由 runOnce 复用仍在途的摘要请求。否则第一次 cleanup 后第二次 setup 被实例标记跳过，
   * 数据准备结果又因 active=false 被丢弃，面板会永久停在加载态。
   */
  useEffect(() => {
    let active = true
    void (async () => {
      setBusy(true)
      try {
        const loaded = await preparePlanBasis(runtime)
        if (!active) return
        setBasis(loaded)
        await runSummary(loaded, 'reuse')
      } catch (reason) {
        if (!active) return
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (active) setBusy(false)
      }
    })()
    return () => { active = false }
    // runtime 在面板打开期间是稳定的（父级只在切换章节时重挂）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const runNeeds = useCallback(async (
    answersOverride?: PlanAskAnswer[],
    options?: { preserveNotice?: boolean },
  ) => {
    if (!basis) return
    if (!summary.trim()) {
      setError('请先确认本章摘要。')
      return
    }
    const effectiveAnswers = answersOverride ?? answersRef.current
    beginStep()
    setBusy(true)
    setError('')
    setGiveUpConfirmed(false)
    // 提问轮刚给过通知（例如"模型无需确认，已直接申报"）时不要立刻抹掉它：
    // 否则作者只看到结果、看不到"为什么跳过了提问"。此后若有新通知会覆盖它。
    if (!options?.preserveNotice) setNotice('')
    try {
      const loadedCatalogs = catalogs ?? await preparePlanNeedsCatalogs(runtime, basis)
      setCatalogs(loadedCatalogs)
      const raw = await runOnce(`${runtime.projectId}:${chapterIdentity}:needs`, () => runNode(needsNode, {
        summary,
        chapterTitle,
        // 提问回答以"作者要求"的形式进入申报：模型据此给计划，作者不必再解释一遍。
        userHint: mergeAuthorHint(userHint ?? '', effectiveAnswers) || undefined,
        catalogs: {
          sourceCatalog: loadedCatalogs.sourceCatalog,
          roster: loadedCatalogs.roster,
         detail: askDetail,
          ragCatalog: loadedCatalogs.ragCatalog,
        },
      }, '生成前协商 · 上下文需求与写作计划', 1_200))
      const payload = parsePlanNeedsPayload(raw)
      if (!payload) {
        setNotice('模型返回的 JSON 无法解析：已保留原始输出供你判断，请重试或按默认清单继续。')
        setStep('review')
        setSelection(null)
        return
      }
      const validated = validatePlanNeeds(payload, {
        sourceKeys: loadedCatalogs.sourceKeys,
        ragEntryKeys: loadedCatalogs.ragEntryKeys,
        characterNames: loadedCatalogs.characterNames,
      })
      if (!validated) {
        setNotice('模型返回的需求不是对象，已忽略；可重试或按默认清单继续。')
        setStep('review')
        setSelection(null)
        return
      }
      answersRef.current = effectiveAnswers
      setSelection({ ...validated, answers: effectiveAnswers })
      setStep('review')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setBusy(false)
    }
  }, [askDetail, basis, beginStep, catalogs, summary, chapterTitle, userHint, needsNode, runNode, runtime, runOnce, chapterIdentity])

  /**
   * PROMPT-PLAN-2：提问轮。模型先思考"自己拿不准什么"，再把问题交给作者。
   * 拿不出问题（空数组）时**不空转**：直接进入申报，并在通知里如实说明发生了一次调用。
   */
  const runAsk = useCallback(async () => {
    if (!basis) return
    if (!summary.trim()) {
      setError('请先确认本章摘要。')
      return
    }
    beginStep()
    setBusy(true)
    setError('')
    setGiveUpConfirmed(false)
    setNotice('')
    try {
      const loadedCatalogs = catalogs ?? await preparePlanNeedsCatalogs(runtime, basis)
      setCatalogs(loadedCatalogs)
      const raw = await runOnce(`${runtime.projectId}:${chapterIdentity}:ask`, () => runNode(askNode, {
        summary,
        chapterTitle,
        userHint,
        roster: loadedCatalogs.roster,
      }, '生成前协商 · 向作者确认走向', 800))
      const parsed = parsePlanAskPayload(raw)
      const validated = parsed ? validatePlanAsk(parsed, askDetail) : null
      if (!validated) {
        // 解析失败：不阻断，明确告知并允许直接申报（作者不该为模型的格式错误买单）。
        setNotice('模型返回的提问 JSON 无法解析，已跳过提问，直接进入申报。')
        void runNeeds([], { preserveNotice: true })
        return
      }
      setAsk(validated)
      if (validated.questions.length === 0) {
        setNotice(validated.dropped > 0
          ? '模型给出的提问全部不合法，已丢弃并直接进入申报。'
          : '模型没有需要向你确认的问题，已直接进入申报。')
        void runNeeds([], { preserveNotice: true })
        return
      }
      setStep('ask')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
      setStep('ask')
    } finally {
      setBusy(false)
    }
  }, [askDetail, askNode, basis, beginStep, catalogs, chapterTitle, runNeeds, runNode, runtime, summary, userHint, runOnce, chapterIdentity])

  const submitAnswers = () => {
    const questions = ask?.questions ?? []
    const collected = collectPlanAskAnswers(questions, askInput)
    void runNeeds(collected)
  }

  const skipAsk = () => {
    void runNeeds([])
  }

  const setAnswer = (id: string, value: string, source: 'option' | 'text') => {
    setAskInput(current => ({ ...current, [id]: { value, source } }))
  }

  const saveEditedOption = (questionId: string, original: string, value: string) => {
    const next = value.trim()
    if (!next) return
    setEditedOptions(current => ({ ...current, [questionId]: { ...(current[questionId] ?? {}), [original]: next } }))
    if (askInput[questionId]?.source === 'option' && askInput[questionId].value === original) setAnswer(questionId, next, 'option')
    setEditingOption(null)
  }

  // 真实装配预估：用确认后的清单跑一次只读装配，拿到 included/omitted/trimmed/未登记与 token 预计。
  useEffect(() => {
    if (!selection) return
    let cancelled = false
    void (async () => {
      try {
        const assembled = await assembleContext({
          projectId: runtime.projectId,
          worldGroupId: runtime.worldGroupId,
          outlineNodeId: runtime.outlineNodeId,
          chapterId: runtime.chapterId,
          provider: runtime.provider,
          model: runtime.model,
          sourceKeys: selection.sourceKeys,
          ragEntryKeys: selection.ragEntryKeys.length ? selection.ragEntryKeys : undefined,
          subjectCharacterName: selection.subjectCharacterName ?? undefined,
        })
        if (cancelled) return
        setPreview({
          included: assembled.included,
          omitted: assembled.omitted,
          trimmed: assembled.trimmed,
          unknownSourceKeys: assembled.unknownSourceKeys,
          totalInputTokens: assembled.totalInputTokens,
          inputBudget: assembled.inputBudget,
        })
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      }
    })()
    return () => { cancelled = true }
  }, [selection, runtime])

  const toggleAddedSource = (key: string) => {
    if (!selection) return
    const removing = selection.aiAddedSourceKeys.includes(key)
    setSelection(applyAuthorEdits(selection, {
      removedAddedSourceKeys: removing ? [key] : [],
      extraSourceKeys: removing ? [] : [key],
    }))
  }

  const toggleRagKey = (key: string) => {
    if (!selection) return
    const removing = selection.ragEntryKeys.includes(key)
    setSelection(applyAuthorEdits(selection, {
      removedRagEntryKeys: removing ? [key] : [],
    }))
  }

  const clearSubject = () => {
    if (!selection) return
    setSelection({ ...selection, subjectCharacterName: null, subjectSourceKeys: [] })
  }

  const [extraSource, setExtraSource] = useState('')
  const selectableSources = useMemo(() => {
    const floor = new Set<string>(PLAN_FLOOR_SOURCES)
    const added = new Set(selection?.aiAddedSourceKeys ?? [])
    return (catalogs?.sourceKeys ?? [])
      .filter(key => !floor.has(key) && !added.has(key))
      .map(key => ({ key, label: labelOf(key) }))
  }, [catalogs, selection])

  const rejected = selection?.rejected
  const nothingDeclared = selection ? isEmptyPlanSelection(selection) : false
  const confirmedSelection = selection

  return (
    <div className="mb-3 rounded-lg border border-accent/30 bg-accent/5 p-3" data-testid="chapter-plan-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
            <Eye className="h-3.5 w-3.5 text-accent" />
            生成前协商
          </div>
          <p className="mt-1 text-[10px] leading-4 text-text-muted">
            ① 摘要 → ② AI 提问（可跳过）→ ③ 需求与写作计划 → ④ 提取最终提示词。修改只影响本次生成，不写回模板或作品资料。
          </p>
        </div>
        <span className="text-[10px] tabular-nums text-text-muted" data-testid="chapter-plan-request-evidence">
          已用 {budgetEvidence.calls}/{budgetEvidence.maxCalls} 次调用 · 约 {budgetEvidence.usedTokens.toLocaleString()} tokens
          {lastRequest && <span className="ml-2">· 最近请求 {lastRequest}</span>}
        </span>
      </div>

      {error && (
        <p className="mt-2 flex items-start gap-1 rounded border border-error/40 bg-error/10 px-2 py-1 text-[11px] text-error">
          <AlertTriangle className="mt-[2px] h-3 w-3 flex-shrink-0" />{error}
        </p>
      )}
      {notice && (
        <p className="mt-2 rounded border border-border bg-bg-base px-2 py-1 text-[11px] text-text-secondary">{notice}</p>
      )}

      {/* ① 摘要 */}
      <div className="mt-3">
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[10px] font-medium text-text-secondary">① 本章写作摘要（可修改）</span>
          <button
            type="button"
            onClick={() => { if (basis) void runSummary(basis) }}
            disabled={busy || !basis}
            className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
          >
            {busy && step !== 'review' ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            重新生成摘要
          </button>
        </div>
        <textarea
          aria-label="本章写作摘要"
          value={summary}
          onChange={event => setSummary(event.target.value)}
          rows={6}
          placeholder={busy ? '正在生成摘要…' : '（空摘要不会进入下一步）'}
          className="w-full resize-y rounded border border-border bg-bg-base px-2.5 py-2 text-xs leading-5 text-text-primary focus:border-accent focus:outline-none"
        />
      </div>

      {/* ② 提问轮（PROMPT-PLAN-2）：AI 先思考，再就"自己拿不准的走向"问作者 */}
      {step === 'ask' && (
        <div className="mt-3 space-y-2 text-[11px]" data-testid="chapter-plan-ask">
          <div className="text-[10px] font-medium text-text-secondary">
            ② AI 需要你确认的走向（可跳过）（{ask?.questions.length ?? 0} 个）
             <span className="ml-2 text-text-muted">当前：{PLAN_ASK_DETAIL_LABELS[askDetail]}</span>
          </div>
          {ask?.reason && <p className="text-text-muted">模型说明：{ask.reason}</p>}

          {(ask?.questions ?? []).map((question, index) => {
            const picked = askInput[question.id]
            return (
              <div key={question.id} className="rounded border border-border bg-bg-base px-2 py-1.5">
                <div className="text-text-primary">{index + 1}. {question.question}</div>
                {question.why && <div className="mt-0.5 text-[10px] text-text-muted">为什么问：{question.why}</div>}
                <div className="mt-1 space-y-1">
                  {question.options.map(option => {
                    const edited = editedOptions[question.id]?.[option] ?? option
                    const isEditing = editingOption?.questionId === question.id && editingOption.option === option
                    return (
                      <div key={option} className="flex items-center gap-2 text-text-secondary">
                        <input type="radio" name={`plan-ask-${question.id}`} checked={picked?.source === 'option' && picked.value === edited} onChange={() => setAnswer(question.id, edited, 'option')} className="mt-[3px] accent-accent" aria-label={`${question.question}：${edited}`} />
                        {isEditing ? (
                          <input autoFocus defaultValue={edited} maxLength={PLAN_ASK_MAX_ANSWER_CHARS} aria-label={`${question.question}的选项编辑`} onBlur={event => saveEditedOption(question.id, option, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingOption(null) }} className="flex-1 rounded border border-accent bg-bg-base px-2 py-1 text-[11px] text-text-primary outline-none" />
                        ) : <span className="flex-1">{edited}</span>}
                        <button type="button" onClick={() => setEditingOption({ questionId: question.id, option })} className="p-0.5 text-text-muted hover:text-accent" title="直接改写此选项" aria-label="编辑此选项"><Edit3 className="h-3 w-3" /></button>
                      </div>
                    )
                  })}
                  <div className="flex items-center gap-2 text-text-secondary">
                    <input
                      type="radio"
                      name={`plan-ask-${question.id}`}
                      checked={picked?.source === 'text'}
                      onChange={() => setAnswer(question.id, picked?.source === 'text' ? picked.value : '', 'text')}
                      className="mt-[3px] accent-accent"
                      aria-label={`${question.question}：自己写`}
                    />
                    <span className="flex-1">自己写</span>
                  </div>
                  {picked?.source === 'text' && (
                    <input
                      value={picked.value}
                      maxLength={PLAN_ASK_MAX_ANSWER_CHARS}
                      onChange={event => setAnswer(question.id, event.target.value, 'text')}
                      aria-label={`${question.question}的自定义回答`}
                      placeholder="输入你的回答"
                      className="mt-1 w-full rounded border border-border bg-bg-surface px-2 py-1 text-[11px] text-text-primary outline-none focus:border-accent"
                    />
                  )}
                </div>
              </div>
            )
          })}

          <div className="flex flex-wrap items-center justify-between gap-2">
            <button
              type="button"
              onClick={skipAsk}
              disabled={busy || generationBusy}
              className="rounded border border-border px-2 py-1 text-text-muted hover:text-text-primary disabled:opacity-40"
            >
              跳过提问，直接申报资料
            </button>
            <button
              type="button"
              onClick={submitAnswers}
              disabled={busy || generationBusy}
              className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              提交回答并申报资料
            </button>
          </div>
          <p className="text-[10px] text-text-muted">
            未回答的问题按"跳过"处理：既有资料能决定的部分交给模型，只有你填的才会成为硬约束。
          </p>
        </div>
      )}

      {/* ③ 触发申报 */}
      {step !== 'review' && step !== 'ask' && (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
           <label className="flex items-center gap-1 text-[10px] text-text-muted">
             提问详细度
             <select aria-label="AI提问详细度" value={askDetail} disabled={busy || generationBusy} onChange={event => setAskDetail(event.target.value as PlanAskDetail)} className="rounded border border-border bg-bg-base px-1.5 py-0.5 text-[10px] text-text-primary">
               {(Object.keys(PLAN_ASK_DETAIL_LABELS) as PlanAskDetail[]).map(detail => <option key={detail} value={detail}>{PLAN_ASK_DETAIL_LABELS[detail]}</option>)}
             </select>
           </label>
          <button
            type="button"
            onClick={() => void runAsk()}
            disabled={busy || generationBusy || !summary.trim()}
            className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            data-testid="chapter-plan-ask-start"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <HelpCircle className="h-3 w-3" />}
            下一步：让 AI 确认走向
          </button>
          <button
            type="button"
            onClick={() => { void runNeeds([]) }}
            disabled={busy || generationBusy || !summary.trim()}
            className="flex items-center gap-1 rounded border border-border px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            跳过提问，直接申报资料
          </button>
        </div>
      )}

      {/* ③ 申报结果 */}
      {step === 'review' && (
        <div className="mt-3 space-y-3 text-[11px]">
          {!confirmedSelection && (
            <p className="rounded border border-error/40 bg-error/10 px-2 py-1 text-error">
              没有得到可用的需求申报。可以「重新申报」，或直接按默认清单继续。
            </p>
          )}

          {confirmedSelection && (
            <>
              <div>
                <div className="mb-1 text-[10px] font-medium text-text-secondary">
                  必带来源（默认清单 {PLAN_FLOOR_SOURCES.length} 项，不可取消）
                </div>
                <details className="rounded border border-border bg-bg-base px-2 py-1">
                  <summary className="cursor-pointer text-text-muted">
                    展开查看 · 协商只能追加，不会移除这些来源
                  </summary>
                  <p className="mt-1 leading-5 text-text-muted">
                    {PLAN_FLOOR_SOURCES.map(key => labelOf(key)).join('、')}
                  </p>
                </details>
              </div>

              <div>
                <div className="mb-1 text-[10px] font-medium text-text-secondary">AI 追加的来源</div>
                {confirmedSelection.aiAddedSourceKeys.length === 0 && confirmedSelection.subjectSourceKeys.length === 0 ? (
                  <p className="text-text-muted">（无：所有需要的来源都已在必带清单内）</p>
                ) : (
                  <ul className="space-y-1">
                    {confirmedSelection.aiAddedSourceKeys.map(key => (
                      <li key={key} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked
                          onChange={() => toggleAddedSource(key)}
                          className="mt-[3px] accent-accent"
                          aria-label={`取消来源 ${labelOf(key)}`}
                        />
                        <span className="text-text-primary">{labelOf(key)}<span className="ml-1 text-text-muted">{key}</span></span>
                      </li>
                    ))}
                    {confirmedSelection.subjectSourceKeys.map(key => (
                      <li key={key} className="flex items-start gap-2 text-text-muted">
                        <span className="mt-[3px]">•</span>
                        <span>{labelOf(key)}<span className="ml-1">（因指定角色自动并入）</span></span>
                      </li>
                    ))}
                    {confirmedSelection.ragSelectionAutoAdded && (
                      <li className="flex items-start gap-2 text-text-muted">
                        <span className="mt-[3px]">•</span>
                        <span>{labelOf('ragSelection')}<span className="ml-1">（因点名记录字段自动并入）</span></span>
                      </li>
                    )}
                  </ul>
                )}
                {selectableSources.length > 0 && (
                  <div className="mt-2 flex items-center gap-2">
                    <select
                      aria-label="手动补充来源"
                      value={extraSource}
                      onChange={event => setExtraSource(event.target.value)}
                      className="min-w-0 flex-1 rounded border border-border bg-bg-base px-2 py-1 text-[11px] text-text-primary"
                    >
                      <option value="">手动补充来源…</option>
                      {selectableSources.map(item => (
                        <option key={item.key} value={item.key}>{item.label}（{item.key}）</option>
                      ))}
                    </select>
                    <button
                      type="button"
                      disabled={!extraSource}
                      onClick={() => {
                        if (!extraSource) return
                        setSelection(current => current && applyAuthorEdits(current, { extraSourceKeys: [extraSource] }))
                        setExtraSource('')
                      }}
                      className="rounded border border-border px-2 py-1 text-text-secondary hover:text-text-primary disabled:opacity-40"
                    >
                      添加
                    </button>
                  </div>
                )}
              </div>

              {confirmedSelection.ragEntryKeys.length > 0 && (
                <div>
                  <div className="mb-1 text-[10px] font-medium text-text-secondary">
                    AI 点名的记录字段（{confirmedSelection.ragEntryKeys.length}）
                  </div>
                  <ul className="max-h-40 space-y-1 overflow-auto pr-1">
                    {confirmedSelection.ragEntryKeys.map(key => (
                      <li key={key} className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          checked
                          onChange={() => toggleRagKey(key)}
                          className="mt-[3px] accent-accent"
                          aria-label={`取消记录字段 ${key}`}
                        />
                        <span className="break-all font-mono text-[10px] text-text-primary">{key}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {confirmedSelection.subjectCharacterName && (
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium text-text-secondary">主体角色</span>
                  <span className="text-text-primary">{confirmedSelection.subjectCharacterName}</span>
                  <button
                    type="button"
                    onClick={clearSubject}
                    className="flex items-center gap-1 text-text-muted hover:text-error"
                  >
                    <X className="h-3 w-3" />清除
                  </button>
                </div>
              )}

              {rejected && (rejected.unknownSources.length > 0 || rejected.unknownRagKeys.length > 0 || rejected.unknownCharacters.length > 0) && (
                <div className="rounded border border-error/40 bg-error/10 px-2 py-1 text-error">
                  <div className="font-medium">未登记（已拒绝，不会生效）</div>
                  {rejected.unknownSources.length > 0 && <div>来源：{rejected.unknownSources.join('、')}</div>}
                  {rejected.unknownRagKeys.length > 0 && <div className="break-all">记录字段：{rejected.unknownRagKeys.join('、')}</div>}
                  {rejected.unknownCharacters.length > 0 && <div>角色：{rejected.unknownCharacters.join('、')}</div>}
                </div>
              )}

              {rejected && rejected.overLimit.length > 0 && (
                <div className="rounded border border-border bg-bg-base px-2 py-1 text-text-muted">
                  超出上限已丢弃：{rejected.overLimit.map(item => `${item.field} −${item.dropped}`).join('、')}
                </div>
              )}

              {preview && (
                <div className="rounded border border-border bg-bg-base px-2 py-1 text-text-muted">
                  <div>
                    预计输入：约 {preview.totalInputTokens.toLocaleString()} / {preview.inputBudget.toLocaleString()} tokens
                    （纳入 {preview.included.length} 个来源）
                  </div>
                  {preview.omitted.length > 0 && (
                    <div>本次取不到（无数据或缺章）：{preview.omitted.map(labelOf).join('、')}</div>
                  )}
                  {preview.trimmed.length > 0 && (
                    <div>被预算截断：{preview.trimmed.map(labelOf).join('、')}</div>
                  )}
                  {preview.unknownSourceKeys.length > 0 && (
                    <div className="text-error">未登记来源（已忽略）：{preview.unknownSourceKeys.join('、')}</div>
                  )}
                </div>
              )}

              {nothingDeclared && (
                <p className="text-text-muted">AI 没有提出额外需求：本次将按默认清单生成。</p>
              )}

              <div>
                <div className="mb-1 text-[10px] font-medium text-text-secondary">写作计划</div>
                <div className="space-y-1 rounded border border-border bg-bg-base px-2 py-1 text-text-secondary">
                  {confirmedSelection.plan.beats.length > 0 && (
                    <div>节拍：{confirmedSelection.plan.beats.map((beat, index) => `${index + 1}) ${beat}`).join(' ')}</div>
                  )}
                  {confirmedSelection.plan.mustPayOff.length > 0 && (
                    <div>必须兑现：{confirmedSelection.plan.mustPayOff.join('；')}</div>
                  )}
                  {confirmedSelection.plan.mustNotReveal.length > 0 && (
                    <div>必须不透露：{confirmedSelection.plan.mustNotReveal.join('；')}</div>
                  )}
                  {confirmedSelection.plan.notes && <div>注意：{confirmedSelection.plan.notes}</div>}
                  {confirmedSelection.plan.beats.length === 0
                    && confirmedSelection.plan.mustPayOff.length === 0
                    && confirmedSelection.plan.mustNotReveal.length === 0
                    && !confirmedSelection.plan.notes && <div className="text-text-muted">（AI 未给出写作计划）</div>}
                  <div className="text-[10px] text-text-muted">
                    确认后这段计划会作为「本次写作要求」进入最终提示词，可在提示词预览里逐字修改。
                  </div>
                </div>
              </div>

              {/* PROMPT-PLAN-2：与最终提示词预览共用同一个展示组件（两处永远一致）。 */}
              <PlanRequestedFields
                selection={confirmedSelection}
                ragEntryLabels={catalogs?.ragEntryLabels}
                title="本次请求的具体字段（与提示词预览同源）"
              />

              {confirmedSelection.answers && confirmedSelection.answers.some(answer => answer.source !== 'skipped') && (
                <button
                  type="button"
                  onClick={() => setStep('ask')}
                  disabled={busy}
                  className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
                >
                  <HelpCircle className="h-3 w-3" />改回答（会重新申报资料）
                </button>
              )}

              <button
                type="button"
                onClick={() => void runNeeds(answersRef.current)}
                disabled={busy}
                className="flex items-center gap-1 text-[11px] text-text-muted hover:text-text-primary disabled:opacity-40"
              >
                {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                重新申报
              </button>
            </>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-border px-2.5 py-1 text-xs text-text-muted hover:text-text-primary"
        >
          取消本次协商
        </button>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy || generationBusy}
            title={busy
              ? '协商还在进行：请等这一步结束，或点「取消本次协商」'
              : generationBusy ? '已有一次生成在进行中'
                : step === 'review' ? '不采用任何申报，按默认清单生成'
                  : '协商尚未完成；点两次才会按默认清单生成'}
            onClick={() => {
              // 协商已跑完 → 一次点击即可（作者有权不采用申报）。
              if (step === 'review') { onConfirm(null); return }
              // 协商没跑完（失败/被中断）→ 需要**明确第二下**，避免"没协商完就悄悄开写正文"。
              if (!giveUpConfirmed) { setGiveUpConfirmed(true); return }
              onConfirm(null)
            }}
            data-testid="chapter-plan-default-continue"
            data-confirm-pending={step === 'review' ? undefined : String(giveUpConfirmed)}
            className="rounded border border-border px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
          >
            {step === 'review' ? '按默认清单继续' : '协商未完成，仍按默认清单生成'}
          </button>
          <button
            type="button"
            disabled={busy || generationBusy || !summary.trim() || !confirmedSelection}
            onClick={() => onConfirm(confirmedSelection)}
            className="flex items-center gap-1 rounded bg-accent px-2.5 py-1 text-xs text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Check className="h-3 w-3" />确认并提取最终提示词
          </button>
        </div>
      </div>

      {step !== 'review' && giveUpConfirmed && (
        <p className="mt-2 rounded border border-warning/40 bg-warning/10 px-2 py-1 text-[11px] text-warning" data-testid="chapter-plan-give-up-warning">
          协商尚未完成：再点一次「仍按默认清单生成」才会开始写作，本次不会采用任何 AI 申报的资料与计划。
        </p>
      )}
    </div>
  )
}
