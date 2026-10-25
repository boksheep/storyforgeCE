/**
 * PROMPT-PLAN-1 · 生成前协商的两个 AI 动作适配器。
 *
 * 分工（关键设计，别改坏）：
 * - **模板库持有**「怎么判断需要什么」的人话口径（`chapter.plan.summary` / `chapter.plan.needs`），
 *   作者可在「提示词管理」里改，与既有 `chapter.content` 完全同一条路径。
 * - **代码持有**闭集清单（登记源目录 / 实体名册 / 记录字段目录）与严格 JSON 契约，
 *   在渲染模板之后追加为一条 user 消息。理由：清单来自注册表与资料库投影，
 *   不是作者文案；解析契约一旦被改坏，整条协商链就会静默降级。
 */
import { usePromptStore } from '../../../stores/prompt'
import { renderPrompt } from '../prompt-engine'
import type { ChatMessage } from '../../types'
import {
  PLAN_ASK_MAX_OPTION_CHARS,
  PLAN_ASK_MAX_OPTIONS,
  PLAN_ASK_MAX_QUESTION_CHARS,
  PLAN_ASK_DETAIL_DEFAULT,
  PLAN_ASK_DETAIL_MAX_QUESTIONS,
  type PlanAskDetail,
} from '../../generation/plan-ask'

export interface PlanSummaryInput {
  chapterTitle: string
  chapterSummary: string
  detailedOutline?: string
  previousContext?: string
  /** 章纲协商宿主提供的卷内位置与既有章纲快照。 */
  positionContext?: string
  userHint?: string
  /** 规划对象范围；卷级请求使用卷级措辞。 */
  planningScope?: 'chapter' | 'volume'
  /** 透传给 renderPrompt（透明模式的最终提示词覆盖等）。 */
  options?: Parameters<typeof renderPrompt>[2]
}

function scopePlanMessages(messages: ChatMessage[], scope?: 'chapter' | 'volume'): ChatMessage[] {
  if (scope !== 'volume') return messages
  return messages.map(message => ({ ...message, content: message.content
    .replace(/本章/g, '本卷').replace(/这一章/g, '这一卷').replace(/整章/g, '整卷')
    .replace(/章节摘要/g, '卷级规划摘要').replace(/本场戏/g, '本卷剧情')
    .replace(/本章节拍/g, '本卷阶段节拍') }))
    .concat({ role: 'user', content: '【规划范围：卷级大纲】本次规划整卷或全书卷级结构，不是单章正文。围绕卷级主线、阶段冲突、重大伏笔、角色成长、卷末落点及跨章新增人物和地点提问；不要把单场戏或某一章的开场当作整卷目标。' })
}

export function buildPlanSummaryPrompt(input: PlanSummaryInput): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('chapter.plan.summary')
  const { messages } = renderPrompt(tpl, {
    chapterTitle: input.chapterTitle || '（未命名章节）',
    chapterSummary: input.chapterSummary || '（本章暂无大纲）',
    detailedOutline: input.detailedOutline || '',
    previousContext: input.previousContext || '',
    userHint: input.userHint,
  }, input.options)
  const scoped = scopePlanMessages(messages, input.planningScope)
  if (input.positionContext?.trim()) {
    return [...scoped, { role: 'user', content: `【目标章在卷内的位置与已有章纲】\n${input.positionContext.trim()}\n请把这份位置快照视为事实边界，不要调换已有章节顺序。` }]
  }
  return scoped
}

export interface PlanNeedsCatalogsText {
  /** 已登记上下文源：`key — 标签` 每行一条。 */
  sourceCatalog: string
  /** 实体名册（entityRoster 源内容）。 */
  roster: string
  /** 可精确选择的记录字段键：`key — 标签` 每行一条。 */
  ragCatalog: string
}

export interface PlanNeedsInput {
  summary: string
  planningScope?: 'chapter' | 'volume'
  chapterTitle?: string
  userHint?: string
  catalogs: PlanNeedsCatalogsText
  options?: Parameters<typeof renderPrompt>[2]
}

/** 机器契约：字段名、类型、上限与"只能从清单里抄"的硬规则。由代码持有。 */
export const PLAN_NEEDS_JSON_CONTRACT = `【输出契约（必须严格遵守）】
只输出一个 JSON 对象，不要 Markdown 围栏、不要任何解释文字：
{
  "sourceKeys": ["从「可申报的上下文来源」里逐字照抄的 key"],
  "ragEntryKeys": ["从「可精确选择的记录字段」里逐字照抄的 key"],
  "subjectCharacterName": "从「实体名册」里逐字照抄的角色正名；不需要就留空字符串",
  "writingPlan": {
    "beats": ["本章节拍，按顺序，每条一句话"],
    "mustPayOff": ["本章必须兑现的伏笔/承诺/既定事实"],
    "mustNotReveal": ["本章必须不能透露的信息（认知边界/未来剧情）"],
    "notes": "其他写作注意事项；没有就留空字符串"
  },
  "reason": "一句话说明为什么需要这些资料"
}
硬规则：
1. sourceKeys / ragEntryKeys / subjectCharacterName 里的每一项都必须**逐字出现在**下面给出的清单中；
   清单里没有的键会被系统直接拒绝并记入"未登记"，不会生效。
2. 不要申报"为了保险全都来一份"；只申报真正会用到的。
3. writingPlan 里不要复述摘要原文，写可执行的约束。
4. 清单为空时，对应字段输出空数组/空字符串。`

