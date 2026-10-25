/**
 * 选中文本浮动工具栏 — Phase 24.3 / BUDGET-1 后续修复 / 右键剪贴板
 *
 * 交互：
 *  - 划选文字后**不再自动弹出**；改为「划选 + 右键」触发，避免阅读时误触。
 *  - 右键菜单固定包含「复制 / 剪切 / 粘贴」，再按选区长度决定是否展示 AI 行：
 *      无选区 → 只有剪贴板行（光标处可粘贴）；
 *      选区过短（≤5 字）→ 只有剪贴板行（避免误触 AI）；
 *      选区 5~5000 字 → 剪贴板行 + 润色/扩写/缩写/改写/查漏；
 *      选区 ≥5000 字 → 只有剪贴板行（超长文本不送 AI）。
 *    桌面端(Electron)与浏览器默认都不再保证原生右键菜单，剪贴板操作必须自备。
 *  - 结果窗口可复制、可关闭、可钉住保留：
 *      复制/关闭按钮不依赖文本选择，因此「选区落在结果窗里」不会再把窗口关掉；
 *      「钉住」后只有点 ✕ 才关闭，便于一边改稿一边留档。
 *
 * 剪贴板实现：优先 Clipboard API，失败或不可用时回落到选区 + execCommand（兼容旧内核/非安全上下文）；
 * 粘贴读不到剪贴板时不谎报成功，改为提示用户按 Ctrl/⌘+V。
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Wand2, Expand, Minimize2, RefreshCw, Search, X, Loader2, Check, Copy, Pin, Scissors, ClipboardPaste,
} from 'lucide-react'
import { useAIStream } from '../../hooks/useAIStream'
import { buildPolishPrompt, buildExpandPrompt } from '../../lib/ai/adapters/chapter-adapter'
import type { ChatMessage } from '../../lib/types'
import { Button } from '../shared/Button'

interface Props {
  /** 获取当前选中文本 */
  getSelectedText: () => string
  /** 获取选中文本的位置（用于定位工具栏） */
  getSelectionRect: () => DOMRect | null
  /** 替换选中文本（无捕获范围时的回落路径） */
  replaceSelectedText: (text: string) => void
  /** BUDGET-1：右键时捕获选区范围，供结果采纳时精确回填 */
  captureSelectionRange?: () => { from: number; to: number } | null
  /** BUDGET-1：按捕获范围替换；范围失效返回 false */
  replaceRange?: (from: number, to: number, html: string) => boolean
  /** 右键剪贴板：按捕获范围删除（剪切）；范围失效返回 false */
  deleteRange?: (from: number, to: number) => boolean
  /** 编辑器内容 DOM；右键只有落在正文里才触发，不劫持编辑器外的右键菜单。 */
  getEditorElement?: () => HTMLElement | null
  /** 是否禁用（如正在 AI 生成时）；禁用时只保留剪贴板行，不再发起 AI 动作 */
  disabled?: boolean
  /** 扩写/润色统一走章节编辑器的预览与协商流程。 */
  onPolish?: (text: string, range: { from: number; to: number } | null) => void
  onExpand?: (text: string, range: { from: number; to: number } | null) => void
}

type ActionType = 'polish' | 'expand' | 'condense' | 'rewrite' | 'check'

const ACTIONS: { type: ActionType; icon: typeof Wand2; label: string }[] = [
  { type: 'polish',   icon: Wand2,      label: '润色' },
  { type: 'expand',   icon: Expand,     label: '扩写' },
  { type: 'condense', icon: Minimize2,  label: '缩写' },
  { type: 'rewrite',  icon: RefreshCw,  label: '改写' },
  { type: 'check',    icon: Search,     label: '查漏' },
]

/** 触发 AI 动作的选区长度边界（与历史行为一致：太短防误触，太长不送模型）。 */
const AI_MIN_CHARS = 5
const AI_MAX_CHARS = 5000

/** 纯文本 → 段落 HTML，避免替换时多段内容挤成一行。 */
function textToHtml(text: string): string {
  return text
    .split(/\n+/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
    .join('')
}

/** 写剪贴板：优先 Clipboard API，失败回落到选区 + execCommand；返回是否真的写入。 */
async function writeClipboardText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 非安全上下文 / 旧内核回落：临时选区 + execCommand
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch { ok = false }
    document.body.removeChild(area)
    return ok
  }
}

/** 读剪贴板纯文本；浏览器未授权/不支持时返回空串，由调用方提示用户手动粘贴。 */
async function readClipboardText(): Promise<string> {
  try {
    return (await navigator.clipboard.readText()) ?? ''
  } catch {
    return ''
  }
}

