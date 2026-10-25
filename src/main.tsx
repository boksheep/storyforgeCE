import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import App from './App'
import ErrorBoundary from './components/shared/ErrorBoundary'
import { DialogProvider } from './components/shared/Dialog'
import { ToastProvider } from './components/shared/Toast'
import { PersistentTaskProvider } from './components/shared/PersistentTaskStatusBar'
import { usePromptStore } from './stores/prompt'
import { useWorkflowStore } from './stores/workflow'
import { ensureSchema, REQUIRED_TABLES } from './lib/db/ensure-schema'
import { validateRegistry } from './lib/registry/validate'
import { db, SCHEMA_VERSION } from './lib/db/schema'
import { finalizeCharacterAxesMigrationSnapshots } from './lib/migrations/finalize-character-axes-snapshots'
import { autoHealEmptyDatabase } from './lib/safety/auto-heal'
import { applyStoryForgeTheme, resolveStoryForgeTheme } from './lib/theme'
import { registerStoryForgeServiceWorker } from './lib/pwa/register-service-worker'
import { resolveRouterBasename } from './lib/deploy/app-base'
import { APP_BUILD_ID } from './lib/version'
import { installRuntimeDiagnostics } from './lib/diagnostics/local-diagnostic-report'
import { loadLogSettings } from './lib/logging/log-settings'
import { log, logEvent, setLogLevel, setLoggingEnabled } from './lib/logging/logger'
import './index.css'

// 从 localStorage 恢复主题（兼容旧主题名迁移）
applyStoryForgeTheme(resolveStoryForgeTheme(localStorage.getItem('storyforge-theme')))
registerStoryForgeServiceWorker()
installRuntimeDiagnostics()

/**
 * LOG-1：先按本机设置启用日志，再**延后**安装落盘调度器。
 * - 设置级别必须在渲染之前，否则启动早期的事件（DB 自检、模板 seed）会被过滤掉；
 * - 但落盘调度器会带进两个 sink（桌面桥 / FSA + 文件夹基础设施），没必要占首屏包体积，
 *   因此用动态 import 放到空闲时加载：在此之前事件只是排队，不会丢。
 */
const logSettings = loadLogSettings()
setLoggingEnabled(logSettings.enabled)
setLogLevel(logSettings.level)
logEvent({
  level: 'info',
  tag: 'bootstrap',
  event: 'app.bootstrap.start',
  message: '应用启动',
  meta: { buildId: APP_BUILD_ID, dev: import.meta.env.DEV },
})

function scheduleLogFlushInstall() {
  void import('./lib/logging/log-flush')
    .then(module => { module.installLogFlush() })
    .catch(() => {
      // 加载失败不阻断启动：事件仍在内存队列里，日志状态卡打开时会再次安装。
    })
}
if (typeof requestIdleCallback === 'function') {
  requestIdleCallback(scheduleLogFlushInstall, { timeout: 3_000 })
} else {
  setTimeout(scheduleLogFlushInstall, 1_500)
}

/**
 * FB-11 数据持久 · 启动期申请「持久化存储」。
 * 不申请时浏览器把 IndexedDB 当 best-effort,可在磁盘压力/关闭清理/隐私插件下
 * 直接驱逐整库 → 用户表现为"数据被重置"。persist() 在 Chrome 是静默授予(按使用度
 * 启发式,不弹窗),被拒或不支持都不影响主流程,故 fire-and-forget。
 */
async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist) {
      const already = await navigator.storage.persisted()
      if (!already) {
        const granted = await navigator.storage.persist()
        log.info('bootstrap', 'bootstrap', `[bootstrap] persistent storage ${granted ? '已授予' : '未授予(浏览器启发式未满足,可稍后再试)'}`)
      }
    }
  } catch (e) {
    logEvent({ level: 'warn', tag: 'bootstrap', event: 'bootstrap', message: '[bootstrap] persist storage 申请失败(不影响运行):', error: e })
  }
}

async function bootstrap() {
  // 0. FB-11: 尽早申请持久化存储,降低 IndexedDB 被浏览器驱逐("重置")的概率。
  void requestPersistentStorage()

  // 0. Phase 1.1b: 注册表完整性校验。开发环境 throw(立刻发现漏登记),生产环境只告警。
  try {
    validateRegistry({ throwOnError: import.meta.env.DEV })
  } catch (e) {
    log.error('bootstrap', 'bootstrap', '[bootstrap] registry validation failed:', undefined, e)
  }

  // 1. Schema 健康自检：开发和生产环境都不得自动删除作者手稿。
  try {
    await ensureSchema(REQUIRED_TABLES, {
      expectedVersion: SCHEMA_VERSION,
    })
    await db.open()
    await finalizeCharacterAxesMigrationSnapshots()
  } catch (e) {
    log.error('bootstrap', 'bootstrap', '[bootstrap] schema check failed:', undefined, e)
  }

  // 1b. DB-SAFETY-1：启动自愈。若主库为空但库外哨兵里有副本（典型场景：程序逻辑
  //     误删库，或上次迁移把库写坏），这里**自动**把副本导回来——用户无需手动导出/导入。
  //     主库正常时此步零开销、零打扰；恢复走 importProjectJSON 生成新项目，不覆盖任何数据。
  try {
    const heal = await autoHealEmptyDatabase()
    if (heal.healed) {
      logEvent({
        level: 'warn', tag: 'bootstrap', event: 'app.autoheal',
        message: `[bootstrap] 已自动恢复 ${heal.restoredProjectIds.length} 个项目`,
        meta: { restored: heal.restoredProjectIds.length },
      })
    }
  } catch (e) {
    log.error('bootstrap', 'bootstrap', '[bootstrap] auto-heal failed:', undefined, e)
  }

  // 2. Phase 1：初始化提示词模板（必要时 seed 系统模板）
  try {
    await usePromptStore.getState().init()
  } catch (e) {
    log.error('bootstrap', 'bootstrap', '[bootstrap] prompt store init failed:', undefined, e)
  }

  // 3. Phase 16：初始化工作流（必要时 seed 系统工作流）
  try {
    await useWorkflowStore.getState().init()
  } catch (e) {
    log.error('bootstrap', 'bootstrap', '[bootstrap] workflow store init failed:', undefined, e)
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        {/* WEB-DEPLOY-1：路由前缀随构建期 BASE_URL 变化；
            子路径部署为 /storyforge，根路径（网页云端）部署为 /。 */}
        <BrowserRouter basename={resolveRouterBasename()}>
          <ToastProvider>
            <PersistentTaskProvider>
              <DialogProvider>
                <App />
              </DialogProvider>
            </PersistentTaskProvider>
          </ToastProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </React.StrictMode>,
  )
}

bootstrap()