function formatCatalog(title: string, lines: readonly string[]): string {
  if (!lines.length) return `【${title}】\n（无可选项）`
  return [`【${title}】`, ...lines].join('\n')
}

/**
 * 构造"需求 + 计划"调用。清单与契约作为**最后一条** user 消息追加（代码持有）。
 */
export function buildPlanNeedsPrompt(input: PlanNeedsInput): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('chapter.plan.needs')
  const { messages } = renderPrompt(tpl, {
    summary: input.summary,
    chapterTitle: input.chapterTitle ?? '',
    userHint: input.userHint,
  }, input.options)

  const catalogBlock = [
    formatCatalog('可申报的上下文来源（sourceKeys 只能取这里的 key）', splitLines(input.catalogs.sourceCatalog)),
    formatCatalog('可精确选择的记录字段（ragEntryKeys 只能取这里的 key）', splitLines(input.catalogs.ragCatalog)),
    input.catalogs.roster.trim() || '【实体名册】\n（本世界暂无角色/词条/地点）',
    PLAN_NEEDS_JSON_CONTRACT,
  ].join('\n\n')

  return [...scopePlanMessages(messages, input.planningScope), { role: 'user', content: catalogBlock }]
}

function splitLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}

/** PROMPT-PLAN-2：提问轮的输入。 */
export interface PlanAskInput {
  summary: string
  planningScope?: 'chapter' | 'volume'
  detail?: PlanAskDetail
  chapterTitle?: string
  userHint?: string
  /** 章纲协商的卷内位置快照。 */
  positionContext?: string
  /** 实体名册（同上，用于"是否新增一个人物/道具"这类问题）。 */
  roster: string
  options?: Parameters<typeof renderPrompt>[2]
}

/**
 * 机器契约：问题数量、选项数量、长度上限与"不要问你自己能决定的事"。
 * 与需求轮的契约一样由代码持有（模板被改坏也不会破坏下限）。
 */
export function buildPlanAskJsonContract(detail: PlanAskDetail = PLAN_ASK_DETAIL_DEFAULT): string {
  const maxQuestions = PLAN_ASK_DETAIL_MAX_QUESTIONS[detail]
  return `【输出契约（必须严格遵守）】
只输出一个 JSON 对象，不要 Markdown 围栏、不要任何解释文字：
{
  "questions": [
    {
      "id": "英文短标识，如 scene / cast / new-item",
      "question": "要问作者的一个具体问题",
      "options": ["可直接采用的候选答案", "另一个候选答案"],
      "why": "一句话说明为什么必须问（不说清就别问）"
    }
  ],
  "reason": "一句话说明这一轮为什么需要作者参与"
}
硬规则：
1. 最多 ${maxQuestions} 个问题（当前详细度：${detail}），每个最多 ${PLAN_ASK_MAX_OPTIONS} 个选项；没有必问的事项就输出空数组。
2. **只问你自己无法从摘要、大纲、名册里确定的剧情走向**：例如本场戏的地点、必须出场的人物、
   是否允许新增人物/道具/地名、本章的结局落点。凡是能从既有资料推出的，一律不要问。
3. 每个问题都要给出 2-${PLAN_ASK_MAX_OPTIONS} 个**可直接采用**的具体候选（作者会点选），不要写"请描述…"。
4. 不要把写作技巧、文风、字数这类已经由系统设定的事拿来问作者。
5. 问题与选项都要短：问题 ≤ ${PLAN_ASK_MAX_QUESTION_CHARS} 字，选项 ≤ ${PLAN_ASK_MAX_OPTION_CHARS} 字。`
}

/**
 * 构造"提问"调用。名册与契约作为**最后一条** user 消息追加（代码持有）。
 */
export function buildPlanAskPrompt(input: PlanAskInput): ChatMessage[] {
  const tpl = usePromptStore.getState().getActive('chapter.plan.ask')
  const { messages } = renderPrompt(tpl, {
    summary: input.summary,
    chapterTitle: input.chapterTitle ?? '',
    userHint: input.userHint,
  }, input.options)

  const suffix = [
    input.positionContext?.trim() ? `【目标章在卷内的位置与已有章纲】\n${input.positionContext.trim()}\n提问必须基于此位置快照，不得把前后章顺序混淆。` : '',
    input.roster.trim() || '【实体名册】\n（本世界暂无角色/词条/地点）',
    buildPlanAskJsonContract(input.detail),
  ].join('\n\n')

  return [...scopePlanMessages(messages, input.planningScope), { role: 'user', content: suffix }]
}

/**
 * 摘要解析：模型偶尔会带引号/围栏/前缀，这里剥掉外壳但**不改写内容**。
 * 空结果由调用方阻断（不得用空摘要继续下一步）。
 */
export function parsePlanSummaryResult(raw: string): string {
  let text = (raw ?? '').trim()
  const fence = text.match(/^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/)
  if (fence) text = fence[1].trim()
  text = text.replace(/^\s*(?:本章)?(?:写作)?摘要\s*[:：]\s*/, '')
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith('“') && text.endsWith('”'))) {
    text = text.slice(1, -1).trim()
  }
  return text
}
