import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router'
import HomePage from './pages/HomePage'
import SettingsRoutePage from './pages/SettingsRoutePage'
import { useCloudDialog } from './stores/cloud-dialog'

const WorkspacePage = lazy(() => import('./pages/WorkspacePage'))
/**
 * 云数据库弹窗按需加载：它只在用户真的点开时才需要，
 * 静态引进入口会让"从不用云端的用户"也背上这份代码。
 * 按钮在 hover / focus 时会预热这个 chunk（见 CloudAccountButton）。
 */
const CloudAccountDialog = lazy(() => import('./components/cloud/CloudAccountDialog'))

export default function App() {
  const cloudDialogOpen = useCloudDialog(state => state.open)

  return (
    <>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/settings" element={<SettingsRoutePage />} />
        <Route path="/workspace/:projectId" element={<Suspense fallback={<div className="p-6 text-sm text-text-muted">工作区加载中…</div>}><WorkspacePage /></Suspense>} />
      </Routes>
      {/*
        云数据库弹窗**全局只挂一份**：触发点有四个（首页顶栏 / 工作区顶栏 /
        数据管理卡片 / 设置区菜单），各自挂一份会叠出多个遮罩，
        而且 Escape 只会关掉最上面那个。开关状态在 `useCloudDialog`。
      */}
      {cloudDialogOpen && (
        <Suspense fallback={null}>
          <CloudAccountDialog />
        </Suspense>
      )}
    </>
  )
}
