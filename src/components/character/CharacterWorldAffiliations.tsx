import { useEffect, useMemo } from 'react'
import type { Character, WorldGroup } from '../../lib/types'
import { parseCultivationStages } from '../../lib/types/cultivation'
import { codexEntryInWorld } from '../../lib/types/codex'
import { useCodexStore } from '../../stores/codex'
import { useCultivationStore } from '../../stores/cultivation'

export default function CharacterWorldAffiliations({
  character,
  projectId,
  worldGroups,
  onChange,
}: {
  character: Character
  projectId: number
  worldGroups: WorldGroup[]
  onChange: (patch: Partial<Character>) => void
}) {
  const categories = useCodexStore(state => state.categories)
  const entries = useCodexStore(state => state.entries)
  const loadCodex = useCodexStore(state => state.loadExisting)
  const systems = useCultivationStore(state => state.systems)
  const loadSystems = useCultivationStore(state => state.loadAll)

  useEffect(() => {
    loadCodex(projectId)
    loadSystems(projectId)
  }, [loadCodex, loadSystems, projectId])

  const raceCategoryIds = useMemo(() => new Set(categories
    .filter(category => category.builtInKey === 'race')
    .map(category => category.id)), [categories])
  const targetWorld = character.homeWorldGroupId ?? null
  const races = entries
    .filter(entry => raceCategoryIds.has(entry.categoryId))
    .filter(entry => character.isCrossWorld || codexEntryInWorld(entry, targetWorld))
  const visibleSystems = systems.filter(system =>
    character.isCrossWorld || (system.worldGroupId ?? null) === targetWorld)
  const selectedSystem = systems.find(system => system.id === character.cultivationSystemId)
  const stages = parseCultivationStages(selectedSystem?.stages)
  const worldName = (worldGroupId?: number | null) =>
    worldGroups.find(group => group.id === worldGroupId)?.name

  return (
    <div className="grid sm:grid-cols-3 gap-2 rounded-lg border border-border bg-bg-base/40 p-3">
      <label className="min-w-0">
        <span className="block text-[11px] text-text-muted mb-1">结构化种族</span>
        <select
          aria-label="结构化种族"
          value={character.raceEntryId ?? ''}
          onChange={event => onChange({ raceEntryId: event.target.value ? Number(event.target.value) : null })}
          className="w-full px-2 py-1.5 bg-bg-elevated border border-border rounded text-xs text-text-primary"
        >
          <option value="">未关联</option>
          {races.map(entry => (
            <option key={entry.id} value={entry.id}>
              {entry.name}{character.isCrossWorld && worldName(entry.worldGroupId) ? ` · ${worldName(entry.worldGroupId)}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-0">
        <span className="block text-[11px] text-text-muted mb-1">主修体系</span>
        <select
          aria-label="主修体系"
          value={character.cultivationSystemId ?? ''}
          onChange={event => onChange({
            cultivationSystemId: event.target.value ? Number(event.target.value) : null,
            cultivationStageId: null,
          })}
          className="w-full px-2 py-1.5 bg-bg-elevated border border-border rounded text-xs text-text-primary"
        >
          <option value="">未关联</option>
          {visibleSystems.map(system => (
            <option key={system.id} value={system.id}>
              {system.name}{character.isCrossWorld && worldName(system.worldGroupId) ? ` · ${worldName(system.worldGroupId)}` : ''}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-0">
        <span className="block text-[11px] text-text-muted mb-1">当前设定境界</span>
        <select
          aria-label="当前设定境界"
          disabled={!selectedSystem}
          value={character.cultivationStageId ?? ''}
          onChange={event => onChange({ cultivationStageId: event.target.value || null })}
          className="w-full px-2 py-1.5 bg-bg-elevated border border-border rounded text-xs text-text-primary disabled:opacity-40"
        >
          <option value="">未指定</option>
          {stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}
        </select>
      </label>
    </div>
  )
}
