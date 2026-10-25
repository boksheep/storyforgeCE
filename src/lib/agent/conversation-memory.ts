import { db } from '../db/schema'
import type { AgentEvent } from '../types'
import { parseAgentEventPayload } from '../types'
import { appendAgentEvent, readAgentEvents } from './conversations'

interface ConversationTurn {
  startSequence: number
  events: AgentEvent[]
  request: string
}

function turnsFrom(events: AgentEvent[]): ConversationTurn[] {
  const turns: ConversationTurn[] = []
  for (const event of events) {
    if (event.kind === 'message' && event.role === 'user') {
      turns.push({ startSequence: event.sequence, events: [event], request: event.content })
    } else if (turns.length && event.kind !== 'memory') {
      turns[turns.length - 1].events.push(event)
    }
  }
  return turns
}

function excerpt(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit)}…` : compact
}

function compactTurn(turn: ConversationTurn): string {
  const plan = turn.events.find(event => event.kind === 'plan')?.content ?? ''
  const decisions = turn.events.filter(event => event.kind === 'confirmation').map(event => event.content)
  const outcome = [...turn.events].reverse().find(event => event.kind === 'error'
    || (event.kind === 'message' && event.role === 'assistant'))?.content ?? ''
  return [
    `#${turn.startSequence} 作者：${excerpt(turn.request, 360)}`,
    plan ? `计划：${excerpt(plan, 200)}` : '',
    ...decisions.map(value => `确认：${excerpt(value, 180)}`),
    outcome ? `结果：${excerpt(outcome, 600)}` : '',
  ].filter(Boolean).join('\n')
}

function terms(value: string): Set<string> {
  const result = new Set<string>()
  for (const match of value.toLowerCase().matchAll(/[\p{Script=Han}]{2,}|[a-z0-9]{2,}/gu)) {
    const word = match[0]
    if (/^[\p{Script=Han}]+$/u.test(word)) {
      for (let index = 0; index < word.length - 1; index++) result.add(word.slice(index, index + 2))
    } else result.add(word)
  }
  return result
}

function indexedTerms(turn: ConversationTurn): Set<string> {
  const relevant = turn.events.filter(event => event.kind === 'plan' || event.kind === 'confirmation'
    || (event.kind === 'message' && (event.role === 'user' || event.role === 'assistant')))
  const ordered = [
    relevant.find(event => event.kind === 'message' && event.role === 'user'),
    [...relevant].reverse().find(event => event.kind === 'message' && event.role === 'assistant'),
    ...relevant.filter(event => event.kind === 'confirmation' || event.kind === 'plan'),
  ].filter((event): event is AgentEvent => event != null)
  return new Set(ordered.flatMap(event => [...terms(event.content.slice(0, 900))].slice(0, 70)))
}

function relevance(haystack: Set<string>, queryTerms: Set<string>): number {
  let score = 0
  for (const term of queryTerms) if (haystack.has(term)) score++
  return score
}

async function scopedEvents(input: { projectId: number; conversationId: number; worldGroupId: number | null }) {
  const conversation = await db.agentConversations.get(input.conversationId)
  if (!conversation || conversation.projectId !== input.projectId
    || (conversation.worldGroupId ?? null) !== input.worldGroupId) {
    throw new Error('主 Agent 会话不属于当前项目或世界。')
  }
  return readAgentEvents(input.conversationId)
}

/** 原始事件永不删；每轮只追加有界的可审计索引，刷新和导入后仍能重建。 */
export async function checkpointMasterConversation(input: {
  projectId: number
  conversationId: number
  worldGroupId: number | null
}): Promise<void> {
  const events = await scopedEvents(input)
  const turns = turnsFrom(events)
  const turn = turns[turns.length - 1]
  if (!turn) return
  const throughSequence = turn.events[turn.events.length - 1].sequence
  const lastMemory = [...events].reverse().find(event => event.kind === 'memory')
  const lastPayload = lastMemory
    ? parseAgentEventPayload<{ version?: number; turnStartSequence?: number; throughSequence?: number }>(lastMemory, {})
    : {}
  if (lastPayload.version === 2
    && lastPayload.turnStartSequence === turn.startSequence
    && lastPayload.throughSequence === throughSequence) return
  await appendAgentEvent({
    projectId: input.projectId,
    conversationId: input.conversationId,
    kind: 'memory',
    content: compactTurn(turn),
    payload: {
      version: 2,
      turnStartSequence: turn.startSequence,
      throughSequence,
      terms: [...indexedTerms(turn)].slice(0, 200),
    },
  })
}

