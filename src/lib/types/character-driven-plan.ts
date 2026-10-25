export type CharacterDrivenPlanStatus = 'draft' | 'generated' | 'adopted'

/** 方案中的角色快照。characterId 是软引用；角色删除后仍保留其余字段。 */
export interface CharacterDrivenPlanArc {
  characterId: number | null
  name: string
  role: string
  initialState: string
  targetState: string
}

export interface CharacterDrivenPlotChapter {
  title: string
  summary: string
  keyCharacters: string[]
  arcProgress: string
}

export interface CharacterDrivenPlotVolume {
  volumeTitle: string
  volumeSummary: string
  characterArcs: string
  chapters: CharacterDrivenPlotChapter[]
}

export interface CharacterDrivenPlan {
  id?: number
  projectId: number
  name: string
  /** CharacterDrivenPlanArc[] JSON。 */
  arcs: string
  userHint: string
  /** CharacterDrivenPlotVolume[] JSON。 */
  generatedVolumes: string
  status: CharacterDrivenPlanStatus
  version: number
  /** 复制为新版本时指向来源方案；删除来源后置空。 */
  parentPlanId: number | null
  createdAt: number
  updatedAt: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object'
    ? value as Record<string, unknown>
    : null
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  try {
    const parsed: unknown = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** 旧数据或手工改坏的 JSON 必须在读取边界降级为空数组，不能让工作区崩溃。 */
export function parseCharacterDrivenPlanArcs(value: unknown): CharacterDrivenPlanArc[] {
  return parseJsonArray(value).flatMap(item => {
    const row = asRecord(item)
    if (!row) return []
    const characterId = typeof row.characterId === 'number' && Number.isFinite(row.characterId)
      ? row.characterId
      : null
    const name = String(row.name ?? '').trim()
    if (!name) return []
    return [{
      characterId,
      name,
      role: String(row.role ?? ''),
      initialState: String(row.initialState ?? ''),
      targetState: String(row.targetState ?? ''),
    }]
  })
}

export function stringifyCharacterDrivenPlanArcs(arcs: CharacterDrivenPlanArc[]): string {
  return JSON.stringify(arcs)
}

export function parseCharacterDrivenPlotVolumes(value: unknown): CharacterDrivenPlotVolume[] {
  return parseJsonArray(value).flatMap(item => {
    const row = asRecord(item)
    if (!row) return []
    const volumeTitle = String(row.volumeTitle ?? row.title ?? '').trim()
    if (!volumeTitle) return []
    const chapters = parseJsonArray(row.chapters).flatMap(chapter => {
      const ch = asRecord(chapter)
      if (!ch) return []
      const title = String(ch.title ?? '').trim()
      if (!title) return []
      return [{
        title,
        summary: String(ch.summary ?? ''),
        keyCharacters: parseJsonArray(ch.keyCharacters).map(String).filter(Boolean),
        arcProgress: String(ch.arcProgress ?? ''),
      }]
    })
    return [{
      volumeTitle,
      volumeSummary: String(row.volumeSummary ?? row.summary ?? ''),
      characterArcs: String(row.characterArcs ?? ''),
      chapters,
    }]
  })
}

export function stringifyCharacterDrivenPlotVolumes(volumes: CharacterDrivenPlotVolume[]): string {
  return JSON.stringify(volumes)
}
