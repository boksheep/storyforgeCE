import { db } from '../db/schema'
import type { AssembleContextInput } from '../registry/types'
import { listWorldMap, mapRevision } from './map-data'

/** Creative use gets a small, world-safe projection. Multiple map nodes require a clear match. */
export async function readMapRelevantFactsContext(input: AssembleContextInput): Promise<string> {
  const nodes = (await db.worldNodes.where('projectId').equals(input.projectId).toArray())
    .filter(node => (node.worldGroupId ?? null) === (input.worldGroupId ?? null))
  if (!nodes.length) return ''
  let outlineNodeId = input.outlineNodeId ?? null
  if (outlineNodeId == null && input.chapterId != null) {
    const chapter = await db.chapters.get(input.chapterId)
    if (chapter?.projectId === input.projectId) outlineNodeId = chapter.outlineNodeId
  }
  let referenceText = ''
  if (outlineNodeId != null) {
    const outline = await db.outlineNodes.get(outlineNodeId)
    if (outline?.projectId === input.projectId) referenceText = `${outline.title} ${outline.summary}`
  }
  const candidates = nodes.length === 1 ? nodes : nodes.filter(node => referenceText.includes(node.name))
  if (candidates.length !== 1) return '【地图事实】当前世界组存在多个地图节点，创作目标未唯一定位；本次不注入任意节点的地点关系。'
  const node = candidates[0]
  if (node.id == null) return ''
  const data = await listWorldMap(input.projectId, node.id)
  const confirmed = data.features.filter(feature => feature.status === 'confirmed')
  const confirmedKeys = new Set(confirmed.map(feature => feature.featureKey))
  const relations = data.relations.filter(relation => relation.status === 'confirmed'
    && confirmedKeys.has(relation.fromFeatureKey) && confirmedKeys.has(relation.toFeatureKey))
  if (!confirmed.length && !relations.length) return ''
  const matches = confirmed.filter(feature => referenceText.includes(feature.name)
    || feature.aliases.some(alias => alias && referenceText.includes(alias)))
  if (!matches.length) return ''
  const selected = matches.slice(0, 12)
  const names = new Map(confirmed.map(feature => [feature.featureKey, feature.name]))
  const selectedKeys = new Set(selected.map(feature => feature.featureKey))
  const related = relations.filter(relation => selectedKeys.has(relation.fromFeatureKey)
    || selectedKeys.has(relation.toFeatureKey)).slice(0, 8)
  const revision = await mapRevision(input.projectId, node.id)
  return [
    `【当前世界地图事实：${node.name}；revision=${revision.slice(0, 12)}】只含作者确认项，展示实体 ${selected.length}/${confirmed.length}、关系 ${related.length}/${relations.length}；原图未发送。`,
    ...selected.map(feature => {
      const customCategory = data.categories.find(category => category.code === feature.kind)
      return `- ${feature.name} [${feature.featureKey}; ${customCategory ? `${customCategory.label}/${customCategory.baseKind}` : feature.kind}]${feature.description ? `：${feature.description.slice(0, 130)}` : ''}；时段${feature.validFrom || feature.validTo ? ` ${feature.validFrom ?? '?'}—${feature.validTo ?? '?'}` : '未注明'}`
    }),
    ...related.map(relation => `- ${names.get(relation.fromFeatureKey) ?? relation.fromFeatureKey} ${relation.kind} ${names.get(relation.toFeatureKey) ?? relation.toFeatureKey} [${relation.relationKey}]${relation.description ? `；依据 ${relation.description.slice(0, 130)}` : ''}；时段${relation.validFrom || relation.validTo ? ` ${relation.validFrom ?? '?'}—${relation.validTo ?? '?'}` : '未注明'}`),
    ...(selected.some(feature => feature.validFrom || feature.validTo)
      || related.some(relation => relation.validFrom || relation.validTo)
      ? ['这些时段标记尚未与当前章节日期核对，不可直接推断在本章有效。'] : []),
    ...(confirmed.length > selected.length || relations.length > related.length ? ['其余地图事实未读；不得声称已核对全部地点。'] : []),
  ].join('\n')
}
