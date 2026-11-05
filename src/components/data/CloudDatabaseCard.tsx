/**
 * CLOUD-DB-1 · 云数据库卡片
 *
 * 与 `CloudBackupCard`（GitHub Gist 备份）并列，两者互不取代：
 *   - Gist 备份：整项目 JSON 快照，手动/半自动，云端只有版本历史
 *   - 云数据库：账号 + 服务端 SQLite，登录后自动同步，可换设备
 *
 * 文案纪律（重要）：
 *   - **不得**暗示"端到端加密"或"服务器看不到手稿" —— 同步通道是服务端可读的明文 SQLite
 *   - **不得**暗示"上云就等于有备份" —— 云端是副本，本地才是主副本
 */
import { useEffect, useState } from 'react'
import {
  AlertTriangle, CheckCircle2, Cloud, CloudOff, CloudUpload,
  LogIn, LogOut, RefreshCw, ShieldCheck,
} from 'lucide-react'
import { useCloudAuth } from '../../stores/cloud-auth'
import { useCloudSync } from '../../stores/cloud-sync'
import { openCloudDialog } from '../../stores/cloud-dialog'
import { getSyncUid } from '../../lib/cloud/project-identity'
import { useToast } from '../shared/Toast'
import { useDialog } from '../shared/Dialog'
import { Button } from '../shared/Button'

interface Props {
  projectId: number
  onImported?: (newProjectId: number) => void
}

function formatTime(timestamp: number | null): string {
  if (!timestamp) return '—'
  try {
    return new Date(timestamp).toLocaleString()
  } catch {
    return '—'
  }
}

