import { chat } from './client'
import { buildStoryTimelinePrompt, parseStoryEvents, type ExtractedStoryEvent } from './adapters/story-timeline-adapter'
import { splitExtractionText, uniqueBy } from './structured-extraction'
import { assembleContext } from '../registry/assemble-context'
import { replaceAdoptedCollection } from '../registry/adopt'
import { htmlToPlainText } from '../utils/html'
import { log } from '../logging/logger'
import type { AIConfig, Chapter } from '../types'

/** 当前统一时间线唯一的正文提取入口；写入仍通过三注册表采纳。 */
export async function extractStoryTimelineFromChapters(input: {
  projectId: number
  chapters: Chapter[]
  config: AIConfig
  onProgress?: (done: number, total: number) => void
  call?: typeof chat
}): Promise<{ chapters: number; events: number }> {
  const chapters = input.chapters.filter(chapter =>
    chapter.id != null && htmlToPlainText(chapter.content ?? '').trim().length > 50)
  if (!chapters.length) throw new Error('还没有已写正文的章节，先去写作再提取')
  let eventCount = 0
  const call = input.call ?? chat
  for (let index = 0; index < chapters.length; index++) {
    const chapter = chapters[index]
    const source = await assembleContext({
      projectId: input.projectId,
      chapterId: chapter.id,
      sourceKeys: ['chapterContent'],
    })
    const found: ExtractedStoryEvent[] = []
    for (const chunk of splitExtractionText(source.text)) {
      const raw = await call(
        buildStoryTimelinePrompt(chapter.title, chunk),
        input.config,
        { category: 'story.timeline', projectId: input.projectId },
      )
      found.push(...parseStoryEvents(raw))
    }
    const parsed = uniqueBy(found, event =>
      `${event.title.trim().toLocaleLowerCase()}\u0000${event.storyTime.trim()}`)
    if (parsed.length && chapter.id != null) {
      await replaceAdoptedCollection({
        projectId: input.projectId,
        target: 'storyTimelineEvents',
        scope: { chapterId: chapter.id },
        data: parsed.map((event, order) => ({
          title: event.title, storyTime: event.storyTime || '',
          importance: event.importance, description: event.description || '',
          chapterId: chapter.id, chapterTitle: chapter.title, order,
        })),
      })
      eventCount += parsed.length
    }
    input.onProgress?.(index + 1, chapters.length)
  }
  log.info('StoryTimeline', 'storytimeline.extracted', '故事年表正文提取完成', {
    projectId: input.projectId, chapterCount: chapters.length, eventCount,
  })
  return { chapters: chapters.length, events: eventCount }
}
