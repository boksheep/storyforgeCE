/**
 * CLOUD-DB-1 · 云数据库账号弹窗（全局唯一实例）
 *
 * 一个弹窗承担三件事，按"当前处于哪一步"切换，而不是三个独立弹窗：
 *   ① 还没配置服务器 → 填地址并连接
 *   ② 已配置未登录   → 账号密码（必要时带图形验证码）
 *   ③ 已登录        → 云端占用、在线状态、立即同步、退出
 *
 * ## 为什么必须"全局唯一"
 *
 * 触发点有四个（首页顶栏 / 工作区顶栏 / 数据管理卡片 / 设置区菜单）。
 * 如果每个触发点各挂一份弹窗，就会出现"两个遮罩叠在一起、Escape 只关掉一个"
 * 的经典 bug。所以状态在 `useCloudDialog`，组件只在 `App` 挂一次。
 *
 * ## 文案纪律（与 CloudDatabaseCard 一致）
 *
 *   - 不得暗示"端到端加密"或"服务器看不到手稿"
 *   - 不得暗示"上云就等于有备份"——云端是副本，本地才是主副本
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertTriangle, Cloud, CloudOff, HardDrive, LogOut, RefreshCw, ShieldCheck, X,
} from 'lucide-react'
import { useCloudAuth } from '../../stores/cloud-auth'
import { useCloudSync } from '../../stores/cloud-sync'
import { useCloudUsage } from '../../stores/cloud-usage'
import { useCloudDialog } from '../../stores/cloud-dialog'
import { formatBytes, formatRelativeTime } from '../../lib/cloud/format'
import { useToast } from '../shared/Toast'
import { useDialog } from '../shared/Dialog'
import { Button } from '../shared/Button'

const inputClass =
  'w-full px-3 py-2 bg-bg-base border border-border rounded text-sm text-text-primary '
  + 'placeholder-text-muted focus:outline-none focus:border-accent transition-colors'

/** 在线状态点：绿=在线，灰=检测中，琥珀=离线。 */
function StatusDot({ online }: { online: boolean | null }) {
  const color = online === null ? 'bg-text-muted' : online ? 'bg-emerald-500' : 'bg-amber-500'
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color}`} aria-hidden />
}

function statusLabel(online: boolean | null): string {
  if (online === null) return '检测中'
  return online ? '服务器在线' : '服务器离线'
}

export default function CloudAccountDialog() {
  const open = useCloudDialog(state => state.open)
  const intent = useCloudDialog(state => state.intent)
  const close = useCloudDialog(state => state.closeCloudDialog)
  const auth = useCloudAuth()
  const sync = useCloudSync()
  // 逐个字段取，**不要**把整个 store 放进 effect 依赖：
  // zustand 每次 state 更新都会给出新对象，`[usage]` 会导致
  // "refresh → state 变 → effect 重跑 → refresh" 的无限请求循环。
  const usageOnline = useCloudUsage(state => state.online)
  const usedBytes = useCloudUsage(state => state.usedBytes)
  const projectCount = useCloudUsage(state => state.projectCount)
  const usageLoading = useCloudUsage(state => state.loading)
  const refreshUsage = useCloudUsage(state => state.refresh)
  const resetUsage = useCloudUsage(state => state.reset)
  const toast = useToast()
  const dialog = useDialog()

  const [serverInput, setServerInput] = useState(auth.apiBase || '/api')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [captchaAnswer, setCaptchaAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [syncing, setSyncing] = useState(false)

  const firstFieldRef = useRef<HTMLInputElement | null>(null)

  const authed = auth.status === 'authed'

  // 打开时刷新一次云端占用；已登录才查，避免未登录时白打一个 401
  useEffect(() => {
    if (!open) return
    if (!authed) {
      resetUsage()
      return
    }
    void refreshUsage()
  }, [open, authed, refreshUsage, resetUsage])

  // Escape 关闭（只在打开时挂监听，避免全局常驻）
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  // 打开后把焦点放到第一个输入框，键盘用户不用先 Tab 一圈
  useEffect(() => {
    if (!open) return
    const timer = window.setTimeout(() => firstFieldRef.current?.focus(), 30)
    return () => window.clearTimeout(timer)
  }, [open, auth.enabled, authed])

  // 服务端要求验证码但手里没有题 → 自动取一张
  useEffect(() => {
    if (!open || authed) return
    if (!auth.captchaRequired || auth.captcha) return
    void useCloudAuth.getState().refreshCaptcha()
  }, [open, authed, auth.captchaRequired, auth.captcha])

  // 记住当前地址（用户可能刚从"填地址"改过）
  useEffect(() => {
    if (open) setServerInput(auth.apiBase || '/api')
  }, [open, auth.apiBase])

  const handleConnect = useCallback(async () => {
    if (!serverInput.trim()) {
      toast.error('请填写服务器地址')
      return
    }
    setBusy(true)
    try {
      const ok = await useCloudAuth.getState().saveServer(serverInput)
      if (ok) toast.success('已连接服务器，请登录')
      else toast.error(useCloudAuth.getState().error ?? '无法连接该服务器')
    } finally {
      setBusy(false)
    }
  }, [serverInput, toast])

  const handleLogin = useCallback(async () => {
    if (!username.trim() || !password) {
      toast.error('请输入用户名与密码')
      return
    }
    if (auth.captchaRequired && !captchaAnswer.trim()) {
      toast.error('请输入验证码')
      return
    }
    setBusy(true)
    try {
      const ok = await useCloudAuth.getState().login(username.trim(), password, captchaAnswer)
      setCaptchaAnswer('')
      if (ok) {
        setPassword('')
        toast.success('已登录，开始同步')
        void refreshUsage()
      } else {
        toast.error(useCloudAuth.getState().error ?? '登录失败')
      }
    } finally {
      setBusy(false)
    }
  }, [username, password, captchaAnswer, auth.captchaRequired, toast, refreshUsage])

  const handleSyncNow = useCallback(async () => {
    setSyncing(true)
    try {
      const engine = await import('../../lib/cloud/sync-engine')
      await engine.flushNow()
      const state = useCloudSync.getState()
      if (state.phase === 'conflict') {
        // 冲突需要用户决策，这里不抢戏，引导去数据管理
        toast.info('有冲突需要你决定，请到「设置区 → 数据管理」处理')
      } else if (state.lastError) {
        toast.error(state.lastError)
      } else {
        toast.success('已检查并推送最新改动')
        void refreshUsage()
      }
    } finally {
      setSyncing(false)
    }
  }, [toast, refreshUsage])

  const handleLogout = useCallback(async () => {
    setBusy(true)
    try {
      await useCloudAuth.getState().logout()
      resetUsage()
      toast.info('已退出登录，本地数据不受影响')
    } finally {
      setBusy(false)
    }
  }, [toast, resetUsage])

  const handleDisable = useCallback(async () => {
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
    resetUsage()
    toast.info('已停用云数据库')
    close()
  }, [dialog, toast, resetUsage, close])

  const handleRefreshCaptcha = useCallback(() => {
    setCaptchaAnswer('')
    void useCloudAuth.getState().refreshCaptcha()
  }, [])

  if (!open) return null

  // ── 步骤判定 ────────────────────────────────────────────────────────────
  const step: 'server' | 'login' | 'info' = !auth.enabled
    ? 'server'
    : authed
      ? 'info'
      : 'login'

  // 用户明确点了"看云端占用"但还没登录 → 仍然落在登录，只是提示一句
  const showInfoIntentHint = intent === 'info' && step !== 'info'

  const title = step === 'server' ? '连接云数据库' : step === 'login' ? '登录云数据库' : '云端存储'
  const subtitle = step === 'server'
    ? '填你自己的服务器地址，账号由服务器管理员创建。'
    : step === 'login'
      ? '账号由服务器管理员创建，没有自助注册。'
      : `账号 ${auth.user?.username ?? '—'}`

  return (
    <div
      className="fixed inset-0 bg-black/60 flex items-center justify-center z-[60] p-4"
      onClick={event => { if (event.target === event.currentTarget) close() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="bg-bg-surface border border-border rounded-2xl w-full max-w-md max-h-[88vh] overflow-y-auto"
      >
        {/* ── 头部 ── */}
        <div className="flex items-start justify-between gap-3 px-5 pt-4 pb-3 border-b border-border">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Cloud className="w-4 h-4 text-accent shrink-0" />
              <h3
                className="text-text-primary truncate"
                style={{ fontFamily: 'var(--font-serif)', fontSize: 18, fontWeight: 400 }}
              >
                {title}
              </h3>
              {step === 'info' && (
                <span className="flex items-center gap-1 text-[11px] text-text-secondary shrink-0">
                  <StatusDot online={usageOnline} />
                  {statusLabel(usageOnline)}
                </span>
              )}
            </div>
            <p className="text-[11px] text-text-muted mt-1 truncate" title={subtitle}>{subtitle}</p>
          </div>
          <Button variant="ghost" size="xs" iconOnly onClick={close} aria-label="关闭">
            <X />
          </Button>
        </div>

        <div className="px-5 py-4">
          {showInfoIntentHint && (
            <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400 mb-3">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>还没有登录，先登录才能看到云端占用。</span>
            </div>
          )}

          {/* ── ① 填服务器地址 ── */}
          {step === 'server' && (
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-text-secondary mb-1.5" htmlFor="sf-cloud-server">
                  服务器地址
                </label>
                <input
                  id="sf-cloud-server"
                  ref={firstFieldRef}
                  value={serverInput}
                  onChange={event => setServerInput(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter') void handleConnect() }}
                  placeholder="/api 或 https://sf.example.com/api"
                  autoComplete="url"
                  spellCheck={false}
                  className={inputClass}
                />
                <p className="text-[11px] text-text-muted mt-1.5 leading-relaxed">
                  同源部署直接填 <code>/api</code>；跨域必须是 <code>https://</code>，
                  否则浏览器会以混合内容为由拦掉请求。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button variant="primary" size="sm" loading={busy} onClick={handleConnect}>
                  连接并启用
                </Button>
                <Button variant="ghost" size="sm" onClick={close}>取消</Button>
              </div>
            </div>
          )}

          {/* ── ② 登录 ── */}
          {step === 'login' && (
            <div className="space-y-3">
              {auth.status === 'offline' && (
                <div className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>暂时连不上服务器，本地写作不受影响。恢复后会自动重试。</span>
                </div>
              )}
              {auth.error && auth.status !== 'offline' && (
                <div className="text-xs text-red-500">{auth.error}</div>
              )}

              <input
                ref={firstFieldRef}
                value={username}
                onChange={event => setUsername(event.target.value)}
                placeholder="用户名"
                autoComplete="username"
                className={inputClass}
              />
              <input
                type="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                placeholder="密码"
                autoComplete="current-password"
                onKeyDown={event => { if (event.key === 'Enter') void handleLogin() }}
                className={inputClass}
              />

              {auth.captchaRequired && (
                <div>
                  <div className="flex items-center gap-2">
                    {auth.captcha ? (
                      <img
                        src={auth.captcha.image}
                        alt="验证码"
                        width={150}
                        height={46}
                        draggable={false}
                        className="rounded border border-border select-none"
                      />
                    ) : (
                      <div className="w-[150px] h-[46px] rounded border border-border bg-bg-base flex items-center justify-center text-[11px] text-text-muted">
                        {auth.captchaError ?? '加载中…'}
                      </div>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      iconOnly
                      onClick={handleRefreshCaptcha}
                      title="换一张"
                      aria-label="换一张验证码"
                    >
                      <RefreshCw />
                    </Button>
                  </div>
                  <input
                    value={captchaAnswer}
                    onChange={event => setCaptchaAnswer(event.target.value)}
                    placeholder="请输入图片中的字符"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={8}
                    onKeyDown={event => { if (event.key === 'Enter') void handleLogin() }}
                    className={`${inputClass} mt-2 tracking-[0.3em] uppercase`}
                  />
                  <p className="text-[11px] text-text-muted mt-1">连续输错密码后需要验证码，不区分大小写。</p>
                </div>
              )}

              <div className="flex items-center gap-2 pt-1">
                <Button variant="primary" size="sm" loading={busy} onClick={handleLogin}>登录</Button>
                <Button variant="ghost" size="sm" onClick={close}>稍后</Button>
                <button
                  type="button"
                  onClick={() => { void useCloudAuth.getState().disableCloud(); resetUsage() }}
                  className="ml-auto text-[11px] text-text-muted hover:text-text-secondary transition-colors"
                  title="换一个服务器地址"
                >
                  换个服务器
                </button>
              </div>
              <p className="text-[11px] text-text-muted">{auth.apiBase}</p>
            </div>
          )}

          {/* ── ③ 云端信息 ── */}
          {step === 'info' && (
            <div className="space-y-3">
              {/* 占用 */}
              <div className="rounded-xl border border-border bg-bg-base p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                    <HardDrive className="w-3.5 h-3.5" />
                    云端已用空间
                  </span>
                  <Button
                    variant="ghost"
                    size="xs"
                    iconOnly
                    onClick={() => { void refreshUsage() }}
                    loading={usageLoading}
                    title="刷新"
                    aria-label="刷新云端占用"
                  >
                    <RefreshCw />
                  </Button>
                </div>
                <div
                  className="text-text-primary mt-1"
                  style={{ fontFamily: 'var(--font-mono)', fontSize: 22, fontFeatureSettings: '"tnum"' }}
                >
                  {usageOnline === false ? '—' : formatBytes(usedBytes)}
                </div>
                <div className="text-[11px] text-text-muted mt-0.5">
                  {usageOnline === false
                    ? '服务器离线，无法获取'
                    : `${projectCount} 个项目 · ${statusLabel(usageOnline)}`}
                </div>
              </div>

              {/* 明细 */}
              <dl className="text-xs space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-muted shrink-0">服务器</dt>
                  <dd className="text-text-secondary truncate" title={auth.apiBase}>{auth.apiBase}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-muted shrink-0">上次同步</dt>
                  <dd className="text-text-secondary">{formatRelativeTime(sync.lastPushAt)}</dd>
                </div>
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-text-muted shrink-0">待同步</dt>
                  <dd className={sync.dirtyCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-text-secondary'}>
                    {sync.dirtyCount > 0 ? `${sync.dirtyCount} 项` : '已是最新'}
                  </dd>
                </div>
                {sync.lastError && (
                  <div className="flex items-start justify-between gap-3">
                    <dt className="text-text-muted shrink-0">最近错误</dt>
                    <dd className="text-red-500 text-right break-words">{sync.lastError}</dd>
                  </div>
                )}
              </dl>

              <div className="flex items-center gap-2 pt-1">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={syncing}
                  onClick={handleSyncNow}
                  icon={<Cloud />}
                >
                  立即同步
                </Button>
                <Button variant="ghost" size="sm" loading={busy} onClick={handleLogout} icon={<LogOut />}>
                  退出登录
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleDisable}
                  className="ml-auto"
                  title="不再使用云数据库（本地数据不受影响）"
                >
                  停用
                </Button>
              </div>

              <p className="flex items-start gap-1.5 text-[11px] text-text-muted leading-relaxed">
                <ShieldCheck className="w-3 h-3 mt-0.5 shrink-0" />
                <span>
                  云端是<strong className="font-medium text-text-secondary">副本</strong>，不是备份。
                  手稿仍以本地为准，建议继续用「导出项目 JSON」做第二道保险。
                  服务器能读取明文内容，这里不是端到端加密。
                </span>
              </p>

              {usageOnline === false && (
                <p className="flex items-start gap-1.5 text-[11px] text-amber-600 dark:text-amber-400">
                  <CloudOff className="w-3 h-3 mt-0.5 shrink-0" />
                  <span>连不上服务器，改动会留在本地队列，恢复后自动补推。</span>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
