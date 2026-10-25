import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import { adopt } from '../lib/registry/adopt'
import {
  createInspirationFragment,
  createInspirationVersion,
  MAX_INSPIRATION_VERSIONS,
  parseInspirationFragments,
  parseInspirationVersions,
  repairInspirationVersionParents,
  upsertInspirationFragment,
} from '../lib/inspiration/workspace'
import type {
  InspirationFragment,
  InspirationResultMode,
  InspirationSourceKind,
  InspirationVersion,
  InspirationWorkspace,
} from '../lib/types/inspiration-workspace'

interface InspirationWorkspaceState {
  workspace: InspirationWorkspace | null
  fragments: InspirationFragment[]
  versions: InspirationVersion[]
  loading: boolean
  load: (projectId: number) => Promise<void>
  addFragment: (projectId: number, input: {
    text: string
    label?: string
    sourceKind?: InspirationSourceKind
  }) => Promise<InspirationFragment | null>
  removeFragment: (projectId: number, fragmentId: string) => Promise<void>
  saveVersion: (projectId: number, input: {
    mode: InspirationResultMode
    parentVersionId?: string | null
    fragmentIds: string[]
    result: unknown
  }) => Promise<InspirationVersion>
}

async function persistWorkspace(
  projectId: number,
  fragments: InspirationFragment[],
  versions: InspirationVersion[],
): Promise<InspirationWorkspace> {
  const adopted = await adopt({
    projectId,
    target: 'inspirationWorkspaces',
    mode: 'replace',
    data: {
      fragments: JSON.stringify(fragments),
      versions: JSON.stringify(versions),
    },
  })
  if (adopted.written.length === 0) {
    log.warn('Inspiration', 'inspiration.workspace.adopt-denied', '灵感工作区写回被采纳边界拒绝', {
      projectId, fragmentCount: fragments.length, versionCount: versions.length,
      skippedCount: adopted.skipped.length, typeErrorCount: adopted.typeErrors.length,
    })
    throw new Error(`灵感工作区写回被拒绝：${adopted.skipped[0]?.reason ?? adopted.typeErrors[0]?.field ?? 'unknown'}`)
  }
  const row = await db.inspirationWorkspaces.where('projectId').equals(projectId).first()
  if (!row) {
    log.error('Inspiration', 'inspiration.workspace.readback-missing', '灵感工作区写回后回读失败', { projectId, fragmentCount: fragments.length, versionCount: versions.length })
    throw new Error('灵感工作区写回后无法回读')
  }
  return row
}

export const useInspirationWorkspaceStore = create<InspirationWorkspaceState>((set, get) => ({
  workspace: null,
  fragments: [],
  versions: [],
  loading: false,

  load: async (projectId) => {
    set({ loading: true })
    try {
      const workspace = await db.inspirationWorkspaces.where('projectId').equals(projectId).first() ?? null
      set({
        workspace,
        fragments: parseInspirationFragments(workspace?.fragments),
        versions: parseInspirationVersions(workspace?.versions),
      })
    } finally {
      set({ loading: false })
    }
  },

  addFragment: async (projectId, input) => {
    const fragment = createInspirationFragment(input)
    if (!fragment) {
      log.warn('Inspiration', 'inspiration.fragment.invalid', '灵感碎片输入无效，未写入', { projectId, inputChars: input.text.length })
      return null
    }
    const current = get().workspace?.projectId === projectId ? get().fragments : []
    const fragments = upsertInspirationFragment(current, fragment)
    if (fragments === current) {
      log.info('Inspiration', 'inspiration.fragment.duplicate', '灵感碎片已存在，未重复写入', { projectId, fragmentCount: current.length, inputChars: input.text.length })
      return current.find(item =>
        item.text.replace(/\s+/g, '').toLocaleLowerCase()
        === fragment.text.replace(/\s+/g, '').toLocaleLowerCase()) ?? null
    }
    const versions = get().workspace?.projectId === projectId ? get().versions : []
    const workspace = await persistWorkspace(projectId, fragments, versions)
    set({ workspace, fragments, versions })
    log.info('Inspiration', 'inspiration.fragment.added', '灵感碎片已写入', { projectId, fragmentCount: fragments.length, versionCount: versions.length, inputChars: input.text.length })
    return fragment
  },

  removeFragment: async (projectId, fragmentId) => {
    const current = get().workspace?.projectId === projectId ? get().fragments : []
    const versions = get().workspace?.projectId === projectId ? get().versions : []
    if (versions.some(version => version.fragmentIds.includes(fragmentId))) {
      log.warn('Inspiration', 'inspiration.fragment.delete-denied', '灵感碎片被已确认版本引用，拒绝删除', { projectId, fragmentCount: current.length, versionCount: versions.length })
      throw new Error('该碎片已被确认版本引用，只能取消勾选，不能删除来源证据')
    }
    const fragments = current.filter(fragment => fragment.id !== fragmentId)
    const workspace = await persistWorkspace(projectId, fragments, versions)
    set({ workspace, fragments, versions })
    log.info('Inspiration', 'inspiration.fragment.removed', '灵感碎片已删除', { projectId, beforeCount: current.length, afterCount: fragments.length, versionCount: versions.length })
  },

  saveVersion: async (projectId, input) => {
    const version = createInspirationVersion(input)
    const fragments = get().workspace?.projectId === projectId ? get().fragments : []
    const current = get().workspace?.projectId === projectId ? get().versions : []
    const versions = repairInspirationVersionParents(
      [...current, version].slice(-MAX_INSPIRATION_VERSIONS),
    )
    const workspace = await persistWorkspace(projectId, fragments, versions)
    set({ workspace, fragments, versions })
    log.info('Inspiration', 'inspiration.version.saved', '灵感版本已保存', { projectId, fragmentCount: fragments.length, versionCount: versions.length, selectedFragmentCount: input.fragmentIds.length, mode: input.mode })
    return version
  },
}))
