/**
 * UI · 统一按钮（项目内所有"可触及按钮"的唯一入口）
 *
 * ── 五态契约 ─────────────────────────────────────────────────
 *   default   由 `variant` + `size` 决定（唯一在这里写死的东西）
 *   hover     全局 base 层叠加层（index.css · --btn-hover-alpha）
 *   pressed   全局 base 层叠加层（--btn-press-alpha）；
 *             若按钮是"开/关"型，另传 `pressed` 走 aria-pressed 常驻选中态
 *   loading   传 `loading` → 自动 spinner + 自动 disabled + aria-busy="true"
 *   disabled  传 `disabled` → 原生 disabled + 全局不透明度
 *
 * 组件**不**重复声明 hover/active/disabled 的工具类：那四态是全局唯一的，
 * 一旦在组件里再写一遍，就会出现"这个按钮 hover 深一点、那个浅一点"的历史问题。
 *
 * ── 用法 ─────────────────────────────────────────────────────
 *   <Button variant="primary" loading={saving} onClick={save}>保存</Button>
 *   <Button variant="ghost" size="sm" aria-label="关闭"><X /></Button>
 *   <Button variant="outline" pressed={isActive} onClick={toggle}>大纲</Button>
 *
 * ── 注意 ─────────────────────────────────────────────────────
 *   · `type` 默认 `"button"`（HTML 默认为 submit，会误触发表单提交）。
 *     表单里的提交按钮必须显式传 `type="submit"`。
 *   · 想改配色请换 `variant`，不要用 `className` 覆盖 `bg-*`／`text-*`：
 *     Tailwind 工具类的胜负由生成顺序决定，不由 className 书写顺序决定。
 */
import type { ComponentPropsWithRef, ReactNode } from 'react'
import { Spinner } from './Spinner'

export type ButtonVariant =
  /** 主操作：实心 accent */
  | 'primary'
  /** 次操作：elevated 底 + 边框 */
  | 'secondary'
  /** 描边 + accent 文字 */
  | 'outline'
  /** 淡 accent 底 + accent 文字（本仓库最常见的"软强调"按钮：收起/展开/查看全部/次要生成动作） */
  | 'accent-soft'
  /** 无底色，仅保留状态反馈（图标按钮、工具条按钮） */
  | 'ghost'
  /** 无底色的强调文字按钮（"收起 / + 新建 / 查看全部"这类行内文字操作） */
  | 'ghost-accent'
  /** 破坏性操作：实心 */
  | 'danger'
  /** 确认/写入类操作：实心 */
  | 'success'
  /** 以下 4 个为「淡色状态按钮」：底色淡、文字用状态色，用于工具条里的状态类操作。
   *  它们消费主题 token（--success/--warning/--error/--info），因此 7 套主题下都成立，
   *  不需要调用方用 className 写死 `bg-amber-500/10 text-amber-300` 这类硬编码色。 */
  | 'success-soft'
  | 'warning-soft'
  | 'danger-soft'
  | 'info-soft'

export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg'

/** 尺寸阶梯：高度 + 内距 + 字号 + 图标尺寸四者同时收口，避免各处手拼 padding */
const SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'h-6 gap-1 rounded px-1.5 text-[11px] [&>svg]:h-3.5 [&>svg]:w-3.5',
  sm: 'h-7 gap-1 rounded-md px-2.5 text-xs [&>svg]:h-4 [&>svg]:w-4',
  md: 'h-8 gap-1.5 rounded-md px-3 text-sm [&>svg]:h-4 [&>svg]:w-4',
  lg: 'h-10 gap-2 rounded-lg px-4 text-sm [&>svg]:h-4 [&>svg]:w-4',
}

/**
 * 纯图标按钮：同样走高度/圆角/图标阶梯，但宽度收成正方形、横向内距归零。
 * 不能靠调用方写 `className="p-0"` 覆盖 `px-1.5` —— Tailwind 工具类的胜负由
 * 生成顺序决定，同为 padding 族的 `px-*` 会恒定压过 `p-*`。所以这里做成显式尺寸。
 */