export default function CloudDatabaseCard({ projectId, onImported }: Props) {
  const auth = useCloudAuth()
  const sync = useCloudSync()
  const toast = useToast()
  const dialog = useDialog()

  const [busy, setBusy] = useState(false)
  const [boundUid, setBoundUid] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void getSyncUid(projectId).then(uid => {
      if (!cancelled) setBoundUid(uid)
    })
    return () => { cancelled = true }
  }, [projectId, sync.lastPushAt])

  const withBusy = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }

  const handleLogout = () => withBusy(async () => {
    await useCloudAuth.getState().logout()
    toast.info('已退出登录，本地数据不受影响')
  })

  const handleSyncNow = () => withBusy(async () => {
    const engine = await import('../../lib/cloud/sync-engine')
    await engine.flushNow()
    const state = useCloudSync.getState()
    if (state.phase === 'conflict') return
    if (state.lastError) toast.error(state.lastError)
    else toast.success('已检查并推送最新改动')
  })

  const handleDisable = async () => {
    const confirmed = await dialog.confirm({
      title: '停用云数据库？',
      message: '本地手稿不受影响，只是不再同步到服务器。之后可以随时重新启用并登录。',
      confirmText: '停用',
      tone: 'danger',
    })
    if (!confirmed) return
    const { shutdownCloud } = await import('../../lib/cloud/boot')
    shutdownCloud()
    useCloudAuth.getState().disableCloud()
    toast.info('已停用云数据库')
  }

  const handleResolve = (choice: 'pull' | 'push' | 'keep-both') => withBusy(async () => {
    const engine = await import('../../lib/cloud/sync-engine')
    const result = await engine.resolveConflict(choice)
    if (!result.ok) {
      toast.error(useCloudSync.getState().lastError ?? '处理失败')
      return
    }
    toast.success(choice === 'push' ? '已用本地版本覆盖云端' : '已把云端版本拉成本地项目')
    if (result.projectId != null) onImported?.(result.projectId)
  })

  // ── 未启用 / 未登录：统一收敛到"打开账号弹窗" ─────────────────────────────
  //
  // 登录表单只在 `CloudAccountDialog` 里维护一份。这里再放一份会带来两个问题：
  //   ① 同一个登录动作有两套状态（本地 useState vs store），容易不同步
  //   ② 从顶栏打开弹窗后，卡片里还留着一个表单，用户不知道该用哪个
  // 所以卡片只保留"说明 + 入口按钮"，真正的表单在弹窗里。
  if (!auth.enabled || auth.status !== 'authed') {
    const connected = auth.enabled
    return (
      <div className="bg-bg-surface border border-border rounded-lg p-4">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2">
            <Cloud className="w-4 h-4 text-accent" />
            <h4 className="text-sm font-medium text-text-primary">
              {connected ? '云数据库 · 未登录' : '云数据库（可选）'}
            </h4>
          </div>
          {connected && (
            <span className="text-[11px] text-text-secondary truncate max-w-[180px]" title={auth.apiBase}>
              {auth.apiBase}
            </span>
          )}
        </div>

        {auth.status === 'offline' && (
          <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 mb-2">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>暂时连不上服务器，本地写作不受影响。恢复后会自动重试。</span>
          </div>
        )}

        <p className="text-xs text-text-secondary mb-3 leading-relaxed">
          把项目同步到自己的服务器数据库，换设备登录即可继续写。
          <strong className="text-text-primary">本地 IndexedDB 始终是主副本</strong>，
          服务器只是副本；停用或服务器故障都不会影响本地写作。
        </p>

        <div className="flex items-center gap-2">
          <Button
            variant="primary"
            size="sm"
            onClick={() => openCloudDialog('login')}
            icon={<LogIn />}
          >
            {connected ? '登录' : '连接云数据库'}
          </Button>
          {connected && (
            <Button variant="ghost" size="sm" onClick={handleDisable}>停用</Button>
          )}
        </div>
        <p className="text-[11px] text-text-secondary mt-2">
          账号由服务器管理员创建，没有自助注册。
        </p>
      </div>
    )
  }

  // ── 已登录 ────────────────────────────────────────────────────────────────
  const conflict = sync.conflict
  const phaseLabel: Record<string, string> = {
    idle: '已就绪',
    syncing: '同步中…',
    offline: '离线',
    error: '同步出错',
    conflict: '需要你决定',
    disabled: '未启用',
  }

  return (
    <div className="bg-bg-surface border border-border rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-500" />
          <h4 className="text-sm font-medium text-text-primary">云数据库</h4>
          <span className="text-[11px] px-1.5 py-0.5 rounded bg-bg-base border border-border text-text-secondary">
            {phaseLabel[sync.phase] ?? sync.phase}
          </span>
        </div>
        <span className="text-[11px] text-text-secondary">
          {auth.user?.username} · {auth.apiBase}
        </span>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-text-secondary mb-3">
        <div className="flex justify-between">
          <dt>上次同步</dt>
          <dd className="text-text-primary">{formatTime(sync.lastPushAt)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>待推送</dt>
          <dd className="text-text-primary">{sync.dirtyCount} 项</dd>
        </div>
        <div className="flex justify-between">
          <dt>本项目</dt>
          <dd className="text-text-primary">{boundUid ? '已绑定云端' : '尚未同步'}</dd>
        </div>
        <div className="flex justify-between">
          <dt>本次已推</dt>
          <dd className="text-text-primary">{sync.pushedCount} 次</dd>
        </div>
      </dl>

      {sync.lastError && (
        <div className="flex items-start gap-2 text-xs text-red-500 mb-2">
          <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{sync.lastError}</span>
        </div>
      )}

      {conflict && (
        <div className="border border-amber-500/40 bg-amber-500/5 rounded p-3 mb-3">
          <div className="flex items-center gap-2 text-xs font-medium text-amber-600 dark:text-amber-400 mb-1">
            <AlertTriangle className="w-3.5 h-3.5" />
            「{conflict.projectName}」在云端也有改动（云端 rev {conflict.remote.rev}）
          </div>
          <p className="text-[11px] text-text-secondary mb-2 leading-relaxed">
            两台设备改了同一个项目。请选择保留哪一份 —— 无论选哪个，都不会静默丢数据：
            覆盖云端前服务器会先留一份快照，拉取云端则会新建一个项目而不是就地覆盖。
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" size="sm" loading={busy} onClick={() => handleResolve('pull')}>
              用云端版本
            </Button>
            <Button variant="outline" size="sm" loading={busy} onClick={() => handleResolve('push')}>
              用本地覆盖云端
            </Button>
            <Button variant="ghost" size="sm" loading={busy} onClick={() => handleResolve('keep-both')}>
              两份都留
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          loading={busy || sync.phase === 'syncing'}
          onClick={handleSyncNow}
        >
          <RefreshCw className="w-3.5 h-3.5" />
          立即同步
        </Button>
        <Button variant="ghost" size="sm" onClick={handleLogout}>
          <LogOut className="w-3.5 h-3.5" />
          退出登录
        </Button>
        <Button variant="ghost" size="sm" onClick={handleDisable}>
          <CloudOff className="w-3.5 h-3.5" />
          停用
        </Button>
      </div>

      <p className="text-[11px] text-text-secondary mt-3 leading-relaxed">
        <CloudUpload className="w-3 h-3 inline mr-1" />
        云端是<strong className="text-text-primary">副本</strong>，不是唯一副本：
        服务器故障时本地照常写作，但请继续用「导出 JSON」做自己的备份。
        同步内容为项目 JSON 明文，服务器管理员可见。
      </p>

      {sync.pushedCount > 0 && (
        <p className="text-[11px] text-emerald-600 dark:text-emerald-400 mt-1">
          <CheckCircle2 className="w-3 h-3 inline mr-1" />
          同步正常
        </p>
      )}
    </div>
  )
}
