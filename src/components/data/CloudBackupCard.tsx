/**
 * 云备份卡（GitHub Gist）—— FB-11 数据持久 · A
 *
 * 把项目备份到 GitHub 私密 Gist：数据离开浏览器存到云端，清浏览器 / 换设备都不丢，可一键拉回。
 * 需要用户提供一个带 `gist` 权限的 GitHub Personal Access Token（opt-in）。
 */
import { useState } from 'react'
import { Cloud, CloudUpload, CloudDownload, Check, LogOut, ExternalLink, History } from 'lucide-react'
import { useGistStore } from '../../stores/gist'
import type { GistBackupMeta, GistRevisionMeta } from '../../lib/export/gist-export'
import { useDialog } from '../shared/Dialog'
import { Button } from '../shared/Button'
import { SaveStateIcon, saveFeedbackState, useSaveSuccessFeedback } from '../shared/SaveSuccessFeedback'

interface Props {
  projectId: number
  onImported?: (newId: number) => void
}

export default function CloudBackupCard({ projectId, onImported }: Props) {
  const { pat, username, rememberPat, autoBackup, busy, error, connect, disconnect, backupProject, restoreFromGist, listBackups, listRevisions, setAutoBackup, projBackup } = useGistStore()
  const dialog = useDialog()
  const [patInput, setPatInput] = useState('')
  const [rememberPatInput, setRememberPatInput] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [backups, setBackups] = useState<GistBackupMeta[] | null>(null)
  const [revisions, setRevisions] = useState<GistRevisionMeta[] | null>(null)
  const proj = projBackup(projectId)
  // 云备份成功后的按钮内动画（与本地文件夹保存同一套：转圈 → 打勾 pop → 自动回落）
  const backupFeedback = useSaveSuccessFeedback()
  const backupSaveState = saveFeedbackState(backupFeedback.succeeded, busy)

  const handleConnect = async () => {
    if (!patInput.trim()) return
    const ok = await connect(patInput, rememberPatInput)
    if (ok) { setPatInput(''); setRememberPatInput(false); setMsg('已连接 GitHub') }
  }
  const handleBackup = async () => {
    setMsg(null)
    const r = await backupProject(projectId)
    if (r) { setMsg('✓ 已备份到云端'); backupFeedback.markSuccess() }
  }
  const handleShowRestore = async () => {
    setMsg(null)
    setRevisions(null)
    setBackups(await listBackups())
  }
  const handleRestore = async (gistId: string, title: string) => {
    const ok = await dialog.confirm({
      title: `从云端恢复「${title}」？`,
      message: '将新建一个项目，不会覆盖当前项目。',
      confirmText: '恢复为新项目',
    })
    if (!ok) return
    const newId = await restoreFromGist(gistId)
    if (newId) { setMsg('✓ 已从云端恢复为新项目'); setBackups(null); onImported?.(newId) }
  }
  const handleShowRevisions = async () => {
    setMsg(null)
    setBackups(null)
    const list = await listRevisions(projectId)
    setRevisions(list)
    if (list.length === 0) setMsg('该项目暂无云端历史版本（先备份一次，之后每次备份都会自动留一版）。')
  }
  const handleRestoreRevision = async (rev: GistRevisionMeta) => {
    if (!proj?.gistId) return
    const when = new Date(rev.committedAt).toLocaleString('zh-CN')
    const ok = await dialog.confirm({
      title: `恢复 ${when} 这一版？`,
      message: '将新建一个项目，不会覆盖当前项目。',
      confirmText: '恢复为新项目',
    })
    if (!ok) return
    const newId = await restoreFromGist(proj.gistId, rev.version)
    if (newId) { setMsg(`✓ 已恢复 ${when} 的版本为新项目`); setRevisions(null); onImported?.(newId) }
  }

  return (
    <div className="bg-bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        <Cloud className="w-5 h-5 text-sky-400" />
        <h3 className="text-sm font-semibold text-text-primary">云备份（GitHub）</h3>
      </div>
      <p className="text-xs text-text-muted mb-3">
        备份到你的 GitHub 私密 Gist —— 数据存在云端，<strong>清浏览器 / 换设备都不丢</strong>，可一键拉回。
      </p>

      {!pat ? (
        // 未连接:填 PAT
        <div className="space-y-2">
          <input
            type="password"
            value={patInput}
            onChange={e => setPatInput(e.target.value)}
            placeholder="粘贴 GitHub Personal Access Token（需 gist 权限）"
            className="w-full px-3 py-2 bg-bg-base border border-border rounded text-sm text-text-primary focus:outline-none focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <Button
              variant="primary"
              size="md"
              onClick={handleConnect}
              disabled={busy || !patInput.trim()}
              loading={busy}
              icon={<Cloud />}
            >
              连接 GitHub
            </Button>
            <a href="https://github.com/settings/tokens/new?scopes=gist&description=storyforge-backup" target="_blank" rel="noreferrer"
              className="text-xs text-sky-400 hover:underline flex items-center gap-0.5">
              如何创建 Token <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <label className="flex items-start gap-2 text-[11px] text-text-secondary cursor-pointer">
            <input
              type="checkbox"
              checked={rememberPatInput}
              onChange={e => setRememberPatInput(e.target.checked)}
              className="mt-0.5 accent-sky-400"
            />
            <span>在本机记住 Token（写入 localStorage）。不勾选时仅本次浏览器会话有效。</span>
          </label>
          <p className="text-[11px] text-text-muted">
            云备份会把完整项目 JSON 明文上传到你的 GitHub 私密 Gist；Private Gist 不是端到端加密保险箱。
          </p>
        </div>
      ) : (
        // 已连接
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-success" /> 已连接 <strong>@{username}</strong>
              <em className="not-italic text-[10px] text-text-muted">
                {rememberPat ? '已在本机记住' : '仅本会话'}
              </em>
            </span>
            <Button variant="ghost" size="xs" onClick={() => { disconnect(); setBackups(null) }} icon={<LogOut />}>
              断开
            </Button>
          </div>
          <p className="text-[11px] text-text-muted">
            备份内容会作为完整项目 JSON 明文上传到 GitHub 私密 Gist；Token {rememberPat ? '保存在本机 localStorage' : '仅保存在本次浏览器会话'}。
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              size="md"
              onClick={handleBackup}
              disabled={busy}
              loading={backupSaveState === 'loading'}
              data-save-state={backupSaveState}
              icon={
                <SaveStateIcon
                  state={backupSaveState}
                  idle={<CloudUpload />}
                  successClassName="text-white"
                />
              }
            >
              立即备份到云端
            </Button>
            <Button variant="secondary" size="md" onClick={handleShowRestore} disabled={busy} icon={<CloudDownload />}>
              从云端恢复
            </Button>
            {proj?.gistId && (
              <Button variant="secondary" size="md" onClick={handleShowRevisions} disabled={busy} icon={<History />}>
                本项目历史版本
              </Button>
            )}
          </div>

          <label className="flex items-center gap-2 text-xs text-text-secondary cursor-pointer">
            <input type="checkbox" checked={autoBackup} onChange={e => setAutoBackup(e.target.checked)} className="accent-sky-400" />
            自动备份（每隔几分钟把改动推到云端）
          </label>

          {proj?.lastBackupAt && (
            <p className="text-[11px] text-text-muted">本项目上次云备份：{new Date(proj.lastBackupAt).toLocaleString('zh-CN')}</p>
          )}

          {backups && (
            <div className="border border-border rounded p-2 space-y-1 max-h-48 overflow-y-auto bg-bg-base">
              {backups.length === 0 ? (
                <p className="text-xs text-text-muted">云端暂无备份。</p>
              ) : backups.map(b => (
                <button key={b.gistId} onClick={() => handleRestore(b.gistId, b.description || b.filename)}
                  className="w-full text-left px-2 py-1.5 rounded hover:bg-bg-hover text-xs">
                  <div className="text-text-primary truncate">{b.description || b.filename}</div>
                  <div className="text-[10px] text-text-muted">更新于 {new Date(b.updatedAt).toLocaleString('zh-CN')}</div>
                </button>
              ))}
            </div>
          )}

          {revisions && revisions.length > 0 && (
            <div className="border border-border rounded bg-bg-base">
              <div className="px-2 py-1.5 border-b border-border flex items-center gap-1.5">
                <History className="w-3.5 h-3.5 text-sky-400" />
                <span className="text-[11px] text-text-secondary">本项目历史版本（每次备份留一版，最新在上 · 选一版恢复为新项目）</span>
              </div>
              <div className="p-2 space-y-1 max-h-56 overflow-y-auto">
                {revisions.map((rev, i) => (
                  <button key={rev.version} onClick={() => handleRestoreRevision(rev)} disabled={busy}
                    className="w-full text-left px-2 py-1.5 rounded hover:bg-bg-hover text-xs disabled:opacity-50 flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5">
                      <span className="text-text-primary">{new Date(rev.committedAt).toLocaleString('zh-CN')}</span>
                      {i === 0 && <span className="text-[10px] px-1 rounded bg-sky-500/20 text-sky-400">最新</span>}
                    </span>
                    <span className="text-[10px] text-text-muted shrink-0">
                      {rev.additions != null && rev.deletions != null ? `+${rev.additions} / -${rev.deletions}` : ''}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {(msg || error) && (
        <p className={`text-xs mt-2 ${error ? 'text-error' : 'text-success'}`}>{error || msg}</p>
      )}
    </div>
  )
}
