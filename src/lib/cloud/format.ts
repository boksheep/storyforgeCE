/**
 * CLOUD-DB-1 · 面向用户的体积/数量格式化
 *
 * 只做展示，不参与任何判断。**统一走这里**，避免"卡片显示 12.3 MB、
 * 弹窗显示 12.4 MB"这类同一份数据两个数的问题。
 */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const

/**
 * 人类可读体积。
 *
 * 用 1024 进制但标 KB/MB（不写 KiB/MiB）—— 面向普通用户，
 * 与系统里其它地方（下载大小、磁盘占用）的习惯一致，少一层换算困惑。
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  let value = bytes
  let index = 0
  while (value >= 1024 && index < UNITS.length - 1) {
    value /= 1024
    index += 1
  }
  // 整数单位（B）不带小数；其余大于 100 时省略小数位，避免"1023.7 KB"这种噪声
  const digits = index === 0 ? 0 : value >= 100 ? 0 : 1
  return `${value.toFixed(digits)} ${UNITS[index]}`
}

/** 相对时间：刚刚 / 3 分钟前 / 2 小时前 / 具体日期。 */
export function formatRelativeTime(timestamp: number | null, now = Date.now()): string {
  if (!timestamp) return '—'
  const delta = now - timestamp
  if (delta < 0) return '刚刚'
  if (delta < 60_000) return '刚刚'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`
  if (delta < 7 * 86_400_000) return `${Math.floor(delta / 86_400_000)} 天前`
  try {
    return new Date(timestamp).toLocaleDateString('zh-CN')
  } catch {
    return '—'
  }
}
