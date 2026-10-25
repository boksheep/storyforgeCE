import { useEffect, useRef } from 'react'
import { useGistStore } from '../stores/gist'
import { log } from '../lib/logging/logger'

/** 云自动备份间隔（毫秒）— 10 分钟（比本地快照稀疏，省 GitHub API） */
export const GIST_AUTO_INTERVAL = 10 * 60 * 1000

/**
 * 云自动备份 Hook：开启「自动备份」且已连接 GitHub 时，
 * 每隔 GIST_AUTO_INTERVAL 把当前项目推到云端 Gist。
 */
export function useGistAutoBackup(projectId: number | null) {
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (!projectId) return

    timerRef.current = setInterval(async () => {
      const { autoBackup, pat, backupProject } = useGistStore.getState()
      if (!autoBackup || !pat) return
      try {
        await backupProject(projectId)
      } catch (err) {
        log.error('GistAutoBackup', 'gistautobackup', '[GistAutoBackup] 云备份失败:', undefined, err)
      }
    }, GIST_AUTO_INTERVAL)

    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    }
  }, [projectId])
}
