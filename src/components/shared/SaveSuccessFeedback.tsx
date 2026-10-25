/**
 * UI · 保存按钮的「保存中 / 保存成功」统一反馈（单一实现，避免每个保存按钮各写一套）
 *
 * 数据管理面板里的保存类按钮（写入本地文件夹、绑定文件夹、重新授权后写入、云备份）
 * 共用同一套视觉语言：
 *   · 保存中：`Loader2` + `animate-spin`，尺寸沿用按钮原本的 w-4 h-4
 *   · 保存成功：同尺寸的 `CheckCircle` 换掉转圈图标，配一次
 *     `transition-all duration-300 ease-out` + `scale-75/opacity-0 → scale-100/opacity-100`
 *     的轻微 pop（与 `Toast.tsx` 的进出场同一族：requestAnimationFrame 起帧 + 300ms ease-out），
 *     `SAVE_SUCCESS_HOLD_MS`（1600ms，落在要求的 1.2–2s 内）后自动回落，不留常驻状态
 *   · 只有 await 真正成功（写入返回 true / 云端返回结果）才 `markSuccess()`；失败路径不碰
 *   · 卸载时清掉回落定时器（不会 setState after unmount）
 *   · `prefers-reduced-motion: reduce` 时仍显示成功图标，但去掉缩放/淡入
 *
 * 稳定钩子（供回归测试断言，避免断言 CSS 类名）：
 *   · 按钮：`data-save-state="idle" | "loading" | "success"`
 *   · 成功图标容器：`data-save-motion="pop" | "reduced"`
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { CheckCircle } from 'lucide-react'
import { Spinner } from './Spinner'

export type SaveFeedbackState = 'idle' | 'loading' | 'success'

/** 成功态停留时长：1.2–2s 区间，短暂确认后自动回落 */
export const SAVE_SUCCESS_HOLD_MS = 1600

/** 由「保存是否刚成功」+「按钮是否 busy」推出按钮展示状态（成功优先） */
export function saveFeedbackState(succeeded: boolean, busy: boolean): SaveFeedbackState {
  if (succeeded) return 'success'
  return busy ? 'loading' : 'idle'
}

/** 系统是否要求减少动态效果（无 matchMedia 的环境按 false 处理） */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches } catch { return false }
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(prefersReducedMotion)
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    if (typeof query.addEventListener !== 'function') return
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return reduced
}

export function useSaveSuccessFeedback(holdMs: number = SAVE_SUCCESS_HOLD_MS): {
  succeeded: boolean
  markSuccess: () => void
} {
  const [succeeded, setSucceeded] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // 卸载时清定时器：成功态还没回落就切走也不会对已卸载组件 setState
  useEffect(() => clearTimer, [clearTimer])

  /** 只在 await 真正成功之后调用；失败路径绝不调用（不做乐观成功） */
  const markSuccess = useCallback(() => {
    clearTimer()
    setSucceeded(true)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      setSucceeded(false)
    }, holdMs)
  }, [clearTimer, holdMs])

  return { succeeded, markSuccess }
}

interface SaveStateIconProps {
  state: SaveFeedbackState
  /** 常态图标（保存中时被转圈替换掉的那个） */
  idle: ReactNode
  /** 尺寸/其它类名，保持与原来手写的 Loader2 一致 */
  className?: string
  /** 成功图标的颜色 token；默认主题 success，深色底按钮可传按钮自身文字色 */
  successClassName?: string
}

export function SaveStateIcon({
  state, idle, className = 'w-4 h-4', successClassName = 'text-success',
}: SaveStateIconProps) {
  const reduced = usePrefersReducedMotion()
  const [popped, setPopped] = useState(false)

  useEffect(() => {
    if (state !== 'success' || reduced) { setPopped(false); return }
    const frame = requestAnimationFrame(() => setPopped(true))
    return () => cancelAnimationFrame(frame)
  }, [state, reduced])

  if (state === 'loading') return <Spinner className={className} />
  if (state !== 'success') return <>{idle}</>

  // 与 Toast 同族：下一帧起帧 → transition-all duration-300 ease-out
  const pop = reduced ? '' : `transition-all duration-300 ease-out ${popped ? 'scale-100 opacity-100' : 'scale-75 opacity-0'}`
  return (
    <span className={`inline-flex ${successClassName}`} data-save-motion={reduced ? 'reduced' : 'pop'}>
      <CheckCircle className={`${className} ${pop}`} aria-hidden="true" />
    </span>
  )
}
