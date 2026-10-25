/**
 * Gist 云备份 store（FB-11 数据持久 · A）
 *
 * 把项目数据备份到 GitHub 私密 Gist —— 数据离开浏览器存到 GitHub 云端,
 * 清浏览器 / 换设备都不丢,可一键拉回。PAT 默认只存 sessionStorage,
 * 用户显式选择记住本机时才落 localStorage。
 */
import { create } from 'zustand'
import {
  exportToGist, importFromGist, validateGitHubPAT, listStoryforgeGists, listGistRevisions,
  type GistBackupMeta, type GistRevisionMeta,
} from '../lib/export/gist-export'
import { exportProjectJSON, importProjectJSON } from '../lib/export/json-export'
import { log } from '../lib/logging/logger'

const PAT_KEY = 'sf-gist-pat'
const USER_KEY = 'sf-gist-user'
const AUTO_KEY = 'sf-gist-auto'
const projKey = (projectId: number) => `sf-gist-proj-${projectId}`

interface ProjBackup { gistId: string; lastBackupAt: number }

function readProj(projectId: number): ProjBackup | null {
  try { const s = localStorage.getItem(projKey(projectId)); return s ? JSON.parse(s) : null } catch { return null }
}
function writeProj(projectId: number, v: ProjBackup) {
  localStorage.setItem(projKey(projectId), JSON.stringify(v))
}

function readSavedAuth(): { pat: string | null; username: string | null; rememberPat: boolean } {
  const sessionPat = sessionStorage.getItem(PAT_KEY)
  if (sessionPat) {
    return {
      pat: sessionPat,
      username: sessionStorage.getItem(USER_KEY),
      rememberPat: false,
    }
  }
  const localPat = localStorage.getItem(PAT_KEY)
  return {
    pat: localPat,
    username: localStorage.getItem(USER_KEY),
    rememberPat: !!localPat,
  }
}

function writeAuth(pat: string, username: string, rememberPat: boolean): void {
  const target = rememberPat ? localStorage : sessionStorage
  const other = rememberPat ? sessionStorage : localStorage
  target.setItem(PAT_KEY, pat)
  target.setItem(USER_KEY, username)
  other.removeItem(PAT_KEY)
  other.removeItem(USER_KEY)
}

function clearAuth(): void {
  localStorage.removeItem(PAT_KEY)
  localStorage.removeItem(USER_KEY)
  sessionStorage.removeItem(PAT_KEY)
  sessionStorage.removeItem(USER_KEY)
}

interface GistState {
  pat: string | null
  username: string | null
  rememberPat: boolean
  autoBackup: boolean
  busy: boolean
  error: string | null

  /** 连接 GitHub:验证 PAT 并保存 */
  connect: (pat: string, rememberPat?: boolean) => Promise<boolean>
  disconnect: () => void
  setAutoBackup: (on: boolean) => void
  /** 备份指定项目到云端(创建/更新该项目的 Gist) */
  backupProject: (projectId: number) => Promise<{ url: string } | null>
  /** 从指定 Gist 恢复(新建一个项目),返回新项目 id;传 sha 则恢复该历史版本 */
  restoreFromGist: (gistId: string, sha?: string) => Promise<number | null>
  /** 列出该账号下所有故事熔炉备份(换设备找回用) */
  listBackups: () => Promise<GistBackupMeta[]>
  /** 列出某项目云备份 Gist 的历史版本(版本回溯用) */
  listRevisions: (projectId: number) => Promise<GistRevisionMeta[]>
  /** 读某项目的本地备份状态(gistId / 上次备份时间) */
  projBackup: (projectId: number) => ProjBackup | null
}

const initialAuth = readSavedAuth()

export const useGistStore = create<GistState>((set, get) => ({
  pat: initialAuth.pat,
  username: initialAuth.username,
  rememberPat: initialAuth.rememberPat,
  autoBackup: localStorage.getItem(AUTO_KEY) === '1',
  busy: false,
  error: null,

  connect: async (pat, rememberPat = false) => {
    set({ busy: true, error: null })
    try {
      const login = await validateGitHubPAT(pat.trim())
      writeAuth(pat.trim(), login, rememberPat)
      set({ pat: pat.trim(), username: login, rememberPat, busy: false })
      return true
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : '连接失败' })
      return false
    }
  },

  disconnect: () => {
    clearAuth()
    localStorage.removeItem(AUTO_KEY)
    set({ pat: null, username: null, rememberPat: false, autoBackup: false })
  },

  setAutoBackup: (on) => {
    localStorage.setItem(AUTO_KEY, on ? '1' : '0')
    set({ autoBackup: on })
  },

  backupProject: async (projectId) => {
    const { pat } = get()
    if (!pat) { set({ error: '未连接 GitHub' }); return null }
    set({ busy: true, error: null })
    try {
      const data = await exportProjectJSON(projectId)
      const existing = readProj(projectId)
      const res = await exportToGist(data, { pat, gistId: existing?.gistId })
      writeProj(projectId, { gistId: res.gistId, lastBackupAt: Date.now() })
      set({ busy: false })
      // 云备份会把整份作品上传到 GitHub：这是数据离开本机的动作，必须留痕。
      // 只记规模与 gist id，绝不记 PAT 或正文。
      const chapters = Array.isArray((data as { chapters?: unknown[] }).chapters)
        ? (data as { chapters: unknown[] }).chapters.length
        : 0
      log.info(
        'GistAutoBackup',
        'gist.backup.done',
        `云备份完成：项目 #${projectId} 已上传（章节 ${chapters} 个，${existing?.gistId ? '更新既有 Gist' : '新建 Gist'}）`,
        {
          projectId,
          gistId: res.gistId,
          chapters,
          mode: existing?.gistId ? 'update' : 'create',
        },
      )
      return { url: res.url }
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : '备份失败' })
      // UI 仍显示 err.message（用户排错需要），但日志只记名称+帧，message 不写。
      log.error(
        'GistAutoBackup',
        'gist.backup.failed',
        `云备份失败：项目 #${projectId} 未上传成功`,
        { projectId },
        e,
      )
      return null
    }
  },

  restoreFromGist: async (gistId, sha) => {
    const { pat } = get()
    if (!pat) { set({ error: '未连接 GitHub' }); return null }
    set({ busy: true, error: null })
    try {
      const data = await importFromGist(gistId, pat, sha)
      const newId = await importProjectJSON(data as any)
      set({ busy: false })
      log.info(
        'GistAutoBackup',
        'gist.restore.done',
        `从云端恢复完成：Gist ${gistId} → 新项目 #${newId}`,
        { gistId, newProjectId: newId, revision: sha },
      )
      return newId
    } catch (e) {
      set({ busy: false, error: e instanceof Error ? e.message : '恢复失败' })
      // 恢复失败尤其重要：作者以为数据已从云端找回，实际没有。
      log.error(
        'GistAutoBackup',
        'gist.restore.failed',
        `从云端恢复失败：Gist ${gistId} 未能导入`,
        { gistId, revision: sha },
        e,
      )
      return null
    }
  },

  listBackups: async () => {
    const { pat } = get()
    if (!pat) return []
    return listStoryforgeGists(pat)
  },

  listRevisions: async (projectId) => {
    const { pat } = get()
    const proj = readProj(projectId)
    if (!pat || !proj?.gistId) return []
    return listGistRevisions(proj.gistId, pat)
  },

  projBackup: (projectId) => readProj(projectId),
}))
