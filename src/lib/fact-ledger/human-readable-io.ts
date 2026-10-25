/**
 * NS-4/NS-5 · 人类可读事实/记忆导出 + 外部候选 diff 导入。
 *
 * 红线：
 * - 导出只读，面向人工审阅/外部编辑；
 * - 导入永远只写 candidate/import，不自动升级 confirmed Canon；
 * - 谓词必须存在于 FACT_PREDICATE_REGISTRY；时序章节引用必须属于本项目，否则跳过。
 */
import { db } from '../db/schema'
import { log } from '../logging/logger'
import { resolveCharacterId as resolveFactCharacterId } from './fact-ledger'
import { getFactPredicate, normalizeFactValue } from '../registry/fact-predicate-registry'
import type { FactKind, TemporalFact } from '../types/temporal-fact'
import { resolveCanonicalChapterSequence } from '../ai/chapter-memory/canonical-chapter-sequence'

export interface FactCandidateDiffRow {
  subjectName: string
  predicate: string
  value: string
  sourceQuote?: string
  validFromChapterId?: number | null
  validToChapterId?: number | null
}

export interface ImportFactCandidateDiffResult {
  written: number
  skippedInvalid: number
  skippedDuplicate: number
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeRows(raw: unknown): FactCandidateDiffRow[] {
  const arr = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray((raw as any).facts) ? (raw as any).facts : [])
  return arr.map((item: unknown) => ({
    subjectName: clean((item as any)?.subjectName ?? (item as any)?.subject),
    predicate: clean((item as any)?.predicate),
    value: clean((item as any)?.value),
    sourceQuote: clean((item as any)?.sourceQuote ?? (item as any)?.quote) || undefined,
    validFromChapterId: (item as any)?.validFromChapterId ?? null,
    validToChapterId: (item as any)?.validToChapterId ?? null,
  }))
}

async function validChapterId(projectId: number, chapterId: unknown): Promise<number | null> {
  if (chapterId == null) return null
  if (typeof chapterId !== 'number' || !Number.isFinite(chapterId)) return null
  const chapter = await db.chapters.get(chapterId)
  return chapter?.projectId === projectId ? chapterId : null
}

async function validRange(projectId: number, from: number | null, to: number | null): Promise<boolean> {
  if (from == null || to == null) return true
  const [outlineNodes, chapters] = await Promise.all([
    db.outlineNodes.where('projectId').equals(projectId).toArray(),
    db.chapters.where('projectId').equals(projectId).toArray(),
  ])
  const { sequence } = resolveCanonicalChapterSequence(outlineNodes, chapters)
  const orderOf = new Map<number, number>()
  sequence.forEach((entry, index) => {
    if (entry.chapter.id != null) orderOf.set(entry.chapter.id, index)
  })
  const fromOrder = orderOf.get(from)
  const toOrder = orderOf.get(to)
  return fromOrder != null && toOrder != null && fromOrder <= toOrder
}

// ALIAS-1: 人读导入的按名解析改为复用事实账本那一份实现（别称感知、歧义不猜），
// 不再维护第二份"精确等名"的私有副本。
function resolveCharacterId(projectId: number, name: string): Promise<number | null> {
  return resolveFactCharacterId(projectId, name, null)
}

function dedupeKey(fact: Pick<TemporalFact, 'subjectName' | 'predicate' | 'value' | 'validFromChapterId'>): string {
  return [fact.subjectName, fact.predicate, fact.value, fact.validFromChapterId ?? ''].join('|')
}

