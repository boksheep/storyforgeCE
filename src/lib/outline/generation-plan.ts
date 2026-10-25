import type { ChatMessage, OutlineNode, Project } from '../types'
import { log } from '../logging/logger'
import {
  buildChapterOutlinePrompt,
  buildSingleChapterOutlinePrompt,
  buildVolumeOutlinePrompt,
  type RunOptions,
} from '../ai/adapters/outline-adapter'
import type { AssembleContextResult } from '../registry/types'
import type { OutlineGenerationRequest } from './generation-request'

export type OutlineGenerationPlan = {
  status: 'ready'
  category: 'outline.volume' | 'outline.chapter'
  messages: ChatMessage[]
} | {
  status: 'skip'
  reason: string
}

function contextPart(assembled: AssembleContextResult, key: string): string {
  const index = assembled.included.indexOf(key)
  return index >= 0 ? assembled.segments[index]?.content ?? '' : ''
}

export function findVolumeForOutlineChapter(nodes: OutlineNode[], chapterId: number): OutlineNode | null {
  const chapter = nodes.find(node => node.id === chapterId && node.type === 'chapter')
  if (!chapter) return null
  const parent = nodes.find(node => node.id === chapter.parentId)
  if (parent?.type === 'volume') return parent
  if (parent?.type === 'storyBlock') return nodes.find(node => node.id === parent.parentId && node.type === 'volume') ?? null
  return null
}

export function findGenerationTargetVolume(request: OutlineGenerationRequest, nodes: OutlineNode[], volumes: OutlineNode[]): OutlineNode | null {
  if (request.kind === 'single-volume' || request.kind === 'chapters' || request.kind === 'chapters-optimize') return volumes.find(volume => volume.id === request.volumeId) ?? null
  if (request.kind === 'single-chapter') return findVolumeForOutlineChapter(nodes, request.chapterId)
  return null
}

export function outlineGenerationTargetError(request: OutlineGenerationRequest, nodes: OutlineNode[], volumes: OutlineNode[]): string | null {
  if (request.kind === 'volumes') return null
  if (findGenerationTargetVolume(request, nodes, volumes)) return null
  return request.kind === 'single-volume' ? '要补全的卷不存在，请重新选择。' : '要生成章纲的卷不存在，请重新选择。'
}

