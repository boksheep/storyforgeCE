import { lazy, Suspense } from 'react'
import { useNavigate } from 'react-router'
import { ArrowLeft } from 'lucide-react'
import { Button } from '../components/shared/Button'

const SettingsPage = lazy(() => import('../components/settings/SettingsPage'))

export default function SettingsRoutePage() {
  const navigate = useNavigate()

  return (
    <div className="min-h-screen bg-bg-base">
      <header className="border-b border-border px-6 py-3 flex items-center gap-3">
        <Button
          variant="ghost"
          size="md"
          iconOnly
          onClick={() => navigate('/')}
          title="返回首页"
        >
          <ArrowLeft />
        </Button>
        <div>
          <h1 className="text-base font-semibold text-text-primary">设置</h1>
          <p className="text-xs text-text-muted">配置 AI 服务商、模型和本地偏好。</p>
        </div>
      </header>
      <Suspense fallback={<div className="p-6 text-sm text-text-muted">设置加载中…</div>}>
        <SettingsPage />
      </Suspense>
    </div>
  )
}
