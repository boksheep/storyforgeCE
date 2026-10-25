import { db } from '../db/schema'
import { log } from '../logging/logger'
import type { ReferenceAnalysisRun } from '../types'

/**
 * 旧项目只保存 Reference + 无 runId 分块。第一次读取版本能力时创建显式 v1，
 * 不在 schema migration 中猜测，也不改分块主键或分析内容。
 *
 * 此桥接保持为独立小模块：通用 AI 上下文会读它，但不应因此把完整分析生命周期
 * 和写回管线打进首屏入口包。
 */
export async function ensureLegacyActiveReferenceRun(
  referenceId: number,
): Promise<ReferenceAnalysisRun | undefined> {
  const existingRuns = await db.referenceAnalysisRuns
    .where('referenceId').equals(referenceId).toArray()
  const existingActive = existingRuns.find(run => run.status === 'active')
  if (existingActive) return existingActive
  if (existingRuns.length > 0) return undefined

  const ref = await db.references.get(referenceId)
  if (!ref?.id || ref.analysisStatus !== 'done') return undefined
  const legacyChunks = (await db.referenceChunkAnalysis
    .where('referenceId').equals(referenceId).toArray())
    .filter(chunk => chunk.analysisRunId == null)
  if (!legacyChunks.length) {
    log.warn('ReferenceAnalysis', 'reference.legacy.run.no-chunks', '旧版参考标记为已完成，但无未归属分块', { referenceId })
    return undefined
  }

  const now = Date.now()
  return db.transaction(
    'rw',
    db.references,
    db.referenceAnalysisRuns,
    db.referenceChunkAnalysis,
    async () => {
      const recheck = await db.referenceAnalysisRuns
        .where('referenceId').equals(referenceId).toArray()
      if (recheck.length) return recheck.find(run => run.status === 'active')
      const run: ReferenceAnalysisRun = {
        projectId: ref.projectId,
        referenceId,
        version: 1,
        status: 'active',
        depth: ref.analysisDepth ?? 'quick',
        sourceFilename: ref.importedData?.sourceFilename ?? ref.title,
        fileHash: ref.fileHash ?? `legacy-reference-${referenceId}`,
        totalChars: ref.totalChars ?? 0,
        sourceKind: 'unknown',
        usageScope: 'analysis-only',
        rightsNote: '旧版分析兼容桥接：未记录来源声明',
        rightsConfirmed: false,
        rightsDeclaredAt: now,
        expectedChunks: legacyChunks.length,
        completedChunks: legacyChunks.length,
        progress: 100,
        analysisSummary: ref.analysisSummary,
        mergedCharacters: ref.mergedCharacters,
        completedAt: now,
        activatedAt: now,
        createdAt: ref.createdAt,
        updatedAt: now,
      }
      const id = await db.referenceAnalysisRuns.add(run) as number
      await db.referenceChunkAnalysis.bulkPut(
        legacyChunks.map(chunk => ({ ...chunk, analysisRunId: id })),
      )
      log.info('ReferenceAnalysis', 'reference.legacy.run.ensured', '旧版参考已桥接为 v1 运行', {
        referenceId,
        runId: id,
        chunks: legacyChunks.length,
      })
      return { ...run, id }
    },
  )
}
