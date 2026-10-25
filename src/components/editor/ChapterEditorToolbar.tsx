import { BookOpenCheck, ClipboardList, Plus, ShieldCheck, StickyNote } from 'lucide-react'
import { Button } from '../shared/Button'
import { Spinner } from '../shared/Spinner'
import { CInput } from '../shared/CompositionInput'

interface Props {
  isStreaming: boolean
  /**
   * 生成在途（含"点击后到第一个 token 到达之间"的装配窗口）。
   * 只靠 `isStreaming` 挡不住装配窗口里的重复点击 —— 第二次生成会把第一次 abort 掉，
   * 未采纳的文本随之清空（真实事故：45 秒的生成被误点取代）。
   */
  generationBusy: boolean
  hasText: boolean
  organizingChapter: boolean
  hasOrganizationCandidate: boolean
  analyzingImpact: boolean
  impactInfo: string | null
  hasOutline: boolean
  showOutlinePreview: boolean
  showReviewPanel: boolean
  consistencyAlertCount: number
  showNotePanel: boolean
  addingNote: boolean
  customInstruction: string
  onGenerate: () => void
  onContinue: () => void
  onExpand: () => void
  onPolish: () => void
  onDeAI: () => void
  onOrganizeChapter: () => void
  onAnalyzeImpact: () => void
  onDismissImpact: () => void
  onToggleOutlinePreview: () => void
  onToggleReviewPanel: () => void
  onToggleNotePanel: () => void
  onAddNote: () => void
  onCustomInstructionChange: (value: string) => void
}

export default function ChapterEditorToolbar({
  isStreaming,
  generationBusy,
  hasText,
  organizingChapter,
  hasOrganizationCandidate,
  analyzingImpact,
  impactInfo,
  hasOutline,
  showOutlinePreview,
  showReviewPanel,
  consistencyAlertCount,
  showNotePanel,
  addingNote,
  customInstruction,
  onGenerate,
  onContinue,
  onExpand,
  onPolish,
  onDeAI,
  onOrganizeChapter,
  onAnalyzeImpact,
  onDismissImpact,
  onToggleOutlinePreview,
  onToggleReviewPanel,
  onToggleNotePanel,
  onAddNote,
  onCustomInstructionChange,
}: Props) {
  /**
   * 保持最朴素的设计：按钮只做它自己的事，**在跑时统一禁用**。
   *
   * 「哪个动作在跑 / 取消生成 / 用哪个模型」全部由屏幕底部那条悬浮状态条承担
   * （作者要求：既然有悬浮条，工具栏就不需要那套圆环与取消按钮了 ——
   * 而且它曾在切章后没恢复，因为工具栏拿的是"在途闸门"而不是"真在跑"）。
   */
  const busy = isStreaming || generationBusy

  return (
    <div className="flex flex-wrap gap-2 border-t border-border/60 bg-bg-surface/35 px-6 py-3">
      <Button variant="outline" size="sm" onClick={onGenerate} disabled={busy}>
        ✨ 生成正文
      </Button>
      <Button variant="secondary" size="sm" onClick={onContinue} disabled={busy || !hasText}>
        📝 续写
      </Button>
      <Button variant="secondary" size="sm" onClick={onExpand} disabled={busy}>
        📖 扩写
      </Button>
      <Button variant="secondary" size="sm" onClick={onPolish} disabled={busy}>
        💎 润色
      </Button>
      <Button variant="secondary" size="sm" onClick={onDeAI} disabled={busy}>
        🔥 去AI味
      </Button>
      {/* 整理在途时这个按钮是「取消」而不是「加载中」：必须保持可点，
          所以走 icon 而不是 loading（loading 会自动 disabled，切断 abort 路径） */}
      <Button variant="success-soft" size="sm"
        onClick={onOrganizeChapter}
        disabled={isStreaming || generationBusy || !hasText}
        title="一次分析本章，生成状态、事实、物品、年表、关系和伏笔候选；确认前不会写入项目"
        icon={organizingChapter ? <Spinner /> : <ClipboardList />}>
        {organizingChapter ? '停止整理' : hasOrganizationCandidate ? '查看整理结果' : '整理本章'}
      </Button>
      <Button variant="warning-soft" size="sm"
        onClick={onAnalyzeImpact}
        disabled={!hasText}
        loading={analyzingImpact}
        loadingText="分析中..."
        title="NS-6：改了历史章后，检查源自本章的事实证据是否失效（失效则降级待复核），并列出需复核的后续章节。不会自动改正文。"
        icon={<ClipboardList />}>
        影响分析
      </Button>
      {impactInfo && (
        <span className="flex items-center gap-2 px-2 py-1 text-xs text-amber-300/90 bg-amber-500/5 rounded-md">
          {impactInfo}
          <Button variant="ghost" size="xs" iconOnly onClick={onDismissImpact} aria-label="关闭影响分析结果">×</Button>
        </span>
      )}
      {hasOutline && (
        <Button variant="secondary" size="sm"
          onClick={onToggleOutlinePreview}
          title="大纲预览"
          pressed={showOutlinePreview}
          icon={<BookOpenCheck />}>
          大纲预览
        </Button>
      )}
      <Button variant="secondary" size="sm"
        onClick={onToggleReviewPanel}
        disabled={!hasText}
        title="质量审校"
        pressed={showReviewPanel}
        icon={<ShieldCheck />}>
        质量审校
        {consistencyAlertCount > 0 && (
          <span className="min-w-4 rounded-full bg-error/15 px-1 text-center text-[10px] text-error">
            {consistencyAlertCount}
          </span>
        )}
      </Button>
      <Button variant="secondary" size="sm"
        onClick={onToggleNotePanel}
        title="便签"
        pressed={showNotePanel}
        icon={<StickyNote />}>
        便签
      </Button>
      <Button variant="secondary" size="sm" onClick={onAddNote} loading={addingNote}
        title="在当前正文位置新建便签" icon={<Plus />}>
        新建便签
      </Button>
      <CInput value={customInstruction} onChange={event => onCustomInstructionChange(event.target.value)}
        placeholder="自定义指令..."
        className="min-w-[220px] flex-1 rounded-md border border-border bg-bg-elevated px-3 py-1.5 text-xs text-text-primary focus:outline-none focus:border-accent" />
    </div>
  )
}
