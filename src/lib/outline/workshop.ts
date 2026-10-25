import type { UseAIStreamReturn } from '../../hooks/useAIStream'
import {
  checkHeldItemAcquisition,
  type HeldItemProjection,
} from '../consistency/held-items'
import type {
  GenerationGateIssue,
  GenerationGateResult,
  GenerationNode,
} from '../generation/generation-node'
import {
  checkCognitionBoundary,
  parseCognitionReferences,
  type CognitionAuditSnapshot,
} from '../knowledge-ledger/knowledge-ledger'
import {
  normalizeConstitutionValue,
} from '../fact-ledger/setting-assertions'
import type { AssembleContextResult } from '../registry/types'
import type { ChatMessage, TemporalFact } from '../types'

export const OUTLINE_WORKSHOP_STAGES = [
  'scan',
  'motivation',
  'collision',
  'quality',
  'scenes',
] as const

export type OutlineWorkshopStage = typeof OUTLINE_WORKSHOP_STAGES[number]

export const OUTLINE_WORKSHOP_STAGE_META: Record<OutlineWorkshopStage, {
  title: string
  description: string
  calls: number
}> = {
  scan: { title: '现状扫描', description: '找出本章必须承接的状态、伏笔和边界', calls: 1 },
  motivation: { title: '动机推演', description: '逐角色明确此刻欲望、恐惧与认知限制', calls: 1 },
  collision: { title: '碰撞预演', description: '让动机自然相撞，形成至少三步反应链', calls: 1 },
  quality: { title: '质量闸门', description: '软性反套路审查 + 物品/认知/宪法闭集硬查', calls: 1 },
  scenes: { title: '场景卡', description: '收敛为可采纳场景卡与不可写清单', calls: 1 },
}

export type OutlineWorkshopArtifacts = Partial<Record<OutlineWorkshopStage, string>>

export function confirmWorkshopArtifact(
  artifacts: OutlineWorkshopArtifacts,
  stage: OutlineWorkshopStage,
  output: string,
): {
  artifacts: OutlineWorkshopArtifacts
  nextStage: OutlineWorkshopStage | null
} {
  const index = OUTLINE_WORKSHOP_STAGES.indexOf(stage)
  for (const required of OUTLINE_WORKSHOP_STAGES.slice(0, index)) {
    if (!artifacts[required]?.trim()) {
      throw new Error(`必须先确认“${OUTLINE_WORKSHOP_STAGE_META[required].title}”。`)
    }
  }
  if (!output.trim()) throw new Error('当前节点没有可确认的产物。')
  return {
    artifacts: { ...artifacts, [stage]: output.trim() },
    nextStage: OUTLINE_WORKSHOP_STAGES[index + 1] ?? null,
  }
}

export function rewindWorkshopArtifacts(
  artifacts: OutlineWorkshopArtifacts,
  stage: OutlineWorkshopStage,
): OutlineWorkshopArtifacts {
  const index = OUTLINE_WORKSHOP_STAGES.indexOf(stage)
  return Object.fromEntries(
    OUTLINE_WORKSHOP_STAGES
      .slice(0, index)
      .flatMap(key => artifacts[key]?.trim() ? [[key, artifacts[key]!.trim()]] : []),
  )
}

export interface OutlineWorkshopNodeInput {
  chapterTitle: string
  chapterSummary: string
  assembled: AssembleContextResult
  artifacts: OutlineWorkshopArtifacts
  cognitionCatalog: string
  canonCatalog: string
}

function contextFor(
  assembled: AssembleContextResult,
  keys: string[],
  fallbackToFull = false,
): string {
  const selected = keys.flatMap(key => {
    const index = assembled.included.indexOf(key)
    const content = index >= 0 ? assembled.segments[index]?.content?.trim() : ''
    return content ? [content] : []
  })
  if (selected.length > 0) return selected.join('\n\n')
  return fallbackToFull ? assembled.text : ''
}

function confirmedArtifacts(
  artifacts: OutlineWorkshopArtifacts,
  stages: OutlineWorkshopStage[],
): string {
  return stages.flatMap(stage => {
    const text = artifacts[stage]?.trim()
    return text ? [`【已确认·${OUTLINE_WORKSHOP_STAGE_META[stage].title}】\n${text}`] : []
  }).join('\n\n')
}

