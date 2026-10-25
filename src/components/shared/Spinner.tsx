/**
 * UI · 统一加载指示器（loading 态的唯一实现）
 *
 * 项目内"转圈"只应有这一处实现：按钮 loading 态、面板等待态、生成中提示共用它，
 * 避免每个按钮各写一套 `<Loader2 className="animate-spin" />`。
 *
 * 约定：
 *   · 尺寸由 `className` 决定（默认 `h-4 w-4`）；放进按钮时由 Button 按 size 注入，
 *     因此 spinner 与按钮文字、图标始终保持同一套尺寸阶梯。
 *   · 永远 `aria-hidden`：加载语义由宿主元素的 `aria-busy` 播报，
 *     否则屏幕阅读器会把图标名和状态重复读两遍。
 *   · `motion-reduce:animate-none`：系统要求减少动态效果时保留图标、停止旋转
 *     （与 `SaveSuccessFeedback` 的 reduced 策略同一族）。
 */
import { Loader2 } from 'lucide-react'

export interface SpinnerProps {
  /** 尺寸/颜色类名，默认 `h-4 w-4` */
  className?: string
}

export function Spinner({ className = 'h-4 w-4' }: SpinnerProps) {
  return (
    <Loader2
      className={`${className} animate-spin motion-reduce:animate-none`}
      aria-hidden="true"
    />
  )
}

export default Spinner
