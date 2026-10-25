import { db } from '../db/schema'
import { adopt } from '../registry/adopt'
import { log } from '../logging/logger'
import type {
  AnalysisDimension,
  Reference,
  ReferenceAnalysisDepth,
  ReferenceAnalysisRun,
  ReferenceAnalysisSource,
  ReferenceChunkAnalysis,
  ReferenceSourceKind,
  ReferenceUsageScope,
} from '../types'
import { ANALYSIS_DIMENSIONS } from '../types/reference'
import type { ChunkPlan } from '../import/chunker'
import { ensureLegacyActiveReferenceRun } from './legacy-bridge'

export { ensureLegacyActiveReferenceRun } from './legacy-bridge'

export const REFERENCE_ANALYSIS_RUN_POLICY = Object.freeze({
  maxRunsPerReference: 6,
  sourceKinds: ['own-work', 'authorized', 'public-domain', 'research', 'unknown'] as const,
  usageScopes: ['analysis-only', 'creative-reference', 'continuation-authorized'] as const,
})

export interface CreateReferenceAnalysisRunInput {
  referenceId: number
  depth: ReferenceAnalysisDepth
  sourceFilename: string
  fileHash: string
  totalChars: number
  expectedChunks: number
  sourceKind: ReferenceSourceKind
  usageScope: ReferenceUsageScope
  rightsNote?: string
  rightsConfirmed: boolean
  sourceText?: string
  sourceChunks?: ChunkPlan[]
}

function constrainUsageScope(
  sourceKind: ReferenceSourceKind,
  usageScope: ReferenceUsageScope,
): ReferenceUsageScope {
  if (sourceKind === 'research' || sourceKind === 'unknown') return 'analysis-only'
  return usageScope
}

async function pruneOneDisposableRun(referenceId: number): Promise<boolean> {
  const runs = await db.referenceAnalysisRuns
    .where('referenceId').equals(referenceId).toArray()
  if (runs.length < REFERENCE_ANALYSIS_RUN_POLICY.maxRunsPerReference) return true
  const disposable = runs
    .filter(run => run.status === 'failed' || run.status === 'cancelled' || run.status === 'superseded')
    .sort((a, b) => a.updatedAt - b.updatedAt)[0]
  if (!disposable?.id) return false
  await discardReferenceAnalysisRun(disposable.id)
  return true
}

export async function createReferenceAnalysisRun(
  input: CreateReferenceAnalysisRunInput,
): Promise<ReferenceAnalysisRun> {
  const ref = await db.references.get(input.referenceId)
  if (!ref?.id) throw new Error('参考资料不存在')
  if (!input.sourceFilename.trim()) throw new Error('来源文件名不能为空')
  if (!input.fileHash.trim()) throw new Error('来源文件哈希不能为空')
  if (input.totalChars <= 0 || input.expectedChunks <= 0) throw new Error('来源文本或分块计划为空')
  if (!await pruneOneDisposableRun(ref.id)) {
    throw new Error(`每份参考最多保留 ${REFERENCE_ANALYSIS_RUN_POLICY.maxRunsPerReference} 个版本，请先删除未使用版本`)
  }

  await ensureLegacyActiveReferenceRun(ref.id)
  const existing = await db.referenceAnalysisRuns
    .where('referenceId').equals(ref.id).toArray()
  const version = Math.max(0, ...existing.map(run => run.version)) + 1
  const now = Date.now()
  const row: ReferenceAnalysisRun = {
    projectId: ref.projectId,
    referenceId: ref.id,
    version,
    status: 'analyzing',
    depth: input.depth,
    sourceFilename: input.sourceFilename.trim(),
    fileHash: input.fileHash.trim(),
    totalChars: input.totalChars,
    sourceKind: input.sourceKind,
    usageScope: constrainUsageScope(input.sourceKind, input.usageScope),
    rightsNote: (input.rightsNote ?? '').trim().slice(0, 1000),
    rightsConfirmed: input.rightsConfirmed,
    rightsDeclaredAt: now,
    expectedChunks: input.expectedChunks,
    completedChunks: 0,
    progress: 0,
    createdAt: now,
    updatedAt: now,
  }

  const runId = await db.transaction(
    'rw',
    db.referenceAnalysisRuns,
    db.referenceAnalysisSources,
    async () => {
      const id = await db.referenceAnalysisRuns.add(row) as number
      if (input.sourceText != null || input.sourceChunks?.length) {
        const chunks = input.sourceChunks?.length
          ? input.sourceChunks
          : [{
              index: 0,
              startChar: 0,
              endChar: input.sourceText!.length,
              charCount: input.sourceText!.length,
              label: '全书',
              text: input.sourceText!,
            }]
        const source: ReferenceAnalysisSource = {
          analysisRunId: id,
          filename: row.sourceFilename,
          fileHash: row.fileHash,
          chunks,
          createdAt: now,
        }
        await db.referenceAnalysisSources.put(source)
      }
      return id
    },
  )
  return { ...row, id: runId }
}