export function buildOutlineWorkshopMessages(
  stage: OutlineWorkshopStage,
  input: OutlineWorkshopNodeInput,
): ChatMessage[] {
  const heading = `【目标章节】${input.chapterTitle}\n【现有章纲】${input.chapterSummary || '暂无'}`
  if (stage === 'scan') {
    return [
      {
        role: 'system',
        content: `你是小说章纲工作坊的“现状扫描”节点。只整理证据和约束，不编造新剧情。

输出简洁 Markdown，必须包含：
1. 必须承接：上一阶段遗留、已写进度、待推进故事线；
2. 可用角色及此时状态；
3. 待处理伏笔/关系/地点；
4. 硬边界：世界宪法、角色认知、当前持有物；
5. 信息缺口：证据不足的内容明确写“未知”，不得补全。`,
      },
      {
        role: 'user',
        content: `${heading}\n\n【登记上下文】\n${contextFor(input.assembled, [
          'chapterOutline',
          'storyCore',
          'characters',
          'foreshadows',
          'storyArcs',
          'storylineProgress',
          'worldRules',
          'canonAssertions',
          'characterKnowledge',
          'heldItems',
          'locations',
        ], true)}\n\n请完成现状扫描：`,
      },
    ]
  }

  if (stage === 'motivation') {
    return [
      {
        role: 'system',
        content: `你是小说章纲工作坊的“动机推演”节点。先问每个人此刻最想要什么，不要直接编事件。

对每位建议出场角色输出：
- 当前目标；
- 恐惧或代价；
- 能采取的行动；
- 不能知道/误以为的内容；
- 与章纲目标的张力。

行动必须来自已确认现状，不能让角色开天眼。`,
      },
      {
        role: 'user',
        content: `${heading}\n\n${confirmedArtifacts(input.artifacts, ['scan'])}\n\n【角色与认知边界】\n${contextFor(input.assembled, ['characters', 'characterKnowledge']) || '无登记内容'}\n\n请完成动机推演：`,
      },
    ]
  }

  if (stage === 'collision') {
    return [
      {
        role: 'system',
        content: `你是小说章纲工作坊的“碰撞预演”节点。情节必须从人物动机相撞产生。

输出 2-3 个候选碰撞方案。每个方案必须包含：
1. 触发点；
2. 至少三步反应链（A行动 → B理解 → B行动 → A再反应）；
3. 不可逆结果与付出的代价；
4. 章末钩子；
5. 为什么不是巧合、降智或强行冲突。

优先价值错位冲突，不得新增未登记能力、物品或提前知情。`,
      },
      {
        role: 'user',
        content: `${heading}\n\n${confirmedArtifacts(input.artifacts, ['scan', 'motivation'])}\n\n请完成碰撞预演：`,
      },
    ]
  }

  if (stage === 'quality') {
    return [
      {
        role: 'system',
        content: `你是小说章纲工作坊的“质量闸门”节点。你提供软性审查和闭集结构化引用；确定性代码会复核引用。

输出严格 JSON，不加代码块：
{
  "advisories": [{"category":"反派降智|主角开天眼|巧合推进|轻易胜利|强行冲突|信息差滥用|工具人|时间冻结|其它","quote":"碰撞方案逐字引文","reason":"原因","suggestion":"修改建议"}],
  "cognitionReferences": [{"characterId":1,"knowledgeKey":"闭集中的 key","quote":"碰撞方案中角色运用或陈述该知识的逐字引文"}],
  "canonClaims": [{"factId":1,"proposedValue":"碰撞方案实际采用的设定值","quote":"碰撞方案逐字引文"}]
}

规则：
1. quote 必须逐字来自待审草案；
2. cognitionReferences 只能选闭集中的 characterId + knowledgeKey，不确定就不输出；
3. canonClaims 只能选闭集中的 factId，且只在草案明确采用该设定值时输出；
4. advisories 是软建议，不能伪装成确定性结论；
5. 没有内容的数组返回 []。`,
      },
      {
        role: 'user',
        content: `${heading}\n\n【待审草案】\n${confirmedArtifacts(input.artifacts, ['scan', 'motivation', 'collision'])}\n\n${input.cognitionCatalog || '【角色认知审计闭集】无'}\n\n${input.canonCatalog || '【世界宪法闭集】无'}\n\n请输出质量审查 JSON：`,
      },
    ]
  }

  return [
    {
      role: 'system',
      content: `你是小说章纲工作坊的“场景卡收敛”节点。只使用已确认的工作坊产物，输出可直接采纳的增强细纲。

输出严格 JSON，不加代码块：
{
  "openingHook":"开场承接",
  "endingCliffhanger":"章末钩子",
  "sceneLocation":"主要地点",
  "emotionArc":"rising|falling|flat|wave|climax",
  "appearingCharacterIds":[1,2],
  "foreshadowIds":[1],
  "prohibitions":["本章绝对不能写的事项"],
  "scenes":[{"title":"场景标题","summary":"概要","location":"地点","conflict":"冲突","pace":"slow|medium|fast|climax","characterIds":[1,2],"estimatedWords":1200}],
  "cognitionReferences":[{"characterId":1,"knowledgeKey":"闭集中的 key","quote":"上述 JSON 文本中角色运用或陈述该知识的逐字片段"}],
  "canonClaims":[{"factId":1,"proposedValue":"场景卡实际采用的设定值","quote":"上述 JSON 文本中的逐字片段"}]
}

要求：
1. 3-6 个场景，顺序体现已确认反应链和不可逆结果；
2. characterIds/foreshadowIds 只能使用上下文已有 ID；
3. prohibitions 必须覆盖提前知情、重复首次获得、设定冲突和节奏前置；
4. cognitionReferences/canonClaims 只能使用闭集 ID，quote 必须逐字出现在本次 JSON 的场景文字中，不确定就返回空数组；
5. 不要把质量审查里的被否决方案写回场景卡。`,
    },
    {
      role: 'user',
      content: `${heading}\n\n${confirmedArtifacts(input.artifacts, [
        'scan',
        'motivation',
        'collision',
        'quality',
      ])}\n\n【必要登记上下文】\n${contextFor(input.assembled, [
        'characters',
        'foreshadows',
        'locations',
        'canonAssertions',
        'characterKnowledge',
        'heldItems',
      ])}\n\n${input.cognitionCatalog || '【角色认知审计闭集】无'}\n\n${input.canonCatalog || '【世界宪法闭集】无'}\n\n请输出最终场景卡 JSON：`,
    },
  ]
}

