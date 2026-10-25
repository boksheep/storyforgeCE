import { useEffect, useRef, useState } from 'react'
import { CheckCircle, Download, Eye, FileText, RefreshCw, Trash2 } from 'lucide-react'
import {
  clearContextMemo,
  downloadContextSnapshot,
  generateContextSnapshot,
  loadContextMemo,
  saveContextMemo,
} from '../../lib/export/context-snapshot'
import { Button } from '../shared/Button'
import { SaveStateIcon, saveFeedbackState, useSaveSuccessFeedback } from '../shared/SaveSuccessFeedback'
import { useToast } from '../shared/Toast'

interface Props {
  projectId: number
  projectName: string
}

export default function ContextMemoCard({ projectId, projectName }: Props) {
  const [memo, setMemo] = useState<string | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const saveFeedback = useSaveSuccessFeedback()
  const toast = useToast()
  const generationRef = useRef(0)

  useEffect(() => {
    generationRef.current += 1
    setGenerating(false)
    setPreview(null)
    setError(null)
    setMemo(null)
    try {
      const saved = loadContextMemo(projectId)
      setMemo(saved)
      setPreview(saved)
    } catch (cause) {
      setError(`读取本地上下文快照失败：${errorMessage(cause)}`)
    }
    return () => { generationRef.current += 1 }
  }, [projectId])

  const handleGenerate = async () => {
    const requestId = ++generationRef.current
    setGenerating(true)
    setError(null)
    try {
      const text = await generateContextSnapshot(projectId)
      if (requestId !== generationRef.current) return
      setPreview(text)
      toast.success('上下文快照已生成，可预览后保存')
    } catch (cause) {
      if (requestId === generationRef.current) {
        setError(`生成上下文快照失败：${errorMessage(cause)}`)
        toast.error(`生成上下文快照失败：${errorMessage(cause)}`)
      }
    } finally {
      if (requestId === generationRef.current) setGenerating(false)
    }
  }

  const handleSave = () => {
    if (!preview) return
    try {
      saveContextMemo(projectId, preview)
      setMemo(preview)
      setError(null)
      saveFeedback.markSuccess()
      toast.success('上下文快照已保存，并将用于后续 AI 上下文')
    } catch (cause) {
      const message = `保存上下文快照失败：${errorMessage(cause)}`
      setError(message)
      toast.error(message)
    }
  }

  const handleClear = () => {
    try {
      clearContextMemo(projectId)
      setMemo(null)
      setError(null)
      toast.success('已清除本地上下文快照')
    } catch (cause) {
      const message = `清除上下文快照失败：${errorMessage(cause)}`
      setError(message)
      toast.error(message)
    }
  }

  const handleDownload = () => {
    if (!preview) return
    try {
      downloadContextSnapshot(preview, projectName)
      toast.success('上下文快照已下载')
    } catch (cause) {
      const message = `下载上下文快照失败：${errorMessage(cause)}`
      setError(message)
      toast.error(message)
    }
  }

  const saveState = saveFeedbackState(saveFeedback.succeeded, false)

  return (
    <section className="bg-bg-surface border border-border rounded-lg p-5 space-y-3" aria-labelledby="context-memo-title">
      <div className="flex items-center gap-2">
        <FileText className="w-5 h-5 text-accent" aria-hidden="true" />
        <h3 id="context-memo-title" className="text-sm font-semibold text-text-primary">项目上下文快照</h3>
      </div>
      <p className="text-xs text-text-muted">快照不会随作品修改自动更新；内容可能受上下文预算裁剪。保存后在后续正文生成读取上下文快照时注入，作品有变化请重新生成并保存。</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="md" onClick={handleGenerate} loading={generating} loadingText="生成中…" icon={<RefreshCw />}>
          生成快照
        </Button>
        <Button
          variant="success"
          size="md"
          onClick={handleSave}
          disabled={!preview}
          data-save-state={saveState}
          icon={<SaveStateIcon state={saveState} idle={<CheckCircle />} successClassName="text-white" />}
        >
          保存到本机
        </Button>
        <Button variant="secondary" size="md" onClick={handleDownload} disabled={!preview} icon={<Download />}>
          下载 Markdown
        </Button>
        <Button variant="danger-soft" size="md" onClick={handleClear} disabled={!memo} icon={<Trash2 />}>
          清除本地快照
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs" role="status" aria-live="polite">
        {memo ? <CheckCircle className="w-4 h-4 text-success" aria-hidden="true" /> : <Eye className="w-4 h-4 text-text-muted" aria-hidden="true" />}
        <span className={memo ? 'text-success' : 'text-text-muted'}>
          {memo ? `已保存到本机（${memo.length.toLocaleString()} 字）` : preview ? '当前预览尚未保存到本机；保存后才会用于 AI 上下文' : '尚无本地保存的上下文快照'}
        </span>
      </div>
      {error && <p role="alert" className="text-sm text-error">{error}</p>}
      {preview !== null && (
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-text-secondary">快照预览{memo === preview ? '（与本地保存版本一致）' : '（尚未保存）'}</h4>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-bg-base p-3 text-xs leading-relaxed text-text-secondary">{preview}</pre>
        </div>
      )}
    </section>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
