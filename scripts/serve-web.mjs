#!/usr/bin/env node
/* global console, process */
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * WEB-DEPLOY-1 · 发布包本地预览服务器。
 *
 * 目的不是"起个静态服务器"这么简单，而是**在本机复现云端静态托管的行为**，
 * 好让 `tests/e2e-web` 能在与线上一致的条件下验收发布包：
 *   - SPA 回退：未命中的路径回 `index.html`，但**带扩展名的资源请求仍然 404**
 *     （很多"本地能开、线上白屏"的问题就出在把缺失资源也回成了 HTML）；
 *   - 缓存头：`/assets/*` 与哈希化的 workbox 文件 immutable，
 *     `index.html` / `sw.js` / `manifest.webmanifest` 必须回源校验。
 *
 * 零依赖（只用 node:http），因此离线环境也能跑。
 *
 * 用法：
 *   node scripts/serve-web.mjs --dir <发布目录> --port 4179
 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const args = { dir: 'dist-web', port: 4179, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--dir') args.dir = argv[++i]
    else if (token === '--port') args.port = Number(argv[++i])
    else if (token === '--quiet') args.quiet = true
  }
  return args
}

/** 与 nginx.conf / vercel.json 保持一致的缓存策略。 */
function cacheControlFor(relativePath) {
  if (relativePath.startsWith('assets/')) return 'public, max-age=31536000, immutable'
  if (/^workbox-[0-9a-f]+\.js$/.test(relativePath)) return 'public, max-age=31536000, immutable'
  if (relativePath === 'index.html' || relativePath === 'sw.js' || relativePath === 'manifest.webmanifest') {
    return 'public, max-age=0, must-revalidate'
  }
  return null
}

export function createStaticServer(siteDir) {
  const siteRoot = path.resolve(siteDir)
  const indexPath = path.join(siteRoot, 'index.html')

  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0].split('#')[0])
    const relative = urlPath.replace(/^\/+/, '')
    const resolved = path.resolve(siteRoot, relative)

    // 目录穿越防护：解析后的路径必须仍在站点目录内
    if (resolved !== siteRoot && !resolved.startsWith(siteRoot + path.sep)) {
      res.writeHead(403).end('Forbidden')
      return
    }

    const send = (filePath, relativeKey) => {
      const body = fs.readFileSync(filePath)
      const headers = { 'Content-Type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream' }
      const cache = cacheControlFor(relativeKey)
      if (cache) headers['Cache-Control'] = cache
      res.writeHead(200, headers).end(body)
    }

    if (relative && fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      send(resolved, relative.split(path.sep).join('/'))
      return
    }

    // 带扩展名的请求视为资源：绝不回退成 HTML，否则前端会拿到一份 HTML 去 JSON.parse
    const looksLikeAsset = path.extname(relative) !== ''
    if (!looksLikeAsset && fs.existsSync(indexPath)) {
      send(indexPath, 'index.html')
      return
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found')
  })
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isCli) {
  const args = parseArgs(process.argv.slice(2))
  const siteDir = path.resolve(root, args.dir)
  if (!fs.existsSync(path.join(siteDir, 'index.html'))) {
    console.error(`[serve-web] ❌ ${siteDir} 下没有 index.html，先执行 npm run package:web`)
    process.exit(1)
  }
  createStaticServer(siteDir).listen(args.port, '127.0.0.1', () => {
    console.log(`[serve-web] 预览 ${siteDir}`)
    console.log(`[serve-web] → http://127.0.0.1:${args.port}/`)
  })
}
