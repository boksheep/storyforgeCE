/* global console, process */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

/**
 * WEB-DEPLOY-1 · 构建版本标识解析（无第三方依赖，跨平台）。
 *
 * 需要它的原因：网页云端发布包必须能回答「这一包是哪个提交、是否含未提交改动」。
 * vite.config.ts 里的 `resolveBuildSha()` 依赖 `execSync` 的**管道 stdio**，
 * 在受限沙箱（Windows 上禁止程序打开命名管道 → EPERM）里会静默降级成 `local`，
 * 于是发布包会丢失可追溯性。这里按三级降级拿到同样的信息：
 *
 *   ① `STORYFORGE_BUILD_SHA` 环境变量显式注入（CI / 受限环境）
 *   ② 直接调用 git（普通开发机）
 *   ③ 直接读 `.git` 目录（不允许 spawn 时的兜底；dirty 记为 null = 未知）
 */

/** 读取 `.git` 目录（兼容 worktree / submodule 的 `gitdir:` 指针文件写法）。 */
function resolveGitDir(root) {
  const dotGit = path.join(root, '.git')
  let stat
  try {
    stat = fs.statSync(dotGit)
  } catch {
    return null
  }
  if (stat.isDirectory()) return dotGit
  try {
    const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim()
    if (!pointer) return null
    return path.isAbsolute(pointer) ? pointer : path.resolve(root, pointer)
  } catch {
    return null
  }
}

/** 从 `.git/HEAD`（含 packed-refs 兜底）直接解析出短 SHA。 */
export function readGitHeadSha(root, length = 7) {
  const gitDir = resolveGitDir(root)
  if (!gitDir) return null
  let head
  try {
    head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return null
  }
  if (!head.startsWith('ref:')) return head.slice(0, length)
  const ref = head.slice(4).trim()
  try {
    return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, length)
  } catch {
    // 引用可能被打包进 packed-refs
  }
  try {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
    const line = packed.split('\n').find(entry => entry.endsWith(` ${ref}`))
    return line ? line.split(' ')[0].slice(0, length) : null
  } catch {
    return null
  }
}

/**
 * @returns {{sha: string, dirty: boolean|null, source: 'env'|'git'|'dotgit'|'unknown'}}
 *   `dirty === null` 表示无法判定（受限环境下未装 git 或不允许 spawn）。
 */
export function resolveGitRevision(root = process.cwd()) {
  const injected = (process.env.STORYFORGE_BUILD_SHA ?? '').trim()
  if (injected) {
    return {
      sha: injected.replace(/-dirty$/, ''),
      dirty: /-dirty$/.test(injected),
      source: 'env',
    }
  }

  try {
    const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim()
    let dirty = null
    try {
      dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
        cwd: root,
        encoding: 'utf8',
      }).trim().length > 0
    } catch {
      dirty = null
    }
    if (sha) return { sha, dirty, source: 'git' }
  } catch {
    // 受限环境（EPERM）或未安装 git → 走 .git 兜底
  }

  const sha = readGitHeadSha(root)
  return sha
    ? { sha, dirty: null, source: 'dotgit' }
    : { sha: 'local', dirty: null, source: 'unknown' }
}

/** 与 vite.config.ts 的 `resolveBuildSha()` 保持同一格式：脏树带 `-dirty` 后缀。 */
export function formatBuildSha({ sha, dirty }) {
  return dirty === true ? `${sha}-dirty` : sha
}

/** 当前分支名（detached HEAD 返回 `HEAD`）。只读 `.git`，不 spawn。 */
export function readGitBranch(root = process.cwd()) {
  const injected = (process.env.STORYFORGE_BUILD_BRANCH ?? '').trim()
  if (injected) return injected
  const gitDir = resolveGitDir(root)
  if (!gitDir) return 'unknown'
  try {
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
    return head.startsWith('ref:') ? head.slice(4).trim().replace(/^refs\/heads\//, '') : 'HEAD'
  } catch {
    return 'unknown'
  }
}
