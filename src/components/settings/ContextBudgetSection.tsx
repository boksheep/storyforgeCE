/**
 * BUDGET-1 · 上下文预算设置面板
 *
 * 把「AI 每次读多少项目资料」从只读注册表常量变成作者可调的显式预算，并暴露
 * 此前藏在小函数里的源内部硬截断（如词条的 2500 字上限 →「词条较多，已截断」）。
 *
 * 全部改动只写 localStorage 本机偏好（上下文策略与地图视觉输出预算），
 * 不碰 Canon / IndexedDB / 项目 JSON，也不影响 API Key 生命周期。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { AlertTriangle, RotateCcw, Search, ChevronDown, ChevronRight, Save, Trash2 } from 'lucide-react'
import {
  AGENT_TEAM_BUDGET_PRESET_META,
  TEAM_BUDGET_MAX_TOKENS,
  TEAM_BUDGET_MIN_TOKENS,
  type AgentTeamBudgetProfile,
} from '../../lib/agent/team-budget'
import { CONTEXT_SOURCES } from '../../lib/registry/context-sources'
import {
  CONTEXT_BUDGET_LIMITS,
  type ContextSourceBudgetPolicy,
} from '../../lib/registry/context-budget-policy'
import type { ContextSourceScope } from '../../lib/registry/types'
import {
  DEFAULT_MAP_VISION_OUTPUT_BUDGET,
  MAP_VISION_OUTPUT_BUDGET_LIMITS,
  type ContextBudgetPreset,
  type MapVisionOutputBudget,
} from '../../stores/ai-config'

interface Props {
  truncationEnabled: boolean
  /** 按源 key 的作者覆盖值。 */
  overrides: Record<string, ContextSourceBudgetPolicy>
  onSetTruncationEnabled: (enabled: boolean) => void
  onSetSourceBudget: (sourceKey: string, override: ContextSourceBudgetPolicy | null) => void
  onReset: () => void
  teamBudgetProfile: AgentTeamBudgetProfile
  teamBudgetTokens: number
  contextBudgetPresets: ContextBudgetPreset[]
  onSetTeamBudgetTokens: (tokens: number, sources?: readonly { key: string; layer: string; budgetTokens: number }[]) => void
  onApplyPreset: (id: string, sources?: readonly { key: string; layer: string; budgetTokens: number }[]) => void
  onSavePreset: (name: string) => string
  onDeletePreset: (id: string) => void
  mapVisionOutputBudget: MapVisionOutputBudget
  onSetMapVisionOutputBudget: (kind: keyof MapVisionOutputBudget, tokens: number) => void
  onResetMapVisionOutputBudget: () => void
}

const SCOPE_LABELS: Record<ContextSourceScope, string> = {
  project: '项目级',
  world: '世界级',
  chapter: '章节级',
  node: '节点级',
  manual: '手动指定',
}

const SCOPE_ORDER: ContextSourceScope[] = ['project', 'world', 'chapter', 'node', 'manual']

const LAYER_HINTS: Record<string, string> = {
  L0: '不可裁剪',
  L1: '核心',
  L2: '扩展',
  L3: '增强（预算紧张时先丢）',
}

/** 作者是否真的改过这个源（用于「已调整」标记与重置按钮可用性）。 */
function isTouched(override?: ContextSourceBudgetPolicy): boolean {
  return !!override && Object.keys(override).length > 0
}

/** 每个源可调的「字数类」控件。未列出的源只有 token 预算可调。 */
interface CharLimitField {
  field: keyof ContextSourceBudgetPolicy
  label: string
  placeholder: string
  step: number
  width: string
}

