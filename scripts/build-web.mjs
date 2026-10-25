#!/usr/bin/env node
/* global console, process */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { formatBuildSha, resolveGitRevision } from './lib/git-revision.mjs'

/**
 * WEB-DEPLOY-1 · 网页云端版构建（根路径 `/`，产物独立到 `dist-web/`）。
 *
 * ## 为什么单独一个脚本而不是 npm script 里写环境变量
 *
 * `STORYFORGE_BASE=/ vite build` 在 Windows 的 cmd 下不成立（无内联环境变量语法），
 * 而引入 cross-env 只为两个变量不划算。这里统一在 Node 里设环境变量，
 * 并用 `process.execPath` 直接调用本地 `vite` / `tsc` 入口：不依赖 shell、
 * 不依赖 `npx`、在 Windows / macOS / Linux 与受限沙箱下行为一致。
 *
 * ## 与既有构建的关系
 *
 * - `npm run build`  → base `/storyforge/` → `dist/`（Vercel 既有线上部署 + Electron 桌面版）
 * - `npm run build:web` → base `/` → `dist-web/`（本脚本；网页云端独立部署）
 *
 * 两者互不覆盖，可同时存在。
 */

export const WEB_BUILD_BASE = '/'
export const WEB_BUILD_OUT_DIR = 'dist-web'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const viteBin = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js')
const tscBin = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')

function run(label, scriptPath, args, extraEnv = {}) {
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`[build:web] 找不到 ${path.relative(root, scriptPath)}，请先 npm install`)
  }
  console.log(`\n[build:web] ▶ ${label}`)
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: root,
    // 必须 inherit：受限沙箱下管道 stdio 会 EPERM，且构建日志本来就该直通终端。
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    console.error(`[build:web] ❌ ${label} 失败（exit ${result.status}）`)
    process.exit(result.status ?? 1)
  }
}

/**
 * @param {{skipTypeCheck?: boolean}} options
 *   `skipTypeCheck` 仅在调用方已单独跑过 `tsc` 时使用（package-web 复用）。
 * @returns {{base: string, outDir: string, buildSha: string}}
 */
export function runWebBuild({ skipTypeCheck = false } = {}) {
  const revision = resolveGitRevision(root)
  const buildSha = formatBuildSha(revision)

  /**
   * esbuild 会把转译中间产物写到系统临时目录再删除。受限/受管环境里
   * `%TEMP%` 在工作区之外，删除会被拒绝（`[vite:esbuild-transpile] remove ...:
   * Access is denied`），构建随即整段失败——而且报错点在依赖内部，很难查。
   * 仓库本来就约定用 `.tmp-build/`（已被 .gitignore 覆盖）放构建临时文件，
   * 这里沿用同一约定，把 TEMP/TMP 指到工作区内。
   */
  const buildTemp = path.join(root, '.tmp-build', 'web-build-temp')
  fs.mkdirSync(buildTemp, { recursive: true })

  const env = {
    STORYFORGE_BASE: WEB_BUILD_BASE,
    STORYFORGE_OUT_DIR: WEB_BUILD_OUT_DIR,
    // 显式注入，避免 vite.config.ts 在受限沙箱里因 spawn 失败静默降级成 local
    STORYFORGE_BUILD_SHA: buildSha,
    TEMP: buildTemp,
    TMP: buildTemp,
  }

  console.log(
    `[build:web] base=${WEB_BUILD_BASE} outDir=${WEB_BUILD_OUT_DIR} `
    + `build=${buildSha} (来源 ${revision.source}, dirty=${revision.dirty === null ? '未知' : revision.dirty})`,
  )

  if (!skipTypeCheck) run('类型检查（tsc -b）', tscBin, ['-b'])
  run('Vite 生产构建', viteBin, ['build'], env)

  // 构建结束即清理临时目录：workbox 会在其中留下 sw.js 中间产物，
  // 留着既没意义，也会让 `eslint .`（虽已 ignore）之类的工具反复扫到垃圾。
  try {
    fs.rmSync(buildTemp, { recursive: true, force: true })
  } catch {
    // 清理失败不影响构建结果
  }

  return { base: WEB_BUILD_BASE, outDir: WEB_BUILD_OUT_DIR, buildSha, revision }
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isCli) runWebBuild()
