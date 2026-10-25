import type { UseAIStreamReturn } from '../../hooks/useAIStream'
import type { ChatMessage } from '../types'
import type { GenerationNode } from './generation-node'

export type ChapterGenerationOperation = 'generate' | 'continue'
export type ChapterGenerationCategory = 'chapter.content' | 'chapter.continue'

export function createChapterGenerationNode(input: {
  operation: ChapterGenerationOperation
  category: ChapterGenerationCategory
  projectId: number
  chapterIdentity: number | string
  ai: Pick<UseAIStreamReturn, 'start'>
}): GenerationNode<ChatMessage[], string> {
  const { operation, category, projectId, chapterIdentity, ai } = input
  return {
    id: `chapter.${operation}:${chapterIdentity}`,
    kind: category,
    editableInput: true,
    assembleInput: messages => messages.map(message => ({ ...message })),
    run: messages => category === 'chapter.content'
      ? ai.start(messages, undefined, { category: 'chapter.content', projectId })
      : ai.start(messages, undefined, { category: 'chapter.continue', projectId }),
  }
}
