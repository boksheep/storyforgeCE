/**
 * 部署基路径（base）解析 —— WEB-DEPLOY-1 的单一事实源。
 *
 * ## 为什么需要这个模块
 *
 * 应用原先在**三处各写一份** `/storyforge`：
 *   1. `vite.config.ts`：`base`、PWA `base` / `scope` / `start_url` / workbox 回退；
 *   2. `src/main.tsx`：`<BrowserRouter basename="/storyforge">`；
 *   3. `src/lib/pwa/register-service-worker.ts`：`register('/storyforge/sw.js')`。
 *
 * 三处必须**同时**改对，否则根路径（`/`）部署的表现是：
 *   - 路由前缀错位 → 首页白屏 / 深链接 404；
 *   - SW 注册地址 404 → PWA 与离线能力静默失效，旧 SW 还可能劫持导航。
 *
 * 而 `tsc`、ESLint、架构守卫都发现不了「字符串写死」这类漂移。
 *
 * 因此这里把「BASE_URL → 路由 basename / SW 地址 / SW 作用域」的换算收敛成
 * 纯函数，由构建期 `import.meta.env.BASE_URL` 这**一个**输入驱动，并有回归测试覆盖
 * （`tests/regression/R-WEBDEPLOY-1-app-base.test.ts`）。
 */

/** 默认基路径：既有线上部署（yuanbw.vercel.app/storyforge/）与桌面版共用。 */
export const DEFAULT_APP_BASE = '/storyforge/'

/**
 * 规范化基路径为「以 `/` 开头、以 `/` 结尾」的路径形式。
 *
 * - `undefined` / `''` / `'/'` / `'./'` → `'/'`（根路径部署）
 * - `'storyforge'` / `'/storyforge'` / `'/storyforge/'` → `'/storyforge/'`
 * - `'https://cdn.example.com/app/'` → `'/app/'`（取 pathname，容忍 CDN 基路径）
 */
export function normalizeAppBase(raw?: string | null): string {
  const value = (raw ?? '').trim()
  if (!value) return '/'

  let pathname = value
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    try {
      pathname = new URL(value).pathname
    } catch {
      pathname = '/'
    }
  } else {
    pathname = pathname.split(/[?#]/)[0] ?? pathname
  }

  if (pathname === '.' || pathname === './') return '/'
  if (!pathname.startsWith('/')) pathname = `/${pathname}`
  pathname = pathname.replace(/\/+$/, '')
  return pathname === '' ? '/' : `${pathname}/`
}

/** 供 `BrowserRouter` 使用的 basename：无尾斜杠；根路径返回 `'/'`。 */
export function resolveRouterBasename(baseUrl: string = import.meta.env.BASE_URL): string {
  const base = normalizeAppBase(baseUrl)
  return base === '/' ? '/' : base.replace(/\/$/, '')
}

/** service worker 脚本地址，必须落在基路径下。 */
export function resolveServiceWorkerUrl(baseUrl: string = import.meta.env.BASE_URL): string {
  return `${normalizeAppBase(baseUrl)}sw.js`
}

/** service worker 作用域：注册地址与作用域前缀不一致时浏览器会直接拒绝注册。 */
export function resolveServiceWorkerScope(baseUrl: string = import.meta.env.BASE_URL): string {
  return normalizeAppBase(baseUrl)
}
