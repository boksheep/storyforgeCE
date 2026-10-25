#!/usr/bin/env node
/* global console, process */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { runWebBuild, WEB_BUILD_BASE, WEB_BUILD_OUT_DIR } from './build-web.mjs'
import { formatBuildSha, readGitBranch, resolveGitRevision } from './lib/git-revision.mjs'
import {
  buildNginxProxyLocations,
  buildRedirectsProxyRules,
  buildVercelProxyConfig,
  verifyProxyCoverage,
} from './lib/ai-proxy-templates.mjs'
import proxyRoutesFile from '../src/lib/ai/proxy-routes.json' with { type: 'json' }

/**
 * WEB-DEPLOY-1 · 网页云端发布包组装。
 *
 * 输出三样东西（都在 .gitignore 覆盖范围内，不会污染工作树）：
 *   dist-web/                                裸站点文件（base=/）
 *   release/storyforge-web-<版本>/            发布目录：站点 + 各平台部署配置 + 文档
 *   release/storyforge-web-<版本>-<提交>.zip  可直接分发/上传的压缩包
 *
 * 与 `npm run build`（base=/storyforge/ → dist/）完全隔离，后者继续服务
 * 既有线上部署与 Electron 桌面版。
 *
 * 组装前后各做一轮校验（`verifyWebDist` / `verifyPackage`），
 * 任何一条不通过就**不让 zip 落盘**并返回非 0，避免"看起来打好了其实白屏"。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
const templateDir = path.join(root, 'packaging', 'web-cloud')
const releaseDir = path.join(root, 'release')
const distDir = path.join(root, WEB_BUILD_OUT_DIR)
const packageName = `storyforge-web-${pkg.version}`
const packageDir = path.join(releaseDir, packageName)

/** 站点根路径 → nginx `root` 取值。容器与主机两份配置只差这一个变量。 */
const NGINX_VARIANTS = [
  { file: 'nginx.conf', siteRoot: '/usr/share/nginx/html', label: '容器（docker/Dockerfile 使用）' },
  { file: 'nginx-host.conf', siteRoot: '/var/www/storyforge', label: '主机 nginx（按需改 root）' },
]

/** 原样复制的部署配置。 */
const TEMPLATE_FILES = [
  ['vercel.json', 'vercel.json'],
  ['netlify.toml', 'netlify.toml'],
  ['_redirects', '_redirects'],
  ['_headers', '_headers'],
  ['.dockerignore', '.dockerignore'],
  ['.nojekyll', '.nojekyll'],
  ['docker/Dockerfile', 'docker/Dockerfile'],
  ['docker/docker-compose.yml', 'docker/docker-compose.yml'],
  ['proxy-examples/README.md', 'proxy-examples/README.md'],
]

/** 会被扫描硬编码残留的文本类产物。 */
const TEXT_FILE_RE = /\.(?:html|js|mjs|css|json|webmanifest|svg|txt)$/i

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

/** 递归列出目录下所有文件（相对 POSIX 路径）。 */
function walkFiles(dir, base = dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, base, acc)
    else acc.push(path.relative(base, full).split(path.sep).join('/'))
  }
  return acc.sort()
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dest = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dest)
    else fs.copyFileSync(src, dest)
  }
}

function applyPlaceholders(text, vars) {
  return text.replace(/__([A-Z_]+)__/g, (match, key) => {
    if (!(key in vars)) throw new Error(`模板占位符 ${match} 没有对应取值`)
    return String(vars[key])
  })
}

function writeTemplate(relFrom, relTo, vars) {
  const source = fs.readFileSync(path.join(templateDir, relFrom), 'utf8')
  const target = path.join(packageDir, relTo)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, applyPlaceholders(source, vars))
  return relTo
}

/** 站点文件（按体积降序），用于报告与 BUILD-INFO。 */
function describeSiteFiles(dir) {
  return walkFiles(dir)
    .map((relative) => {
      const size = fs.statSync(path.join(dir, relative)).size
      return { path: relative, bytes: size }
    })
    .sort((a, b) => b.bytes - a.bytes)
}

/**
 * 组装发布目录。
 *
 * ⚠️ 会先清空同名发布目录。删除前显式断言目标确实位于 `release/` 之下，
 * 避免任何路径拼错导致误删（AGENTS.md 数据红线：破坏性操作必须自证目标）。
 */
