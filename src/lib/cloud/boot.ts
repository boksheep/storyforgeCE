/**
 * CLOUD-DB-1 · 云端动态入口
 *
 * 由 `main.tsx` 在**空闲时**动态 `import()`。因此：
 *   - 纯本地用户：这段代码（连同同步引擎）永不下载
 *   - 已配置用户：首屏渲染完成后才开始解析配置、恢复登录态、启动同步
 *
 * 硬约束：
 *   1. 云模式**永不参与启动流程**（`bootstrap()` 里没有 await 它）
 *   2. 任何失败都静默降级为纯本地，绝不弹窗、绝不阻塞编辑
 *   3. 只有确认已登录才安装写入捕获、启动同步引擎
 */
import { log } from '../logging/logger'
import { registerCloudLifecycle, useCloudAuth } from '../../stores/cloud-auth'
import { startCapture, stopCapture } from './change-capture'
import { resolveCloudConfig } from './config'
import { clearOutbox } from './outbox'
import { startSyncEngine, stopSyncEngine } from './sync-engine'
import type { CloudConfig } from './types'

export interface CloudRuntime {
  config: CloudConfig
  /** 是否已完成一次成功解析。 */
  resolved: boolean
}

let runtime: CloudRuntime = {
  config: { enabled: false, apiBase: '/api', source: 'none' },
  resolved: false,
}

/** 供 UI（设置页卡片）读取当前生效的云端配置。 */
export function getCloudRuntime(): CloudRuntime {
  return runtime
}

export interface CloudBootResult {
  enabled: boolean
  source: CloudConfig['source']
  authenticated: boolean
}

/**
 * 解析云端配置、恢复登录态、按需启动同步。
 *
 * 幂等：重复调用只会重新解析配置，不会重复启动引擎（引擎自带 `started` 守卫）。
 */
export async function bootCloud(): Promise<CloudBootResult> {
  try {
    const config = await resolveCloudConfig()
    runtime = { config, resolved: true }

    if (!config.enabled) {
      log.info('Cloud', 'cloud.boot.disabled', '云端未启用，保持纯本地模式', {
        source: config.source,
      })
      return { enabled: false, source: config.source, authenticated: false }
    }

    const auth = useCloudAuth.getState()
    auth.applyConfig(config)

    // 登录/登出与"捕获 + 引擎"绑定：不登录绝不安装捕获，
    // 否则会产生一份永不消费的脏集。
    registerCloudLifecycle({
      onAuthed: () => {
        startCapture()
        startSyncEngine({
          onUnauthorized: () => useCloudAuth.getState().markExpired(),
        })
      },
      onLoggedOut: () => {
        stopCapture()
        stopSyncEngine()
        clearOutbox()
      },
    })

    await auth.refresh()
    const status = useCloudAuth.getState().status

    log.info('Cloud', 'cloud.boot.enabled', '云端已启用', {
      source: config.source,
      apiBase: config.apiBase,
      status,
    })

    return {
      enabled: true,
      source: config.source,
      authenticated: status === 'authed',
    }
  } catch (error) {
    runtime = {
      config: { enabled: false, apiBase: '/api', source: 'none' },
      resolved: true,
    }
    log.error('Cloud', 'cloud.boot.failed', '云端初始化失败，降级为纯本地', {}, error)
    return { enabled: false, source: 'none', authenticated: false }
  }
}

/** 关闭云端（UI 里"停用云数据库"）：停捕获、停引擎、清脏集。 */
export function shutdownCloud(): void {
  stopCapture()
  stopSyncEngine()
  clearOutbox()
  runtime = { config: { enabled: false, apiBase: '/api', source: 'none' }, resolved: true }
}

/** 仅测试使用：重置运行时状态。 */
export function __resetCloudRuntimeForTest(): void {
  runtime = {
    config: { enabled: false, apiBase: '/api', source: 'none' },
    resolved: false,
  }
}
