import { logEvent } from '../logging/logger'
import { resolveServiceWorkerScope, resolveServiceWorkerUrl } from '../deploy/app-base'

const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])

export function shouldRegisterStoryForgeServiceWorker(hostname = globalThis.location?.hostname ?? ''): boolean {
  return !LOCAL_HOSTNAMES.has(hostname)
}

export function registerStoryForgeServiceWorker() {
  if (!shouldRegisterStoryForgeServiceWorker()) return
  if (!('serviceWorker' in navigator)) return

  window.addEventListener('load', () => {
    // WEB-DEPLOY-1：地址与作用域都从构建期 BASE_URL 派生，根路径（/）与
    // 子路径（/storyforge/）部署共用同一份代码，不再各写一遍字符串。
    navigator.serviceWorker.register(resolveServiceWorkerUrl(), { scope: resolveServiceWorkerScope() })
      .catch(error => {
        logEvent({ level: 'warn', tag: 'pwa', event: 'pwa', message: '[pwa] service worker 注册失败:', error })
      })
  })
}
