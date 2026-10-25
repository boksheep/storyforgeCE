import type { ChatMessage, LocationTag } from '../../types'
import type { CodexFieldDef } from '../../types/codex'
import { ALL_LOCATION_TAGS } from '../../types/location'
import { usePromptStore } from '../../../stores/prompt'
import { renderPrompt } from '../prompt-engine'
import { parseJsonArray, splitExtractionText } from '../structured-extraction'

export interface ExtractedCodexEntry {
  name: string
  summary: string
  description: string
  fields: Record<string, string>
  tags: string[]
  icon: string
  importance: number
}

export interface ExtractedLocation {
  name: string
  tags: LocationTag[]
  description: string
  significance: string
}

export function buildCodexExtractPrompt(input: {
  categoryName: string
  sourceText: string
  fieldSchema: CodexFieldDef[]
  existingNames: string[]
  supplementTags: boolean
}): ChatMessage[] {
  const template = usePromptStore.getState().getActive('codex.extract')
  return renderPrompt(template, {
    categoryName: input.categoryName,
    fieldSchema: JSON.stringify(input.fieldSchema.map(field => ({
      key: field.key,
      label: field.label,
      type: field.type,
      options: field.options ?? [],
    })), null, 2),
    existingEntries: input.existingNames.join('、') || '无',
    supplementTags: input.supplementTags ? '是' : '否',
    sourceText: input.sourceText,
  }).messages
}

export function parseCodexEntries(raw: string, allowedFieldKeys: string[]): ExtractedCodexEntry[] {
  const allowed = new Set(allowedFieldKeys)
  return parseJsonArray<Record<string, unknown>>(raw).map(item => {
    const sourceFields = item.fields && typeof item.fields === 'object' && !Array.isArray(item.fields)
      ? item.fields as Record<string, unknown>
      : {}
    const fields: Record<string, string> = {}
    for (const [key, value] of Object.entries(sourceFields)) {
      if (allowed.has(key) && value != null && String(value).trim()) fields[key] = String(value).trim()
    }
    return {
      name: String(item.name ?? '').trim(),
      summary: String(item.summary ?? '').trim(),
      description: String(item.description ?? '').trim(),
      fields,
      tags: Array.isArray(item.tags) ? item.tags.map(String).map(s => s.trim()).filter(Boolean).slice(0, 5) : [],
      icon: String(item.icon ?? '').trim(),
      importance: Math.max(0, Math.min(5, Math.round(Number(item.importance) || 0))),
    }
  }).filter(item => item.name)
}

export function buildLocationExtractPrompt(chapterText: string, existingNames: string[]): ChatMessage[] {
  const template = usePromptStore.getState().getActive('location.extract')
  return renderPrompt(template, {
    sourceText: chapterText,
    existingEntries: existingNames.join('、') || '无',
    allowedTags: ALL_LOCATION_TAGS.join('、'),
  }).messages
}

export function parseLocations(raw: string): ExtractedLocation[] {
  const allowed = new Set<string>(ALL_LOCATION_TAGS)
  return parseJsonArray<Record<string, unknown>>(raw).map(item => ({
    name: String(item.name ?? '').trim(),
    tags: (Array.isArray(item.tags) ? item.tags.map(String).filter(tag => allowed.has(tag)) : []) as LocationTag[],
    description: String(item.description ?? '').trim(),
    significance: String(item.significance ?? '').trim(),
  })).filter(item => item.name)
}

export { splitExtractionText }
