/**
 * 便签/笔记 Store — Phase H3
 */
import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import type { Note, NoteColor } from '../lib/types'

const now = () => Date.now()
// 同一便签按调用顺序写库；输入法组词和快速连续输入不能由较慢的旧写入覆盖新值。
const writes = new Map<number, Promise<void>>()

interface NoteStore {
  notes: Note[]
  loading: boolean

  loadAll: (projectId: number) => Promise<void>
  addNote: (projectId: number, content?: string, chapterId?: number, color?: NoteColor,
    position?: Note['position']) => Promise<number>
  updateNote: (id: number, data: Partial<Note>) => Promise<void>
  deleteNote: (id: number) => Promise<void>
  togglePin: (id: number) => Promise<void>

  /** 获取某章节的便签 */
  getChapterNotes: (chapterId: number) => Note[]
  /** 获取未关联章节的便签 */
  getGlobalNotes: () => Note[]
}

export const useNoteStore = create<NoteStore>((set, get) => ({
  notes: [],
  loading: false,

  loadAll: async (projectId: number) => {
    set({ loading: true })
    await Promise.all([...writes.values()].map(write => write.catch(() => undefined)))
    const notes = await db.notes.where('projectId').equals(projectId).toArray()
    set({ notes: notes.sort((a, b) => {
      // 置顶优先，再按时间倒序
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
      return b.updatedAt - a.updatedAt
    }), loading: false })
  },

  addNote: async (projectId, content = '', chapterId, color = 'yellow', position) => {
    const note: Note = {
      projectId,
      chapterId,
      content,
      color,
      pinned: false,
      collapsed: false,
      position,
      createdAt: now(),
      updatedAt: now(),
    }
    const id = await db.notes.add(note) as number
    log.info('NoteStore', 'note.created', '便签已创建', { projectId, noteId: id, chapterId: chapterId ?? null, contentChars: content.length })
    set({ notes: [{ ...note, id }, ...get().notes] })
    return id
  },

  updateNote: async (id, data) => {
    const patch = { ...data, updatedAt: now() }
    const note = get().notes.find(n => n.id === id)
    if (!note) {
      log.warn('NoteStore', 'note.update.missing', '便签更新目标不存在', { noteId: id, fieldCount: Object.keys(data).length })
      return
    }
    // 先同步给受控 textarea，避免拼音 composing 时旧值回写成「w我」。
    set(state => ({ notes: state.notes.map(n => n.id === id ? { ...n, ...patch } : n) }))
    const previous = writes.get(id) ?? Promise.resolve()
    const write = previous.catch(() => undefined).then(async () => {
      const updated = await db.notes.update(id, patch)
      if (!updated) {
        log.warn('NoteStore', 'note.update.missing', '便签更新目标不存在', { noteId: id, fieldCount: Object.keys(data).length })
        return
      }
      log.info('NoteStore', 'note.updated', '便签已更新', {
        projectId: note.projectId, noteId: id, fields: Object.keys(data).join(','),
        ...(data.position ? { x: Math.round(data.position.x), y: Math.round(data.position.y) } : {}),
        ...(data.collapsed != null ? { collapsed: data.collapsed } : {}),
      })
    })
    writes.set(id, write)
    try { await write } finally { if (writes.get(id) === write) writes.delete(id) }
  },

  deleteNote: async (id) => {
    const note = get().notes.find(n => n.id === id)
    await writes.get(id)?.catch(() => undefined)
    await db.notes.delete(id)
    log.info('NoteStore', 'note.deleted', '便签删除已执行', { projectId: note?.projectId, noteId: id, existedInStore: Boolean(note) })
    set({ notes: get().notes.filter(n => n.id !== id) })
  },

  togglePin: async (id) => {
    const note = get().notes.find(n => n.id === id)
    if (!note) {
      log.warn('NoteStore', 'note.pin.missing', '置顶操作找不到便签', { noteId: id })
      return
    }
    const pinned = !note.pinned
    await get().updateNote(id, { pinned })
    log.info('NoteStore', 'note.pin.changed', '便签置顶状态已更新', { projectId: note.projectId, noteId: id, pinned })
  },

  getChapterNotes: (chapterId) => {
    return get().notes.filter(n => n.chapterId === chapterId)
  },

  getGlobalNotes: () => {
    return get().notes.filter(n => !n.chapterId)
  },
}))