export interface WorkshopAdvisory {
  category: string
  quote: string
  reason: string
  suggestion: string
}

export interface WorkshopCanonClaim {
  factId: number
  proposedValue: string
  quote: string
}

export interface WorkshopQualityEvaluation {
  gate: GenerationGateResult
  advisories: WorkshopAdvisory[]
}

function parseObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(raw.slice(start, end + 1))
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * 最终场景卡的硬校验只审“实际会写进剧情”的叙事字段。
 * 不可写清单与 cognition/canon 审计元数据不能反过来充当剧情证据，
 * 否则“不能再次获得钥匙”会被误判成真的再次获得，quote 字段也会自证。
 */
export function extractWorkshopSceneNarrative(raw: string): string {
  const parsed = parseObject(raw)
  if (!parsed) return ''
  const values: unknown[] = [
    parsed.openingHook,
    parsed.endingCliffhanger,
    parsed.sceneLocation,
  ]
  if (Array.isArray(parsed.scenes)) {
    for (const scene of parsed.scenes) {
      if (!scene || typeof scene !== 'object' || Array.isArray(scene)) continue
      const row = scene as Record<string, unknown>
      values.push(row.title, row.summary, row.location, row.conflict)
    }
  }
  return values
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    .map(value => value.trim())
    .join('\n')
}

export function formatWorkshopCanonCatalog(facts: TemporalFact[]): string {
  if (!facts.length) return ''
  return [
    '【世界宪法闭集】',
    ...facts.slice(0, 80).map(fact =>
      `- factId=${fact.id ?? 0} | ${fact.subjectName} | ${fact.predicate} | ${fact.value}`),
  ].join('\n')
}

export function parseWorkshopCanonClaims(
  raw: string,
  generatedDraft: string,
  facts: TemporalFact[],
): WorkshopCanonClaim[] {
  const parsed = parseObject(raw)
  if (!parsed || !Array.isArray(parsed.canonClaims)) return []
  const allowed = new Set(facts.filter(fact => fact.id != null).map(fact => fact.id!))
  return parsed.canonClaims.flatMap((value): WorkshopCanonClaim[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    const factId = Number(row.factId)
    const proposedValue = String(row.proposedValue ?? '').trim()
    const quote = String(row.quote ?? '').trim()
    if (!allowed.has(factId) || !proposedValue || !quote || !generatedDraft.includes(quote)) return []
    return [{ factId, proposedValue, quote }]
  })
}

