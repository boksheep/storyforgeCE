import { PersistentTaskStatusBar, useHasPersistentTaskProvider, usePersistentTask } from '../shared/PersistentTaskStatusBar'

interface Props {
  title: string | null
  detail?: string
  onCancel: () => void
}

/** Map analysis uses the same bottom status bar as chapter generation. */
export default function MapAnalysisStatusBar({ title, detail, onCancel }: Props) {
  const hasProvider = useHasPersistentTaskProvider()
  const task = { title: title ?? '', detail, onCancel, cancelLabel: '取消分析', testId: 'map-analysis-status-bar' }
  usePersistentTask(task, hasProvider && Boolean(title))
  if (!title || hasProvider) return null
  return <PersistentTaskStatusBar task={{ ...task, id: 'map-analysis' }} floating />
}
