import { createContext, useContext, useEffect, useRef } from 'react'
import { Loader2, X } from 'lucide-react'
import { usePersistentTaskStore, type PersistentTask, type PersistentTaskInput } from '../../stores/persistent-task'

const PersistentTaskProviderContext = createContext(false)

export function useHasPersistentTaskProvider() {
  return useContext(PersistentTaskProviderContext)
}

/** Shared visual treatment for long-running tasks across the application. */
export function PersistentTaskStatusBar({ task, floating = false }: { task: PersistentTask; floating?: boolean }) {
  const testId = task.testId ?? 'persistent-task-status-bar'
  const titleTestId = task.testId === 'generation-status-bar' ? 'generation-status-title' : (task.testId ? `${task.testId}-title` : undefined)
  const detailTestId = task.testId === 'generation-status-bar' ? 'generation-status-detail' : (task.testId ? `${task.testId}-detail` : undefined)
  const cancelTestId = task.testId === 'generation-status-bar' ? 'generation-status-cancel' : (task.testId ? `${task.testId}-cancel` : undefined)
  return (
    <div
      className={floating ? 'pointer-events-none fixed inset-x-0 bottom-4 z-[90] flex justify-center px-4' : 'pointer-events-none flex justify-center px-4'}
      data-testid={testId}
      role="status"
      aria-live="polite"
    >
      <div className="pointer-events-auto flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-full border border-accent/40 bg-bg-surface/95 px-4 py-2 shadow-theme-lg backdrop-blur">
        <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-accent" aria-hidden />
        <span className="min-w-0 truncate text-xs text-text-primary" data-testid={titleTestId}>
          {task.title}
        </span>
        {task.detail && (
          <span className="hidden min-w-0 truncate text-[11px] text-text-muted sm:inline" data-testid={detailTestId}>
            {task.detail}
          </span>
        )}
        {task.onCancel && (
          <button
            type="button"
            onClick={task.onCancel}
            data-testid={cancelTestId}
            aria-label={task.cancelLabel ?? '取消任务'}
            className="flex flex-shrink-0 items-center gap-1 rounded-full border border-error/40 bg-error/10 px-2.5 py-1 text-[11px] text-error"
          >
            <X className="h-3 w-3" />{task.cancelLabel ?? '取消任务'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Mount once near the app root; independent tasks stack instead of overwriting. */
export function PersistentTaskProvider({ children }: { children: React.ReactNode }) {
  const tasks = usePersistentTaskStore(state => state.tasks)
  return (
    <PersistentTaskProviderContext.Provider value={true}>
      {children}
      {tasks.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[90] flex flex-col-reverse items-center gap-2">
          {tasks.map(task => <PersistentTaskStatusBar key={task.id} task={task} />)}
        </div>
      )}
    </PersistentTaskProviderContext.Provider>
  )
}

/** Subscribe a component-owned task to the global persistent status bar. */
export function usePersistentTask(
  input: PersistentTaskInput | null,
  enabled: boolean,
): void {
  const taskIdRef = useRef<string | null>(null)
  const latestInput = useRef(input)
  latestInput.current = input

  useEffect(() => {
    if (!enabled || !latestInput.current) return
    const id = usePersistentTaskStore.getState().start(latestInput.current)
    taskIdRef.current = id
    return () => {
      usePersistentTaskStore.getState().finish(id)
      if (taskIdRef.current === id) taskIdRef.current = null
    }
  }, [enabled])

  const title = input?.title
  const detail = input?.detail
  const cancelLabel = input?.cancelLabel
  const onCancel = input?.onCancel
  const testId = input?.testId

  useEffect(() => {
    const id = taskIdRef.current
    if (enabled && id && title) {
      usePersistentTaskStore.getState().update(id, { title, detail, cancelLabel, onCancel, testId })
    }
  }, [enabled, title, detail, cancelLabel, onCancel, testId])
}
