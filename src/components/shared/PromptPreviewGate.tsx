import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Eye, ListChecks, RotateCcw, Send } from 'lucide-react'
import { estimateTokens } from '../../lib/ai/context-budget'
import type { ChatMessage } from '../../lib/types'
import { Button } from './Button'

interface Props {
  messages: ChatMessage[]
  onBack: () => void
  onConfirm: (messages: ChatMessage[]) => void
  backLabel?: string
  /**
   * PROMPT-PLAN-2：这次请求**具体点了哪些字段**（由 `PlanRequestedFields` 渲染）。
   * 只有走生成前协商的流程才传；不传时预览与以前完全一致（大纲等流程不受影响）。
   */
  requestedFields?: ReactNode
}

const ROLE_LABEL: Record<ChatMessage['role'], string> = {
  system: 'System Prompt',
  user: 'User Prompt',
  assistant: 'Assistant 上文',
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(message => ({ ...message }))
}

/**
 * PIPELINE-1 最终消息闸门。草稿仅存在于组件 state，关闭或重新发起请求即丢弃。
 */
export default function PromptPreviewGate({
  messages,
  onBack,
  onConfirm,
  backLabel = '返回生成依据',
  requestedFields,
}: Props) {
  const [draft, setDraft] = useState(() => cloneMessages(messages))
  useEffect(() => {
    setDraft(cloneMessages(messages))
  }, [messages])
  const originalTokens = useMemo(
    () => messages.reduce((sum, message) => sum + estimateTokens(message.content), 0),
    [messages],
  )
  const draftTokens = draft.reduce(
    (sum, message) => sum + estimateTokens(message.content),
    0,
  )
  const valid = draft.length > 0 && draft.every(message => message.content.trim())

  const updateContent = (index: number, content: string) => {
    setDraft(current => current.map((message, messageIndex) => (
      messageIndex === index ? { ...message, content } : message
    )))
  }

  return (
    <div className="space-y-3" data-testid="prompt-preview-gate">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2 text-xs font-medium text-text-primary">
            <Eye className="h-3.5 w-3.5 text-accent" />
            最终发送内容
          </div>
          <p className="mt-1 text-[10px] leading-4 text-text-muted">
            这里是模板、参数和作品上下文拼接后的真实消息。修改只影响本次调用，不写回模板或作品资料。
          </p>
        </div>
        <span className="text-[10px] tabular-nums text-text-muted">
          约 {draftTokens.toLocaleString()} tokens
          {draftTokens !== originalTokens && `（原 ${originalTokens.toLocaleString()}）`}
        </span>
      </div>

      {/* PROMPT-PLAN-2：具体请求字段与最终提示词放在同一屏，作者不必两个界面来回对照。 */}
      {requestedFields && (
        <div className="space-y-1">
          <div className="flex items-center gap-1 text-[10px] font-medium text-text-secondary">
            <ListChecks className="h-3 w-3 text-accent" />本次请求的具体字段
          </div>
          {requestedFields}
        </div>
      )}

      <div className="max-h-[28rem] space-y-3 overflow-auto pr-1">
        {draft.map((message, index) => (          <label key={`${message.role}-${index}`} className="block space-y-1">
            <span className="text-[10px] font-medium text-text-secondary">
              {ROLE_LABEL[message.role]}
            </span>
            <textarea
              aria-label={`${ROLE_LABEL[message.role]} ${index + 1}`}
              value={message.content}
              onChange={event => updateContent(index, event.target.value)}
              rows={message.role === 'system' ? 8 : 14}
              className="w-full resize-y rounded border border-border bg-bg-base px-2.5 py-2 font-mono text-[11px] leading-5 text-text-primary focus:border-accent focus:outline-none"
            />
          </label>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setDraft(cloneMessages(messages))}
          icon={<RotateCcw />}
        >
          还原拼接结果
        </Button>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={onBack}
          >
            {backLabel}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!valid}
            onClick={() => onConfirm(cloneMessages(draft))}
            icon={<Send />}
          >
            发送本次版本
          </Button>
        </div>
      </div>
    </div>
  )
}
