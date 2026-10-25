import type { ChatMessage, CharacterDrivenPlan } from '../types'
import { parseCharacterDrivenPlanArcs } from '../types'
import { db } from '../db/schema'
import { assembleContext } from '../registry/assemble-context'
import {
  buildCharacterRevisionSnapshot,
  formatCharacterRevisionScope,
  type CharacterRevisionScopeInput,
  type CharacterRevisionSnapshot,
} from '../story-planning/character-revision'
import { usePromptStore } from '../../stores/prompt'
import { renderPrompt } from './prompt-engine'
import { appendSimplifiedChineseOutputConstraint } from './adapters/prompt-guards'

export interface PreparedCharacterRevisionRequest {
  messages: ChatMessage[]
  snapshot: CharacterRevisionSnapshot
  includedSources: string[]
  omittedSources: string[]
}

function formatPlan(plan: CharacterDrivenPlan | null): string {
  if (!plan) return '【本次所选角色驱动方案】无；仅依据角色卡与作者变更说明分析。'
  const lines = [
    `【本次所选角色驱动方案】${plan.name}（v${plan.version}，${plan.status}）`,
  ]
  if (plan.userHint.trim()) lines.push(`作者要求：${plan.userHint.trim()}`)
  for (const arc of parseCharacterDrivenPlanArcs(plan.arcs)) {
    lines.push(
      `- ${arc.name}｜${arc.role || '未标注身份'}：${arc.initialState || '未填写'} → ${arc.targetState || '未填写'}`,
    )
  }
  return lines.join('\n')
}

async function resolveWorldGroupId(
  projectId: number,
  characterId: number | null,
): Promise<number | null> {
  if (characterId != null) {
    const character = await db.characters.get(characterId)
    if (character?.projectId === projectId && character.homeWorldGroupId != null) {
      return character.homeWorldGroupId
    }
  }
  const primary = await db.worldGroups
    .where('projectId').equals(projectId)
    .and(group => group.type === 'primary')
    .first()
  return primary?.id ?? null
}

/**
 * CF-12 的 AI 读取入口。结构化章序也先进入 manualText context source，
 * 其余事实全部由 CONTEXT_SOURCES 装配，调用方不拼第二套上下文。
 */
export async function buildCharacterRevisionPrompt(input: {
  projectId: number
  plan: CharacterDrivenPlan | null
  scope: CharacterRevisionScopeInput
}): Promise<PreparedCharacterRevisionRequest> {
  const [snapshot, project, worldGroupId] = await Promise.all([
    buildCharacterRevisionSnapshot(input.projectId),
    db.projects.get(input.projectId),
    resolveWorldGroupId(input.projectId, input.scope.characterId),
  ])
  const manualSourceText = [
    formatPlan(input.plan),
    formatCharacterRevisionScope(snapshot, input.scope),
  ].join('\n\n')
  const sourceKeys = [
    'manualText',
    'storyCore',
    'characters',
    'characterRelations',
    'storyArcs',
    'storylineProgress',
    'existingVolumeOutlines',
    'currentFacts',
    'chapterContinuityHandoff',
    'previousPlanReconciliation',
    'recentChapterSummaries',
    'characterFacts',
    'characterPassages',
    'foreshadows',
    'canonAssertions',
    'worldRules',
    'codex',
  ]
  if (project?.activeCharacterDrivenPlanId === input.plan?.id) {
    sourceKeys.push('characterDrivenPlan')
  }
  const context = await assembleContext({
    projectId: input.projectId,
    worldGroupId,
    chapterId: snapshot.lastWrittenChapterId,
    sourceKeys,
    manualSourceText,
    subjectCharacterName: input.scope.characterName,
  })
  const template = usePromptStore.getState().getActive('plot.character-revision')
  const { messages } = renderPrompt(template, { revisionContext: context.text })
  return {
    messages: appendSimplifiedChineseOutputConstraint(messages),
    snapshot,
    includedSources: context.included,
    omittedSources: context.omitted,
  }
}