export async function listReferenceAnalysisRuns(referenceId: number): Promise<ReferenceAnalysisRun[]> {
  await ensureLegacyActiveReferenceRun(referenceId)
  const runs = await db.referenceAnalysisRuns
    .where('referenceId').equals(referenceId).toArray()
  return runs.sort((a, b) => b.version - a.version)
}

export async function getActiveReferenceAnalysisRun(
  referenceId: number,
): Promise<ReferenceAnalysisRun | undefined> {
  const legacy = await ensureLegacyActiveReferenceRun(referenceId)
  if (legacy) return legacy
  return (await db.referenceAnalysisRuns
    .where('referenceId').equals(referenceId).toArray())
    .find(run => run.status === 'active')
}

export async function getReferenceAnalysisRunChunks(
  referenceId: number,
  analysisRunId?: number,
): Promise<ReferenceChunkAnalysis[]> {
  const run = analysisRunId
    ? await db.referenceAnalysisRuns.get(analysisRunId)
    : await getActiveReferenceAnalysisRun(referenceId)
  if (run && run.referenceId !== referenceId) return []
  if (run?.id) {
    return db.referenceChunkAnalysis
      .where('analysisRunId').equals(run.id)
      .sortBy('chunkIndex')
  }
  return (await db.referenceChunkAnalysis
    .where('referenceId').equals(referenceId)
    .sortBy('chunkIndex'))
    .filter(chunk => chunk.analysisRunId == null)
}

export async function readReferenceAnalysisSource(runId: number): Promise<string | undefined> {
  const source = await db.referenceAnalysisSources.get(runId)
  return source?.chunks.map(chunk => chunk.text).join('\n\n')
}

export async function readReferenceAnalysisChunks(runId: number): Promise<ChunkPlan[] | undefined> {
  const source = await db.referenceAnalysisSources.get(runId)
  return source?.chunks
}

export async function patchReferenceAnalysisRun(
  runId: number,
  changes: Partial<ReferenceAnalysisRun>,
): Promise<void> {
  const run = await db.referenceAnalysisRuns.get(runId)
  if (!run) throw new Error('分析版本不存在')
  const result = await adopt({
    projectId: run.projectId,
    target: 'referenceAnalysisRuns',
    recordId: runId,
    mode: 'replace',
    data: changes as Record<string, unknown>,
  })
  if (!result.written.length) {
    throw new Error(`分析版本写回被拒绝：${result.skipped[0]?.reason ?? result.typeErrors[0]?.field ?? 'unknown'}`)
  }
}

export async function completeReferenceAnalysisRun(
  runId: number,
  _reportedCompletedChunks: number,
  error?: string,
): Promise<'active' | 'ready' | 'failed'> {
  const run = await db.referenceAnalysisRuns.get(runId)
  if (!run) throw new Error('分析版本不存在')
  const completedChunks = await db.referenceChunkAnalysis
    .where('analysisRunId').equals(runId).count()
  const hasResults = completedChunks > 0
  if (!hasResults) {
    await patchReferenceAnalysisRun(runId, {
      status: 'failed',
      completedChunks: 0,
      progress: 0,
      error: error || '没有可用分析结果',
      completedAt: Date.now(),
    })
    const active = await getActiveReferenceAnalysisRun(run.referenceId)
    if (!active) await patchReferenceCompatibility(run.referenceId, {
      analysisStatus: 'failed',
      analysisError: error || '没有可用分析结果',
      analysisProgress: 0,
    })
    log.warn('ReferenceAnalysis', 'reference.run.no-results', '参考书分析完成 0 块，判定为失败', {
      projectId: run.projectId,
      referenceId: run.referenceId,
      runId: run.id,
      expectedChunks: run.expectedChunks,
      hasError: Boolean(error),
    })
    return 'failed'
  }

  const active = await getActiveReferenceAnalysisRun(run.referenceId)
  if (!active) {
    await patchReferenceAnalysisRun(runId, {
      status: 'ready',
      completedChunks,
      progress: Math.min(100, Math.round((completedChunks / run.expectedChunks) * 100)),
      error: error ?? null,
      completedAt: Date.now(),
    })
    await activateReferenceAnalysisRun(runId)
    return 'active'
  }
  await patchReferenceAnalysisRun(runId, {
    status: 'ready',
    completedChunks,
    progress: Math.min(100, Math.round((completedChunks / run.expectedChunks) * 100)),
    error: error ?? null,
    completedAt: Date.now(),
  })
  return 'ready'
}

export async function activateReferenceAnalysisRun(runId: number): Promise<void> {
  const target = await db.referenceAnalysisRuns.get(runId)
  if (!target?.id) throw new Error('分析版本不存在')
  if (!['ready', 'active', 'superseded'].includes(target.status)) {
    throw new Error('只有已完成版本可以激活')
  }
  const now = Date.now()
  await db.transaction('rw', db.references, db.referenceAnalysisRuns, async () => {
    const runs = await db.referenceAnalysisRuns
      .where('referenceId').equals(target.referenceId).toArray()
    for (const run of runs) {
      if (!run.id || run.id === runId || run.status !== 'active') continue
      await db.referenceAnalysisRuns.update(run.id, { status: 'superseded', updatedAt: now })
    }
    await db.referenceAnalysisRuns.update(runId, {
      status: 'active',
      activatedAt: now,
      updatedAt: now,
    })
    await db.references.update(target.referenceId, {
      totalChars: target.totalChars,
      fileHash: target.fileHash,
      analysisDepth: target.depth,
      analysisStatus: 'done',
      analysisProgress: target.progress,
      analysisError: target.error,
      analysisSummary: target.analysisSummary,
      mergedCharacters: target.mergedCharacters,
      updatedAt: now,
    })
  })
}

