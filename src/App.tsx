import { lazy, Suspense } from 'react'
import { Routes, Route } from 'react-router'
import HomePage from './pages/HomePage'
import SettingsRoutePage from './pages/SettingsRoutePage'

const WorkspacePage = lazy(() => import('./pages/WorkspacePage'))

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/settings" element={<SettingsRoutePage />} />
      <Route path="/workspace/:projectId" element={<Suspense fallback={<div className="p-6 text-sm text-text-muted">工作区加载中…</div>}><WorkspacePage /></Suspense>} />
    </Routes>
  )
}
