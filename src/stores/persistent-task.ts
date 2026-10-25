import { create } from 'zustand'

export interface PersistentTaskInput {
  title: string
  detail?: string
  cancelLabel?: string
  onCancel?: () => void
  /** Preserve existing feature-specific selectors when sharing the status bar. */
  testId?: string
}

export interface PersistentTask extends PersistentTaskInput {
  id: string
}

interface PersistentTaskState {
  tasks: PersistentTask[]
  start: (task: PersistentTaskInput) => string
  update: (id: string, patch: Partial<PersistentTaskInput>) => void
  finish: (id: string) => void
}

let nextTaskId = 0

/** Ephemeral UI state only: never persisted alongside the author's manuscript. */
export const usePersistentTaskStore = create<PersistentTaskState>((set) => ({
  tasks: [],
  start: (task) => {
    const id = `persistent-task-${++nextTaskId}`
    set(state => ({ tasks: [...state.tasks, { ...task, id }] }))
    return id
  },
  update: (id, patch) => set(state => ({
    tasks: state.tasks.map(task => task.id === id ? { ...task, ...patch } : task),
  })),
  finish: (id) => set(state => ({
    tasks: state.tasks.filter(task => task.id !== id),
  })),
}))
