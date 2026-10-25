/**
 * 便签/笔记 — Phase H3
 */

export interface Note {
  id?: number
  projectId: number
  /** 关联章节 ID（可选） */
  chapterId?: number | null
  /** 笔记内容 */
  content: string
  /** 便签颜色 */
  color: NoteColor
  /** 是否置顶 */
  pinned: boolean
  /** x 以正文纸张左边为原点，可为负以放在左侧空白；y 随正文区域滚动。 */
  position?: { x: number; y: number }
  /** 作者拖拽调整的卡片宽度（像素）。缺省时按内容宽度显示。 */
  width?: number
  /** 作者拖拽调整的卡片高度（像素）。缺省时随内容自动增高。 */
  height?: number
  /** 收起后只显示一行摘要。 */
  collapsed?: boolean
  createdAt: number
  updatedAt: number
}

export type NoteColor = 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'orange'

export function assertNotePosition(value: unknown): asserts value is { x: number; y: number } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('便签位置必须是 {x,y}。')
  const point = value as Record<string, unknown>
  if (Object.keys(point).length !== 2 || !Number.isInteger(point.x) || !Number.isInteger(point.y)
    || Number(point.x) < -5000 || Number(point.y) < 0
    || Number(point.x) > 5000 || Number(point.y) > 100000) {
    throw new Error('便签位置 x 必须在 -5000 到 5000 之间，y 必须是非负整数。')
  }
}

export const NOTE_COLORS: Record<NoteColor, { bg: string; text: string; label: string }> = {
  yellow: { bg: 'bg-yellow-100 dark:bg-yellow-900/30', text: 'text-yellow-800 dark:text-yellow-200', label: '黄色' },
  blue:   { bg: 'bg-blue-100 dark:bg-blue-900/30',     text: 'text-blue-800 dark:text-blue-200',     label: '蓝色' },
  green:  { bg: 'bg-green-100 dark:bg-green-900/30',   text: 'text-green-800 dark:text-green-200',   label: '绿色' },
  pink:   { bg: 'bg-pink-100 dark:bg-pink-900/30',     text: 'text-pink-800 dark:text-pink-200',     label: '粉色' },
  purple: { bg: 'bg-purple-100 dark:bg-purple-900/30', text: 'text-purple-800 dark:text-purple-200', label: '紫色' },
  orange: { bg: 'bg-orange-100 dark:bg-orange-900/30', text: 'text-orange-800 dark:text-orange-200', label: '橙色' },
}
