/**
 * PROMPT-PLAN-2（后续改动 2）· 「本次请求的具体字段」只读展示块。
 *
 * 为什么要单独抽出来：协商面板里已经逐条列过申报结果，但作者真正按下「发送」的那一刻
 * 看的是**最终提示词预览**——而那里此前只有拼好的消息文本，看不出"这次到底点名了哪些字段、
 * 哪些被拒绝、作者的回答有没有进去"。于是作者要在两个界面之间来回对照。
 * 现在同一个组件同时挂在「协商面板」与「最终提示词预览」里，两处**永远一致**。
 *
 * 显示口径（诚实优先）：
 * - 地板来源与 AI 追加分开列：不能让作者以为地板是 AI 要的（那是协议下限）；
 * - 未登记项、超限被丢弃项、结论为空的项一律显示（不隐藏失败）；
 * - 提问回答若为"跳过"就不列（`formatPlanAskAnswers` 同样只渲染有答案的项）。
 */
import { CONTEXT_SOURCE_BY_KEY } from '../../lib/registry/context-sources'
import { PLAN_FLOOR_SOURCES, type PlanSelection } from '../../lib/generation/plan-needs'
import type { PlanAskAnswer } from '../../lib/generation/plan-ask'

export interface PlanRequestedFieldsPreview {
  included: string[]
  omitted: string[]
  trimmed: string[]
  totalInputTokens: number
  inputBudget: number
}

interface Props {
  selection: PlanSelection | null
  preview?: PlanRequestedFieldsPreview | null
  /** 协商目录提供的记录字段中文标签。 */
  ragEntryLabels?: Readonly<Record<string, string>>
  /** 标题（默认「本次请求的具体字段」）。 */
  title?: string
}

function labelOf(key: string): string {
  return CONTEXT_SOURCE_BY_KEY.get(key)?.label ?? key
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="w-16 flex-shrink-0 text-text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-text-secondary">{children}</span>
    </div>
  )
}

export default function PlanRequestedFields({ selection, preview, ragEntryLabels, title = '本次请求的具体字段' }: Props) {
  if (!selection) {
    return (
      <div className="rounded border border-border bg-bg-base px-2 py-1 text-[11px] text-text-muted" data-testid="plan-requested-fields">
        {title}：未使用生成前协商（按默认装配）。
      </div>
    )
  }

  const answers: PlanAskAnswer[] = (selection.answers ?? []).filter(answer => answer.source !== 'skipped' && answer.answer)
  const floorCount = PLAN_FLOOR_SOURCES.length
  const rejected = selection.rejected

  return (
    <div className="rounded border border-border bg-bg-base px-2 py-1.5 text-[11px]" data-testid="plan-requested-fields">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="font-medium text-text-secondary">{title}</span>
        <span className="text-text-muted">
          来源 {selection.sourceKeys.length}（含必带 {floorCount}）
          {selection.ragEntryKeys.length > 0 && ` · 记录字段 ${selection.ragEntryKeys.length}`}
          {selection.subjectCharacterName && ' · 主体角色 1'}
          {answers.length > 0 && ` · 作者回答 ${answers.length}`}
        </span>
      </div>

      <div className="space-y-1">
        <Section label="AI 追加">
          {selection.aiAddedSourceKeys.length === 0
            ? <span className="text-text-muted">（无）</span>
            : selection.aiAddedSourceKeys.map(key => `${labelOf(key)}（${key}）`).join('、')}
        </Section>

        {(selection.subjectSourceKeys.length > 0 || selection.ragSelectionAutoAdded) && (
          <Section label="自动并入">
            {[
              ...selection.subjectSourceKeys.map(key => `${labelOf(key)}（因指定角色）`),
              ...(selection.ragSelectionAutoAdded ? [`${labelOf('ragSelection')}（因点名记录字段）`] : []),
            ].join('、')}
          </Section>
        )}

        {selection.ragEntryKeys.length > 0 && (
          <Section label="记录字段">
            <span className="break-all text-[10px]">
              {selection.ragEntryKeys.map(key => (
                <span key={key} className="mr-1.5 inline-block">
                  {ragEntryLabels?.[key] ?? key} <span className="font-mono text-text-muted">（{key}）</span>
                </span>
              ))}
            </span>
          </Section>
        )}

        {selection.subjectCharacterName && (
          <Section label="主体角色">{selection.subjectCharacterName}</Section>
        )}

        {answers.length > 0 && (
          <Section label="作者回答">
            <ul className="space-y-0.5">
              {answers.map(answer => (
                <li key={answer.id}>{answer.question} → <span className="text-text-primary">{answer.answer}</span></li>
              ))}
            </ul>
          </Section>
        )}

        {selection.plan.beats.length > 0 && (
          <Section label="节拍">
            {selection.plan.beats.map((beat, index) => `${index + 1}) ${beat}`).join(' ')}
          </Section>
        )}
        {selection.plan.mustPayOff.length > 0 && (
          <Section label="必兑现">{selection.plan.mustPayOff.join('；')}</Section>
        )}
        {selection.plan.mustNotReveal.length > 0 && (
          <Section label="不可透露">{selection.plan.mustNotReveal.join('；')}</Section>
        )}
        {selection.plan.notes && <Section label="注意">{selection.plan.notes}</Section>}

        {rejected && (rejected.unknownSources.length > 0 || rejected.unknownRagKeys.length > 0 || rejected.unknownCharacters.length > 0) && (
          <Section label="已拒绝">
            <span className="text-error">
              {[
                ...rejected.unknownSources.map(key => `来源 ${key}`),
                ...rejected.unknownRagKeys.map(key => `字段 ${key}`),
                ...rejected.unknownCharacters.map(name => `角色 ${name}`),
              ].join('、')}
              （未登记，不会生效）
            </span>
          </Section>
        )}

        {rejected && rejected.overLimit.length > 0 && (
          <Section label="超限丢弃">
            {rejected.overLimit.map(item => `${item.field} −${item.dropped}`).join('、')}
          </Section>
        )}

        {preview && (
          <Section label="装配预估">
            约 {preview.totalInputTokens.toLocaleString()} / {preview.inputBudget.toLocaleString()} tokens
            （纳入 {preview.included.length} 个来源）
            {preview.omitted.length > 0 && <span className="text-text-muted">；取不到：{preview.omitted.map(labelOf).join('、')}</span>}
            {preview.trimmed.length > 0 && <span className="text-warning">；被截断：{preview.trimmed.map(labelOf).join('、')}</span>}
          </Section>
        )}
      </div>
    </div>
  )
}
