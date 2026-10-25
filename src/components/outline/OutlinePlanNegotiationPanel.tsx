import { useCallback, useEffect, useRef, useState } from 'react'
import { Edit3, Loader2, X } from 'lucide-react'
import type { ChatMessage } from '../../lib/types'
import {
  buildPlanAskPrompt,
  buildPlanNeedsPrompt,
  buildPlanSummaryPrompt,
  parsePlanSummaryResult,
} from '../../lib/ai/adapters/chapter-plan-adapter'
import {
  collectPlanAskAnswers,
  formatPlanAskAnswers,
  parsePlanAskPayload,
  validatePlanAsk,
  type PlanAskAnswer,
  type PlanAskPayload,
} from '../../lib/generation/plan-ask'
import {
  parsePlanNeedsPayload,
  validatePlanNeeds,
  type PlanNeedsCatalogs,
  type PlanSelection,
} from '../../lib/generation/plan-needs'
import {
  preparePlanBasis,
  preparePlanNeedsCatalogs,
  type PlanNegotiationRuntime,
} from '../../lib/generation/plan-negotiation-node'

interface Props {
  runtime: PlanNegotiationRuntime
  chapterTitle: string
  chapterSummary: string
  planningScope?: 'chapter' | 'volume'
  negotiationTitle?: string
  userHint?: string
  previousContext?: string
  positionContext?: string
  call: (messages: ChatMessage[], category: 'chapter.plan.summary' | 'chapter.plan.ask' | 'chapter.plan.needs', signal?: AbortSignal) => Promise<string>
  /**
   * 确认协商。第二个参数是**装配用**的协商结果：调用方必须把它交给 `assembleContext`，
   * 否则「已自动提取上下文来源」只是提示词里的一串 key 名，AI 实际拿不到这些资料
   * （真实缺陷：大纲协商此前只把 key 当文本写进 hint）。
   */
  onConfirm: (hint: string, selection: PlanSelection | null) => void
  onCancel: () => void
}

type Step = 'summary' | 'ask' | 'needs'

