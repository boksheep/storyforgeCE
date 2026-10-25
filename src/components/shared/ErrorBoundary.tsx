import { Component, type ReactNode, type ErrorInfo } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { Button } from './Button'
import { recordRuntimeDiagnosticError } from '../../lib/diagnostics/local-diagnostic-report'
import { logEvent } from '../../lib/logging/logger'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
  error: Error | null
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    recordRuntimeDiagnosticError(error, 'react')
    logEvent({
      level: 'error',
      tag: 'ErrorBoundary',
      event: 'errorboundary',
      message: '[StoryForge ErrorBoundary]',
      meta: { componentStack: errorInfo.componentStack },
      error,
    })
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback

      return (
        <div className="flex flex-col items-center justify-center min-h-[300px] p-8 text-center">
          <AlertTriangle className="w-12 h-12 text-warning mb-4" />
          <h2 className="text-lg font-bold text-text-primary mb-2">出了点问题 😅</h2>
          <p className="text-sm text-text-muted mb-4 max-w-md">
            {this.state.error?.message || '发生了未知错误'}
          </p>
          <Button variant="primary" size="md" onClick={this.handleReset}>
            <RefreshCw /> 重试
          </Button>
        </div>
      )
    }

    return this.props.children
  }
}