export default function FloatingToolbar({
  getSelectedText, getSelectionRect, replaceSelectedText, captureSelectionRange, replaceRange,
  deleteRange, getEditorElement, disabled, onPolish, onExpand,
}: Props) {
  const [visible, setVisible] = useState(false)
  const [position, setPosition] = useState({ top: 0, left: 0 })
  const [result, setResult] = useState<string | null>(null)
  const [selectedText, setSelectedText] = useState('')
  const [pinned, setPinned] = useState(false)
  const [copied, setCopied] = useState(false)
  const [clipboardHint, setClipboardHint] = useState<string | null>(null)
  const ai = useAIStream()
  const toolbarRef = useRef<HTMLDivElement>(null)
  const rangeRef = useRef<{ from: number; to: number } | null>(null)
  /** 始终指向最新 ai 句柄，供只依赖 [visible, pinned] 的监听器取消流式请求。 */
  const aiRef = useRef(ai)
  aiRef.current = ai

  /**
   * 右键触发：落在正文里就接管（浏览器与 Electron 的原生菜单并不可靠，
   * 剪贴板操作必须自带），按选区长度决定是否同时给出 AI 行。
   */
  const handleContextMenu = useCallback((event: MouseEvent) => {
    if (toolbarRef.current?.contains(event.target as Node)) return
    // 必须落在正文里，否则保留浏览器原生右键菜单（拼写检查等）。
    const editorEl = getEditorElement?.()
    if (!editorEl || !editorEl.contains(event.target as Node)) return
    event.preventDefault()
    const text = getSelectedText()
    const rect = getSelectionRect()
    rangeRef.current = captureSelectionRange?.() ?? null
    setPosition(rect
      ? { top: rect.top - 45, left: rect.left + rect.width / 2 }
      : { top: event.clientY + 12, left: event.clientX })
    setSelectedText(text)
    setResult(null)
    setPinned(false)
    setCopied(false)
    setClipboardHint(null)
    setVisible(true)
  }, [getSelectedText, getSelectionRect, captureSelectionRange, getEditorElement])

  useEffect(() => {
    document.addEventListener('contextmenu', handleContextMenu)
    return () => document.removeEventListener('contextmenu', handleContextMenu)
  }, [handleContextMenu])

  /**
   * 钉住时任何点击都不关；未钉住时点击窗格外关闭（点窗内不关，否则没法复制）。
   * 只做状态复位，不调 close()，以免把 ai 对象带进依赖数组导致每次渲染重绑定监听。
   */
  useEffect(() => {
    if (!visible || pinned) return
    const onPointerDown = (event: MouseEvent) => {
      if (toolbarRef.current?.contains(event.target as Node)) return
      rangeRef.current = null
      setVisible(false)
      setResult(null)
      setCopied(false)
      setClipboardHint(null)
      aiRef.current?.reset()
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [visible, pinned])

  function close() {
    setVisible(false)
    setResult(null)
    setPinned(false)
    setCopied(false)
    setClipboardHint(null)
    rangeRef.current = null
    ai.reset()
  }

  const handleAction = async (action: ActionType) => {
    if (!selectedText) return
    let messages: ChatMessage[]

    switch (action) {
      case 'polish':
        if (onPolish) { onPolish(selectedText, rangeRef.current); return }
        messages = buildPolishPrompt(selectedText, '优化文笔，使表达更生动优美')
        break
      case 'expand':
        if (onExpand) { onExpand(selectedText, rangeRef.current); return }
        messages = buildExpandPrompt(selectedText)
        break
      case 'condense':
        messages = [
          { role: 'system', content: '你是一位精炼文字的编辑。请在保留核心意思的前提下，将以下文字压缩到原来的 60-70% 长度。直接输出结果。' },
          { role: 'user', content: selectedText },
        ]
        break
      case 'rewrite':
        messages = [
          { role: 'system', content: '你是一位创意写作者。请用完全不同的表达方式改写以下文字，保留核心意思但换种写法。直接输出结果。' },
          { role: 'user', content: selectedText },
        ]
        break
      case 'check':
        messages = [
          { role: 'system', content: '你是一位严谨的审稿编辑。请检查以下文字中的问题（逻辑矛盾、用词不当、语法错误、前后不一致等）。用简短的列表指出问题，如果没有问题就说"未发现问题"。' },
          { role: 'user', content: selectedText },
        ]
        break
    }

    const output = await ai.start(messages, undefined, { category: 'chapter.toolbar' })
    if (output) setResult(output)
  }

  const handleAccept = () => {
    if (!result) return
    const range = rangeRef.current
    // 优先按捕获范围精确回填；范围失效则退回编辑器当前选区。
    if (range && replaceRange?.(range.from, range.to, textToHtml(result))) {
      close()
      return
    }
    replaceSelectedText(result)
    close()
  }

  const handleCopy = async () => {
    if (!result) return
    // 写不进去（无权限/旧内核）时不显示「已复制」，不谎报成功。
    if (await writeClipboardText(result)) setCopied(true)
  }

  /** 剪贴板动作成功后按右键菜单习惯关闭（失败路径改为原地提示，不关窗）。 */
  const handleCopySelection = async () => {
    if (!selectedText) return
    if (!await writeClipboardText(selectedText)) {
      setClipboardHint('浏览器未授权剪贴板，请按 Ctrl/⌘+C 复制')
      return
    }
    close()
  }

  const handleCutSelection = async () => {
    if (!selectedText) return
    const range = rangeRef.current
    if (!range) {
      setClipboardHint('没有可剪切的选区，请重新划选')
      return
    }
    if (!await writeClipboardText(selectedText)) {
      setClipboardHint('浏览器未授权剪贴板，剪切已取消')
      return
    }
    if (!deleteRange?.(range.from, range.to)) {
      setClipboardHint('选区已失效，已复制但未删除，请重新划选')
      return
    }
    close()
  }

  const handlePaste = async () => {
    const text = await readClipboardText()
    if (!text) {
      setClipboardHint('读不到剪贴板内容，请按 Ctrl/⌘+V 粘贴')
      return
    }
    const range = rangeRef.current
    // 有捕获选区时按范围替换（保证粘到右键时选中的位置），否则插到编辑器当前光标处。
    if (!range || !replaceRange?.(range.from, range.to, textToHtml(text))) {
      replaceSelectedText(text)
    }
    close()
  }

  const hasSelection = selectedText.length > 0
  const aiEligible = !disabled && selectedText.length > AI_MIN_CHARS && selectedText.length < AI_MAX_CHARS

  if (!visible) return null

  return (
    <div
      ref={toolbarRef}
      className="fixed z-50 transform -translate-x-1/2"
      style={{ top: `${Math.max(8, position.top)}px`, left: `${position.left}px` }}
    >
      {/* 右键菜单：剪贴板行固定，AI 行按选区长度与生成状态决定 */}
      {!result && !ai.isStreaming && (
        <div className="bg-bg-elevated border border-border rounded-lg shadow-lg">
          <div className="flex items-center gap-0.5 px-1 py-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void handleCopySelection() }}
              disabled={!hasSelection}
              title={hasSelection ? '复制选中文字' : '先划选要复制的文字'}
              icon={<Copy />}
            >
              复制
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void handleCutSelection() }}
              disabled={!hasSelection}
              title={hasSelection ? '剪切选中文字' : '先划选要剪切的文字'}
              icon={<Scissors />}
            >
              剪切
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { void handlePaste() }}
              title="粘贴到光标处"
              icon={<ClipboardPaste />}
            >
              粘贴
            </Button>
            <Button variant="ghost" size="sm" iconOnly onClick={close} title="关闭">
              <X />
            </Button>
          </div>

          {aiEligible ? (
            <div className="flex items-center gap-0.5 border-t border-border/60 px-1 py-0.5">
              {ACTIONS.map(({ type, icon: Icon, label }) => (
                <Button
                  key={type}
                  variant="ghost"
                  size="sm"
                  onClick={() => handleAction(type)}
                  title={label}
                  icon={<Icon />}
                >
                  {label}
                </Button>
              ))}
            </div>
          ) : (
            <div className="border-t border-border/60 px-2 py-1 text-[10px] text-text-muted">
              {disabled
                ? 'AI 处理中，完成后可用润色 / 扩写'
                : `划选 ${AI_MIN_CHARS + 1} 字以上正文后可用 AI 润色 / 扩写`}
            </div>
          )}

          {clipboardHint && (
            <div className="border-t border-border/60 px-2 py-1 text-[10px] text-text-muted">{clipboardHint}</div>
          )}
        </div>
      )}

      {/* AI 生成中 */}
      {ai.isStreaming && (
        <div className="bg-bg-elevated border border-accent/30 rounded-lg shadow-lg px-3 py-2 min-w-[200px]">
          <div className="flex items-center gap-2 text-xs text-accent">
            <Loader2 className="w-3 h-3 animate-spin" />
            AI 处理中...
          </div>
          {ai.output && (
            <p className="mt-1 text-xs text-text-secondary max-h-20 overflow-y-auto whitespace-pre-wrap">
              {ai.output.slice(0, 200)}{ai.output.length > 200 ? '...' : ''}
            </p>
          )}
        </div>
      )}

      {/* 结果展示：可选中复制、可钉住保留 */}
      {result && !ai.isStreaming && (
        <div className="bg-bg-elevated border border-border rounded-lg shadow-lg p-3 w-[26rem] max-w-[90vw]">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="text-[10px] text-text-muted">AI 结果</span>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="xs"
                iconOnly
                onClick={() => setPinned(v => !v)}
                title={pinned ? '取消保留（点外部即关闭）' : '保留此窗口（点外部不关闭）'}
                pressed={pinned}
              >
                <Pin />
              </Button>
              <Button variant="ghost" size="xs" iconOnly onClick={close} title="关闭">
                <X />
              </Button>
            </div>
          </div>
          <p className="mb-2 max-h-64 select-text cursor-text overflow-y-auto whitespace-pre-wrap text-xs text-text-primary">
            {result}
          </p>
          {ai.tokenUsage && (
            <p className="mb-2 text-[10px] text-text-muted">
              Token: ↑{ai.tokenUsage.inputTokens.toLocaleString()} ↓{ai.tokenUsage.outputTokens.toLocaleString()}
            </p>
          )}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="xs" onClick={handleAccept} icon={<Check />}>
              替换
            </Button>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => { void handleCopy() }}
              icon={copied ? <Check /> : <Copy />}
            >
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
