import { htmlToPlainText } from '../utils/html'
import type {
  StyleCalibrationFeedback,
  StyleCalibrationVerdict,
  StyleRevisionPair,
} from '../types/user-style'

export const MAX_STYLE_REVISION_PAIRS = 8
export const MAX_INJECTED_STYLE_PAIRS = 3
const MAX_PAIR_EXCERPT_CHARS = 560
const MAX_CALIBRATION_EXCERPT_CHARS = 700
const MAX_STYLE_NOTE_CHARS = 240
const MAX_STYLE_SAMPLE_TITLE_CHARS = 120

function parseArray<T>(value: string | undefined): T[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed as T[] : []
  } catch {
    return []
  }
}

export function parseStyleRevisionPairs(value: string | undefined): StyleRevisionPair[] {
  return parseArray<StyleRevisionPair>(value).filter(pair =>
    !!pair
    && typeof pair.id === 'string'
    && typeof pair.chapterTitle === 'string'
    && typeof pair.beforeText === 'string'
    && typeof pair.afterText === 'string'
    && typeof pair.capturedAt === 'number'
    && Number.isFinite(pair.capturedAt),
  )
}

export function parseStyleCalibrationFeedback(value: string | undefined): StyleCalibrationFeedback[] {
  return parseArray<StyleCalibrationFeedback>(value).filter(item =>
    !!item
    && typeof item.id === 'string'
    && (item.verdict === 'closer' || item.verdict === 'needs-adjustment')
    && typeof item.note === 'string'
    && typeof item.createdAt === 'number'
    && Number.isFinite(item.createdAt),
  )
}

function normalizePlainText(value: string): string {
  const plain = /<[^>]+>/.test(value) ? htmlToPlainText(value) : value
  return plain
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}

function commonPrefixLength(left: string, right: string): number {
  const limit = Math.min(left.length, right.length)
  let index = 0
  while (index < limit && left[index] === right[index]) index += 1
  return index
}

function commonSuffixLength(left: string, right: string, prefix: number): number {
  const limit = Math.min(left.length, right.length) - prefix
  let count = 0
  while (
    count < limit
    && left[left.length - 1 - count] === right[right.length - 1 - count]
  ) {
    count += 1
  }
  return count
}

function changedExcerpt(text: string, changeStart: number, changeEnd: number): string {
  if (text.length <= MAX_PAIR_EXCERPT_CHARS) return text
  const changedLength = Math.max(0, changeEnd - changeStart)
  const contextBudget = Math.max(120, MAX_PAIR_EXCERPT_CHARS - Math.min(changedLength, 360))
  const beforeContext = Math.floor(contextBudget / 2)
  let start = Math.max(0, changeStart - beforeContext)
  let end = Math.min(text.length, Math.max(changeEnd, changeStart + 1) + beforeContext)
  if (end - start > MAX_PAIR_EXCERPT_CHARS) end = start + MAX_PAIR_EXCERPT_CHARS
  if (end - start < MAX_PAIR_EXCERPT_CHARS && start > 0) {
    start = Math.max(0, end - MAX_PAIR_EXCERPT_CHARS)
  }
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export function createStyleRevisionPair(input: {
  sourceChapterId?: number | null
  chapterTitle: string
  beforeText: string
  afterText: string
  authorNote?: string
  capturedAt?: number
}): StyleRevisionPair | null {
  const before = normalizePlainText(input.beforeText)
  const after = normalizePlainText(input.afterText)
  if (!before || !after || before === after) return null

  const prefix = commonPrefixLength(before, after)
  const suffix = commonSuffixLength(before, after, prefix)
  const beforeEnd = before.length - suffix
  const afterEnd = after.length - suffix
  const beforeText = changedExcerpt(before, prefix, beforeEnd)
  const afterText = changedExcerpt(after, prefix, afterEnd)
  const capturedAt = input.capturedAt ?? Date.now()
  return {
    id: `${input.sourceChapterId ?? 'manual'}-${stableHash(`${beforeText}\0${afterText}`)}`,
    sourceChapterId: input.sourceChapterId ?? null,
    chapterTitle: input.chapterTitle.trim().slice(0, MAX_STYLE_SAMPLE_TITLE_CHARS) || '未命名样本',
    beforeText,
    afterText,
    authorNote: input.authorNote?.trim().slice(0, MAX_STYLE_NOTE_CHARS) || undefined,
    capturedAt,
  }
}

export function upsertStyleRevisionPair(
  pairs: readonly StyleRevisionPair[],
  pair: StyleRevisionPair,
): StyleRevisionPair[] {
  return [
    ...pairs.filter(item => item.id !== pair.id),
    pair,
  ]
    .sort((left, right) => right.capturedAt - left.capturedAt)
    .slice(0, MAX_STYLE_REVISION_PAIRS)
}

export function selectStyleFewShotPairs(
  pairs: readonly StyleRevisionPair[],
  limit = MAX_INJECTED_STYLE_PAIRS,
): StyleRevisionPair[] {
  return [...pairs]
    .filter(pair => pair.beforeText.trim() && pair.afterText.trim())
    .sort((left, right) =>
      Number(!!right.authorNote?.trim()) - Number(!!left.authorNote?.trim())
      || right.capturedAt - left.capturedAt,
    )
    .slice(0, Math.max(0, limit))
}

export function formatStyleFewShotPairs(
  pairs: readonly StyleRevisionPair[],
  limit = MAX_INJECTED_STYLE_PAIRS,
): string {
  const selected = selectStyleFewShotPairs(pairs, limit)
  if (!selected.length) return ''
  return selected.map((pair, index) => [
    `【改稿对照 ${index + 1}·${pair.chapterTitle.slice(0, MAX_STYLE_SAMPLE_TITLE_CHARS)}】`,
    `改前：${pair.beforeText.slice(0, MAX_PAIR_EXCERPT_CHARS)}`,
    `改后：${pair.afterText.slice(0, MAX_PAIR_EXCERPT_CHARS)}`,
    pair.authorNote?.trim()
      ? `作者说明：${pair.authorNote.trim().slice(0, MAX_STYLE_NOTE_CHARS)}`
      : '',
  ].filter(Boolean).join('\n')).join('\n\n')
}

export function createStyleCalibrationFeedback(input: {
  verdict: StyleCalibrationVerdict
  note: string
  sourceText: string
  resultText: string
  createdAt?: number
}): StyleCalibrationFeedback {
  const sourceExcerpt = normalizePlainText(input.sourceText).slice(0, MAX_CALIBRATION_EXCERPT_CHARS)
  const resultExcerpt = normalizePlainText(input.resultText).slice(0, MAX_CALIBRATION_EXCERPT_CHARS)
  const createdAt = input.createdAt ?? Date.now()
  return {
    id: `${createdAt}-${stableHash(`${input.verdict}\0${input.note}\0${sourceExcerpt}\0${resultExcerpt}`)}`,
    verdict: input.verdict,
    note: input.note.trim().slice(0, MAX_STYLE_NOTE_CHARS),
    sourceExcerpt,
    resultExcerpt,
    createdAt,
  }
}

export function formatStyleCalibrationFeedback(
  feedback: readonly StyleCalibrationFeedback[],
  limit = 5,
): string {
  return [...feedback]
    .sort((left, right) => right.createdAt - left.createdAt)
    .slice(0, Math.max(0, limit))
    .map(item =>
      `- ${item.verdict === 'closer' ? '接近作者风格' : '仍需调整'}：${
        item.note.trim().slice(0, MAX_STYLE_NOTE_CHARS) || '作者未补充文字说明'
      }`,
    )
    .join('\n')
}
