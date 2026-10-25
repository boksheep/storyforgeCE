import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { Project, CreateProjectInput } from '../lib/types'
import { migrateGenre } from '../lib/types'
import { requireBackupBefore } from '../lib/safety/require-backup-before'
import { cascadeDeleteProject } from '../lib/registry/lifecycle'
import { sumChapterWordCounts } from '../lib/chapters/selectors'
import { log } from '../lib/logging/logger'

interface ProjectStore {
  projects: Project[]
  currentProjectId: number | null
  loading: boolean

  loadProjects: () => Promise<void>
  loadProject: (id: number) => Promise<Project | undefined>
  createProject: (data: CreateProjectInput) => Promise<number>
  updateProject: (id: number, data: Partial<Project>) => Promise<void>
  deleteProject: (id: number) => Promise<void>
  setCurrentProject: (id: number | null) => void
}

/**
 * 从真实章节行派生 `currentWordCount`（首页项目卡片 / 工作区状态栏）。
 *
 * 为什么不在写章节时回写 projects 表：章节保存、AI 采纳、导入、删章分散在不同入口，
 * 任何一条漏更新就会留下一个永远偏低的持久化计数（历史 bug：首页字数恒为 0）。
 * 这里只在读取时按统一口径现算，DB 里不存第二份真相。
 */
async function withDerivedWordCounts(projects: Project[]): Promise<Project[]> {
  const ids = projects
    .map(project => project.id)
    .filter((id): id is number => typeof id === 'number')
  if (!ids.length) return projects.map(project => ({ ...project, currentWordCount: 0 }))

  const chapters = await db.chapters.where('projectId').anyOf(ids).toArray()
  const grouped = new Map<number, typeof chapters>()
  for (const chapter of chapters) {
    const bucket = grouped.get(chapter.projectId)
    if (bucket) bucket.push(chapter)
    else grouped.set(chapter.projectId, [chapter])
  }

  return projects.map(project => ({
    ...project,
    currentWordCount: project.id == null ? 0 : sumChapterWordCounts(grouped.get(project.id) ?? []),
  }))
}

export const useProjectStore = create<ProjectStore>((set, get) => ({
  projects: [],
  currentProjectId: null,
  loading: false,

  loadProjects: async () => {
    set({ loading: true })
    const raw = await db.projects.orderBy('updatedAt').reverse().toArray()
    // 兼容旧数据：确保每条记录都有 genres[] 和 status
    const projects = await withDerivedWordCounts(raw.map(migrateGenre))
    set({ projects, loading: false })
  },

  loadProject: async (id: number) => {
    const raw = await db.projects.get(id)
    if (!raw) return undefined
    const [project] = await withDerivedWordCounts([migrateGenre(raw)])
    const projects = get().projects
    const exists = projects.some(p => p.id === id)
    const nextProjects = exists
      ? projects.map(p => p.id === id ? project : p)
      : [...projects, project].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    set({ currentProjectId: id, projects: nextProjects })
    return project
  },

  createProject: async (data: CreateProjectInput) => {
    const now = Date.now()
    const id = await db.projects.add({
      ...data,
      genres: data.genres ?? [],
      status: data.status ?? 'drafting',
      createdAt: now,
      updatedAt: now,
    } as Project)
    await get().loadProjects()
    return id as number
  },

  updateProject: async (id: number, data: Partial<Project>) => {
    await db.projects.update(id, { ...data, updatedAt: Date.now() })
    await get().loadProjects()
  },

  deleteProject: async (id: number) => {
    // 数据红线:删项目前强制提示备份(Pre-Phase 0 安全网)
    const proceed = await requireBackupBefore({
      operation: '删除项目',
      projectId: id,
      details: '此操作将清除该项目的全部数据(章节、世界观、角色、词条、状态卡等),不可恢复。',
    })
    if (!proceed) {
      // 用户取消也要留痕：排查"我以为删了却没删"时，这条是唯一证据。
      log.info(
        'ProjectStore',
        'project.delete.cancelled',
        `用户取消了删除项目 #${id}（未做任何删除）`,
        { projectId: id },
      )
      return
    }

    // 销毁规模必须在删之前量好：删完项目本身也没了，日志是唯一的事后依据。
    const target = get().projects.find(p => p.id === id)
    const chapterCount = await db.chapters.where('projectId').equals(id).count()
    const characterCount = await db.characters.where('projectId').equals(id).count()
    const codexCount = await db.codexEntries.where('projectId').equals(id).count()

    // Phase 1.1b: 级联删除全部从 PROJECT_TABLES 注册表派生(不再手写表清单)。
    // 加新表 = 注册表加一行,这里自动覆盖。行为与 Phase 0.6 手写版等价(R-05 保证)。
    await cascadeDeleteProject(id)

    if (get().currentProjectId === id) {
      set({ currentProjectId: null })
    }
    await get().loadProjects()
    log.warn(
      'ProjectStore',
      'project.deleted',
      `已删除项目「${target?.name ?? id}」：连带章节 ${chapterCount} 个、角色 ${characterCount} 个、词条 ${codexCount} 条`,
      {
        projectId: id,
        projectName: target?.name ?? '',
        chapterCount,
        characterCount,
        codexCount,
      },
    )
  },

  setCurrentProject: (id: number | null) => {
    set({ currentProjectId: id })
  },
}))
