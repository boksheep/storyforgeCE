import { useState, useRef, useEffect } from 'react'
import {
  Download, Upload, FileJson, FileText, FileType,
  Loader2, CheckCircle, AlertCircle, FolderOpen, X,
  History, Plus, Trash2, RotateCcw, HardDrive,
  ShieldAlert, Stethoscope, ScrollText,
} from 'lucide-react'
import { exportProjectJSON, downloadJSON, importProjectJSON, type ProjectExportData } from '../../lib/export/json-export'
import { downloadIndexedDBSnapshot, exportIndexedDBSnapshot, importIndexedDBSnapshot, parseIndexedDBSnapshot } from '../../lib/export/db-snapshot'
import { hasSensitiveSettings } from '../../lib/export/settings-snapshot'
import { exportProjectMarkdown, exportProjectTXT, downloadTextFile } from '../../lib/export/text-export'
import {
  isFSASupported, pickFolder, ensureFolderPermission, folderPermissionGranted,
  writeProjectJSONToFolder,
} from '../../lib/storage/folder-backup'
import { saveFolderHandle, loadFolderHandle, clearFolderHandle, projFolderKey, LAST_FOLDER_KEY } from '../../lib/storage/folder-handle-store'
import { useBackupStore } from '../../stores/backup'
import CloudBackupCard from './CloudBackupCard'
import LogStatusCard from './LogStatusCard'
import ContextMemoCard from './ContextMemoCard'
import { useToast } from '../shared/Toast'
import { useDialog } from '../shared/Dialog'
import { Button, type ButtonVariant } from '../shared/Button'
import { SaveStateIcon, saveFeedbackState, useSaveSuccessFeedback, type SaveFeedbackState } from '../shared/SaveSuccessFeedback'
import type { Project, Snapshot } from '../../lib/types'
import { buildLocalDiagnosticReport } from '../../lib/diagnostics/local-diagnostic-report'

type Tab = 'export' | 'backup'
type ExportStatus = 'idle' | 'loading' | 'success' | 'error'

interface Props {
  project: Project
  onImported?: (newProjectId: number) => void
}

export default function DataManagementPanel({ project, onImported }: Props) {
  const [activeTab, setActiveTab] = useState<Tab>('export')

  const TABS: { id: Tab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { id: 'export',    label: '导出 / 导入', icon: FileJson },
    { id: 'backup',    label: '版本历史',    icon: History },
  ]

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h2 className="text-xl font-bold text-text-primary mb-1">数据管理</h2>
        <p className="text-sm text-text-muted">备份、恢复、导出正文。（AI 解析导入请用左侧「文档导入」面板。）</p>
      </div>

      {/* Tab 切换：开/关型按钮 → 用 pressed 表达常驻选中态，不再手写选中/未选中两套配色 */}
      <div className="flex gap-1 bg-bg-elevated rounded-xl p-1 w-fit">
        {TABS.map(tab => {
          const Icon = tab.icon
          return (
            <Button
              key={tab.id}
              variant="ghost"
              size="md"
              pressed={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              icon={<Icon />}
            >
              {tab.label}
            </Button>
          )
        })}
      </div>

      {activeTab === 'export'    && <ExportTab    project={project} onImported={onImported} />}
      {activeTab === 'backup'    && <BackupTab    project={project} onImported={onImported} />}
    </div>
  )
}