const CHAR_LIMIT_FIELDS: Record<string, CharLimitField[]> = {
  codex: [
    { field: 'maxChars', label: '字数上限（留空 = 不截断）', placeholder: '不截断', step: 100, width: 'w-32' },
    { field: 'maxPerCategory', label: '每分类条数（留空 = 不限）', placeholder: '不限', step: 5, width: 'w-28' },
    { field: 'maxFieldsPerEntry', label: '每条字段数', placeholder: '3', step: 1, width: 'w-20' },
  ],
  retrievedPassages: [
    { field: 'maxTotalChars', label: '「全书截至本章」字数', placeholder: '1800', step: 100, width: 'w-28' },
    { field: 'maxVolumeChapters', label: '本卷取本章前 N 章（留空=整卷）', placeholder: '整卷', step: 1, width: 'w-32' },
    { field: 'maxVolumeChars', label: '本卷段字数安全阀', placeholder: '1200', step: 100, width: 'w-28' },
  ],
}

export default function ContextBudgetSection({
  truncationEnabled,
  overrides,
  onSetTruncationEnabled,
  onSetSourceBudget,
  onReset,
  teamBudgetProfile,
  teamBudgetTokens,
  contextBudgetPresets,
  onSetTeamBudgetTokens,
  onApplyPreset,
  onSavePreset,
  onDeletePreset,
  mapVisionOutputBudget,
  onSetMapVisionOutputBudget,
  onResetMapVisionOutputBudget,
}: Props) {
  const [query, setQuery] = useState('')
  const [expanded, setExpanded] = useState(false)
  const [presetName, setPresetName] = useState('')
  const [mapOutputDraft, setMapOutputDraft] = useState({
    features: String(mapVisionOutputBudget.features), legend: String(mapVisionOutputBudget.legend),
  })
  useEffect(() => {
    setMapOutputDraft({ features: String(mapVisionOutputBudget.features), legend: String(mapVisionOutputBudget.legend) })
  }, [mapVisionOutputBudget.features, mapVisionOutputBudget.legend])
  const sourceMeta = useMemo(() => CONTEXT_SOURCES.map(source => ({ key: source.key, layer: source.layer, budgetTokens: source.budgetTokens })), [])
  const latestBudgetRef = useRef(teamBudgetTokens)
  useEffect(() => { latestBudgetRef.current = teamBudgetTokens }, [teamBudgetTokens])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return CONTEXT_SOURCES
    return CONTEXT_SOURCES.filter(source =>
      source.label.toLowerCase().includes(q) || source.key.toLowerCase().includes(q),
    )
  }, [query])

  const grouped = useMemo(() => {
    return SCOPE_ORDER
      .map(scope => ({ scope, sources: filtered.filter(source => source.scope === scope) }))
      .filter(group => group.sources.length > 0)
  }, [filtered])

  const touchedCount = useMemo(
    () => Object.values(overrides).filter(isTouched).length,
    [overrides],
  )

  /** 写入单个源的覆盖值；传空字段 = 恢复该字段的注册表默认。 */
  const patchSource = (key: string, patch: ContextSourceBudgetPolicy) => {
    const next: ContextSourceBudgetPolicy = { ...overrides[key], ...patch }
    for (const field of Object.keys(next) as Array<keyof ContextSourceBudgetPolicy>) {
      if (next[field] === undefined) delete next[field]
    }
    onSetSourceBudget(key, Object.keys(next).length ? next : null)
  }

  return (
    <div className="max-w-2xl mt-6 p-4 bg-bg-surface border border-border rounded-xl">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">团队总预算与上下文预算</h3>
          <p className="mt-1 text-[11px] text-text-muted">
            总预算会联动主 Agent 团队和各上下文源。自动分配按 L0/L1/L2/L3 优先级拆分；展开后仍可逐项手动调整。
          </p>
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={!truncationEnabled && touchedCount === 0
            && mapVisionOutputBudget.features === DEFAULT_MAP_VISION_OUTPUT_BUDGET.features
            && mapVisionOutputBudget.legend === DEFAULT_MAP_VISION_OUTPUT_BUDGET.legend}
          className="flex flex-shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-xs bg-bg-elevated text-text-secondary rounded-lg hover:bg-bg-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          title="恢复上下文与地图视觉输出预算为默认值"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          恢复默认
        </button>
      </div>

      <div className="mt-3 rounded-lg border border-accent/30 bg-bg-base p-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <span className="text-xs font-medium text-text-primary">本轮团队总预算</span>
            <span className="ml-2 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{teamBudgetProfile === 'custom' ? '自定义' : AGENT_TEAM_BUDGET_PRESET_META[teamBudgetProfile].label}</span>
            <p className="mt-1 text-[11px] text-text-muted">当前 {Math.round(teamBudgetTokens / 1000)}K tokens，范围 50K–999K。</p>
          </div>
          <output className="font-mono text-sm font-semibold text-accent">{Math.round(teamBudgetTokens / 1000)}K</output>
        </div>
        <input type="range" min={TEAM_BUDGET_MIN_TOKENS} max={TEAM_BUDGET_MAX_TOKENS} step={1000} value={teamBudgetTokens} onChange={event => onSetTeamBudgetTokens(Number(event.target.value), sourceMeta)} aria-label="团队总预算 tokens" className="mt-3 w-full accent-accent" />
        <div className="mt-2 flex flex-wrap gap-1.5">
          {(Object.entries(AGENT_TEAM_BUDGET_PRESET_META) as Array<[Exclude<AgentTeamBudgetProfile, 'custom'>, typeof AGENT_TEAM_BUDGET_PRESET_META['economy']]>).map(([id, meta]) => (
            <button key={id} type="button" onClick={() => onApplyPreset(id, sourceMeta)} className="rounded border border-border bg-bg-surface px-2 py-1 text-[11px] text-text-secondary hover:border-accent/60 hover:text-accent">{meta.label} · {meta.maxTokens / 1000}K</button>
          ))}
          {contextBudgetPresets.map(preset => (
            <span key={preset.id} className="inline-flex items-center gap-1 rounded border border-accent/30 bg-accent/10 pl-2 text-[11px] text-accent">
              <button type="button" onClick={() => onApplyPreset(preset.id)}>{preset.name} · {Math.round(preset.totalTokens / 1000)}K</button>
              <button type="button" onClick={() => onDeletePreset(preset.id)} aria-label={`删除预算预设 ${preset.name}`} className="p-1 hover:text-error"><Trash2 className="h-3 w-3" /></button>
            </span>
          ))}
          <div className="ml-auto flex items-center gap-1">
            <input value={presetName} onChange={event => setPresetName(event.target.value)} placeholder="保存为预设" aria-label="自定义预算预设名称" className="w-24 rounded border border-border bg-bg-surface px-2 py-1 text-[11px] text-text-primary" />
            <button type="button" disabled={!presetName.trim()} onClick={() => { onSavePreset(presetName.trim()); setPresetName('') }} title="保存自定义预算预设" className="rounded border border-border p-1.5 text-text-muted hover:text-accent disabled:opacity-40"><Save className="h-3.5 w-3.5" /></button>
          </div>
        </div>
      </div>

      {/* 主开关 */}
      <label className="mt-3 block rounded-lg border border-border bg-bg-base p-3">
        <span className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={truncationEnabled}
            onChange={event => onSetTruncationEnabled(event.target.checked)}
            className="accent-accent"
            aria-label="按预算自动截断上下文"
          />
          <span className="text-xs font-medium text-text-primary">按预算自动截断上下文</span>
        </span>
        <span className="mt-1 block text-[11px] leading-4 text-text-muted">
          {truncationEnabled
            ? '开启：单个源超出预算时会截断并注明「已按预算截断」。词条等源仍受各自的字数上限约束。'
            : '已关闭：不再按单源预算截断，词条等内容完整注入；只有真的装不下模型上下文窗口时才会裁剪。输出会变长，消耗相应增加。'}
        </span>
        {!truncationEnabled && (
          <span className="mt-1.5 flex items-start gap-1.5 text-[11px] leading-4 text-amber-400">
            <AlertTriangle className="mt-0.5 h-3 w-3 flex-shrink-0" />
            词条/角色很多时，单次请求会明显变大。若模型报「上下文超长」，请调低模型窗口或重新开启截断。
          </span>
        )}
      </label>

      <button type="button" onClick={() => setExpanded(value => !value)} className="mt-3 flex w-full items-center justify-between rounded-lg border border-border bg-bg-base px-3 py-2 text-left text-xs font-medium text-text-secondary hover:border-accent/50 hover:text-text-primary">
        <span>{expanded ? '收起各项预算' : `展开各上下文源及地图视觉预算${touchedCount > 0 ? `（已调整 ${touchedCount} 项）` : ''}`}</span>
        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>

      {expanded && <>
      <div className="mt-3 rounded-lg border border-border bg-bg-base p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-xs font-medium text-text-primary">地图视觉单次输出预算</h4>
          <button type="button" onClick={onResetMapVisionOutputBudget}
            disabled={mapVisionOutputBudget.features === DEFAULT_MAP_VISION_OUTPUT_BUDGET.features && mapVisionOutputBudget.legend === DEFAULT_MAP_VISION_OUTPUT_BUDGET.legend}
            className="text-[11px] text-text-muted underline decoration-dotted hover:text-accent disabled:opacity-40">
            恢复地图默认
          </button>
        </div>
        <p className="mt-1 text-[11px] leading-4 text-text-muted">
          识图和图例每次请求的最大输出 tokens。与上方输入上下文预算分别计算，不随团队总预算自动分配；设得太小可能截断坐标 JSON，模型自身上限仍会生效。
        </p>
        <div className="mt-2 flex flex-wrap gap-3">
          {([['features', '地图分块识图'], ['legend', '图例提取']] as const).map(([kind, label]) => (
            <label key={kind} className="flex flex-col gap-0.5 text-[10px] text-text-muted">
              {label}（默认 {DEFAULT_MAP_VISION_OUTPUT_BUDGET[kind].toLocaleString()}）
              <input type="number" min={MAP_VISION_OUTPUT_BUDGET_LIMITS.min} max={MAP_VISION_OUTPUT_BUDGET_LIMITS.max} step={256}
                value={mapOutputDraft[kind]}
                onChange={event => setMapOutputDraft(current => ({ ...current, [kind]: event.target.value }))}
                onBlur={() => {
                  const raw = Number(mapOutputDraft[kind])
                  if (mapOutputDraft[kind].trim() && Number.isFinite(raw)) onSetMapVisionOutputBudget(kind, raw)
                  else setMapOutputDraft(current => ({ ...current, [kind]: String(mapVisionOutputBudget[kind]) }))
                }}
                aria-label={`${label}单次输出 token 预算`}
                className="w-36 rounded border border-border bg-bg-surface px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none" />
            </label>
          ))}
        </div>
        <p className="mt-2 text-[10px] text-text-muted">范围 1,024–16,384；保存在本机，保存自定义预算预设时一并记录。</p>
      </div>
      {/* 搜索 */}
      <div className="relative mt-3">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-text-muted" />
        <input
          type="text"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder={`搜索上下文源（共 ${CONTEXT_SOURCES.length} 个）`}
          aria-label="搜索上下文源"
          className="w-full rounded-lg border border-border bg-bg-base py-1.5 pl-8 pr-3 text-xs text-text-primary placeholder-text-muted focus:border-accent focus:outline-none"
        />
      </div>

      {touchedCount > 0 && (
        <p className="mt-2 text-[11px] text-accent">已调整 {touchedCount} 个源的预算。</p>
      )}

      {/* 源分组列表 */}
      <div className="mt-3 space-y-4">
        {grouped.map(group => (
          <div key={group.scope}>
            <h4 className="mb-1.5 text-[11px] font-medium text-text-secondary">
              {SCOPE_LABELS[group.scope]}
              <span className="ml-1 text-text-muted">({group.sources.length})</span>
            </h4>
            <div className="space-y-1.5">
              {group.sources.map(source => {
                const override = overrides[source.key]
                const touched = isTouched(override)
                return (
                  <div
                    key={source.key}
                    className={`rounded-lg border p-2.5 ${touched ? 'border-accent/40 bg-bg-base' : 'border-border bg-bg-base'}`}
                  >
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="text-xs font-medium text-text-primary">{source.label}</span>
                      <span className="font-mono text-[10px] text-text-muted">{source.key}</span>
                      <span className="rounded bg-bg-elevated px-1 py-0.5 text-[10px] text-text-muted">
                        {source.layer} · {LAYER_HINTS[source.layer] ?? ''}
                      </span>
                      {touched && (
                        <span className="rounded bg-accent/15 px-1 py-0.5 text-[10px] text-accent">已调整</span>
                      )}
                    </div>

                    <div className="mt-2 flex flex-wrap items-end gap-3">
                      <label className="flex flex-col">
                        <span className="text-[10px] text-text-muted">
                          预算 (token，默认 {source.budgetTokens.toLocaleString()})
                        </span>
                        <input
                          type="number"
                          min={CONTEXT_BUDGET_LIMITS.budgetTokens.min}
                          max={CONTEXT_BUDGET_LIMITS.budgetTokens.max}
                          step={100}
                          value={override?.budgetTokens ?? ''}
                          onChange={event => patchSource(source.key, {
                            budgetTokens: parseOptionalNumber(event.target.value),
                          })}
                          placeholder={String(source.budgetTokens)}
                          aria-label={`${source.label} token 预算`}
                          className="mt-0.5 w-32 rounded border border-border bg-bg-surface px-2 py-1 text-xs text-text-primary placeholder-text-muted focus:border-accent focus:outline-none"
                        />
                      </label>

                      {(CHAR_LIMIT_FIELDS[source.key] ?? []).map(({ field, label, placeholder, step, width }) => (
                        <label key={field} className="flex flex-col">
                          <span className="text-[10px] text-text-muted">{label}</span>
                          <input
                            type="number"
                            min={CONTEXT_BUDGET_LIMITS[field as keyof typeof CONTEXT_BUDGET_LIMITS]?.min}
                            max={CONTEXT_BUDGET_LIMITS[field as keyof typeof CONTEXT_BUDGET_LIMITS]?.max}
                            step={step}
                            value={override?.[field] ?? ''}
                            onChange={event => patchSource(source.key, {
                              [field]: parseOptionalNumber(event.target.value),
                            })}
                            placeholder={placeholder}
                            aria-label={`${source.label} ${label}`}
                            className={`mt-0.5 ${width} rounded border border-border bg-bg-surface px-2 py-1 text-xs text-text-primary placeholder-text-muted focus:border-accent focus:outline-none`}
                          />
                        </label>
                      ))}

                      {touched && (
                        <button
                          type="button"
                          onClick={() => onSetSourceBudget(source.key, null)}
                          className="mb-0.5 text-[11px] text-text-muted underline decoration-dotted hover:text-accent"
                        >
                          恢复该源默认
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
        {grouped.length === 0 && (
          <p className="text-[11px] text-text-muted">没有匹配「{query}」的上下文源。</p>
        )}
      </div>

      <p className="mt-3 text-[11px] leading-4 text-text-muted">
        说明：任何源都不会超过模型窗口（设置 →「上下文窗口」）。留空的项一律沿用登记表默认值；
        「恢复默认」不会改动模型配置与 API Key。
      </p>
       </>}
    </div>
  )
}

/** 空串 / 非法值 → undefined（= 沿用默认或不限），正整数 → 该值。 */
function parseOptionalNumber(raw: string): number | undefined {
  if (!raw.trim()) return undefined
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.floor(n)
}