export function assemblePackage({ buildSha, branch, builtAt, siteInfo }) {
  const resolvedRelease = path.resolve(releaseDir)
  const resolvedPackage = path.resolve(packageDir)
  if (!resolvedPackage.startsWith(resolvedRelease + path.sep)) {
    throw new Error(`拒绝清理：${resolvedPackage} 不在 ${resolvedRelease} 之内`)
  }
  fs.rmSync(resolvedPackage, { recursive: true, force: true })
  copyDir(distDir, resolvedPackage)

  const sharedVars = {
    VERSION: pkg.version,
    BUILD_SHA: buildSha,
    BUILT_AT: builtAt,
    BASE_PATH: WEB_BUILD_BASE,
    GIT_BRANCH: branch,
  }

  // ① 原样复制的部署配置
  for (const [from, to] of TEMPLATE_FILES) writeTemplate(from, to, sharedVars)

  // ② nginx：同一模板产出容器版与主机版，只差 root
  for (const variant of NGINX_VARIANTS) {
    writeTemplate('nginx.conf.template', variant.file, { ...sharedVars, SITE_ROOT: variant.siteRoot })
  }

  // ③ 可选 AI 反向代理：从 proxy-routes.json 派生（禁止手写平行路由表）
  const routes = proxyRoutesFile.routes
  const proxyArtifacts = {
    'vercel-ai-proxy.json': `${JSON.stringify(buildVercelProxyConfig(routes), null, 2)}\n`,
    'netlify-cloudflare-ai-proxy._redirects': buildRedirectsProxyRules(routes),
    'nginx-ai-proxy.conf': buildNginxProxyLocations(routes),
  }
  const coverageGaps = verifyProxyCoverage(routes, proxyArtifacts)
  if (coverageGaps.length > 0) {
    throw new Error(`AI 代理示例未覆盖全部路由：\n  - ${coverageGaps.join('\n  - ')}`)
  }
  for (const [name, text] of Object.entries(proxyArtifacts)) {
    fs.writeFileSync(path.join(resolvedPackage, 'proxy-examples', name), text)
  }

  // ④ 不支持回退规则的静态托管（GitHub Pages 等）靠 404.html 兜底
  fs.copyFileSync(path.join(resolvedPackage, 'index.html'), path.join(resolvedPackage, '404.html'))

  // ⑤ 构建元数据
  const artifacts = walkFiles(resolvedPackage)
  fs.writeFileSync(
    path.join(resolvedPackage, 'BUILD-INFO.json'),
    `${JSON.stringify(
      {
        app: pkg.name,
        version: pkg.version,
        buildSha,
        gitBranch: branch,
        builtAt,
        base: WEB_BUILD_BASE,
        deployTarget: 'static-web-cloud',
        aiProxyEnabled: false,
        aiProxyExamples: Object.keys(proxyArtifacts),
        siteFileCount: siteInfo.files.length,
        siteTotalBytes: siteInfo.totalBytes,
        note: 'AI 代理默认关闭；启用方式见 proxy-examples/README.md。',
      },
      null,
      2,
    )}\n`,
  )

  // ⑥ 交付文档（最后写，因为占位符含站点统计）
  writeTemplate('README-DEPLOY.template.md', 'README-DEPLOY.md', {
    ...sharedVars,
    FILE_COUNT: siteInfo.files.length,
    TOTAL_SIZE: formatBytes(siteInfo.totalBytes),
  })

  return { artifacts: walkFiles(resolvedPackage), siteInfo: { ...siteInfo, files: siteInfo.files } }
}