// ── 导出/导入 Tab ────────────────────────────────────────────
function ExportTab({ project, onImported }: Props) {
  const dialog = useDialog()
  const [status, setStatus] = useState<ExportStatus>('idle')
  const [message, setMessage] = useState('')
  const [includeSensitiveSettings, setIncludeSensitiveSettings] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // ── 本地文件夹（句柄持久化 + 重新授权 + 自动备份，FB-11）──
  const [folderHandle, setFolderHandle] = useState<FileSystemDirectoryHandle | null>(null)
  const [folderName, setFolderName] = useState('')
  const [folderNeedsAuth, setFolderNeedsAuth] = useState(false)
  const [folderBusy, setFolderBusy] = useState(false)

  // 保存类按钮的「保存成功」动画：每个动作一份独立状态，谁成功谁亮，不互相串台
  const saveFeedback = useSaveSuccessFeedback()
  const bindFeedback = useSaveSuccessFeedback()
  const reauthFeedback = useSaveSuccessFeedback()

  // 进面板时把该项目已持久化的绑定读回来；授权仍有效则直接显示已绑定，失效则提示重新授权
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const h = await loadFolderHandle(projFolderKey(project.id!))
      if (!h || cancelled) return
      setFolderHandle(h)
      setFolderName(h.name)
      setFolderNeedsAuth(!(await folderPermissionGranted(h)))
    })()
    return () => { cancelled = true }
  }, [project.id])

  const show = (s: ExportStatus, msg: string) => {
    setStatus(s); setMessage(msg)
    if (s === 'success') setTimeout(() => setStatus('idle'), 4000)
  }

  const handleExportJSON = async () => {
    try {
      show('loading', '正在导出 JSON...')
      const data = await exportProjectJSON(project.id!)
      downloadJSON(data, `${project.name}_${new Date().toISOString().slice(0, 10)}.json`)
      show('success', 'JSON 导出成功！')
    } catch (e) { show('error', `导出失败：${(e as Error).message}`) }
  }

  const handleFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      show('loading', '正在导入项目...')
      const data: ProjectExportData = JSON.parse(await file.text())
      const newId = await importProjectJSON(data)
      show('success', '导入成功！')
      onImported?.(newId)
    } catch (err) { show('error', `导入失败：${(err as Error).message}`) }
    e.target.value = ''
  }

  const handleExportSnapshot = async () => {
    try {
      if (includeSensitiveSettings && !(await dialog.confirm({
        title: '确认导出高危设置？',
        message: '快照将包含 API Key、GitHub PAT 等凭据。文件一旦泄露，第三方可能直接使用你的服务，请仅通过可信渠道传输并在使用后删除文件。',
        confirmText: '确认导出凭据',
      }))) return
      show('loading', '正在导出 IndexedDB 快照...')
      const snapshot = await exportIndexedDBSnapshot(includeSensitiveSettings)
      downloadIndexedDBSnapshot(snapshot, `storyforge-snapshot-${new Date().toISOString().slice(0, 10)}.json`)
      show('success', `快照导出成功，共 ${snapshot.projects.length} 个项目${includeSensitiveSettings ? '，已包含高危设置' : ''}。`)
    } catch (e) { show('error', `快照导出失败：${(e as Error).message}`) }
  }

  const handleSnapshotSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const snapshot = parseIndexedDBSnapshot(JSON.parse(await file.text()))
      if (snapshot.projects.length === 0) throw new Error('快照中没有可导入的项目')
      const containsSensitive = hasSensitiveSettings(snapshot.settings)
       const confirmed = await dialog.confirm({
        title: `导入 ${snapshot.projects.length} 个项目？`,
        message: `将全部创建为项目副本，现有数据不会被覆盖。${containsSensitive ? '该文件包含 API Key / GitHub PAT 等高危设置，确认后会写入本机。' : '其中的普通设置也会同步到本机。'}`,
        confirmText: '导入为副本',
      })
      if (!confirmed) return
      show('loading', '正在导入 IndexedDB 快照...')
      const ids = await importIndexedDBSnapshot(snapshot, containsSensitive)
      show('success', `快照导入成功，新增 ${ids.length} 个项目。`)
      if (ids[0] != null) onImported?.(ids[0])
    } catch (err) { show('error', `快照导入失败：${(err as Error).message}`) }
    e.target.value = ''
  }

  const handleExportMarkdown = async () => {
    try {
      show('loading', '正在导出 Markdown...')
      const md = await exportProjectMarkdown(project.id!)
      downloadTextFile(md, `${project.name}_${new Date().toISOString().slice(0, 10)}.md`, 'text/markdown')
      show('success', 'Markdown 导出成功！')
    } catch (e) { show('error', `导出失败：${(e as Error).message}`) }
  }

  const handleExportTXT = async () => {
    try {
      show('loading', '正在导出 TXT...')
      const txt = await exportProjectTXT(project.id!)
      downloadTextFile(txt, `${project.name}_${new Date().toISOString().slice(0, 10)}.txt`)
      show('success', 'TXT 导出成功！')
    } catch (e) { show('error', `导出失败：${(e as Error).message}`) }
  }

  const handleDownloadDiagnostics = async () => {
    try {
      show('loading', '正在整理本地诊断信息...')
      const report = await buildLocalDiagnosticReport()
      downloadTextFile(
        JSON.stringify(report, null, 2),
        `storyforge-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
        'application/json',
      )
      show('success', '诊断信息已下载，不含作品内容与 API Key。')
    } catch (e) {
      show('error', `诊断信息生成失败：${(e as Error).message}`)
    }
  }

  // 绑定文件夹：选目录 → 请求授权 → 持久化句柄 → 立刻写一次
  const handleBindFolder = async () => {
    const h = await pickFolder()
    if (!h) return
    setFolderBusy(true)
    try {
      const ok = await ensureFolderPermission(h)
      if (!ok) { show('error', '未授予文件夹写入权限'); return }
      await saveFolderHandle(projFolderKey(project.id!), h)
      await saveFolderHandle(LAST_FOLDER_KEY, h)
      setFolderHandle(h); setFolderName(h.name); setFolderNeedsAuth(false)
      const wrote = await writeProjectJSONToFolder(h, project.id!)
      show(wrote ? 'success' : 'error', wrote ? `已绑定并保存到 / ${h.name}` : '绑定成功但写入失败')
      if (wrote) bindFeedback.markSuccess()
    } catch (e) { show('error', `绑定失败：${(e as Error).message}`) }
    finally { setFolderBusy(false) }
  }

  // 重新授权（更新/刷新后浏览器把权限降回 prompt 时，一次手势恢复）
  const handleReauthFolder = async () => {
    if (!folderHandle) return
    setFolderBusy(true)
    try {
      const ok = await ensureFolderPermission(folderHandle)
      if (!ok) { show('error', '仍未获授权'); return }
      setFolderNeedsAuth(false)
      // 写盘结果只决定要不要亮「保存成功」，成功提示文案保持原样（授权本身已成功）
      const wrote = await writeProjectJSONToFolder(folderHandle, project.id!)
      show('success', '已重新授权，本项目会自动写入该文件夹')
      if (wrote) reauthFeedback.markSuccess()
    } catch (e) { show('error', `授权失败：${(e as Error).message}`) }
    finally { setFolderBusy(false) }
  }

  const handleSaveToFolder = async () => {
    if (!folderHandle) return
    setFolderBusy(true)
    try {
      show('loading', '正在写入本地文件夹...')
      if (!(await ensureFolderPermission(folderHandle))) { show('error', '未获授权，无法写入'); setFolderNeedsAuth(true); return }
      const ok = await writeProjectJSONToFolder(folderHandle, project.id!)
      show(ok ? 'success' : 'error', ok ? '已保存到本地文件夹' : '写入失败，请重新绑定文件夹')
      if (ok) saveFeedback.markSuccess()
    } catch (e) { show('error', `写入失败：${(e as Error).message}`) }
    finally { setFolderBusy(false) }
  }

  const handleUnbindFolder = async () => {
    await clearFolderHandle(projFolderKey(project.id!))
    setFolderHandle(null); setFolderName(''); setFolderNeedsAuth(false)
  }

  return (
    <div className="space-y-4">
      {status !== 'idle' && (
        <StatusBar status={status} message={message} />
      )}

      <ContextMemoCard key={project.id} projectId={project.id!} projectName={project.name} />

      {/* JSON */}
      <SectionCard
        icon={<FileJson className="w-5 h-5 text-accent" />}
        title="JSON（完整备份）"
        desc="导出包含所有数据的完整备份文件，可用于恢复项目。"
      >
        <div className="flex gap-3 flex-wrap">
          <ActionButton onClick={handleExportJSON} disabled={status === 'loading'} variant="accent">
            <Download className="w-4 h-4" /> 导出 JSON
          </ActionButton>
          <ActionButton onClick={() => fileInputRef.current?.click()} disabled={status === 'loading'} variant="default">
            <Upload className="w-4 h-4" /> 导入 JSON
          </ActionButton>
          <input ref={fileInputRef} type="file" accept=".json" onChange={handleFileSelected} className="hidden" />
        </div>
      </SectionCard>

      {/* 云备份（GitHub Gist）—— 清浏览器/换设备都不丢 */}
      <SectionCard
         icon={<HardDrive className="w-5 h-5 text-emerald-400" />}
         title="IndexedDB 快照（跨设备迁移）"
         desc="导出全部项目和普通应用设置，导入会创建项目副本并同步设置；API Key、GitHub PAT 等高危凭据默认不会写入。"
       >
         <div className="flex gap-3 flex-wrap">
           <ActionButton onClick={handleExportSnapshot} disabled={status === 'loading'} variant="default">
             <Download className="w-4 h-4" /> 导出 IndexedDB 快照
           </ActionButton>
           <label className="flex items-start gap-2 text-xs text-text-secondary w-full max-w-xl">
             <input type="checkbox" checked={includeSensitiveSettings} onChange={e => setIncludeSensitiveSettings(e.target.checked)} className="mt-0.5 accent-red-500" />
             <span><strong className="text-red-400">允许导出高危凭据</strong>：包含 API Key、GitHub PAT 等数据。仅在可信设备之间使用，导出时仍会再次警告确认。</span>
           </label>
           <ActionButton onClick={() => document.getElementById('indexeddb-snapshot-input')?.click()} disabled={status === 'loading'} variant="default">
             <Upload className="w-4 h-4" /> 导入 IndexedDB 快照
           </ActionButton>
           <input id="indexeddb-snapshot-input" type="file" accept=".json,application/json" onChange={handleSnapshotSelected} className="hidden" />
         </div>
       </SectionCard>

       <CloudBackupCard projectId={project.id!} onImported={onImported} />

      {/* Markdown */}
      <SectionCard
        icon={<FileText className="w-5 h-5 text-blue-400" />}
        title="Markdown（正文导出）"
        desc="按大纲结构导出所有章节正文。"
      >
        <ActionButton onClick={handleExportMarkdown} disabled={status === 'loading'} variant="blue">
          <Download className="w-4 h-4" /> 导出 Markdown
        </ActionButton>
      </SectionCard>

      {/* TXT */}
      <SectionCard
        icon={<FileType className="w-5 h-5 text-yellow-400" />}
        title="纯文本 TXT"
        desc="适合直接发布到小说平台。"
      >
        <ActionButton onClick={handleExportTXT} disabled={status === 'loading'} variant="yellow">
          <Download className="w-4 h-4" /> 导出 TXT
        </ActionButton>
      </SectionCard>

      {/* 本地文件夹 */}
      <SectionCard
        icon={<FolderOpen className="w-5 h-5 text-orange-400" />}
        title="本地文件夹自动备份"
        desc="绑定后，进入本项目会自动把完整数据写入该文件夹（打开时 + 每 5 分钟）。绑定跨刷新/更新保留；换设备或数据重置后，可在首页「从本地文件夹恢复」。"
        badge={!isFSASupported() ? '仅 Chrome/Edge 支持' : undefined}
      >
        {folderHandle ? (
          <div className="space-y-2">
            {folderNeedsAuth ? (
              <div className="flex items-center gap-2 text-sm text-amber-400 bg-amber-500/10 px-3 py-2 rounded-lg">
                <ShieldAlert className="w-4 h-4 shrink-0" />
                <span className="flex-1 truncate">已绑定「{folderName}」，但浏览器需重新授权才能自动写入</span>
                <Button variant="ghost" size="xs" iconOnly onClick={handleUnbindFolder} aria-label="解除文件夹绑定" title="解除文件夹绑定"><X /></Button>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-green-400 bg-green-500/10 px-3 py-2 rounded-lg">
                <FolderOpen className="w-4 h-4 shrink-0" />
                <span className="flex-1 truncate">已绑定：{folderName}（自动写入已生效）</span>
                <Button variant="ghost" size="xs" iconOnly onClick={handleUnbindFolder} aria-label="解除文件夹绑定" title="解除文件夹绑定"><X /></Button>
              </div>
            )}
            <div className="flex gap-2 flex-wrap">
              {folderNeedsAuth && (
                <ActionButton
                  onClick={handleReauthFolder}
                  disabled={folderBusy}
                  variant="orange"
                  saveState={saveFeedbackState(reauthFeedback.succeeded, folderBusy)}
                  idleIcon={<ShieldAlert className="w-4 h-4" />}
                >
                  重新授权
                </ActionButton>
              )}
              <ActionButton
                onClick={handleSaveToFolder}
                disabled={folderBusy || status === 'loading'}
                variant={folderNeedsAuth ? 'default' : 'orange'}
                saveState={saveFeedbackState(saveFeedback.succeeded, folderBusy)}
                idleIcon={<Download className="w-4 h-4" />}
              >
                {folderBusy ? '写入中...' : '立即保存'}
              </ActionButton>
            </div>
          </div>
        ) : (
          <ActionButton
            onClick={handleBindFolder}
            disabled={!isFSASupported() || folderBusy || status === 'loading'}
            variant="orange"
            saveState={saveFeedbackState(bindFeedback.succeeded, folderBusy)}
            idleIcon={<FolderOpen className="w-4 h-4" />}
          >
            选择本地文件夹
          </ActionButton>
        )}
      </SectionCard>

      <SectionCard
        icon={<Stethoscope className="w-5 h-5 text-teal-400" />}
        title="本地诊断信息"
        desc="仅包含应用/浏览器版本、数据库表记录数量和本次页面会话的错误位置；不包含作品正文、设定、API Key 或 localStorage 内容，也不会自动上传。"
      >
        <ActionButton onClick={handleDownloadDiagnostics} disabled={status === 'loading'} variant="default">
          <Download className="w-4 h-4" /> 下载诊断信息
        </ActionButton>
      </SectionCard>

      {/* LOG-1：运行日志落盘状态（桌面写应用目录，浏览器写绑定文件夹的 log/ 子目录） */}
      <SectionCard
        icon={<ScrollText className="w-5 h-5 text-teal-400" />}
        title="运行日志"
        desc="按天写入 txt（默认保留 14 天）。只记录元数据：不写作品正文、设定、提示词或 API Key。"
      >
        <LogStatusCard />
      </SectionCard>
    </div>
  )
}

// ── 版本历史 Tab ─────────────────────────────────────────────
function BackupTab({ project }: Props) {
  const { snapshots, loading, loadSnapshots, createSnapshot, deleteSnapshot, restoreSnapshot } = useBackupStore()
  const toast = useToast()
  const dialog = useDialog()
  const [creating, setCreating] = useState(false)
  const [restoring, setRestoring] = useState<number | null>(null)
  const [label, setLabel] = useState('')
  const [showForm, setShowForm] = useState(false)

  useState(() => { loadSnapshots(project.id!) })

  const handleCreate = async () => {
    setCreating(true)
    try {
      await createSnapshot(project.id!, label.trim() || `手动备份 ${new Date().toLocaleString('zh-CN')}`, 'manual')
      toast.success('快照创建成功')
      setLabel(''); setShowForm(false)
    } catch (err) {
      toast.error('快照创建失败: ' + (err as Error).message)
    } finally { setCreating(false) }
  }

  const handleRestore = async (snap: Snapshot) => {
    const ok = await dialog.confirm({
      title: `恢复快照「${snap.label}」？`,
      message: '将创建一个新项目，不会覆盖当前项目。',
      confirmText: '恢复为新项目',
    })
    if (!ok) return
    setRestoring(snap.id!)
    try {
      await restoreSnapshot(snap.id!)
      toast.success('恢复成功，已创建新项目')
    } catch (err) { toast.error('恢复失败: ' + (err as Error).message) }
    finally { setRestoring(null) }
  }

  return (
    <div className="space-y-4">
      {/* 新建快照 */}
      <div className="bg-bg-surface border border-border rounded-lg p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <HardDrive className="w-4 h-4 text-accent" />
            <span className="text-sm font-medium text-text-primary">创建快照</span>
          </div>
          <Button
            variant="ghost-accent"
            size="xs"
            onClick={() => setShowForm(!showForm)}
          >
            {showForm ? '收起' : '+ 新建'}
          </Button>
        </div>
        {showForm && (
          <div className="flex gap-2">
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="快照备注（可选）"
              className="flex-1 px-3 py-1.5 bg-bg-base border border-border rounded text-sm text-text-primary focus:outline-none focus:border-accent"
            />
            <Button
              variant="primary"
              size="md"
              onClick={handleCreate}
              loading={creating}
              loadingText="创建中…"
              icon={<Plus />}
            >
              创建
            </Button>
          </div>
        )}
      </div>

      {/* 快照列表 */}
      <div className="space-y-2">
        {loading && (
          <div className="flex items-center justify-center py-8 text-text-muted">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> 加载中...
          </div>
        )}
        {!loading && snapshots.length === 0 && (
          <div className="text-center text-text-muted text-sm py-10">
            <History className="w-8 h-8 mx-auto mb-2 opacity-30" />
            暂无快照，创建第一个吧
          </div>
        )}
        {snapshots.map(snap => (
          <div key={snap.id} className="bg-bg-surface border border-border rounded-lg p-3 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">{snap.label}</p>
              <p className="text-xs text-text-muted">{new Date(snap.createdAt).toLocaleString('zh-CN')}</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                iconOnly
                onClick={() => handleRestore(snap)}
                loading={restoring === snap.id}
                title="从此快照恢复"
                aria-label="从此快照恢复"
              >
                <RotateCcw />
              </Button>
              <Button
                variant="danger-soft"
                size="sm"
                iconOnly
                onClick={() => deleteSnapshot(snap.id!)}
                title="删除快照"
                aria-label="删除快照"
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── 共用小组件 ───────────────────────────────────────────────
function StatusBar({ status, message }: { status: ExportStatus; message: string }) {
  const cls = status === 'loading' ? 'bg-accent/10 text-accent'
    : status === 'success' ? 'bg-green-500/10 text-green-400'
    : 'bg-red-500/10 text-red-400'
  return (
    <div className={`flex items-center gap-2 px-4 py-3 rounded-lg text-sm ${cls}`}>
      {status === 'loading' && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
      {status === 'success' && <CheckCircle className="w-4 h-4 shrink-0" />}
      {status === 'error'   && <AlertCircle className="w-4 h-4 shrink-0" />}
      <span>{message}</span>
    </div>
  )
}

function SectionCard({
  icon, title, desc, badge, children,
}: {
  icon: React.ReactNode; title: string; desc: string; badge?: string; children: React.ReactNode
}) {
  return (
    <div className="bg-bg-surface border border-border rounded-lg p-5 space-y-3">
      <h3 className="text-sm font-semibold text-text-primary flex items-center gap-2">
        {icon} {title}
        {badge && <span className="text-xs text-text-muted bg-bg-elevated px-2 py-0.5 rounded ml-auto">{badge}</span>}
      </h3>
      <p className="text-xs text-text-muted">{desc}</p>
      {children}
    </div>
  )
}

type ActionVariant = 'accent' | 'default' | 'blue' | 'yellow' | 'orange'

/** 业务语义 → 统一按钮 variant。配色一律由 Button 决定，这里不再手写 hover/disabled 类名。 */
const ACTION_VARIANT: Record<ActionVariant, ButtonVariant> = {
  accent: 'primary',
  default: 'secondary',
  blue: 'info-soft',
  yellow: 'warning-soft',
  orange: 'warning-soft',
}

function ActionButton({
  onClick, disabled, variant, children, saveState, idleIcon,
}: {
  onClick: () => void; disabled?: boolean; variant: ActionVariant; children: React.ReactNode
  /** 保存类按钮：给定时按钮上暴露 data-save-state（idle/loading/success），并把前导图标交给 SaveStateIcon 统一渲染 */
  saveState?: SaveFeedbackState
  idleIcon?: React.ReactNode
}) {
  const state = saveState ?? 'idle'
  const isSaveButton = idleIcon !== undefined
  return (
    <Button
      variant={ACTION_VARIANT[variant]}
      size="md"
      onClick={onClick}
      disabled={disabled}
      loading={isSaveButton && state === 'loading'}
      data-save-state={isSaveButton ? state : undefined}
      icon={isSaveButton ? <SaveStateIcon state={state} idle={idleIcon} /> : idleIcon}
    >
      {children}
    </Button>
  )
}
