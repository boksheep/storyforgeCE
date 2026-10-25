import { useCallback, useEffect, useRef } from 'react'
import { log } from '../lib/logging/logger'

/**
 * 正文自动保存：按章节排队。
 *
 * 早期实现只有一个 pending 槽位。切章后在新章继续输入会覆盖上一章尚未落盘的内容，
 * 那段输入就永远不会写入 IndexedDB。现在每个章节各自持有一份待写内容，
 * flush 时按排队顺序逐章写入；单章失败只重排该章，不拖累其它章节。
 *
 * 保存回调必须携带产生该内容的章节 ID，避免迟到的 flush 写进另一个章节。
 */
export function useChapterAutoSave(
  save: (chapterId: number, html: string) => Promise<void>,
  delay = 1500,
) {
  const saveRef = useRef(save)
  saveRef.current = save
  const pendingRef = useRef(new Map<number, string>())
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const writesRef = useRef<Promise<void>>(Promise.resolve())

  const flush = useCallback((): Promise<void> => {
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = null
    if (pendingRef.current.size === 0) return writesRef.current
    const batch = [...pendingRef.current.entries()]
    pendingRef.current = new Map()
    const write = writesRef.current.catch(() => undefined).then(async () => {
      for (const [chapterId, html] of batch) {
        try {
          await saveRef.current(chapterId, html)
          log.info('AutoSave', 'autosave.completed', '章节自动保存已完成', {
            chapterId, contentChars: html.length,
          })
        } catch (error) {
          // 单章失败不能吞掉其它章节的待写内容：只把失败章节放回队列，等下次 flush 重试。
          if (!pendingRef.current.has(chapterId)) pendingRef.current.set(chapterId, html)
          log.error('AutoSave', 'autosave.failed', '章节自动保存失败', { chapterId }, error)
        }
      }
    })
    writesRef.current = write
    return write
  }, [])

  const schedule = useCallback((chapterId: number, html: string) => {
    pendingRef.current.set(chapterId, html)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => { void flush() }, delay)
  }, [delay, flush])

  useEffect(() => () => { void flush() }, [flush])
  return { schedule, flush }
}
