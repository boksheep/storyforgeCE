import { db } from '../db/schema'
import { adopt } from '../registry/adopt'
import type { CharacterDrivenPlotVolume } from '../types/character-driven-plan'

export interface CharacterDrivenAdoptionResult {
  volumeIds: number[]
  chapterIds: number[]
}

async function resolveWorldGroupId(projectId: number): Promise<number | null> {
  const project = await db.projects.get(projectId)
  if (!project?.enableMultiWorld) return null
  const primary = await db.worldGroups
    .where('projectId').equals(projectId)
    .and(group => group.type === 'primary')
    .first()
  return primary?.id ?? null
}

/**
 * 角色驱动结果写入大纲的唯一领域入口。
 * 每一行都经过 adopt()/FIELD_REGISTRY/ADOPTION_SCHEMAS；重复卷复用既有节点，
 * 不绕过统一写回层，也不触碰 storyCore 或既有正文。
 */
export async function adoptCharacterDrivenVolumes(input: {
  projectId: number
  volumes: CharacterDrivenPlotVolume[]
}): Promise<CharacterDrivenAdoptionResult> {
  const worldGroupId = await resolveWorldGroupId(input.projectId)
  const topLevel = await db.outlineNodes
    .where('projectId').equals(input.projectId)
    .filter(node => node.parentId === null)
    .toArray()
  const result: CharacterDrivenAdoptionResult = { volumeIds: [], chapterIds: [] }

  for (let volumeIndex = 0; volumeIndex < input.volumes.length; volumeIndex++) {
    const volume = input.volumes[volumeIndex]
    const adoptedVolume = await adopt({
      projectId: input.projectId,
      worldGroupId,
      target: 'outlineNodes',
      mode: 'add',
      data: {
        parentId: null,
        type: 'volume',
        title: volume.volumeTitle,
        summary: volume.volumeSummary,
        order: topLevel.length + volumeIndex,
      },
    })
    const volumeId = adoptedVolume.written[0]?.id
      ?? (await db.outlineNodes
        .where('projectId').equals(input.projectId)
        .filter(node =>
          node.parentId === null
          && node.type === 'volume'
          && node.title === volume.volumeTitle,
        )
        .first())?.id
    if (volumeId == null) throw new Error(`无法采纳卷：${volume.volumeTitle}`)
    result.volumeIds.push(volumeId)

    for (let chapterIndex = 0; chapterIndex < volume.chapters.length; chapterIndex++) {
      const chapter = volume.chapters[chapterIndex]
      const adoptedChapter = await adopt({
        projectId: input.projectId,
        worldGroupId,
        target: 'outlineNodes',
        mode: 'add',
        data: {
          parentId: volumeId,
          type: 'chapter',
          title: chapter.title,
          summary: `${chapter.summary}${chapter.arcProgress ? `\n\n【角色弧光推进】${chapter.arcProgress}` : ''}`,
          order: chapterIndex,
        },
      })
      const chapterId = adoptedChapter.written[0]?.id
      if (chapterId != null) result.chapterIds.push(chapterId)
    }
  }

  return result
}