const ICON_SIZE_CLASS: Record<ButtonSize, string> = {
  xs: 'h-6 w-6 gap-0 rounded p-0 text-[11px] [&>svg]:h-3.5 [&>svg]:w-3.5',
  sm: 'h-7 w-7 gap-0 rounded-md p-0 text-xs [&>svg]:h-4 [&>svg]:w-4',
  md: 'h-8 w-8 gap-0 rounded-md p-0 text-sm [&>svg]:h-4 [&>svg]:w-4',
  lg: 'h-10 w-10 gap-0 rounded-lg p-0 text-sm [&>svg]:h-4 [&>svg]:w-4',
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white border border-transparent',
  secondary: 'bg-bg-elevated text-text-secondary border border-border',
  outline: 'bg-transparent text-accent border border-accent/40',
  'accent-soft': 'bg-accent/15 text-accent border border-transparent',
  ghost: 'bg-transparent text-text-secondary border border-transparent',
  'ghost-accent': 'bg-transparent text-accent border border-transparent',
  danger: 'bg-error text-white border border-transparent',
  success: 'bg-success text-white border border-transparent',
  'success-soft': 'bg-success/15 text-success border border-transparent',
  'warning-soft': 'bg-warning/15 text-warning border border-transparent',
  'danger-soft': 'bg-error/15 text-error border border-transparent',
  'info-soft': 'bg-info/15 text-info border border-transparent',
}

/**
 * `pressed`（开/关型按钮的常驻选中态）必须与 base 层的瞬时 :active 区分开：
 * 前者是"这个开关现在开着"，后者是"手指正按下去"。
 */
const PRESSED_CLASS: Record<ButtonVariant, string> = {
  primary: 'aria-pressed:bg-accent-muted',
  secondary: 'aria-pressed:bg-accent/15 aria-pressed:text-accent aria-pressed:border-accent/40',
  outline: 'aria-pressed:bg-accent/25',
  'accent-soft': 'aria-pressed:bg-accent/25',
  ghost: 'aria-pressed:bg-accent/15 aria-pressed:text-accent',
  'ghost-accent': 'aria-pressed:bg-accent/15',
  danger: 'aria-pressed:bg-error/75',
  success: 'aria-pressed:bg-success/75',
  'success-soft': 'aria-pressed:bg-success/25',
  'warning-soft': 'aria-pressed:bg-warning/25',
  'danger-soft': 'aria-pressed:bg-error/25',
  'info-soft': 'aria-pressed:bg-info/25',
}

/** 图标尺寸由 SIZE_CLASS 的 `[&>svg]` 统一注入，这里只需给 spinner 一个同尺寸类名 */
const SPINNER_CLASS: Record<ButtonSize, string> = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-4 w-4',
  md: 'h-4 w-4',
  lg: 'h-4 w-4',
}

export interface ButtonProps extends Omit<ComponentPropsWithRef<'button'>, 'disabled'> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** 纯图标按钮：宽度收成与高度相等的正方形（关闭按钮、工具条图标按钮） */
  iconOnly?: boolean
  /** 加载中：自动显示 spinner、自动禁用点击（防重复提交）、自动置 aria-busy */
  loading?: boolean
  /** 加载中替换显示的文案；不传则保留 children（按钮宽度不跳动） */
  loadingText?: ReactNode
  /** 开/关型按钮的常驻选中态（写入 aria-pressed） */
  pressed?: boolean
  disabled?: boolean
  /** 撑满父容器宽度 */
  fullWidth?: boolean
  /** 前置图标（loading 时被 spinner 替换） */
  icon?: ReactNode
  /** 后置图标（loading 时保留） */
  iconRight?: ReactNode
  children?: ReactNode
}

export function Button({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  loading = false,
  loadingText,
  pressed,
  disabled = false,
  fullWidth = false,
  icon,
  iconRight,
  type = 'button',
  className,
  children,
  ...rest
}: ButtonProps) {
  // loading 也必须真正禁用：只画 spinner 不禁用 = 用户连点会重复提交
  const isDisabled = disabled || loading

  const classes = [
    'inline-flex items-center justify-center font-medium whitespace-nowrap',
    (iconOnly ? ICON_SIZE_CLASS : SIZE_CLASS)[size],
    VARIANT_CLASS[variant],
    pressed === undefined ? '' : PRESSED_CLASS[variant],
    fullWidth ? 'w-full' : '',
    className ?? '',
  ].filter(Boolean).join(' ')

  return (
    <button
      {...rest}
      type={type}
      className={classes}
      disabled={isDisabled}
      aria-busy={loading ? 'true' : undefined}
      aria-pressed={pressed}
    >
      {loading ? <Spinner className={SPINNER_CLASS[size]} /> : icon}
      {loading && loadingText !== undefined ? loadingText : children}
      {iconRight}
    </button>
  )
}

export default Button
