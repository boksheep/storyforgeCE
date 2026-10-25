import { adopt } from '../registry/adopt'
import { log } from '../logging/logger'
import type { GeneratedEntityCandidates } from '../ai/adapters/generation-entities-adapter'

export interface GeneratedOutlineItem {
  title: string
  summary: string
  entities?: GeneratedEntityCandidates
}

export interface AdoptGeneratedOutlineItemsInput {
  projectId: number
  worldGroupId?: number | null
  parentId: number | null
  type: 'volume' | 'chapter'
  items: GeneratedOutlineItem[]
  startingOrder: number
}

export interface AdoptGeneratedOutlineItemsResult {
  writtenCount: number
  firstId: number | null
  skippedReasons: string[]
  writtenItems?: GeneratedOutlineItem[]
}

export async function adoptOptimizedChapterOutlines(input: {
  projectId: number
  parentId: number
  items: GeneratedOutlineItem[]
  existing: Array<{ id?: number; title: string; order: number }>
}): Promise<AdoptGeneratedOutlineItemsResult> {
  let writtenCount = 0
  let firstId: number | null = null
  const skippedReasons = new Set<string>()
  const writtenItems: GeneratedOutlineItem[] = []
  for (const [index, item] of input.items.entries()) {
    const existing = input.existing.find(node => node.title.trim() === item.title.trim())
    const result = await adopt({
      projectId: input.projectId,
      target: 'outlineNodes',
      recordId: existing?.id,
      mode: existing?.id != null ? 'replace' : 'add',
      data: existing?.id != null
        ? { summary: item.summary }
        : { parentId: input.parentId, type: 'chapter', title: item.title, summary: item.summary, order: input.existing.length + index },
    })
    const id = result.written[0]?.id ?? existing?.id ?? null
    if (id != null) { writtenCount++; writtenItems.push(item); if (firstId == null) firstId = id }
    else skippedReasons.add(result.skipped[0]?.reason ?? '未知原因')
  }
  // AI 输出翻成 DB 行：写 0 行必须可见，否则"优化了但没采纳"看起来像成功。
  if (writtenCount === 0) {
    log.warn('OutlineDomain', 'outline.adoption.optimize.empty', `优化采纳写入 0 行（共 ${input.items.length} 行）`, {
      projectId: input.projectId,
      target: 'outlineNodes',
      writtenCount,
      totalCount: input.items.length,
      skippedCount: skippedReasons.size,
    })
  } else {
    log.info('OutlineDomain', 'outline.adoption.optimize.completed', `优化采纳：写入 ${writtenCount}/${input.items.length} 行`, {
      projectId: input.projectId,
      target: 'outlineNodes',
      writtenCount,
      totalCount: input.items.length,
      skippedCount: skippedReasons.size,
    })
  }
  return { writtenCount, firstId, skippedReasons: [...skippedReasons], writtenItems }
}

export async function adoptGeneratedOutlineSummary(
  projectId: number,
  recordId: number,
  summary: string,
): Promise<{ written: boolean; reason?: string }> {
  const result = await adopt({
    projectId,
    target: 'outlineNodes',
    recordId,
    mode: 'replace',
    data: { summary },
  })
  const written = result.written.length > 0
  const reason = written ? undefined : (result.skipped[0]?.reason ?? '结果为空')
  // 单条章纲摘要替换：写 0 行与写成功必须分得清（事故常表现为后者）。
  if (written) {
    log.info('OutlineDomain', 'outline.adoption.summary.completed', '章纲摘要已采纳', {
      projectId,
      target: 'outlineNodes',
      recordId,
      mode: 'replace',
    })
  } else {
    log.warn('OutlineDomain', 'outline.adoption.summary.empty', '章纲摘要采纳未生效（写 0 行）', {
      projectId,
      target: 'outlineNodes',
      recordId,
      mode: 'replace',
    })
  }
  return { written, reason }
}

export async function adoptGeneratedOutlineItems(
  input: AdoptGeneratedOutlineItemsInput,
): Promise<AdoptGeneratedOutlineItemsResult> {
  let writtenCount = 0
  let firstId: number | null = null
  const skippedReasons = new Set<string>()
  const writtenItems: GeneratedOutlineItem[] = []

  for (let index = 0; index < input.items.length; index++) {
    const item = input.items[index]
    const result = await adopt({
      projectId: input.projectId,
      worldGroupId: input.worldGroupId,
      target: 'outlineNodes',
      mode: 'add',
      data: {
        parentId: input.parentId,
        type: input.type,
        title: item.title,
        summary: item.summary,
        order: input.startingOrder + index,
      },
    })
    const id = result.written[0]?.id ?? null
    if (id != null) {
      writtenCount++
      writtenItems.push(item)
      if (firstId == null) firstId = id
    } else {
      skippedReasons.add(result.skipped[0]?.reason ?? '未知原因')
    }
  }

  // AI 生成的卷/章节点翻成 DB 行：写 0 行视为失败信号而非成功。
  const adoptionMeta = {
    projectId: input.projectId,
    target: 'outlineNodes',
    mode: 'add',
    type: input.type,
    writtenCount,
    totalCount: input.items.length,
    skippedCount: skippedReasons.size,
    ...(input.worldGroupId != null ? { worldGroupId: input.worldGroupId } : {}),
  }
  if (writtenCount === 0) {
    log.warn('OutlineDomain', 'outline.adoption.items.empty', `大纲采纳写入 0 行（共 ${input.items.length} 行）`, adoptionMeta)
  } else {
    log.info('OutlineDomain', 'outline.adoption.items.completed', `大纲采纳：写入 ${writtenCount}/${input.items.length} 行`, adoptionMeta)
  }
  return { writtenCount, firstId, skippedReasons: [...skippedReasons], writtenItems }
}
