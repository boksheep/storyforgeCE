/**
 * CLOUD-DB-1 · 顶栏云数据库入口按钮
 *
 * 一个按钮承担两种语义，靠状态切换而不是两个按钮：
 *   未登录 → "登录"（点了打开弹窗，第一步是填服务器地址，若还没配）
 *   已登录 → 云图标 + 已用空间 + 在线状态点（点了打开云端信息）
 *
 * ## 为什么不在这里自己发请求
 *
 * 这个按钮会同时出现在首页与工作区。各发一次 `/sync/status` 既浪费，
 * 又会让两处数字不一致。统一走 `useCloudUsage`，它内部做了并发去重。
 *
 * ## 为什么状态点不写颜色文字
 *
 * 顶栏空间紧张，三个字的"在线/离线"会把按钮撑得很长；用点 + `title`
 * 表达，鼠标悬停可读，视觉上也更安静。文字版说明在弹窗里。
 */
import { useEffect } from 'react'
import { Cloud, CloudOff, LogIn } from 'lucide-react'
import { useCloudAuth } from '../../stores/cloud-auth'
import { useCloudUsage } from '../../stores/cloud-usage'
import { useCloudDialog } from '../../stores/cloud-dialog'
import { formatBytes } from '../../lib/cloud/format'
import { Button } from '../shared/Button'

interface Props {
  /** 紧凑模式：只显示图标（窄屏或空间不足时用）。 */
  compact?: boolean
}

export default function CloudAccountButton({ compact = false }: Props) {
  const authStatus = useCloudAuth(state => state.status)
  const online = useCloudUsage(state => state.online)
  const usedBytes = useCloudUsage(state => state.usedBytes)
  // **必须用 selector 取函数**：直接 `useCloudUsage()` 拿整个 store 时，
  // 每次 state 更新都会返回新的对象引用，把它放进 useEffect 依赖会导致
  // "refresh → state 变 → effect 重跑 → refresh" 的无限请求循环。
  const refreshUsage = useCloudUsage(state => state.refresh)
  const openDialog = useCloudDialog(state => state.openCloudDialog)

  const authed = authStatus === 'authed'

  // 登录后（含刷新页面后已登录）拉一次占用；未登录不请求
  useEffect(() => {
    if (!authed) return
    void refreshUsage()
  }, [authed, refreshUsage])

  const dotClass = online === null ? 'bg-text-muted' : online ? 'bg-emerald-500' : 'bg-amber-500'
  const dotTitle = online === null ? '检测中' : online ? '服务器在线' : '服务器离线'

  /**
   * 预热弹窗 chunk。
   *
   * 弹窗是 `lazy` 的（不拖累入口体积），第一次点开会有一次网络往返。
   * 在 hover / focus 时先拉下来，点击时通常已经就绪，用户感觉不到延迟。
   * 失败静默忽略——预热失败不影响正常打开（那时会再拉一次）。
   */
  const warmUpDialog = () => {
    void import('./CloudAccountDialog').catch(() => {})
  }

  if (!authed) {
    if (compact) {
      return (
        <Button
          variant="ghost"
          size="sm"
          iconOnly
          onClick={() => openDialog('login')}
          onMouseEnter={warmUpDialog}
          onFocus={warmUpDialog}
          title="登录云数据库"
          aria-label="登录云数据库"
        >
          <LogIn />
        </Button>
      )
    }
    return (
      <Button
        variant="ghost"
        size="sm"
        onClick={() => openDialog('login')}
        onMouseEnter={warmUpDialog}
        onFocus={warmUpDialog}
        icon={<LogIn />}
        title="登录云数据库（换设备也能继续写）"
      >
        登录
      </Button>
    )
  }

  const usageText = online === false ? '离线' : formatBytes(usedBytes)
  const label = `云端 ${usageText}`

  if (compact) {
    return (
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        onClick={() => openDialog('info')}
        onMouseEnter={warmUpDialog}
        onFocus={warmUpDialog}
        title={`${label} · ${dotTitle}`}
        aria-label={`${label}，${dotTitle}`}
      >
        {online === false ? <CloudOff /> : <Cloud />}
      </Button>
    )
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => openDialog('info')}
      onMouseEnter={warmUpDialog}
      onFocus={warmUpDialog}
      title={`${label} · ${dotTitle} · 点击查看云端存储`}
      aria-label={`${label}，${dotTitle}`}
    >
      {online === false ? <CloudOff /> : <Cloud />}
      <span className="tabular-nums">{usageText}</span>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotClass}`} aria-hidden />
    </Button>
  )
}
