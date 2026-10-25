import { useCallback, useEffect, useState } from 'react'
import { Redo2, Undo2 } from 'lucide-react'
import { Button } from '../shared/Button'
import { useChapterStore } from '../../stores/chapter'
import { log } from '../../lib/logging/logger'
import {
  readStepStatus,
  redoStep,
  subscribeStepJournal,
  undoStep,
  type StepStatus,
} from '../../lib/history/step-recorder'

const EMPTY_STATUS: StepStatus = {
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  stepCount: 0,
}

interface Props {
  /** 当前项目 id；null 时按钮保持禁用。 */
  projectId: number | null
}

/**
 * STEP-1 撤回 / 重做按钮（工作区顶栏）。
 *
 * 为什么单独成组件而不是写在 WorkspacePage 里：历史是**异步**落库的
 * （`adopt()` 入队 → 下一个宏任务 flush），界面必须靠 `subscribeStepJournal`
 * 实时刷新可用状态。之前把状态放在页面里只在挂载时读一次，导致"采纳候选后
 * 上一步仍然灰着、必须刷新页面才出现"——真实缺陷，且因为没有组件级测试而全绿通过。
 * 独立组件让"采纳 → 按钮变可用 → 点击 → 数据回滚"这条链路可以被真实 UI 测试覆盖。
 */
export default function StepHistoryButtons({ projectId }: Props) {
  const [status, setStatus] = useState<StepStatus>(EMPTY_STATUS)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (projectId == null) {
      setStatus(EMPTY_STATUS)
      return
    }
    try {
      setStatus(await readStepStatus(projectId))
    } catch {
      // 历史读取失败时按钮保持不可用即可，不阻塞工作区
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
    return subscribeStepJournal(() => { void refresh() })
  }, [refresh])

  const apply = useCallback(async (direction: 'undo' | 'redo') => {
    if (projectId == null || busy) return
    setBusy(true)
    try {
      const result = direction === 'undo' ? await undoStep(projectId) : await redoStep(projectId)
      if (result.ok) {
        // 撤回会改动正文/大纲等其它面板的数据，刷新当前章节让作者立刻看到变化。
        await useChapterStore.getState().loadAll(projectId)
        const current = useChapterStore.getState().currentChapter
        if (current?.id != null) await useChapterStore.getState().refreshChapter(current.id)
      }
      await refresh()
    } catch (error) {
      log.warn('StepRecorder', 'step.apply.failed', `[STEP-1] ${direction} 失败`, {
        projectId,
        direction,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusy(false)
    }
  }, [projectId, refresh, busy])

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        disabled={!status.canUndo || busy}
        onClick={() => { void apply('undo') }}
        title={status.canUndo ? `上一步：${status.undoLabel}` : '没有可撤回的步骤'}
        aria-label="上一步"
        className="shrink-0"
      >
        <Undo2 />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        iconOnly
        disabled={!status.canRedo || busy}
        onClick={() => { void apply('redo') }}
        title={status.canRedo ? `下一步：${status.redoLabel}` : '没有可重做的步骤'}
        aria-label="下一步"
        className="shrink-0"
      >
        <Redo2 />
      </Button>
    </>
  )
}