export async function readMasterConversationContext(input: {
  projectId: number
  conversationId: number
  worldGroupId: number | null
  query: string
  beforeSequence?: number
}): Promise<string> {
  const events = (await scopedEvents(input))
    .filter(event => input.beforeSequence == null || event.sequence < input.beforeSequence)
  const turns = turnsFrom(events)
  if (!turns.length) return ''
  const memoryByTurn = new Map<number, AgentEvent>()
  for (const event of events) {
    if (event.kind !== 'memory') continue
    const payload = parseAgentEventPayload<{ turnStartSequence?: number }>(event, {})
    if (payload.turnStartSequence != null) memoryByTurn.set(payload.turnStartSequence, event)
  }
  const storedOrFresh = (turn: ConversationTurn): string => {
    const event = memoryByTurn.get(turn.startSequence)
    const payload = event
      ? parseAgentEventPayload<{ throughSequence?: number }>(event, {})
      : {}
    return event && payload.throughSequence === turn.events[turn.events.length - 1]?.sequence
      ? event.content
      : compactTurn(turn)
  }
  const recent = turns.slice(-3)
  const older = turns.slice(0, -3)
  const queryTerms = terms(input.query)
  const focusedExcerpt = (turn: ConversationTurn): string => {
    const outcome = [...turn.events].reverse().find(event => event.kind === 'message'
      && event.role === 'assistant')?.content ?? ''
    if (outcome.length <= 600) return ''
    const compact = outcome.replace(/\s+/g, ' ')
    const hit = [...queryTerms].map(term => compact.toLowerCase().indexOf(term))
      .find(index => index >= 600)
    if (hit == null) return ''
    return `相关结果原文：${compact.slice(Math.max(0, hit - 100), hit + 380)}`
  }
  const renderTurn = (turn: ConversationTurn) => [
    storedOrFresh(turn).replace(excerpt(turn.request, 360), excerpt(turn.request, 1800)),
    focusedExcerpt(turn),
  ].filter(Boolean).join('\n')
  const relevant = older
    .map(turn => {
      const checkpoint = memoryByTurn.get(turn.startSequence)
      const payload = checkpoint
        ? parseAgentEventPayload<{ version?: number; throughSequence?: number; terms?: string[] }>(checkpoint, {})
        : {}
      const validIndex = payload.version === 2
        && payload.throughSequence === turn.events[turn.events.length - 1]?.sequence
        && Array.isArray(payload.terms)
      const haystack = validIndex ? new Set(payload.terms) : indexedTerms(turn)
      const indexedScore = relevance(haystack, queryTerms)
      const score = indexedScore || relevance(terms(turn.events
        .filter(event => event.kind === 'message' && event.role === 'assistant')
        .map(event => event.content).join(' ')), queryTerms)
      return { turn, score }
    })
    .filter(item => item.score > 0)
    .sort((left, right) => right.score - left.score || right.turn.startSequence - left.turn.startSequence)
    .slice(0, 3)
    .map(item => item.turn)
  const first = older[0]
  const relevantStarts = new Set(relevant.map(turn => turn.startSequence))
  const selectedOlder = [...new Map([...older.slice(-6).reverse(), ...(first ? [first] : [])]
    .filter(turn => !relevantStarts.has(turn.startSequence))
    .map(turn => [turn.startSequence, turn] as const)).values()]
  return [
    '【主 Agent 会话记忆｜历史指令与确认；仅作上下文，不等于本轮写入授权】',
    ...(relevant.length ? ['【较早的相关指令与结果】', ...relevant.map(renderTurn)] : []),
    '【最近三轮】',
    ...recent.map(renderTurn),
    ...(selectedOlder.length ? ['【其他较早的指令索引】', ...selectedOlder.map(renderTurn)] : []),
  ].join('\n\n')
}
