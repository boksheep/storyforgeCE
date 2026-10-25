/**
 * 全局故事线 — Phase B
 * 给全书一条从开篇到结局的主线剧情锚点
 */

/** 故事线类型 */
export type StoryArcType = 'main' | 'sub'

/** 故事阶段 */
export interface StoryStage {
  id: string              // nanoid
  title: string           // "起：初入江湖"
  description: string     // 这个阶段发生什么
  startVolume?: number    // 对应卷起始
  endVolume?: number      // 对应卷结束
  /** 作者明确放置在绝对时间轴上的起始年份；缺省表示未放置。 */
  timelineStartYear?: number
  /** 作者明确放置在绝对时间轴上的结束年份；缺省表示未放置。 */
  timelineEndYear?: number
  keyEvents: string[]     // 关键事件
  turningPoint?: string   // 转折点
}

/** 故事线 */
export interface StoryArc {
  id?: number
  projectId: number
  name: string            // "主线" / "感情线" / "复仇线"
  type: StoryArcType
  /** JSON 序列化的 StoryStage[] */
  stages: string
  description?: string    // 故事线整体描述
  createdAt: number
  updatedAt: number
}

// ── 工具函数 ──

export function parseStages(stagesJson: string): StoryStage[] {
  try {
    const parsed = JSON.parse(stagesJson)
    if (Array.isArray(parsed)) return parsed
    return []
  } catch {
    return []
  }
}

export function stringifyStages(stages: StoryStage[]): string {
  return JSON.stringify(stages)
}
