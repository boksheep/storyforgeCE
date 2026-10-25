import { Columns2, Eye, Save } from 'lucide-react'
import type { ChapterStatus } from '../../lib/types'
import { Button } from '../shared/Button'

const STATUS_OPTIONS: { value: ChapterStatus; label: string }[] = [
  { value: 'outline', label: '仅大纲' },
  { value: 'draft', label: '初稿' },
  { value: 'revised', label: '已修改' },
  { value: 'polished', label: '已润色' },
  { value: 'final', label: '定稿' },
]

const STATUS_STYLE: Record<ChapterStatus, string> = {
  outline: 'bg-bg-elevated text-text-muted',
  draft: 'bg-warning/10 text-warning',
  revised: 'bg-info/10 text-info',
  polished: 'bg-accent/10 text-accent',
  final: 'bg-success/10 text-success',
}

const STATUS_OPTION_STYLE = 'bg-bg-surface text-text-primary'

interface Props {
  title: string
  wordCount: number
  /** 平均码字速度（字/分，已剔除空闲时间） */
  typingSpeed: number
  /** 累计有效打字时长（已格式化） */
  typingDuration: string
  status: ChapterStatus
  showContext: boolean
  canCompare: boolean
  saveDisabled: boolean
  saving: boolean
  saveError: string
  isSaved: boolean
  onStatusChange: (status: ChapterStatus) => void
  onToggleContext: () => void
  onOpenCompare: () => void
  onSave: () => void
}

export default function ChapterEditorHeader({
  title,
  wordCount,
  typingSpeed,
  typingDuration,
  status,
  showContext,
  canCompare,
  saveDisabled,
  saving,
  saveError,
  isSaved,
  onStatusChange,
  onToggleContext,
  onOpenCompare,
  onSave,
}: Props) {
  return (
    <div className="flex items-center justify-between px-6 py-3">
      <div className="flex items-center gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-[0.18em] text-text-muted">
            创作区 · 正文
          </p>
          <h2 className="font-serif text-xl font-semibold text-text-primary">{title}</h2>
        </div>
        <span className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-xs text-text-muted">
          {wordCount.toLocaleString()} 字
        </span>
        <span
          className="rounded-full border border-border bg-bg-elevated px-2.5 py-1 text-xs text-text-muted"
          title="按活动输入时间计算，空闲超过 8 秒不计时"
        >
          {typingSpeed.toLocaleString()} 字/分 · {typingDuration}
        </span>
        <select
          aria-label="章节状态"
          value={status}
          onChange={event => onStatusChange(event.target.value as ChapterStatus)}
          title="章节状态会决定该章是否可用于文风学习"
          className={`text-xs px-2 py-1 rounded border border-transparent focus:outline-none focus:border-accent cursor-pointer ${STATUS_STYLE[status]}`}
        >
          {STATUS_OPTIONS.map(option => (
            <option key={option.value} value={option.value} className={STATUS_OPTION_STYLE}>{option.label}</option>
          ))}
        </select>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleContext}
          pressed={showContext}
          icon={<Eye />}
        >
          上下文
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenCompare}
          disabled={!canCompare}
          icon={<Columns2 />}
        >
          对照润色
        </Button>
        <Button
          variant={saveError ? 'danger-soft' : isSaved ? 'success-soft' : 'ghost'}
          size="sm"
          onClick={onSave}
          disabled={saveDisabled}
          loading={saving}
          loadingText="保存中..."
          title={saveError ? `保存失败：${saveError}` : undefined}
          icon={<Save />}
        >
          {saveError ? '保存失败' : isSaved ? '已保存' : '保存'}
        </Button>
      </div>
    </div>
  )
}
