import { useEffect, useRef } from 'react'
import { useBackupStore, AUTO_BACKUP_INTERVAL } from '../stores/backup'
import { requestRescue } from '../lib/safety/rescue-scheduler'
import { log } from '../lib/logging/logger'

/**
 * 自动定时备份 Hook
 * 每 5 分钟为当前项目创建一个自动快照
 *
 * DB-SAFETY-1：同一节拍下**额外**往库外哨兵库写一份副本。
 * 快照住在主库里（主库被删就一起没），哨兵住在独立库（能活下来）——两者互补，不重复。
 */
export function useAutoBackup(projectId: number | null) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const { createSnapshot } = useBackupStore()

  useEffect(() => {
    // 清理旧定时器
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (!projectId) return

    // 进入项目先落一份哨兵（切项目时也补齐）
    void requestRescue(projectId, 'project-switch')

    // 启动定时备份
    timerRef.current = setInterval(async () => {
      try {
        const now = new Date()
        const timeStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
        await createSnapshot(projectId, `自动备份 ${timeStr}`, 'auto')
        // DB-SAFETY-1：库外副本（受节流约束，失败静默）
        void requestRescue(projectId, 'auto')
      } catch (err) {
        log.error('AutoBackup', 'autobackup', '[AutoBackup] 创建快照失败:', undefined, err)
      }
    }, AUTO_BACKUP_INTERVAL)

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [projectId, createSnapshot])
}
