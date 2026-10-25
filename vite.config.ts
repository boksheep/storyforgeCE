import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { execSync } from 'node:child_process'
import proxyRoutesFile from './src/lib/ai/proxy-routes.json' with { type: 'json' }
import { AI_PROXY_ENDPOINTS } from './src/lib/ai/proxy-endpoints'
import { DEFAULT_APP_BASE, normalizeAppBase } from './src/lib/deploy/app-base'

/**
 * WEB-DEPLOY-1 · 部署形态由环境变量决定，默认与既有线上/桌面版完全一致。
 *
 *   STORYFORGE_BASE=/      → 根路径的网页云端版本（`npm run build:web`）
 *   STORYFORGE_BASE 未设置  → /storyforge/（Vercel 既有部署 + Electron 桌面版）
 *   STORYFORGE_OUT_DIR     → 产物目录，默认 dist；网页云端版用 dist-web 隔离，
 *                            避免覆盖桌面版打包所依赖的 dist。
 *
 * 基路径换算逻辑在 `src/lib/deploy/app-base.ts`（同一份代码被 main.tsx 与
 * service worker 注册复用），这里只负责把环境变量喂进去，禁止再写死字符串。
 */
const appBase = normalizeAppBase(process.env.STORYFORGE_BASE ?? DEFAULT_APP_BASE)
const outDir = process.env.STORYFORGE_OUT_DIR || 'dist'

/** 子路径名（无前后斜杠）；根路径部署为空串。 */
const baseSegment = appBase === '/' ? '' : appBase.slice(1, -1)

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * workbox 导航回退黑名单：只对落在应用基路径下的导航回退到 index.html。
 * 根路径部署时没有需要排除的前缀，返回空数组（否则会把所有导航都挡掉）。
 */
function buildNavigateFallbackDenylist(): RegExp[] {
  return baseSegment ? [new RegExp(`^/(?!${escapeRegExp(baseSegment)})`)] : []
}

interface ProxyRoute { prefix: string; target: string; rewriteTo?: string }

interface ProxyEntry {
  target: string
  changeOrigin: boolean
  rewrite: (path: string) => string
  secure: boolean
}

/**
 * AI 代理路由的单一事实源：`src/lib/ai/proxy-routes.json`。
 *
 * 开发服务器（这里）与桌面版（`desktop/server.mjs`）都读它，禁止各写一份——
 * 否则「设置 → 切换到本地代理」会出现「npm run dev 能用、桌面版失效」这种
 * 没人会发现的静默漂移。
 */
function buildAIProxy(): Record<string, ProxyEntry> {
  const routes = (proxyRoutesFile as { routes: ProxyRoute[] }).routes
  const proxy: Record<string, ProxyEntry> = {}
  for (const route of routes) {
    proxy[route.prefix] = {
      target: route.target,
      changeOrigin: true,
      rewrite: (path: string) => path.replace(new RegExp(`^${route.prefix}`), route.rewriteTo ?? ''),
      secure: true,
    }
  }

  // 自检：UI 上「切换到本地代理」写出的每个前缀都必须有对应路由，
  // 否则那个按钮会把人送到 404 —— 比没有按钮更糟。
  const registered = new Set(routes.map(r => r.prefix))
  for (const [provider, ep] of Object.entries(AI_PROXY_ENDPOINTS)) {
    if (!ep) continue
    const prefix = '/' + ep.proxy.split('/')[1]
    if (!registered.has(prefix)) {
      throw new Error(
        `[proxy] 提供商 ${provider} 的代理前缀 ${prefix} 未登记在 src/lib/ai/proxy-routes.json，`
        + '「切换到本地代理」会指向 404。请补齐路由表。',
      )
    }
  }
  return proxy
}

function resolveBuildSha(): string {
  // WEB-DEPLOY-1：显式注入优先。受限沙箱（Windows 下禁止程序用管道 stdio spawn）
  // 会让下面的 execSync 直接 EPERM 并静默降级成 'local'，发布包就失去了可追溯性；
  // scripts/build-web.mjs / scripts/package-web.mjs 会先算好再注入。
  const injectedSha = process.env.STORYFORGE_BUILD_SHA
  if (injectedSha) return injectedSha
  const envSha = process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA
  if (envSha) return envSha.slice(0, 7)
  try {
    const sha = execSync('git rev-parse --short=7 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    const dirty = execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'local'
  }
}

export default defineConfig({
  define: {
    __STORYFORGE_BUILD_SHA__: JSON.stringify(resolveBuildSha()),
  },
  plugins: [
    react(),
    VitePWA({
      injectRegister: null,
      registerType: 'autoUpdate',
      base: appBase,
      scope: appBase,
      manifest: {
        name: '故事熔炉 StoryForge',
        short_name: '故事熔炉',
        description: 'AI 驱动的小说创作工坊',
        theme_color: '#6366f1',
        background_color: '#0a0a0f',
        display: 'standalone',
        start_url: appBase,
        scope: appBase,
        lang: 'zh-CN',
        icons: [
          {
            src: `${appBase}icon-192.png`,
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: `${appBase}icon-512.png`,
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: `${appBase}icon-512.png`,
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        navigateFallback: `${appBase}index.html`,
        navigateFallbackDenylist: buildNavigateFallbackDenylist(),
        // 主 bundle 已随功能增多突破 2 MiB（pdf.js + mammoth + 分块流水线），
        // 放宽到 5 MiB 让它被精确预缓存而不是只靠 runtime cache。
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        runtimeCaching: [
          {
            // Google Fonts
            urlPattern: /^https:\/\/fonts\.(googleapis|gstatic)\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts',
              expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 365 },
            },
          },
        ],
      },
    }),
  ],
  base: appBase,
  server: {
    port: 1111,
    // CF-1: 端口被占用时直接失败报错，而不是静默换到 1112 —— 避免用户以为在 1111、
    // 实际打开的却是被旧进程占用的 1111（错误服务 / 重定向循环）。
    strictPort: true,
    open: appBase,
    proxy: buildAIProxy(),
  },
  build: {
    outDir,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // 只把 react 固定成独立 vendor chunk（便于缓存）。
        // pdfjs / mammoth / three / jszip 均已通过「动态 import() 按需加载」自然分块，
        // 不可在此用 manualChunks 固定它们——否则会被并入主包静态引用、反而变回首屏 eager 加载。
        // Phase 3.5:把大的静态依赖拆成独立 vendor chunk。
        // 好处:① 主包变小、解析更快 ② 这些库很少变,浏览器可长期缓存(应用更新不必重下)。
        manualChunks: {
          'vendor-react': ['react', 'react-dom', 'react-router'],
          // react-dom/client 是实际首屏入口；单独分块，避免 renderer 留在入口脚本。
          'vendor-react-dom-client': ['react-dom/client'],
          'vendor-editor': ['@tiptap/react', '@tiptap/starter-kit', '@tiptap/extension-placeholder'],
          'vendor-db': ['dexie'],
          'vendor-d3': ['d3-hierarchy'],
          // 侧栏与工作区共享大量图标；独立缓存，避免每次功能加一个图标都把入口包推过预算。
          'vendor-icons': ['lucide-react'],
          // 上下文装配被首页、写作与多个懒加载面板共同引用；单独缓存可避免
          // 每次扩展项目数据源都推高首屏入口包，同时不改变其同步调用语义。
          'ai-context': ['./src/lib/ai/context-builder.ts'],
        },
      },
    },
  },
})
