import { useState, useCallback } from 'react'
import type { DragEvent } from 'react'

/**
 * 原生 HTML5 拖动排序（FB-2，大纲卷/章节/故事块通用，零依赖）。
 *
 * 用法：抓「拖拽手柄」拖（dragHandleProps），整行作放置区（dropProps）。
 * 放下时按「把拖起项移动到目标项所在位置」计算新顺序，回调 onReorder(新 id 顺序)。
 * 只在同一组（同 parentId）内排序——调用方各自传自己的 id 列表。
 */
export function computeReorder(ids: number[], dragId: number, targetId: number): number[] {
  const from = ids.indexOf(dragId)
  const to = ids.indexOf(targetId)
  if (from < 0 || to < 0 || from === to) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, dragId)
  return next
}

export interface ItemDnD {
  dragHandleProps: {
    draggable: true
    onDragStart: (e: DragEvent) => void
    onDragEnd: () => void
  }
  dropProps: {
    onDragOver: (e: DragEvent) => void
    onDragEnter: () => void
    onDragLeave: () => void
    onDrop: (e: DragEvent) => void
  }
  isDragging: boolean
  isOver: boolean
}

export function useDragReorder(
  ids: (number | undefined)[],
  onReorder: (orderedIds: number[]) => void,
) {
  const [dragId, setDragId] = useState<number | null>(null)
  const [overId, setOverId] = useState<number | null>(null)

  const reset = useCallback(() => { setDragId(null); setOverId(null) }, [])

  const itemDnD = useCallback((id: number | undefined): ItemDnD => {
    const has = id != null
    return {
      dragHandleProps: {
        draggable: true,
        onDragStart: (e: DragEvent) => {
          if (!has) return
          setDragId(id!)
          e.dataTransfer.effectAllowed = 'move'
          // Firefox 需要 setData 才会触发拖拽
          try { e.dataTransfer.setData('text/plain', String(id)) } catch { /* 忽略 */ }
        },
        onDragEnd: reset,
      },
      dropProps: {
        onDragOver: (e: DragEvent) => { if (dragId != null) e.preventDefault() },
        onDragEnter: () => { if (has && dragId != null && id !== dragId) setOverId(id!) },
        onDragLeave: () => { if (overId === id) setOverId(null) },
        onDrop: (e: DragEvent) => {
          e.preventDefault()
          if (dragId == null || !has || dragId === id) { reset(); return }
          const list = ids.filter((x): x is number => x != null)
          const next = computeReorder(list, dragId, id!)
          if (next !== list) onReorder(next)
          reset()
        },
      },
      isDragging: dragId === id,
      isOver: overId === id && dragId != null && dragId !== id,
    }
  }, [ids, onReorder, dragId, overId, reset])

  return { itemDnD, dragging: dragId != null }
}