/** 发布目录自检：部署配置齐不齐、404 兜底是不是 index 的副本、代理示例是否覆盖全路由。 */
export function verifyPackage(dir) {
  const errors = []
  const required = [
    'index.html',
    '404.html',
    'sw.js',
    'manifest.webmanifest',
    'BUILD-INFO.json',
    'README-DEPLOY.md',
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    'third-party-licenses/Apache-2.0.txt',
    'third-party-licenses/bmp-js-LICENSE',
    'third-party-licenses/idb-keyval-LICENCE',
    'third-party-licenses/is-url-LICENSE-MIT',
    'third-party-licenses/node-fetch-LICENSE.md',
    'third-party-licenses/regenerator-runtime-LICENSE',
    'third-party-licenses/wasm-feature-detect-LICENSE',
    'third-party-licenses/zlibjs-LICENSE',
    'map-ocr/chi_sim.traineddata',
    'map-ocr/eng.traineddata',
    'map-ocr/worker.min.js',
    ...['lstm', 'simd-lstm', 'relaxedsimd-lstm'].flatMap(variant => [
      `map-ocr/tesseract-core-${variant}.wasm.js`,
      `map-ocr/tesseract-core-${variant}.wasm`,
    ]),
    'vercel.json',
    'netlify.toml',
    '_redirects',
    '_headers',
    'nginx.conf',
    'nginx-host.conf',
    '.nojekyll',
    '.dockerignore',
    'docker/Dockerfile',
    'docker/docker-compose.yml',
    'proxy-examples/README.md',
    'proxy-examples/vercel-ai-proxy.json',
    'proxy-examples/netlify-cloudflare-ai-proxy._redirects',
    'proxy-examples/nginx-ai-proxy.conf',
  ]
  for (const relative of required) {
    if (!fs.existsSync(path.join(dir, relative))) errors.push(`发布目录缺少 ${relative}`)
  }

  if (fs.existsSync(path.join(dir, '404.html')) && fs.existsSync(path.join(dir, 'index.html'))) {
    const a = fs.readFileSync(path.join(dir, '404.html'))
    const b = fs.readFileSync(path.join(dir, 'index.html'))
    if (!a.equals(b)) errors.push('404.html 不是 index.html 的副本，GitHub Pages 回退会不一致')
  }

  // 占位符必须全部被替换（漏替换会让部署者看到 __XXX__ 这种残渣）
  for (const relative of ['README-DEPLOY.md', 'nginx.conf', 'nginx-host.conf']) {
    if (!fs.existsSync(path.join(dir, relative))) continue
    const text = fs.readFileSync(path.join(dir, relative), 'utf8')
    const leftover = text.match(/__[A-Z_]+__/g)
    if (leftover) errors.push(`${relative} 仍有未替换的占位符：${[...new Set(leftover)].join(', ')}`)
  }

  // vercel.json 必须是合法 JSON（平台解析失败的表现是一整站 404，很难查）
  try {
    const vercel = JSON.parse(fs.readFileSync(path.join(dir, 'vercel.json'), 'utf8'))
    if (!Array.isArray(vercel.rewrites) || vercel.rewrites.length === 0) {
      errors.push('vercel.json 缺少 SPA 回退 rewrites')
    }
  } catch (error) {
    errors.push(`vercel.json 不是合法 JSON：${error.message}`)
  }

  const redirects = fs.existsSync(path.join(dir, '_redirects'))
    ? fs.readFileSync(path.join(dir, '_redirects'), 'utf8')
    : ''
  if (!/\/\*\s+\/index\.html\s+200/.test(redirects)) {
    errors.push('_redirects 缺少 SPA 回退规则（/* /index.html 200）')
  }

  return errors
}

/** 打包 zip（JSZip，跨平台；不依赖系统 zip/Compress-Archive）。 */
export async function createZip(dir, zipPath, artifacts) {
  const zip = new JSZip()
  for (const relative of artifacts) {
    const content = fs.readFileSync(path.join(dir, relative))
    // 图片本身已压缩，再 DEFLATE 只徒增 CPU；文本类保持最高压缩。
    const store = /\.(?:png|jpg|jpeg|webp|gif|ico|woff2)$/i.test(relative)
    zip.file(relative, content, store ? { compression: 'STORE' } : { compression: 'DEFLATE', compressionOptions: { level: 9 } })
  }
  const buffer = await zip.generateAsync({ type: 'nodebuffer' })
  fs.mkdirSync(path.dirname(zipPath), { recursive: true })
  fs.writeFileSync(zipPath, buffer)
  return buffer.byteLength
}

function printSiteBreakdown(siteInfo, limit = 5) {
  console.log('[package:web] 站点文件按体积排序（前 %d 项）：', limit)
  for (const file of siteInfo.files.slice(0, limit)) {
    console.log(`  ${formatBytes(file.bytes).padStart(10)}  ${file.path}`)
  }
}