export async function updateReferenceAnalysisDerived(
  runId: number,
  changes: Pick<ReferenceAnalysisRun, 'analysisSummary'> | Pick<ReferenceAnalysisRun, 'mergedCharacters'>,
): Promise<void> {
  await patchReferenceAnalysisRun(runId, changes)
  const run = await db.referenceAnalysisRuns.get(runId)
  if (!run || run.status !== 'active') return
  await patchReferenceCompatibility(run.referenceId, changes as Partial<Reference>)
}

export async function discardReferenceAnalysisRun(runId: number): Promise<void> {
  const run = await db.referenceAnalysisRuns.get(runId)
  if (!run) return
  if (run.status === 'active') throw new Error('不能删除当前激活版本，请先激活另一版本')
  await db.transaction(
    'rw',
    db.referenceAnalysisRuns,
    db.referenceAnalysisSources,
    db.referenceChunkAnalysis,
    async () => {
      await db.referenceChunkAnalysis.where('analysisRunId').equals(runId).delete()
      await db.referenceAnalysisSources.delete(runId)
      await db.referenceAnalysisRuns.delete(runId)
    },
  )
}

export async function deleteReferenceWithAnalysis(referenceId: number): Promise<number | undefined> {
  const ref = await db.references.get(referenceId)
  if (!ref?.id) return undefined
  const runs = await db.referenceAnalysisRuns
    .where('referenceId').equals(referenceId).toArray()
  const runIds = runs.map(run => run.id).filter((id): id is number => id != null)
  await db.transaction(
    'rw',
    [
      db.references,
      db.referenceAnalysisRuns,
      db.referenceAnalysisSources,
      db.referenceChunkAnalysis,
      db.creativeRules,
    ],
    async () => {
      const rules = await db.creativeRules.where('projectId').equals(ref.projectId).toArray()
      for (const rule of rules) {
        if (!rule.id) continue
        const ids = parseIdArray(rule.citedReferenceIds)
        if (!ids.includes(referenceId)) continue
        await db.creativeRules.update(rule.id, {
          citedReferenceIds: JSON.stringify(ids.filter(id => id !== referenceId)),
          updatedAt: Date.now(),
        })
      }
      await db.referenceChunkAnalysis.where('referenceId').equals(referenceId).delete()
      if (runIds.length) await db.referenceAnalysisSources.bulkDelete(runIds)
      await db.referenceAnalysisRuns.where('referenceId').equals(referenceId).delete()
      await db.references.delete(referenceId)
    },
  )
  log.info('ReferenceStore', 'reference.delete-cascade', '参考书级联删除完成', {
    projectId: ref.projectId,
    referenceId,
    analysisRunCount: runIds.length,
  })
  return ref.projectId
}

async function patchReferenceCompatibility(referenceId: number, changes: Partial<Reference>): Promise<void> {
  const ref = await db.references.get(referenceId)
  if (!ref) return
  const result = await adopt({
    projectId: ref.projectId,
    target: 'references',
    recordId: referenceId,
    mode: 'replace',
    data: changes as Record<string, unknown>,
  })
  if (!result.written.length) throw new Error('参考资料兼容投影写回失败')
}

function parseIdArray(value: unknown): number[] {
  if (Array.isArray(value)) return value.filter((id): id is number => typeof id === 'number')
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed.filter((id): id is number => typeof id === 'number') : []
  } catch {
    return []
  }
}

export interface ReferenceAnalysisDiff {
  added: AnalysisDimension[]
  changed: AnalysisDimension[]
  removed: AnalysisDimension[]
  unchanged: AnalysisDimension[]
}

export function diffReferenceAnalysisChunks(
  active: ReferenceChunkAnalysis[],
  candidate: ReferenceChunkAnalysis[],
): ReferenceAnalysisDiff {
  const result: ReferenceAnalysisDiff = { added: [], changed: [], removed: [], unchanged: [] }
  for (const dimension of ANALYSIS_DIMENSIONS) {
    const before = normalizedDimension(active, dimension)
    const after = normalizedDimension(candidate, dimension)
    if (!before && after) result.added.push(dimension)
    else if (before && !after) result.removed.push(dimension)
    else if (before === after) result.unchanged.push(dimension)
    else result.changed.push(dimension)
  }
  return result
}

function normalizedDimension(
  chunks: ReferenceChunkAnalysis[],
  dimension: AnalysisDimension,
): string {
  return chunks
    .map(chunk => chunk[dimension])
    .filter((value): value is string => typeof value === 'string' && value !== '本块未涉及')
    .map(value => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}