export async function exportFactMemoryMarkdown(projectId: number): Promise<string> {
  const [project, facts, summaries] = await Promise.all([
    db.projects.get(projectId),
    db.temporalFacts.where('projectId').equals(projectId).toArray(),
    db.narrativeSummaryNodes.where('projectId').equals(projectId).toArray(),
  ])
  const lines: string[] = [
    `# StoryForge 事实/派生记忆导出`,
    '',
    `项目：${project?.name ?? `#${projectId}`}`,
    `导出时间：${new Date().toISOString()}`,
    '',
    '## 事实账本 Temporal Facts',
    '',
  ]
  if (!facts.length) {
    lines.push('（无事实记录）', '')
  } else {
    for (const fact of facts.sort((a, b) => (a.status.localeCompare(b.status) || a.subjectName.localeCompare(b.subjectName)))) {
      const spec = getFactPredicate(fact.predicate)
      lines.push(
        `- [${fact.status}] ${fact.subjectName} / ${spec?.label ?? fact.predicate} = ${fact.value}`,
        `  - id: ${fact.id ?? ''}`,
        `  - predicate: ${fact.predicate}`,
        `  - kind: ${fact.factKind}`,
        `  - source: ${fact.sourceType}${fact.sourceChapterId != null ? ` chapter#${fact.sourceChapterId}` : ''}`,
        `  - valid: ${fact.validFromChapterId ?? '起点未知'} → ${fact.validToChapterId ?? '至今'}`,
        fact.sourceQuote ? `  - quote: ${fact.sourceQuote}` : '',
        '',
      )
    }
  }
  lines.push('## 层级叙事摘要 Narrative Summary Tree', '')
  if (!summaries.length) {
    lines.push('（无派生摘要节点）')
  } else {
    for (const node of summaries.sort((a, b) => a.level.localeCompare(b.level) || a.title.localeCompare(b.title))) {
      lines.push(
        `- [${node.status}] ${node.level} · ${node.title}`,
        `  - sourceChapterId: ${node.sourceChapterId ?? ''}`,
        `  - sourceOutlineNodeId: ${node.sourceOutlineNodeId ?? ''}`,
        `  - summary: ${node.summary.replace(/\n/g, ' / ')}`,
        '',
      )
    }
  }
  const output = lines.filter((line, index, all) => !(line === '' && all[index - 1] === '')).join('\n')
  log.info('FactLedger', 'fact.memory.export.completed', '事实和派生记忆导出已装配', {
    projectId, factCount: facts.length, summaryCount: summaries.length, outputChars: output.length,
  })
  return output
}

export async function importFactCandidateDiff(projectId: number, raw: unknown): Promise<ImportFactCandidateDiffResult> {
  const result: ImportFactCandidateDiffResult = { written: 0, skippedInvalid: 0, skippedDuplicate: 0 }
  const rows = normalizeRows(raw)
  const existing = await db.temporalFacts.where('projectId').equals(projectId).toArray()
  const seen = new Set(existing.map(dedupeKey))
  for (const row of rows) {
    const spec = getFactPredicate(row.predicate)
    const normalizedValue = spec ? normalizeFactValue(spec, row.value) : null
    if (!row.subjectName || !normalizedValue || !spec) {
      result.skippedInvalid++
      continue
    }
    const validFromChapterId = await validChapterId(projectId, row.validFromChapterId)
    const validToChapterId = await validChapterId(projectId, row.validToChapterId)
    if (row.validFromChapterId != null && validFromChapterId == null) {
      result.skippedInvalid++
      continue
    }
    if (row.validToChapterId != null && validToChapterId == null) {
      result.skippedInvalid++
      continue
    }
    if (!await validRange(projectId, validFromChapterId, validToChapterId)) {
      result.skippedInvalid++
      continue
    }
    const key = dedupeKey({ ...row, value: normalizedValue, validFromChapterId })
    if (seen.has(key)) {
      result.skippedDuplicate++
      continue
    }
    seen.add(key)
    const fact: TemporalFact = {
      projectId,
      worldGroupId: null,
      characterId: spec.subjectTypes.includes('character') ? await resolveCharacterId(projectId, row.subjectName) : null,
      subjectName: row.subjectName,
      predicate: row.predicate,
      factKind: spec.factKind as FactKind,
      value: normalizedValue,
      sourceType: 'import',
      sourceRecordTable: 'human-readable-diff',
      sourceQuote: row.sourceQuote,
      validFromChapterId,
      validToChapterId,
      status: 'candidate',
      locked: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await db.temporalFacts.add(fact)
    result.written++
  }
  log.info('FactLedger', 'fact.candidate-diff.import.completed', '人工事实候选差异导入已结束', {
    projectId, inputRows: rows.length, written: result.written,
    skippedInvalid: result.skippedInvalid, skippedDuplicate: result.skippedDuplicate,
  })
  return result
}