export default function OutlinePlanNegotiationPanel({
  runtime, chapterTitle, chapterSummary, planningScope = 'chapter', negotiationTitle = '生成本章章纲', userHint, previousContext, positionContext, call, onConfirm, onCancel,
}: Props) {
  const [step, setStep] = useState<Step>('summary')
  const [summary, setSummary] = useState('')
  const [ask, setAsk] = useState<PlanAskPayload | null>(null)
  const [answers, setAnswers] = useState<Record<string, { value: string; source: 'option' | 'text' }>>({})
  const [editingOption, setEditingOption] = useState<{ questionId: string; option: string } | null>(null)
  const [editedOptions, setEditedOptions] = useState<Record<string, Record<string, string>>>({})
  const [needs, setNeeds] = useState<PlanSelection | null>(null)
  const [catalogs, setCatalogs] = useState<PlanNeedsCatalogs | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const startedRef = useRef(false)

  const run = useCallback(async (action: Step, summaryOverride?: string) => {
    setBusy(true)
    setError('')
    try {
      const basis = await preparePlanBasis(runtime)
      const currentSummary = summaryOverride || summary || chapterSummary || chapterTitle
      if (action === 'summary') {
        const raw = await call(buildPlanSummaryPrompt({
          chapterTitle,
          planningScope,
          chapterSummary,
          previousContext: previousContext || basis.previousContext,
          positionContext,
          userHint,
        }), 'chapter.plan.summary')
        const parsed = parsePlanSummaryResult(raw)
        if (!parsed) throw new Error('AI 未返回有效的章纲生成计划')
        setSummary(parsed)
        setStep('ask')
        await run('ask', parsed)
        return
      }
      if (action === 'ask') {
        const raw = await call(buildPlanAskPrompt({
          chapterTitle,
          planningScope,
          summary: currentSummary,
          positionContext,
          roster: basis.roster,
        }), 'chapter.plan.ask')
        const payload = parsePlanAskPayload(raw)
        const parsed = payload ? validatePlanAsk(payload) : null
        if (!parsed) throw new Error('AI 提问结果无法解析，请重试')
        setAsk(parsed)
        setStep('ask')
        return
      }
      const preparedCatalogs = await preparePlanNeedsCatalogs(runtime, basis)
      const draftAnswers = ask ? collectPlanAskAnswers(ask.questions, answers) : []
      const raw = await call(buildPlanNeedsPrompt({
        chapterTitle,
        planningScope,
         summary: currentSummary,
        userHint: [userHint, formatPlanAskAnswers(draftAnswers)].filter(Boolean).join('\n\n'),
        catalogs: preparedCatalogs,
      }), 'chapter.plan.needs')
      const payload = parsePlanNeedsPayload(raw)
      if (!payload) throw new Error('AI 字段需求结果无法解析，请重试')
      const selected = validatePlanNeeds(payload, preparedCatalogs)
      setCatalogs(preparedCatalogs)
      setNeeds(selected)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '协商失败，请重试')
    } finally {
      setBusy(false)
    }
  }, [answers, ask, chapterTitle, chapterSummary, call, planningScope, positionContext, previousContext, runtime, summary, userHint])

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void run('summary')
  }, [run])

  const saveEditedOption = (questionId: string, original: string, value: string) => {
    const next = value.trim()
    if (!next) return
    setEditedOptions(current => ({ ...current, [questionId]: { ...(current[questionId] ?? {}), [original]: next } }))
    if (answers[questionId]?.source === 'option' && answers[questionId].value === original) setAnswers(current => ({ ...current, [questionId]: { value: next, source: 'option' } }))
    setEditingOption(null)
  }

  const confirm = () => {
    const parsedAnswers: PlanAskAnswer[] = ask ? collectPlanAskAnswers(ask.questions, answers) : []
    const planText = needs?.plan
      ? [`【章纲生成计划】`, ...needs.plan.beats.map((item, index) => `${index + 1}. ${item}`),
        needs.plan.mustPayOff.length ? `必须兑现：${needs.plan.mustPayOff.join('；')}` : '',
        needs.plan.mustNotReveal.length ? `禁止提前透露：${needs.plan.mustNotReveal.join('；')}` : '',
        needs.plan.notes].filter(Boolean).join('\n')
      : ''
    const sourceText = needs && catalogs && needs.sourceKeys.length
      ? `【AI 自动提取的依据字段】${needs.sourceKeys.join('、')}${needs.ragEntryKeys.length ? `；记录字段：${needs.ragEntryKeys.join('、')}` : ''}`
      : ''
    const answerText = formatPlanAskAnswers(parsedAnswers)
    onConfirm(
      [userHint?.trim(), summary ? `【AI 章纲意图】${summary}` : '', answerText, sourceText, planText]
        .filter(Boolean).join('\n\n'),
      needs,
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-3" data-testid="outline-plan-negotiation">
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="text-xs font-medium text-text-primary">{negotiationTitle}前协商 · {chapterTitle}</div>
          <div className="mt-1 text-[11px] text-text-muted">先让 AI 提炼意图，再提问不确定项并自动提取所需资料。</div>
        </div>
        <button type="button" onClick={onCancel} className="p-1 text-text-muted hover:text-text-primary" aria-label="取消协商"><X className="h-3.5 w-3.5" /></button>
      </div>
      {error && <div className="rounded border border-error/30 bg-error/10 px-2 py-1 text-xs text-error">{error}</div>}
      {busy && <div className="flex items-center gap-2 text-xs text-accent"><Loader2 className="h-3.5 w-3.5 animate-spin" />正在进行第 {step === 'summary' ? '一' : step === 'ask' ? '二' : '三'} 轮协商…</div>}
      {step === 'summary' && summary && <textarea value={summary} onChange={event => setSummary(event.target.value)} rows={4} className="w-full rounded border border-border bg-bg-base px-2 py-1.5 text-xs text-text-primary" />}
      {step === 'ask' && ask && (
        <div className="space-y-2 text-[11px]">
          {ask.questions.length === 0 && <div className="text-xs text-text-muted">AI 判断没有必须向作者确认的问题。</div>}
          {ask.questions.map((question, index) => {
            const picked = answers[question.id]
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
                        <input type="radio" name={`outline-plan-ask-${question.id}`} checked={picked?.source === 'option' && picked.value === edited} onChange={() => setAnswers(current => ({ ...current, [question.id]: { value: edited, source: 'option' } }))} className="mt-[3px] accent-accent" aria-label={`${question.question}：${edited}`} />
                        {isEditing ? (
                          <input autoFocus defaultValue={edited} maxLength={300} aria-label={`${question.question}的选项编辑`} onBlur={event => saveEditedOption(question.id, option, event.target.value)} onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); if (event.key === 'Escape') setEditingOption(null) }} className="flex-1 rounded border border-accent bg-bg-base px-2 py-1 text-[11px] text-text-primary outline-none" />
                        ) : <span className="flex-1">{edited}</span>}
                        <button type="button" onClick={() => setEditingOption({ questionId: question.id, option })} className="p-0.5 text-text-muted hover:text-accent" title="直接改写此选项" aria-label="编辑此选项"><Edit3 className="h-3 w-3" /></button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      )}
      {step === 'needs' && needs && <div className="space-y-1 text-xs text-text-secondary"><div>已自动提取上下文来源：{needs.sourceKeys.length ? needs.sourceKeys.join('、') : '无新增来源'}</div><div>写作计划：{needs.plan.beats.join('；') || '由 AI 根据章纲自由组织'}</div>{needs.rejected.unknownSources.length > 0 && <div className="text-warning">未登记来源已拒绝：{needs.rejected.unknownSources.join('、')}</div>}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="rounded border border-border px-2.5 py-1 text-xs text-text-muted">取消</button>
        {step === 'summary' && <button type="button" disabled={busy} onClick={() => void run('summary')} className="rounded border border-border px-2.5 py-1 text-xs">重新生成意图</button>}
        {step === 'ask' && <button type="button" disabled={busy} onClick={() => { setStep('needs'); void run('needs') }} className="rounded border border-border px-2.5 py-1 text-xs">下一步：提取字段</button>}
        {step === 'needs' && !needs && <button type="button" disabled={busy} onClick={() => void run('needs')} className="rounded border border-border px-2.5 py-1 text-xs">提取字段</button>}
        {step === 'needs' && needs && <button type="button" onClick={confirm} className="rounded bg-accent px-2.5 py-1 text-xs text-white">确认并生成章纲</button>}
      </div>
    </div>
  )
}