function parseAdvisories(raw: string, generatedDraft: string): WorkshopAdvisory[] {
  const parsed = parseObject(raw)
  if (!parsed || !Array.isArray(parsed.advisories)) return []
  return parsed.advisories.flatMap((value): WorkshopAdvisory[] => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    const row = value as Record<string, unknown>
    const quote = String(row.quote ?? '').trim()
    const reason = String(row.reason ?? '').trim()
    if (!quote || !reason || !generatedDraft.includes(quote)) return []
    return [{
      category: String(row.category ?? '其它').trim() || '其它',
      quote,
      reason,
      suggestion: String(row.suggestion ?? '').trim(),
    }]
  })
}

export function evaluateWorkshopQuality(input: {
  raw: string
  generatedDraft: string
  heldItems: HeldItemProjection[]
  knownCharacterNames: string[]
  cognition: CognitionAuditSnapshot
  canonFacts: TemporalFact[]
}): WorkshopQualityEvaluation {
  const issues: GenerationGateIssue[] = []
  const heldFindings = checkHeldItemAcquisition(
    input.generatedDraft,
    input.heldItems,
    [],
    input.knownCharacterNames,
  )
  heldFindings.forEach((finding, index) => issues.push({
    code: `held-item:${index}`,
    message: `${finding.reason} 引文：“${finding.quote}”`,
  }))

  const cognitionReferences = parseCognitionReferences(
    input.raw,
    input.generatedDraft,
    input.cognition.catalog,
  )
  checkCognitionBoundary(
    input.generatedDraft,
    cognitionReferences,
    input.cognition.projected,
  ).forEach((finding, index) => issues.push({
    code: `cognition:${index}`,
    message: `${finding.reason} 引文：“${finding.quote}”`,
  }))

  const canonById = new Map(
    input.canonFacts.filter(fact => fact.id != null).map(fact => [fact.id!, fact]),
  )
  parseWorkshopCanonClaims(input.raw, input.generatedDraft, input.canonFacts)
    .forEach((claim, index) => {
      const fact = canonById.get(claim.factId)
      if (!fact) return
      if (
        normalizeConstitutionValue(claim.proposedValue)
        !== normalizeConstitutionValue(fact.value)
      ) {
        issues.push({
          code: `canon:${index}`,
          message: `草案采用“${claim.proposedValue}”，与作者确认的“${fact.subjectName}｜${fact.predicate}：${fact.value}”冲突。引文：“${claim.quote}”`,
        })
      }
    })

  return {
    gate: {
      status: issues.length > 0 ? 'blocked' : 'pass',
      issues,
    },
    advisories: parseAdvisories(input.raw, input.generatedDraft),
  }
}

type WorkshopAI = Pick<UseAIStreamReturn, 'start'>

export function createOutlineWorkshopNode(input: {
  stage: OutlineWorkshopStage
  projectId: number
  chapterIdentity: number
  ai: WorkshopAI
  qualityGate?: (output: string) => GenerationGateResult
}): GenerationNode<OutlineWorkshopNodeInput, string> {
  const { stage, projectId, chapterIdentity, ai, qualityGate } = input
  const run = (messages: ChatMessage[]) => {
    if (stage === 'scan') {
      return ai.start(messages, undefined, { category: 'outline.workshop.scan', projectId })
    }
    if (stage === 'motivation') {
      return ai.start(messages, undefined, { category: 'outline.workshop.motivation', projectId })
    }
    if (stage === 'collision') {
      return ai.start(messages, undefined, { category: 'outline.workshop.collision', projectId })
    }
    if (stage === 'quality') {
      return ai.start(messages, undefined, { category: 'review.outline-workshop', projectId })
    }
    return ai.start(messages, undefined, { category: 'outline.workshop.scenes', projectId })
  }
  return {
    id: `outline.workshop.${stage}:${chapterIdentity}`,
    kind: `outline.workshop.${stage}`,
    editableInput: true,
    assembleInput: nodeInput => buildOutlineWorkshopMessages(stage, nodeInput),
    run,
    gate: stage === 'quality' && qualityGate ? qualityGate : undefined,
  }
}
