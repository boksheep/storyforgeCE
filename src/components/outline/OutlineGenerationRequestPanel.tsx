import type { PreparedGenerationContext, OutlineGenerationRequest } from '../../lib/outline/generation-request'
import type { ChatMessage } from '../../lib/types'
import PromptPreviewGate from '../shared/PromptPreviewGate'
import OutlineGenerationBasis from './OutlineGenerationBasis'

interface Props {
  request: OutlineGenerationRequest
  preparedContext: PreparedGenerationContext | null
  loading: boolean
  error: string
  onRetry: () => void
  onCancel: () => void
  onConfirm: () => void
  messages?: ChatMessage[] | null
  transparentMode?: boolean
  promptReviewOpen?: boolean
  onTransparentModeChange?: (enabled: boolean) => void
  onClosePromptReview?: () => void
  onConfirmMessages?: (messages: ChatMessage[]) => void
}

function requestTitle(request: OutlineGenerationRequest): string {
  if (request.kind === 'volumes') return '批量生成卷级大纲'
  if (request.kind === 'chapters') return '生成本卷所有章节'
  if (request.kind === 'chapters-optimize') return '优化扩展全卷章纲'
  if (request.kind === 'single-volume') return 'AI 生成本卷卷纲'
  return 'AI 生成本章章纲'
}

export default function OutlineGenerationRequestPanel({
  request,
  preparedContext,
  loading,
  error,
  onRetry,
  onCancel,
  onConfirm,
  messages = null,
  transparentMode = false,
  promptReviewOpen = false,
  onTransparentModeChange,
  onClosePromptReview,
  onConfirmMessages,
}: Props) {
  if (promptReviewOpen && messages && onClosePromptReview && onConfirmMessages) {
    return (
      <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-3">
        <PromptPreviewGate
          messages={messages}
          onBack={onClosePromptReview}
          onConfirm={onConfirmMessages}
        />
      </div>
    )
  }

  return (
    <div className="space-y-3 rounded-lg border border-accent/30 bg-accent/5 px-3 py-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="text-xs leading-5 text-text-secondary">
          <span className="font-medium text-text-primary">{requestTitle(request)}</span>
          <span className="ml-2">
            {request.kind === 'single-chapter'
              ? '单章补全固定只生成当前 1 章；上方“本卷章节数”不参与本次调用。确认后才会调用 API。'
              : '请先调整上方参数，确认后才会调用 API。'}
          </span>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          {error && (
            <button
              onClick={onRetry}
              className="px-2.5 py-1 text-xs text-accent border border-accent/30 rounded hover:bg-accent/10"
            >
              重新读取
            </button>
          )}
          <button
            onClick={onCancel}
            className="px-2.5 py-1 text-xs text-text-muted border border-border rounded hover:text-text-primary"
          >
            取消
          </button>
          <button
            onClick={onConfirm}
            disabled={loading || Boolean(error) || !preparedContext}
            className="px-2.5 py-1 text-xs text-white bg-accent rounded hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {transparentMode ? '预览最终提示词' : '确认生成'}
          </button>
        </div>
      </div>
      <label className="flex cursor-pointer items-start gap-2 rounded border border-border/70 bg-bg-base/60 px-2.5 py-2 text-xs">
        <input
          type="checkbox"
          checked={transparentMode}
          onChange={event => onTransparentModeChange?.(event.target.checked)}
          className="mt-0.5 accent-accent"
        />
        <span>
          <span className="font-medium text-text-secondary">透明模式（高级）</span>
          <span className="ml-2 text-[10px] text-text-muted">
            发送前查看并临时编辑拼接后的最终消息；默认关闭，本次编辑不会保存。
          </span>
        </span>
      </label>
      <div className="border-t border-accent/20 pt-3">
        <OutlineGenerationBasis
          context={preparedContext?.assembled ?? null}
          loading={loading}
          error={error}
        />
      </div>
    </div>
  )
}
