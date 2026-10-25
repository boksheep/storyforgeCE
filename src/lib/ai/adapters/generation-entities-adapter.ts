import type { ChatMessage, LocationTag } from '../../types'
import { ALL_LOCATION_TAGS } from '../../types/location'
import { usePromptStore } from '../../../stores/prompt'
import { renderPrompt } from '../prompt-engine'
import { parseJsonArray } from '../structured-extraction'

export interface GeneratedCharacterCandidate {
  name: string
  shortDescription: string
  roleWeight: 'main' | 'secondary' | 'npc'
  identity: string
  background: string
  motivation: string
  location: string
}

export interface GeneratedLocationCandidate {
  name: string
  tags: LocationTag[]
  description: string
  significance: string
}

export interface GeneratedEntityCandidates {
  characters: GeneratedCharacterCandidate[]
  locations: GeneratedLocationCandidate[]
}

export function buildGenerationEntitiesPrompt(input: {
  sourceText: string
  existingCharacters: string[]
  existingLocations: string[]
}): ChatMessage[] {
  return renderPrompt(usePromptStore.getState().getActive('generation.entities.extract'), {
    sourceText: input.sourceText,
    existingCharacters: input.existingCharacters.join('、') || '无',
    existingLocations: input.existingLocations.join('、') || '无',
    allowedTags: ALL_LOCATION_TAGS.join('、'),
  }).messages
}

export function parseGenerationEntityCandidates(raw: string): GeneratedEntityCandidates {
  return normalizeGenerationEntityCandidates(parseJsonArray<unknown>(raw)[0])
}

/** Normalize entities returned together with generation results without another AI call. */
export function normalizeGenerationEntityCandidates(value: unknown): GeneratedEntityCandidates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { characters: [], locations: [] }
  const parsed = value as { characters?: unknown; locations?: unknown }
  const characters = Array.isArray(parsed.characters) ? parsed.characters.map(item => {
    const row = item as Record<string, unknown>
    const roleWeight: GeneratedCharacterCandidate['roleWeight'] = row.roleWeight === 'main' || row.roleWeight === 'secondary' ? row.roleWeight : 'npc'
    return {
      name: String(row.name ?? '').trim(), shortDescription: String(row.shortDescription ?? '').trim(),
      roleWeight, identity: String(row.identity ?? '').trim(), background: String(row.background ?? '').trim(),
      motivation: String(row.motivation ?? '').trim(), location: String(row.location ?? '').trim(),
    }
  }).filter(item => item.name) : []
  const allowed = new Set<string>(ALL_LOCATION_TAGS)
  const locations = Array.isArray(parsed.locations) ? parsed.locations.map(item => {
    const row = item as Record<string, unknown>
    return {
      name: String(row.name ?? '').trim(),
      tags: (Array.isArray(row.tags) ? row.tags.map(String).filter(tag => allowed.has(tag)) : []) as LocationTag[],
      description: String(row.description ?? '').trim(), significance: String(row.significance ?? '').trim(),
    }
  }).filter(item => item.name) : []
  return { characters, locations }
}
