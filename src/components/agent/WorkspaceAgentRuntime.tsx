import type { ReactNode } from 'react'
import type { Project } from '../../lib/types'
import { useMasterCopilot } from './useMasterCopilot'
import type { MasterCopilotController } from './ChatCopilotPanel'

/** 任务归属工作区，而非右栏/底栏/全屏中的某个视图。隐藏面板也不会中止任务。 */
export default function WorkspaceAgentRuntime({ project, worldGroupId, children }: {
  project: Project
  worldGroupId: number | null
  children: (copilot: MasterCopilotController) => ReactNode
}) {
  const copilot = useMasterCopilot({ project, worldGroupId })
  return <>{children(copilot)}</>
}
