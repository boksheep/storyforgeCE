/**
 * 主 Agent 副驾面板的布局尺寸规则（单一事实源）。
 *
 * 为什么单独成模块：面板（`ChatCopilotPanel`）和工作区页面（`WorkspacePage`）都要
 * 夹取同一批尺寸——页面负责持久化到 localStorage，面板负责拖拽时约束。
 * 之前两边各抄了一份夹取规则，改一处就会静默分叉（拖拽时的边界与恢复时的边界不一致）。
 */

/** 右侧竖窗默认宽度 / 最小宽度（px）。 */
export const DEFAULT_PANEL_WIDTH = 448
export const MIN_PANEL_WIDTH = 320

/** 底部横窗默认高度 / 最小高度（px）。 */
export const DEFAULT_DOCK_HEIGHT = 320
export const MIN_DOCK_HEIGHT = 180

/** 输入区默认高度 / 最小高度（px）。 */
export const DEFAULT_INPUT_HEIGHT = 88
export const MIN_INPUT_HEIGHT = 44

function clamp(value: number, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.max(Math.round(value), min), max)
}

/** 输入区高度收敛到 [MIN_INPUT_HEIGHT, 视口-240]，避免把对话区挤没。 */
export function clampInputHeight(value: number): number {
  const maxHeight = Math.max(MIN_INPUT_HEIGHT, (globalThis.innerHeight || 800) - 240)
  return clamp(value, DEFAULT_INPUT_HEIGHT, MIN_INPUT_HEIGHT, maxHeight)
}

/** 底部横窗高度收敛到合法范围（持久化值可能来自旧版本或被手改）。 */
export function clampDockHeight(value: number): number {
  const maxHeight = Math.max(MIN_DOCK_HEIGHT, (globalThis.innerHeight || 800) - 160)
  return clamp(value, DEFAULT_DOCK_HEIGHT, MIN_DOCK_HEIGHT, maxHeight)
}

/** 宽度收敛到 [MIN_PANEL_WIDTH, 视口-240]，避免把主面板挤没。 */
export function clampPanelWidth(value: number): number {
  const maxWidth = Math.max(MIN_PANEL_WIDTH, (globalThis.innerWidth || 1280) - 240)
  return clamp(value, DEFAULT_PANEL_WIDTH, MIN_PANEL_WIDTH, maxWidth)
}

/** 右侧竖窗宽度与面板宽度同规则（页面持久化时复用）。 */
export const clampDockWidth = clampPanelWidth

/** 布局循环：右侧竖窗 → 底部横窗 → 全屏 → 右侧竖窗。 */
export type CopilotPlacement = 'right' | 'bottom' | 'full'

export function nextCopilotPlacement(current: CopilotPlacement): CopilotPlacement {
  if (current === 'right') return 'bottom'
  if (current === 'bottom') return 'full'
  return 'right'
}
