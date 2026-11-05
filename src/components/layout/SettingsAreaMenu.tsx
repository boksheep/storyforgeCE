/**
 * 「设置区」入口菜单
 *
 * 首页顶栏原来是一个"直接跳 /settings"的齿轮。问题是 `/settings` 只是设置区里的
 * **一项**（AI 服务商），把整块设置区压缩成一个入口会让人找不到"数据管理/版本历史/消耗统计"。
 *
 * 所以改成：点齿轮 → 弹出菜单，四项并列，与工作区侧边栏的「设置区」分组一一对应。
 * 这样"设置区"在首页和工作区是同一个心智模型，而不是两套。
 *
 * ## 项目相关项的处理
 *
 * 后三项都需要一个已打开的项目（它们在工作区侧边栏里也是项目内的面板）。
 * 首页没有项目时：
 *   - 有项目 → 跳到**最近编辑**的那个项目的对应模块
 *   - 没项目 → 置灰并说明"先打开一个项目"，**不做死入口**
 *     （架构守卫禁止空按钮式承诺，所以必须给出真实原因，而不是画一个点不动的入口）
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import { Coins, Download, History, Settings } from 'lucide-react'
import { Button } from '../shared/Button'

export interface SettingsAreaProject {
  id: number
  name: string
  updatedAt: number
}

interface Props {
  /** 按 `updatedAt` 倒序传入；取第一个作为"最近编辑"目标。 */
  projects: SettingsAreaProject[]
}

interface MenuItem {
  key: string
  label: string
  description: string
  icon: ReactNode
  /** `null` 表示需要项目但当前没有。 */
  path: string | null
}

export default function SettingsAreaMenu({ projects }: Props) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const latest = projects.length > 0
    ? projects.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a))
    : null

  const projectPath = (module: string) => (latest ? `/workspace/${latest.id}?module=${module}` : null)

  const items: MenuItem[] = [
    {
      key: 'settings',
      label: '设置',
      description: 'AI 服务商、模型与上下文预算',
      icon: <Settings className="w-3.5 h-3.5" />,
      path: '/settings',
    },
    {
      key: 'export',
      label: '数据管理',
      description: '导出 / 导入、云端快照',
      icon: <Download className="w-3.5 h-3.5" />,
      path: projectPath('export'),
    },
    {
      key: 'version-history',
      label: '版本历史',
      description: '手动快照与回滚',
      icon: <History className="w-3.5 h-3.5" />,
      path: projectPath('version-history'),
    },
    {
      key: 'usage-stats',
      label: '消耗统计',
      description: 'AI 调用次数与花费',
      icon: <Coins className="w-3.5 h-3.5" />,
      path: projectPath('usage-stats'),
    },
  ]

  const close = useCallback(() => setOpen(false), [])

  // Escape 关闭
  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [open, close])

  const handleSelect = (item: MenuItem) => {
    if (!item.path) return
    setOpen(false)
    navigate(item.path)
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="md"
        iconOnly
        pressed={open}
        onClick={() => setOpen(value => !value)}
        title="设置区"
        aria-label="设置区"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Settings />
      </Button>

      {open && (
        <>
          {/* 点击空白关闭：单独一层遮罩，避免监听 document 带来的时序问题 */}
          <div className="fixed inset-0 z-40" onClick={close} aria-hidden />
          <div
            role="menu"
            aria-label="设置区"
            className="absolute right-0 top-full mt-1.5 w-60 z-50 rounded-xl border border-border bg-bg-surface shadow-xl overflow-hidden"
          >
            {items.map(item => {
              const disabled = !item.path
              return (
                <button
                  key={item.key}
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  onClick={() => handleSelect(item)}
                  title={disabled ? '先打开一个项目，这一项在项目内使用' : item.description}
                  className={`w-full text-left px-3 py-2 flex items-start gap-2.5 transition-colors ${
                    disabled
                      ? 'opacity-45 cursor-not-allowed'
                      : 'hover:bg-bg-hover'
                  }`}
                >
                  <span className="mt-0.5 text-text-muted shrink-0">{item.icon}</span>
                  <span className="min-w-0">
                    <span className="block text-xs text-text-primary">{item.label}</span>
                    <span className="block text-[11px] text-text-muted truncate">
                      {disabled ? '先打开一个项目' : item.description}
                    </span>
                  </span>
                </button>
              )
            })}
            {latest && (
              <div className="px-3 py-1.5 border-t border-border text-[10px] text-text-muted truncate">
                项目类入口会打开最近编辑的「{latest.name}」
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}