async function main() {
  const args = new Set(process.argv.slice(2))
  const skipBuild = args.has('--skip-build')
  const noZip = args.has('--no-zip')

  const revision = resolveGitRevision(root)
  const buildSha = formatBuildSha(revision)
  const branch = readGitBranch(root)
  const builtAt = new Date().toISOString()

  if (!skipBuild) runWebBuild()
  else console.log('[package:web] --skip-build：复用现有 dist-web/')

  // ── ① 构造产物校验 ──
  const distResult = verifyWebDist(distDir, WEB_BUILD_BASE)
  for (const warning of distResult.warnings) console.warn(`[package:web] ⚠️ ${warning}`)
  if (distResult.errors.length > 0) {
    console.error('[package:web] ❌ 构建产物校验未通过：')
    for (const error of distResult.errors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(
    `[package:web] ✅ 构建产物校验通过：入口 ${distResult.entry.script} `
    + `${formatBytes(distResult.entry.scriptBytes)}，共 ${distResult.files.length} 个文件 / `
    + `${formatBytes(distResult.totalBytes)}`,
  )
  printSiteBreakdown(distResult)

  // ── ② 组装发布目录 ──
  const { artifacts, siteInfo } = assemblePackage({ buildSha, branch, builtAt, siteInfo: distResult })

  // ── ③ 发布目录自检 ──
  const packageErrors = verifyPackage(packageDir)
  if (packageErrors.length > 0) {
    console.error('[package:web] ❌ 发布目录校验未通过：')
    for (const error of packageErrors) console.error(`  - ${error}`)
    process.exit(1)
  }
  console.log(`[package:web] ✅ 发布目录校验通过：${artifacts.length} 个条目 → ${path.relative(root, packageDir)}`)

  // ── ④ 打 zip ──
  if (!noZip) {
    const zipName = `${packageName}${buildSha && buildSha !== 'local' ? `-${buildSha}` : ''}.zip`
    const zipPath = path.join(releaseDir, zipName)
    const zipBytes = await createZip(packageDir, zipPath, artifacts)
    console.log(`[package:web] ✅ 压缩包：${path.relative(root, zipPath)}（${formatBytes(zipBytes)}）`)
  } else {
    console.log('[package:web] --no-zip：跳过压缩包')
  }

  console.log('\n[package:web] ── 交付摘要 ─────────────────────────────')
  console.log(`  版本 / 提交     ${pkg.version} / ${buildSha}（来源 ${revision.source}）`)
  console.log(`  分支 / 工作树   ${branch} / ${revision.dirty === null ? '未能判定' : revision.dirty ? '有未提交改动' : '干净'}`)
  console.log(`  部署基路径      ${WEB_BUILD_BASE}（必须部署在域名根路径）`)
  console.log(`  站点体积        ${siteInfo.files.length} 文件 / ${formatBytes(siteInfo.totalBytes)}`)
  console.log('  AI 反向代理     默认关闭（proxy-examples/ 内可选启用）')
  console.log('  下一步          npm run package:web 产物目录整体上传即可\n')
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isCli) {
  main().catch((error) => {
    console.error('[package:web] ❌ 打包失败：', error)
    process.exit(1)
  })
}

/**
 * 构建产物校验 —— 这是「能不能直接部署」的判据，不是走过场。
 *
 * 最关键的一条是「不得残留 /storyforge 硬编码」：它是 WEB-DEPLOY-1 之前
 * 三处写死基路径的直接症状，一旦残留就是白屏或 PWA 失效。
 */
export function verifyWebDist(dir, base = WEB_BUILD_BASE) {
  const errors = []
  const warnings = []
  const indexPath = path.join(dir, 'index.html')

  if (!fs.existsSync(dir)) errors.push(`构建产物目录不存在：${path.relative(root, dir)}`)
  if (!fs.existsSync(indexPath)) {
    errors.push('构建产物缺少 index.html')
    return { errors, warnings, entry: null }
  }

  const files = walkFiles(dir)
  const indexHtml = fs.readFileSync(indexPath, 'utf8')

  // ① 不得残留旧基路径（三处写死 /storyforge 的回归症状）
  //
  // 注意：`/storyforge` 作为**子串**出现并不等于基路径泄漏。构建产物里已知有两类
  // 同名巧合，必须排除，否则每次构建都会误报：
  //   - AI 提示词标签 `</storyforge_project_context>`（前一个字符是 `<`）
  //   - 仓库链接 `https://github.com/yuanbw2025/storyforge`（前一个字符是 `5`）
  // 真正危险的形态是「它作为路径字面量使用」：`"/storyforge/sw.js"`、
  // `basename:"/storyforge"`、`navigateFallback:"/storyforge/index.html"`。
  // 判据：`/storyforge` 的前一个字符是字符串起始或引号/括号/赋值符/冒号/空白。
  // 这个方向是 fail-closed：万一将来出现新的巧合，它会报错让人复审，而不是静默放过。
  const leaks = []
  const leakPattern = /(?:^|["'`(,=:\s])(\/storyforge)/g
  for (const relative of files) {
    if (!TEXT_FILE_RE.test(relative)) continue
    const text = fs.readFileSync(path.join(dir, relative), 'utf8')
    for (const match of text.matchAll(leakPattern)) {
      if (leaks.length >= 8) break
      const at = match.index ?? 0
      const from = Math.max(0, at - 60)
      const to = Math.min(text.length, at + 60)
      leaks.push(`${relative}: …${text.slice(from, to).replace(/\s+/g, ' ')}…`)
    }
  }
  if (leaks.length > 0) {
    errors.push(`构建产物仍残留 /storyforge 基路径（根路径部署会 404 / 白屏）：\n    ${leaks.join('\n    ')}`)
  }

  // ② index.html 引用的本地资源必须真实存在
  const refs = [...indexHtml.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map(match => match[1])
  const missingRefs = []
  for (const ref of new Set(refs)) {
    const clean = ref.split(/[?#]/)[0]
    if (!clean || clean === '/') continue
    if (!fs.existsSync(path.join(dir, clean.replace(/^\//, '')))) missingRefs.push(ref)
  }
  if (missingRefs.length > 0) errors.push(`index.html 引用了不存在的本地资源：${missingRefs.join(', ')}`)

  // ③ index.html 的引用必须是基路径开头（base 生效的证据）
  const offBaseRefs = [...new Set(refs)].filter(ref => !ref.startsWith(base))
  if (offBaseRefs.length > 0) {
    errors.push(`index.html 存在不在基路径 ${base} 下的引用：${offBaseRefs.join(', ')}`)
  }

  // ④ PWA 三件套：manifest 的 start_url/scope 必须等于构建基路径
  const manifestPath = path.join(dir, 'manifest.webmanifest')
  if (!fs.existsSync(manifestPath)) {
    errors.push('缺少 manifest.webmanifest（PWA 与移动端「添加到主屏幕」会失效）')
  } else {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    if (manifest.start_url !== base) errors.push(`manifest.start_url=${manifest.start_url}，期望 ${base}`)
    if (manifest.scope !== base) errors.push(`manifest.scope=${manifest.scope}，期望 ${base}`)
    for (const icon of manifest.icons ?? []) {
      if (!icon.src?.startsWith(base)) errors.push(`manifest 图标不在基路径下：${icon.src}`)
      else if (!fs.existsSync(path.join(dir, icon.src.replace(/^\//, '')))) {
        errors.push(`manifest 图标文件缺失：${icon.src}`)
      }
    }
  }
  if (!fs.existsSync(path.join(dir, 'sw.js'))) {
    errors.push('缺少 sw.js（离线/PWA 能力缺失）')
  } else {
    const sw = fs.readFileSync(path.join(dir, 'sw.js'), 'utf8')
    if (sw.includes('/storyforge')) errors.push('sw.js 的预缓存清单仍指向 /storyforge')
  }

  // ⑤ 入口脚本与样式表
  const entryMatch = indexHtml.match(/<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["']([^"']+)["']/i)
  const cssMatch = indexHtml.match(/<link\b[^>]*\brel=["']stylesheet["'][^>]*\bhref=["']([^"']+)["']/i)
  if (!entryMatch) errors.push('index.html 中未找到 module 入口脚本')
  if (!cssMatch) warnings.push('index.html 中未找到样式表引用（若样式已内联可忽略）')

  const entry = entryMatch
    ? {
        script: entryMatch[1],
        stylesheet: cssMatch?.[1] ?? null,
        scriptBytes: fs.statSync(path.join(dir, entryMatch[1].replace(/^\//, ''))).size,
      }
    : null

  const siteFiles = describeSiteFiles(dir)
  return {
    errors,
    warnings,
    entry,
    files: siteFiles,
    totalBytes: siteFiles.reduce((sum, file) => sum + file.bytes, 0),
  }
}
