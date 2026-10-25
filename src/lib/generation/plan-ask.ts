/**
 * PROMPT-PLAN-2（后续改动 3）· 生成前协商的「AI 提问」载荷。
 *
 * 为什么需要这一轮：摘要与需求申报都是**模型单方面**决定"要写什么、要哪些资料"。
 * 当它拿不准剧情走向（这场戏放在哪、谁在场、要不要新增一个道具/人物）时，
 * 现在只有两条路：自己猜，或者写进 `notes` 让作者事后读。前者会把猜测写进正文，
 * 后者要等生成完才发现不对——两种都在浪费作者的钱与时间。
 * 因此在这一步插入一次**可跳过的提问**：模型先思考，再把真正拿不准的点列成问题，
 * 由作者点选或补充，答案作为"本次写作要求"的最高优先级约束进入最终提示词。
 *
 * 边界（与 PROMPT-PLAN-1 同型）：
 * - 闭集校验：问题里的选项由模型给，但**答案只能来自作者**，系统不替作者填；
 * - 数量与长度硬上限，防止模型把提问变成一次长文输出（那是另一种烧钱方式）；
 * - 解析失败 = 显式报告并允许跳过，**绝不用半套问题继续**；
 * - 答案不落库（会话级），只在本次生成里生效。
 */

export const PLAN_ASK_MAX_QUESTIONS = 6
export const PLAN_ASK_MAX_OPTIONS = 6

export type PlanAskDetail = 'concise' | 'balanced' | 'detailed'

export const PLAN_ASK_DETAIL_DEFAULT: PlanAskDetail = 'balanced'
export const PLAN_ASK_DETAIL_MAX_QUESTIONS: Record<PlanAskDetail, number> = {
  concise: 2,
  balanced: 4,
  detailed: 6,
}

export const PLAN_ASK_DETAIL_LABELS: Record<PlanAskDetail, string> = {
  concise: '简洁（最多 2 个）',
  balanced: '中等详细度（最多 4 个）',
  detailed: '详细（最多 6 个）',
}
export const PLAN_ASK_MAX_QUESTION_CHARS = 120
export const PLAN_ASK_MAX_OPTION_CHARS = 60
export const PLAN_ASK_MAX_REASON_CHARS = 200
export const PLAN_ASK_MAX_ANSWER_CHARS = 300

export interface PlanAskQuestion {
  /** 稳定 id（模型给或系统补 `q1…`），用于把答案对回问题。 */
  id: string
  question: string
  options: string[]
  /** 模型说明"为什么必须问"（让作者判断值不值得回答）。 */
  why: string
}

export interface PlanAskPayload {
  questions: PlanAskQuestion[]
  reason: string
  /** 被丢弃的问题数（超上限/空文本），面板必须如实显示，不能静默吞。 */
  dropped: number
}

export interface PlanAskAnswer {
  id: string
  question: string
  answer: string
  /** 作者是选了选项、自己写的，还是跳过了（跳过也记录，便于在计划里显示"未指定"）。 */
  source: 'option' | 'text' | 'skipped'
}

function text(value: unknown, maxChars: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function stringList(value: unknown, maxChars: number, maxItems: number): string[] {
  const raw = typeof value === 'string'
    ? value.split(/[、,，;；\n]/)
    : Array.isArray(value) ? value : []
  const out: string[] = []
  for (const item of raw) {
    const cleaned = text(item, maxChars)
    if (!cleaned || out.includes(cleaned)) continue
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
}

function slugId(value: unknown, fallback: string): string {
  const raw = typeof value === 'string' ? value.trim().toLocaleLowerCase() : ''
  const cleaned = raw.replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return cleaned || fallback
}

/** 从模型原文里抠出 JSON 对象；失败返回 null（调用方必须显式报告，不得继续）。 */
export function parsePlanAskPayload(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * 归一与校验。返回 null 表示"载荷根本不是对象"（调用方报错）；
 * 返回 `questions: []` 表示"模型认为不需要问"（合法结果，面板直接跳到申报）。
 */
export function validatePlanAsk(payload: Record<string, unknown>, detail: PlanAskDetail = PLAN_ASK_DETAIL_DEFAULT): PlanAskPayload | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null
  const rawQuestions = Array.isArray(payload.questions) ? payload.questions : []
  const questions: PlanAskQuestion[] = []
  const seenIds = new Set<string>()
  let dropped = 0

  for (const item of rawQuestions) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      dropped++
      continue
    }
    const row = item as Record<string, unknown>
    const questionText = text(row.question ?? row.q ?? row.title, PLAN_ASK_MAX_QUESTION_CHARS)
    if (!questionText) {
      dropped++
      continue
    }
    if (questions.length >= PLAN_ASK_DETAIL_MAX_QUESTIONS[detail]) {
      dropped++
      continue
    }
    let id = slugId(row.id ?? row.key, `q${questions.length + 1}`)
    while (seenIds.has(id)) id = `${id}-${questions.length + 1}`
    seenIds.add(id)
    questions.push({
      id,
      question: questionText,
      options: stringList(row.options ?? row.choices, PLAN_ASK_MAX_OPTION_CHARS, PLAN_ASK_MAX_OPTIONS),
      why: text(row.why ?? row.reason, PLAN_ASK_MAX_REASON_CHARS),
    })
  }

  return {
    questions,
    reason: text(payload.reason ?? payload.why, PLAN_ASK_MAX_REASON_CHARS),
    dropped,
  }
}

/** 把作者在界面上的原始输入整理成答案数组（未回答的记为 skipped，不丢问题）。 */
export function collectPlanAskAnswers(
  questions: readonly PlanAskQuestion[],
  input: Readonly<Record<string, { value?: string; source?: PlanAskAnswer['source'] }>>,
): PlanAskAnswer[] {
  return questions.map(question => {
    const raw = input[question.id]
    const answer = text(raw?.value, PLAN_ASK_MAX_ANSWER_CHARS)
    const source: PlanAskAnswer['source'] = !answer
      ? 'skipped'
      : raw?.source === 'option' ? 'option' : 'text'
    return { id: question.id, question: question.question, answer, source }
  })
}

export function answeredCount(answers: readonly PlanAskAnswer[]): number {
  return answers.filter(answer => answer.source !== 'skipped').length
}

/**
 * 渲染成给正文模型的追加要求。**只渲染有答案的项**：
 * 把"跳过"也写进提示词只会让模型把空话当约束。
 */
export function formatPlanAskAnswers(answers: readonly PlanAskAnswer[] | undefined): string {
  const usable = (answers ?? []).filter(answer => answer.source !== 'skipped' && answer.answer.trim())
  if (!usable.length) return ''
  return [
    '【作者对「生成前提问」的回答（优先级高于你的默认判断，本章必须按此写）】',
    ...usable.map((answer, index) => `${index + 1}. ${answer.question} → ${answer.answer}`),
  ].join('\n')
}

/**
 * 把"作者的临时要求"与"提问回答"合成一个 hint。
 * 顺序固定为：临时要求在前（那是作者当下最想说的），提问回答在后。
 */
export function mergeAuthorHint(base: string, answers: readonly PlanAskAnswer[] | undefined): string {
  const formatted = formatPlanAskAnswers(answers)
  const trimmed = base.trim()
  if (!formatted) return trimmed
  return trimmed ? `${trimmed}\n\n${formatted}` : formatted
}
