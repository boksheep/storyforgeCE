import { db } from '../db/schema'
import { adopt } from '../registry/adopt'
import { buildGenerationEntitiesPrompt, parseGenerationEntityCandidates, type GeneratedEntityCandidates } from '../ai/adapters/generation-entities-adapter'
import type { ChatMessage } from '../types'
import { locationInWorld } from '../location/scope'

export async function extractGenerationEntityCandidates(input: {
  projectId: number
  worldGroupId?: number | null
  sourceText: string
  call: (messages: ChatMessage[]) => Promise<string>
}): Promise<GeneratedEntityCandidates> {
  const [characters, locations, project] = await Promise.all([
    db.characters.where('projectId').equals(input.projectId).toArray(),
    db.importantLocations.where('projectId').equals(input.projectId).toArray(),
    db.projects.get(input.projectId),
  ])
  const visibleLocations = locations.filter(location => locationInWorld(location, Boolean(project?.enableMultiWorld), input.worldGroupId ?? null))
  const raw = await input.call(buildGenerationEntitiesPrompt({
    sourceText: input.sourceText,
    existingCharacters: characters.map(item => item.name),
    existingLocations: visibleLocations.map(item => item.name),
  }))
  const parsed = parseGenerationEntityCandidates(raw)
  const characterNames = new Set(characters.map(item => item.name.trim().toLocaleLowerCase()))
  const locationNames = new Set(visibleLocations.map(item => item.name.trim().toLocaleLowerCase()))
  return {
    characters: parsed.characters.filter(item => !characterNames.has(item.name.toLocaleLowerCase())),
    locations: parsed.locations.filter(item => !locationNames.has(item.name.toLocaleLowerCase())),
  }
}

export async function adoptGenerationEntityCandidates(input: {
  projectId: number
  worldGroupId?: number | null
  candidates: GeneratedEntityCandidates
}): Promise<{ characters: number; locations: number }> {
  const characterResult = input.candidates.characters.length
    ? await adopt({
      projectId: input.projectId, worldGroupId: input.worldGroupId ?? null,
      target: 'characters', mode: 'add-many', data: input.candidates.characters.map(item => ({
        name: item.name, roleWeight: item.roleWeight, moralAxis: 'neutral', orderAxis: 'neutral',
        shortDescription: item.shortDescription, identity: item.identity, background: item.background,
        motivation: item.motivation, location: item.location, relationships: '',
      })),
    })
    : { written: [] }
  const locationResult = input.candidates.locations.length
    ? await adopt({
      projectId: input.projectId, worldGroupId: input.worldGroupId ?? null, target: 'importantLocations', mode: 'add-many', data: input.candidates.locations.map(item => ({
        name: item.name, tags: item.tags, description: item.description, significance: item.significance,
        scope: input.worldGroupId != null ? 'world' : 'unassigned',
        parentId: null, sortOrder: 0,
      })),
    })
    : { written: [] }
  return { characters: characterResult.written.length, locations: locationResult.written.length }
}
