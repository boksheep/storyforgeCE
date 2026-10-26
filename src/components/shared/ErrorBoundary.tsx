import { Component, type ReactNode, type ErrorInfo } from 'react'
import { AlertTriangle, Download, RefreshCw } from 'lucide-react'
import { Button } from './Button'
import { recordRuntimeDiagnosticError } from '../../lib/diagnostics/local-diagnostic-report'
import { logEvent } from '../../lib/logging/logger'
import { buildErrorDiagnosticBundle } from '../../lib/diagnostics/error-bundle'
import { explainCommonError } from '../../lib/diagnostics/error-guide'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
  bundleJson: string | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null, bundleJson: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, bundleJson: null }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    recordRuntimeDiagnosticError(error, 'react')
    logEvent({
      level: 'error',
      tag: 'ErrorBoundary',
      event: 'errorboundary',
      message: '[StoryForge ErrorBoundary]',
      meta: { componentFrames: errorInfo.componentStack?.split('\n').filter(Boolean).length ?? 0 },
      error,
    })
    void buildErrorDiagnosticBundle(error).then(bundle => {
      const json = JSON.stringify(bundle, null, 2)
      this.setState(current => current.error === error ? { bundleJson: json } : null)
      logEvent({ level: 'info', tag: 'ErrorBoundary', event: 'errorbundle.ready',
        message: '本地诊断包已生成', meta: { logCount: bundle.todayLogs.length, operationCount: bundle.recentOperations.length } })
    }).catch(() => {
      // 诊断失败不能覆盖原始错误界面；重试仍可用。
      logEvent({ level: 'warn', tag: 'ErrorBoundary', event: 'errorbundle.failed', message: '本地诊断包生成失败' })
    })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, bundleJson: null })
  }

  handleDownload = () => {
    if (!this.state.bundleJson) return
    const url = URL.createObjectURL(new Blob([this.state.bundleJson], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = `storyforge-error-${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback
      const guide = explainCommonError(this.state.error)

      return (
        <div className="flex flex-col items-center justify-center min-h-[300px] p-8 text-center">
          <AlertTriangle className="w-12 h-12 text-warning mb-4" />
          <h2 className="text-lg font-bold text-text-primary mb-2">出了点问题 😅</h2>
          <p className="text-sm text-text-muted mb-2 max-w-md">
            {guide?.explanation ?? this.state.error?.message ?? '发生了未知错误'}
          </p>
          {guide && <p className="text-xs text-text-muted mb-4 max-w-md">{guide.selfCheck}</p>}
          <div className="flex items-center gap-2">
            <Button variant="primary" size="md" onClick={this.handleReset} data-operation="error.retry">
              <RefreshCw /> 重试
            </Button>
            <Button variant="secondary" size="md" iconOnly onClick={this.handleDownload}
              disabled={!this.state.bundleJson} aria-label="下载诊断包" title={this.state.bundleJson ? '下载诊断包' : '正在整理诊断包'}
              data-operation="error.download-diagnostics">
              <Download />
            </Button>
          </div>
          <p className="text-xs text-text-muted mt-2">诊断包只保存在本机，由你决定是否分享；不包含正文或输入内容。</p>
        </div>
      )
    }

    return this.props.children
  }
}
