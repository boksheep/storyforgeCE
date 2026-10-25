import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Info,
  ListChecks,
  Loader2,
  Maximize2,
  Minimize2,
  PanelBottom,
  RotateCcw,
  Send,
  Square,
  Target,
  Trash2,
  X,
} from 'lucide-react'
import type { Project } from '../../lib/types'
import { parseAgentEventPayload } from '../../lib/types'
import { formatPercent, formatTokenCount } from '../../lib/agent/agent-usage'
import { getUsdCnyRate } from '../../lib/ai/usage-log'
import { resolveModelWindow } from '../../lib/ai/context-budget'
import {
  DEFAULT_INPUT_HEIGHT,
  DEFAULT_PANEL_WIDTH,
  clampDockHeight,
  clampInputHeight,
  clampPanelWidth,
} from '../../lib/agent/copilot-layout'

// 尺寸规则来自 copilot-layout；再导出给测试与外部引用，避免出现第二份夹取逻辑。
export { DEFAULT_INPUT_HEIGHT, DEFAULT_PANEL_WIDTH, clampDockHeight, clampInputHeight, clampPanelWidth } from '../../lib/agent/copilot-layout'
import { useAIConfigStore } from '../../stores/ai-config'
import MarkdownText from '../shared/MarkdownText'
import { useMasterCopilot } from './useMasterCopilot'

interface Props {
  project: Project
  worldGroupId: number | null
  worldName: string
  onClose: () => void
  /** 'right' = 右侧竖窗（默认）；'bottom' = 底部横窗；'full' = 全屏 */
  placement?: 'right' | 'bottom' | 'full'
  /** 循环切换布局：right → bottom → full → right */
  onTogglePlacement?: () => void
  /** 底部横窗高度（px），由 WorkspacePage 持久化 */
  dockHeight?: number
  onDockHeightChange?: (height: number) => void
  /** 右侧竖窗宽度（px），由 WorkspacePage 持久化 */
  dockWidth?: number
  onDockWidthChange?: (width: number) => void
  /** 输入区高度（px），由 WorkspacePage 持久化 */
  inputHeight?: number
  onInputHeightChange?: (height: number) => void
}

export type MasterCopilotController = ReturnType<typeof useMasterCopilot>
type ViewProps = Props & { copilot: MasterCopilotController }

const CONTEXT_PROFILE_LABELS = {
  lean: '精简',
  balanced: '均衡',
  full: '完整',
} as const

const DEFAULT_DOCK_HEIGHT = 320


/**
 * 点击后才展开的说明气泡。
 *
 * 用原生 `<details>`：无需额外状态、键盘可操作，且默认收起——
 * 面板空间优先给对话内容，说明只在作者主动点 ⓘ 时出现。
 */