export function buildOutlineGenerationPlan(input: {
  request: OutlineGenerationRequest
  project: Project
  nodes: OutlineNode[]
  volumes: OutlineNode[]
  assembled: AssembleContextResult
  hint: string
  options: RunOptions
}): OutlineGenerationPlan {
  const { request, project, nodes, volumes, assembled, hint, options } = input
  const targetError = outlineGenerationTargetError(request, nodes, volumes)
  if (targetError) {
    log.warn('OutlineDomain', 'outline.generation.plan.skipped', targetError, {
      projectId: project.id ?? null,
      requestKind: request.kind,
    })
    return { status: 'skip', reason: targetError }
  }

  if (request.kind === 'volumes' || request.kind === 'single-volume') {
    const explicitCount = Number(options.parameterValues?.volumeCount)
    if (request.kind === 'volumes' && options.parameterValues?.volumeCount !== '' && options.parameterValues?.volumeCount != null && Number.isFinite(explicitCount) && explicitCount > 0 && explicitCount <= volumes.length) {
      const reachedReason = `当前已有 ${volumes.length} 卷，已达到你设定的 ${Math.floor(explicitCount)} 卷，无需继续生成。`
      log.warn('OutlineDomain', 'outline.generation.plan.skipped', reachedReason, {
        projectId: project.id ?? null,
        requestKind: request.kind,
        existingVolumeCount: volumes.length,
        configuredVolumeCount: Math.floor(explicitCount),
      })
      return { status: 'skip', reason: reachedReason }
    }
    const targetVolume = request.kind === 'single-volume' ? volumes.find(volume => volume.id === request.volumeId) ?? null : null
    const messages = buildVolumeOutlinePrompt(project.name, project.genre, assembled.text, contextPart(assembled, 'storyCore'), project.targetWordCount || 500000, hint, options, contextPart(assembled, 'characters'), contextPart(assembled, 'worldRules'), {
      existingVolumesContext: contextPart(assembled, 'existingVolumeOutlines'), existingVolumeCount: volumes.length, targetVolumeTitle: targetVolume?.title,
    })
    log.info('OutlineDomain', 'outline.generation.plan.ready', `卷纲生成计划就绪：${messages.length} 条消息`, {
      projectId: project.id ?? null,
      requestKind: request.kind,
      category: 'outline.volume',
      nodeCount: messages.length,
      existingVolumeCount: volumes.length,
    })
    return {
      status: 'ready', category: 'outline.volume',
      messages,
    }
  }

  const volume = request.kind === 'chapters' || request.kind === 'chapters-optimize' ? volumes.find(item => item.id === request.volumeId) ?? null : findVolumeForOutlineChapter(nodes, request.chapterId)
  if (!volume) {
    log.warn('OutlineDomain', 'outline.generation.plan.skipped', '要生成章纲的卷不存在，请重新选择。', {
      projectId: project.id ?? null,
      requestKind: request.kind,
    })
    return { status: 'skip', reason: '要生成章纲的卷不存在，请重新选择。' }
  }
  const volumeIndex = volumes.findIndex(item => item.id === volume.id)
  const previousSummary = volumeIndex > 0 ? volumes[volumeIndex - 1].summary : ''
  const characterContext = contextPart(assembled, 'characters')
  const worldRulesContext = contextPart(assembled, 'worldRules')

  if (request.kind === 'single-chapter') {
    const chapter = nodes.find(node => node.id === request.chapterId && node.type === 'chapter')
    if (!chapter) {
      log.warn('OutlineDomain', 'outline.generation.plan.skipped', '要生成章纲的章节不存在，请重新选择。', {
        projectId: project.id ?? null,
        requestKind: request.kind,
      })
      return { status: 'skip', reason: '要生成章纲的章节不存在，请重新选择。' }
    }
    const siblings = nodes.filter(node => node.type === 'chapter' && node.parentId === chapter.parentId && node.id !== chapter.id).sort((a, b) => a.order - b.order)
    const siblingContext = siblings.length ? `同级已有章节：\n${siblings.map(item => `- ${item.title}${item.summary ? `：${item.summary}` : ''}`).join('\n')}` : ''
    const previousCandidates = siblings.filter(item => item.order < chapter.order)
    const previousChapter = previousCandidates[previousCandidates.length - 1]
    const nextChapter = siblings.find(item => item.order > chapter.order)
    const neighboringContext = [
      previousChapter ? `前一章（必须承接其结尾状态）：${previousChapter.title}${previousChapter.summary ? `：${previousChapter.summary}` : '（暂无章纲）'}` : '前方没有已知前一章，本章负责建立开场状态。',
      nextChapter ? `后一章（必须为其留下可接续落点）：${nextChapter.title}${nextChapter.summary ? `：${nextChapter.summary}` : '（暂无章纲）'}` : '后方没有已知后一章，本章负责形成可扩展的卷内落点。',
    ].join('\n')
    const messages = buildSingleChapterOutlinePrompt(volume.title, volume.summary, chapter.title, siblingContext, assembled.text, previousSummary, hint, options, characterContext, worldRulesContext, neighboringContext)
    log.info('OutlineDomain', 'outline.generation.plan.ready', `单章章纲生成计划就绪：${messages.length} 条消息`, {
      projectId: project.id ?? null,
      requestKind: request.kind,
      category: 'outline.chapter',
      nodeCount: messages.length,
      siblingCount: siblings.length,
    })
    return {
      status: 'ready', category: 'outline.chapter',
      messages,
    }
  }

  const chapterHint = request.kind === 'chapters-optimize'
    ? `${hint}\n【优化扩展全卷章纲】请结合已有章节逐章检查并优化：保持已有章节标题和顺序，已有章纲输出改进后的同标题摘要；对明显缺失的后续剧情可追加章节。只输出本卷完整章节 JSON 数组。`
    : hint
  const messages = buildChapterOutlinePrompt(volume.title, volume.summary, assembled.text, previousSummary, chapterHint, options, characterContext, worldRulesContext)
  log.info('OutlineDomain', 'outline.generation.plan.ready', `批量章纲生成计划就绪：${messages.length} 条消息`, {
    projectId: project.id ?? null,
    requestKind: request.kind,
    category: 'outline.chapter',
    nodeCount: messages.length,
  })
  return {
    status: 'ready', category: 'outline.chapter',
    messages,
  }
}