function InfoNote({ label, children, align = 'right' }: {
  label: string
  children: React.ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <details className="relative inline-flex">
      <summary
        aria-label={label}
        title={label}
        className="flex cursor-pointer list-none items-center rounded p-0.5 text-text-muted hover:bg-bg-hover hover:text-text-primary [&::-webkit-details-marker]:hidden"
      >
        <Info className="h-3.5 w-3.5" />
      </summary>
      <div
        className={`absolute top-6 z-40 w-72 rounded-md border border-border bg-bg-elevated p-2 text-[10px] leading-4 text-text-secondary shadow-theme-md ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        {children}
      </div>
    </details>
  )
}

export default function ChatCopilotPanel(props: Props) {
  const copilot = useMasterCopilot({ project: props.project, worldGroupId: props.worldGroupId })
  return <ChatCopilotPanelView {...props} copilot={copilot} />
}

export function ChatCopilotPanelView({
  project,
  worldName,
  copilot,
  onClose,
  placement = 'right',
  onTogglePlacement,
  dockHeight = DEFAULT_DOCK_HEIGHT,
  onDockHeightChange,
  dockWidth = DEFAULT_PANEL_WIDTH,
  onDockWidthChange,
  inputHeight = DEFAULT_INPUT_HEIGHT,
  onInputHeightChange,
}: ViewProps) {
  const aiConfig = useAIConfigStore(state => state.config)
  // 运行过程默认展开，让作者能看见程序在做什么；作者手动收起后不再自动弹出。
  const [showDetails, setShowDetails] = useState(true)
  const [detailsTouched, setDetailsTouched] = useState(false)
  const [busySeconds, setBusySeconds] = useState(0)
  const [copiedId, setCopiedId] = useState<number | null>(null)
  // 任务目标在对话流内折叠展示，让输入区保持稳定可用。
  const [showGoal, setShowGoal] = useState(false)
  const endRef = useRef<HTMLDivElement | null>(null)
  const messages = copilot.events.filter(event => event.kind === 'message')
  const lastUserSequence = [...copilot.events].reverse()
    .find(event => event.kind === 'message' && event.role === 'user')?.sequence ?? -1
  const latestPlan = [...copilot.events].reverse().find(event => event.kind === 'plan'
    && event.sequence > lastUserSequence)
  const planPayload = useMemo(() => (latestPlan
    ? parseAgentEventPayload<{ summary?: string; executionMode?: string; tasks?: Array<{ id: string; agentId: string; instruction: string }> }>(latestPlan, {})
    : null), [latestPlan])
  const taskEvents = copilot.events.filter(event => event.kind === 'task' && event.sequence > lastUserSequence)
  const latestTasks = useMemo(() => {
    const result = new Map<string, {
      taskId: string
      agentId: string
      status: string
      detail: string
      error?: string
    }>()
    taskEvents.forEach(event => {
      const payload = parseAgentEventPayload<{
        taskId?: string
        agentId?: string
        status?: string
        error?: string
      }>(event, {})
      if (payload.taskId) result.set(payload.taskId, {
        taskId: payload.taskId,
        agentId: payload.agentId ?? 'domain',
        status: payload.status ?? 'unknown',
        detail: event.content,
        error: payload.error,
      })
    })
    return [...result.values()]
  }, [taskEvents])
  const displayTasks = copilot.liveProgress.length > 0
    ? copilot.liveProgress.map(progress => ({
      taskId: progress.id, agentId: progress.label, status: progress.status,
      detail: progress.detail, error: undefined as string | undefined,
    }))
    : latestTasks

  // 只在作者本来就贴着底部时跟随新内容；否则运行中的每条进度都会把视口拽回底部，
  // 作者无法回看上文。
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)
  const trackScroll = () => {
    const node = scrollRef.current
    if (!node) return
    stickToBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48
  }
  useEffect(() => {
    if (!stickToBottomRef.current) return
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [copilot.events.length, copilot.pendingCandidates.length, copilot.liveProgress.length])

  // 新一轮开始且作者没有手动收起时，自动展开运行过程。
  useEffect(() => {
    if (copilot.busy && !detailsTouched) setShowDetails(true)
  }, [copilot.busy, detailsTouched])

  // 运行秒表：让作者能感知任务在推进，而不是界面“卡住”。
  useEffect(() => {
    if (!copilot.busy) { setBusySeconds(0); return }
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setBusySeconds(Math.floor((Date.now() - startedAt) / 1000))
    }, 1000)
    return () => clearInterval(timer)
  }, [copilot.busy])

  const completedTasks = displayTasks.filter(task => task.status === 'completed').length
  const failedTasks = displayTasks.filter(task => task.status === 'failed').length
  const currentProgress = [...copilot.liveProgress].reverse().find(progress => progress.status === 'running')
  const liveStep = !copilot.busy
    ? ''
    : currentProgress
      ? `${currentProgress.label}：${currentProgress.detail}`
      : copilot.pendingReview
      ? '已生成只读审阅计划，等待你确认'
      : displayTasks.length > 0 && completedTasks + failedTasks < displayTasks.length
        ? `正在执行任务 ${completedTasks + failedTasks}/${displayTasks.length}`
        : latestPlan
          ? '正在整理结果'
          : '正在理解目标并安排任务'
  // 只展示最近一次运行之后的错误，避免历史失败长期占据面板。
  const recentErrors = useMemo(() => {
    return copilot.events.filter(event => event.kind === 'error' && event.sequence >= lastUserSequence)
  }, [copilot.events, lastUserSequence])

  // 底部横窗拖拽：向上拖变高，向下拖变矮；边界统一由 copilot-layout 夹取，
  // 避免"拖拽时的边界"和"恢复持久化值时的边界"分叉。
  const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const beginResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (placement !== 'bottom' || !onDockHeightChange) return
    resizeRef.current = { startY: event.clientY, startHeight: dockHeight }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = resizeRef.current
    if (!state || !onDockHeightChange) return
    onDockHeightChange(clampDockHeight(state.startHeight + (state.startY - event.clientY)))
  }
  const endResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!resizeRef.current) return
    resizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // 右侧竖窗拖拽：向左拖变宽。
  const widthResizeRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const beginWidthResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (placement !== 'right' || !onDockWidthChange) return
    widthResizeRef.current = { startX: event.clientX, startWidth: dockWidth }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveWidthResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = widthResizeRef.current
    if (!state || !onDockWidthChange) return
    onDockWidthChange(clampPanelWidth(state.startWidth + (state.startX - event.clientX)))
  }
  const endWidthResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!widthResizeRef.current) return
    widthResizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // 输入区高度：拖动"对话区 / 输入区"分界线，向上拖变高。
  const inputResizeRef = useRef<{ startY: number; startHeight: number } | null>(null)
  const beginInputResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!onInputHeightChange) return
    inputResizeRef.current = { startY: event.clientY, startHeight: inputHeight }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveInputResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = inputResizeRef.current
    if (!state || !onInputHeightChange) return
    onInputHeightChange(clampInputHeight(state.startHeight + (state.startY - event.clientY)))
  }
  const endInputResize = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!inputResizeRef.current) return
    inputResizeRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  // 底部状态栏数据：上下文压力来自本轮调用估算，累计 token/缓存命中来自用量日志。
  // 窗口数字与设置页、上下文装配用同一个解析（手填 > 服务端报告 > 名称族/服务商预设），
  // 并在 tooltip 里说明来源，避免"选了长窗口模型却显示 128K"变成无法解释的数字。
  const effectiveWindow = resolveModelWindow(
    aiConfig.provider,
    aiConfig.model,
    aiConfig.contextWindow,
    aiConfig.contextWindowSource === 'detected' ? 'detected' : 'manual',
  )
  const contextWindow = effectiveWindow.maxContext
  const contextUsed = copilot.contextUsage?.peakInputTokens ?? 0
  const contextRatio = contextWindow > 0 ? contextUsed / contextWindow : null
  const isBottom = placement === 'bottom'
  const isFull = placement === 'full'
  const nextPlacementLabel = isFull ? '退出全屏' : isBottom ? '全屏显示' : '切换为底部横窗'
  const placementIcon = isFull ? <Minimize2 className="h-4 w-4" /> : isBottom ? <Maximize2 className="h-4 w-4" /> : <PanelBottom className="h-4 w-4" />

  return (
    <aside
      aria-label="主 Agent 创作副驾"
      data-placement={placement}
      style={isBottom
        ? { height: dockHeight }
        : placement === 'right'
          ? { width: dockWidth, maxWidth: 'calc(100vw - 2rem)' }
          : undefined}
      className={isFull
        ? 'fixed inset-0 z-40 flex h-full w-full flex-col bg-bg-surface'
        : isBottom
          ? 'z-30 flex w-full shrink-0 flex-col border-t border-border bg-bg-surface shadow-xl'
          : 'fixed inset-y-0 right-0 z-30 flex h-full shrink-0 flex-col border-l border-border bg-bg-surface shadow-xl lg:static lg:z-auto lg:shadow-none'}
    >
      {isBottom && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="拖动调整副驾窗口高度"
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={() => onDockHeightChange?.(DEFAULT_DOCK_HEIGHT)}
          title="拖动调整高度（双击恢复默认）"
          className="group flex h-2 w-full shrink-0 cursor-row-resize items-center justify-center bg-bg-surface"
        >
          <span className="h-0.5 w-10 rounded-full bg-border transition-colors group-hover:bg-accent" />
        </div>
      )}
      {placement === 'right' && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整副驾窗口宽度"
          onPointerDown={beginWidthResize}
          onPointerMove={moveWidthResize}
          onPointerUp={endWidthResize}
          onPointerCancel={endWidthResize}
          onDoubleClick={() => onDockWidthChange?.(DEFAULT_PANEL_WIDTH)}
          title="拖动调整宽度（双击恢复默认）"
          className="group absolute inset-y-0 left-0 hidden w-2 cursor-col-resize items-center justify-center lg:flex"
        >
          <span className="h-10 w-0.5 rounded-full bg-border transition-colors group-hover:bg-accent" />
        </div>
      )}
      <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border/70 px-3 py-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Bot className="h-4 w-4 shrink-0 text-accent" />
          <span className="shrink-0 text-sm font-semibold text-text-primary">主 Agent</span>
          <span className="shrink-0 rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
            单一对话入口
          </span>
          <InfoNote label="关于主 Agent 的说明">
            <p className="font-medium text-text-primary">{project.name} · {worldName}</p>
            <p className="mt-1">
              你只需要描述目标。主 Agent 会在幕后调度领域 Agent；任何正式写入仍必须由你确认。
            </p>
            <p className="mt-1 text-text-muted">
              Enter 发送，Shift+Enter 换行。输入、计划和候选都会自动保存在本地；刷新或重开项目后可继续。
            </p>
          </InfoNote>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onTogglePlacement && (
            <button
              type="button"
              aria-label={nextPlacementLabel}
              title={nextPlacementLabel}
              onClick={onTogglePlacement}
              className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
            >
              {placementIcon}
            </button>
          )}
          <button
            type="button"
            aria-label="关闭主 Agent"
            onClick={onClose}
            className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </header>

      <div ref={scrollRef} onScroll={trackScroll} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2.5 py-2">
        {copilot.loading && (
          <div className="flex items-center gap-2 text-xs text-text-muted">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            正在恢复对话与候选…
          </div>
        )}
        {copilot.draftSaveError && (
          <p role="alert" className="rounded border border-error/30 bg-error/5 px-2 py-1 text-xs text-error">
            {copilot.draftSaveError}
          </p>
        )}

        {messages.map(message => (
          <div key={message.id} className={message.role === 'user' ? 'flex justify-end' : undefined}>
            {/* 不用气泡框：对话按角色用颜色与对齐区分，省下的边框与内边距全部留给正文 */}
            <div
              className={message.role === 'user'
                ? 'group max-w-[92%] text-right text-[11px] leading-5 text-accent'
                : 'group w-full text-xs leading-5 text-text-secondary'}
            >
              {message.role === 'user'
                ? <p className="whitespace-pre-wrap break-words">{message.content}</p>
                : <MarkdownText text={message.content} />}
              {message.role === 'assistant' && message.content.trim().length > 40 && (
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(message.content)
                      .then(() => {
                        setCopiedId(message.id ?? null)
                        setTimeout(() => setCopiedId(current => (current === message.id ? null : current)), 1500)
                      })
                      .catch(() => {})
                  }}
                  className="mt-2 flex items-center gap-1 text-[10px] text-text-muted opacity-0 transition-opacity group-hover:opacity-100 focus:opacity-100"
                  title="复制这条回复的 Markdown 原文"
                >
                  {copiedId === message.id ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                  {copiedId === message.id ? '已复制' : '复制原文'}
                </button>
              )}
              {message.role === 'user' && (
                <button type="button"
                  aria-label="重新发送这条消息"
                  title="重新发送这条消息；会重新运行并生成新结果"
                  disabled={copilot.busy || copilot.loading || copilot.pendingCandidates.length > 0}
                  onClick={() => { void copilot.submit(message.content) }}
                  className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-text-muted opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100 disabled:opacity-40"
                >
                  <RotateCcw className="h-3 w-3" />重发
                </button>
              )}
            </div>
          </div>
        ))}

        {recentErrors.map(event => (
          <section key={event.id} role="alert" className="rounded-lg border border-error/40 bg-error/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-error" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-error">本轮没有完成</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-5 text-text-secondary">
                  {event.content || '主 Agent 执行失败，但没有返回错误详情。'}
                </p>
              </div>
            </div>
            <div className="mt-2 flex justify-end">
              <button
                type="button"
                disabled={copilot.busy || !copilot.lastRequest}
                onClick={() => { void copilot.retryLast() }}
                className="flex items-center gap-1 rounded border border-error/40 px-2.5 py-1.5 text-xs text-error hover:bg-error/10 disabled:opacity-50"
                title={copilot.lastRequest ? `重试：${copilot.lastRequest.slice(0, 40)}` : '没有可重试的指令'}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                重试这条指令
              </button>
            </div>
          </section>
        ))}

        {latestPlan && (
          <section className="rounded border border-border/70 bg-bg-base">
            <button type="button" aria-expanded={showGoal} aria-label="任务目标"
              onClick={() => setShowGoal(value => !value)}
              className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left">
              <Target className="h-3.5 w-3.5 shrink-0 text-accent" />
              <span className="shrink-0 text-[11px] font-medium text-text-secondary">任务目标</span>
              <span className="min-w-0 flex-1 truncate text-[10px] text-text-muted">
                {planPayload?.summary ?? latestPlan.content}
              </span>
              {showGoal ? <ChevronDown className="h-3.5 w-3.5 text-text-muted" />
                : <ChevronRight className="h-3.5 w-3.5 text-text-muted" />}
            </button>
            {showGoal && (
              <div className="border-t border-border/60 px-2 py-1.5 text-[10px] leading-4 text-text-secondary">
                <p>{planPayload?.summary ?? latestPlan.content}</p>
                {(planPayload?.tasks?.length ?? 0) > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {planPayload!.tasks!.map(task => {
                      const state = latestTasks.find(item => item.taskId === task.id)
                      return <li key={task.id} className="flex items-start gap-1">
                        {state?.status === 'completed' ? <Check className="h-3 w-3 shrink-0 text-success" />
                          : state?.status === 'failed' ? <AlertTriangle className="h-3 w-3 shrink-0 text-error" />
                            : <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-text-muted/50" />}
                        <span>{task.agentId} · {task.instruction}</span>
                      </li>
                    })}
                  </ul>
                ) : <p className="mt-1 flex items-center gap-1 text-text-muted">
                  <ListChecks className="h-3 w-3" />
                  {planPayload?.executionMode === 'agent-first'
                    ? '主 Agent 会根据项目证据逐步决定执行步骤；明细见运行过程。'
                    : '本目标由主 Agent 直接处理。'}
                </p>}
              </div>
            )}
          </section>
        )}

        {(displayTasks.length > 0 || copilot.busy || latestPlan != null || recentErrors.length > 0) && (
          <section className="rounded-lg border border-border/70 bg-bg-base">
            <button
              type="button"
              aria-expanded={showDetails}
              onClick={() => { setDetailsTouched(true); setShowDetails(value => !value) }}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left"
            >
              <span className="flex items-center gap-2 text-xs font-medium text-text-primary">
                {copilot.busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />}
                {copilot.busy ? `正在运行${busySeconds > 0 ? ` · ${busySeconds}s` : ''}` : '运行过程'}
              </span>
              <span className="flex items-center gap-1 text-[10px] text-text-muted">
                {completedTasks}/{displayTasks.length || '…'}
                {showDetails
                  ? <ChevronDown className="h-3.5 w-3.5" />
                  : <ChevronRight className="h-3.5 w-3.5" />}
              </span>
            </button>
            {showDetails && (
              <div aria-live="polite" className="max-h-44 space-y-1 overflow-y-auto border-t border-border/60 px-3 py-2">
                {liveStep && (
                  <p className="mb-2 flex items-center gap-1.5 rounded border border-accent/20 bg-accent/5 px-2 py-1 text-[10px] leading-4 text-text-secondary">
                    <Loader2 className="h-3 w-3 shrink-0 animate-spin text-accent" />
                    {liveStep}
                  </p>
                )}
                {displayTasks.length === 0 && !liveStep && (
                  <p className="text-[10px] text-text-muted">
                    {recentErrors.length > 0 ? '这次运行没有产生步骤明细，失败原因见上方。' : '这次运行没有步骤明细。'}
                  </p>
                )}
                {displayTasks.map(task => (
                  <div key={task.taskId} className="flex items-start justify-between gap-2 text-[10px]">
                    <span className="min-w-0 text-text-secondary">
                      <span className="font-medium">{task.agentId}</span>
                      {task.detail && <span className="ml-1 break-words">· {task.detail}</span>}
                    </span>
                    <span className={
                      task.status === 'completed'
                        ? 'text-success'
                        : task.status === 'failed'
                          ? 'text-error'
                          : 'text-accent'
                    }>
                      {task.status === 'completed' ? '已完成' : task.status === 'failed' ? task.error || '失败' : '执行中'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {!copilot.busy && copilot.taskContinuation && copilot.pendingCandidates.length === 0 && (
          <section className="flex items-center gap-2 rounded border border-accent/30 bg-accent/5 px-2 py-1.5 text-[11px]">
            <div className="min-w-0 flex-1">
              <p className="font-medium text-text-primary">
                {copilot.taskContinuation.kind === 'summarize' ? '任务已结算，但还没有答复' : '任务已暂停，可从断点继续'}
              </p>
              <p className="truncate text-text-muted" title={copilot.taskContinuation.originalRequest}>
                {copilot.taskContinuation.originalRequest}
              </p>
            </div>
            <button type="button" onClick={() => { void copilot.continueTask() }}
              className="shrink-0 rounded bg-accent px-2 py-1 text-white">
              {copilot.taskContinuation.kind === 'summarize' ? '查看已完成结果' : '继续任务'}
            </button>
          </section>
        )}

        {copilot.pendingReview && (
          <section className="rounded-lg border border-accent/30 bg-bg-base p-3">
            <p className="text-xs font-semibold text-text-primary">待确认 · 只读剧情审阅</p>
            {copilot.pendingReview.plan.review?.volumeTitle && (
              <p className="mt-1 flex items-center gap-1.5 text-[11px] text-text-secondary">
                <Target className="h-3 w-3 text-accent" />
                审阅目标：{copilot.pendingReview.plan.review.volumeTitle}
              </p>
            )}
            <p className="mt-1 text-[11px] leading-5 text-text-secondary">
              {copilot.pendingReview.plan.summary}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" disabled={copilot.busy}
                onClick={() => { void copilot.rejectReview() }}
                className="rounded px-2.5 py-1.5 text-xs text-text-muted hover:bg-bg-hover disabled:opacity-50">
                取消
              </button>
              <button type="button" disabled={copilot.busy}
                onClick={() => { void copilot.confirmReview() }}
                className="rounded bg-accent px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50">
                允许只读审阅
              </button>
            </div>
          </section>
        )}

        {copilot.pendingCandidates.map(candidate => (
          <section
            key={candidate.event.id}
            className="rounded-lg border border-accent/30 bg-bg-base p-3"
          >
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-text-primary">
                待确认 · {candidate.payload.label}
                <InfoNote label="候选来源与采纳规则" align="left">
                  <p>
                    {candidate.payload.agentId === 'project-field'
                      ? '这是项目字段修改候选。刷新后仍会保留；只有采纳才会更新项目正式数据。'
                      : candidate.payload.agentId === 'project-native'
                        ? '这是主 Agent 读取项目后提出的多操作候选。采纳时整组校验并写入；任一项失败会回滚整组。'
                      : candidate.payload.agentId === 'project-lifecycle'
                        ? '这是章节删除影响预览。确认时会复核章节及关联数据，再调用章节现有级联删除入口。'
                      : candidate.payload.agentId === 'project-create'
                        ? '这是新增候选。刷新后仍会保留；只有采纳才会在项目里新建这条记录。'
                        : '这是领域 Agent 的真实输出。刷新后仍会保留；只有采纳才会进入项目正式数据。'}
                  </p>
                  {candidate.payload.contextEvidence && (
                    <>
                      <p className="mt-1">
                        本次输入 {candidate.payload.contextEvidence.estimatedInputTokens.toLocaleString()} /
                        {' '}{candidate.payload.contextEvidence.inputBudgetTokens.toLocaleString()} tokens
                      </p>
                      <p className="mt-1">已纳入：{candidate.payload.contextEvidence.included.join('、') || '无'}</p>
                      {candidate.payload.contextEvidence.trimmed.length > 0 && (
                        <p className="text-warning">被预算裁剪：{candidate.payload.contextEvidence.trimmed.join('、')}</p>
                      )}
                      {candidate.payload.contextEvidence.omitted.length > 0 && (
                        <p>无数据/未启用：{candidate.payload.contextEvidence.omitted.join('、')}</p>
                      )}
                    </>
                  )}
                  {candidate.payload.teamBudgetEvidence && (
                    <p className="mt-1">
                      本轮团队预算 {candidate.payload.teamBudgetEvidence.usedTokens.toLocaleString()} /
                      {' '}{candidate.payload.teamBudgetEvidence.maxTokens.toLocaleString()} tokens
                      {' · '}{candidate.payload.teamBudgetEvidence.calls}/{candidate.payload.teamBudgetEvidence.maxCalls} 次调用
                      {' · '}Canon 打回 {candidate.payload.teamBudgetEvidence.canonRetries}/{candidate.payload.teamBudgetEvidence.maxCanonRetries}
                    </p>
                  )}
                </InfoNote>
              </span>
              <span
                className="max-w-[45%] truncate text-[10px] text-text-muted"
                title={candidate.payload.contextSources.join('、')}
              >
                {candidate.payload.contextEvidence
                  ? `${CONTEXT_PROFILE_LABELS[candidate.payload.contextEvidence.profile]} · ≈${candidate.payload.contextEvidence.estimatedInputTokens.toLocaleString()} tokens`
                  : `${candidate.payload.contextSources.length} 个输入来源`}
              </span>
            </div>
            <textarea
              aria-label={`${candidate.payload.label}候选内容`}
              value={candidate.event.content}
              disabled={copilot.busy || candidate.payload.agentId === 'project-lifecycle'}
              onChange={event => {
                void Promise.resolve(copilot.updateCandidate(candidate.event.id!, event.target.value)).catch(() => {})
              }}
              className={`h-64 w-full resize-y rounded border border-border bg-bg-surface p-2 text-[11px] leading-5 text-text-primary outline-none focus:border-accent disabled:opacity-60 ${
                candidate.payload.agentId === 'world-origin' ? '' : 'font-mono'
              }`}
            />
            {candidate.payload.dependsOnTaskIds?.length ? (
              <p className="mt-1 text-[10px] text-warning">
                采纳前需先采纳上游任务：{candidate.payload.dependsOnTaskIds.join('、')}
              </p>
            ) : null}
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                disabled={copilot.busy}
                onClick={() => { void copilot.rejectCandidate(candidate) }}
                className="flex items-center gap-1 rounded px-2.5 py-1.5 text-xs text-text-muted hover:bg-bg-hover hover:text-text-primary disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                拒绝
              </button>
              <button
                type="button"
                disabled={copilot.busy}
                onClick={() => { void copilot.adoptCandidate(candidate) }}
                className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-50"
              >
                {copilot.busy
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Check className="h-3.5 w-3.5" />}
                {candidate.payload.agentId === 'project-lifecycle' ? '确认删除' : '采纳'}
              </button>
            </div>
          </section>
        ))}
        <div ref={endRef} />
      </div>

      {/* 输入区高度由「对话区 / 输入区」这条分界线拖动调整（不是输入框右下角的原生手柄） */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整输入区高度"
        onPointerDown={beginInputResize}
        onPointerMove={moveInputResize}
        onPointerUp={endInputResize}
        onPointerCancel={endInputResize}
        onDoubleClick={() => onInputHeightChange?.(DEFAULT_INPUT_HEIGHT)}
        title="拖动调整输入区高度（双击恢复默认）"
        className="group flex h-1.5 w-full shrink-0 cursor-row-resize items-center justify-center hover:bg-bg-hover"
      >
        <span className="h-0.5 w-10 rounded-full bg-border transition-colors group-hover:bg-accent" />
      </div>

      <form
        className="shrink-0 px-2.5 pb-1.5"
        onSubmit={event => {
          event.preventDefault()
          void copilot.submit()
        }}
      >
        {copilot.submitNotice && copilot.pendingCandidates.length > 0 && (
          <p role="status" className="mb-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] leading-4 text-text-secondary">
            {copilot.submitNotice}
          </p>
        )}
        <textarea
          aria-label="告诉主 Agent 你的目标"
          value={copilot.authorRequest}
          disabled={copilot.loading || copilot.busy}
          maxLength={2000}
          style={{ height: inputHeight }}
          onChange={event => copilot.setAuthorRequest(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void copilot.submit()
            }
          }}
          placeholder={copilot.pendingCandidates.length ? '候选待处理：可输入「确认」/「取消」，或在上方逐份处理' : ''}
          className="w-full resize-none rounded-md border border-border bg-bg-base px-3 py-2 text-xs leading-5 text-text-primary outline-none focus:border-accent disabled:opacity-60"
        />
        <div className="mt-1 flex items-center justify-end gap-2">
          {copilot.busy ? (
            <button
              type="button"
              onClick={copilot.stop}
              className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover"
            >
              <Square className="h-3.5 w-3.5" />
              停止
            </button>
          ) : (
            <button
              type="submit"
              disabled={
                copilot.loading
                || !copilot.authorRequest.trim()
                || copilot.pendingCandidates.length > 0
              }
              className="flex items-center gap-1 rounded bg-accent px-3 py-1.5 text-xs text-white hover:opacity-90 disabled:opacity-40"
            >
              <Send className="h-3.5 w-3.5" />
              交给主 Agent
            </button>
          )}
        </div>
      </form>

      {/* 底部状态栏：上下文占用 / token / 缓存命中率 / 调用与费用（与 DSH 底栏同一信息层级） */}
      <footer
        aria-label="主 Agent 运行指标"
        className="flex shrink-0 items-center gap-3 overflow-x-auto whitespace-nowrap border-t border-border/70 bg-bg-base/60 px-2.5 py-1 text-[10px] text-text-muted"
      >
        <span
          className="flex items-center gap-1"
          title={`本轮最近一次调用估算输入 ${contextUsed.toLocaleString()} tokens（峰值），模型上下文窗口 ${contextWindow.toLocaleString()} tokens（${effectiveWindow.description}）。窗口可在「设置 → AI 模型配置 → 上下文窗口」修改；点刷新模型列表会尝试读取服务端报告的窗口。`}
        >
          <span className="text-text-secondary">上下文</span>
          <span className="tabular-nums">
            {formatTokenCount(contextUsed)} / {formatTokenCount(contextWindow)}
          </span>
          <span className={contextRatio != null && contextRatio > 0.8 ? 'text-warning' : undefined}>
            ({formatPercent(contextRatio)})
          </span>
        </span>
        <span className="flex items-center gap-1" title="本项目主 Agent 累计输入/输出 token">
          <span className="text-text-secondary">Token</span>
          <span className="tabular-nums">↑{formatTokenCount(copilot.usage.inputTokens)} ↓{formatTokenCount(copilot.usage.outputTokens)}</span>
        </span>
        <span
          className="flex items-center gap-1"
          title={copilot.usage.cacheHitRate == null
            ? '服务端未返回缓存字段：该服务商或模型不报告提示词缓存命中'
            : `命中 ${copilot.usage.cachedInputTokens.toLocaleString()} / 输入 ${copilot.usage.inputTokens.toLocaleString()} tokens`}
        >
          <span className="text-text-secondary">缓存命中</span>
          <span className="tabular-nums">{formatPercent(copilot.usage.cacheHitRate)}</span>
        </span>
        <span className="flex items-center gap-1">
          <span className="text-text-secondary">调用</span>
          <span className="tabular-nums">{copilot.usage.calls}</span>
        </span>
        <span className="flex items-center gap-1" title="按当前模型价格与汇率估算的本项目主 Agent 累计费用">
          <span className="text-text-secondary">费用</span>
          <span className="tabular-nums">≈¥{(copilot.usage.costUsd * getUsdCnyRate()).toFixed(2)}</span>
        </span>
        <span className="ml-auto max-w-[45%] truncate" title={`${aiConfig.provider} · ${aiConfig.model || '未选择模型'}`}>
          {aiConfig.model || '未选择模型'}
        </span>
        {copilot.contextUsage?.teamBudget && (
          <span className="flex items-center gap-1" title="本轮 Agent 团队预算使用情况">
            <span className="text-text-secondary">团队预算</span>
            <span className="tabular-nums">
              {formatTokenCount(copilot.contextUsage.teamBudget.usedTokens)} / {formatTokenCount(copilot.contextUsage.teamBudget.maxTokens)}
            </span>
          </span>
        )}
        {copilot.busy && (
          <span className="ml-auto flex items-center gap-1 text-accent">
            <Loader2 className="h-3 w-3 animate-spin" />
            运行中{busySeconds > 0 ? ` ${busySeconds}s` : ''}
          </span>
        )}
      </footer>
    </aside>
  )
}
