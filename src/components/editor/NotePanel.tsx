/** 正文便签：以纸张左边为 x 原点，可进入两侧空白，随正文一起滚动。 */
import { useEffect, useRef, useState, type PointerEvent } from 'react'
import { Grip, Maximize2, Minimize2, Pin, Trash2 } from 'lucide-react'
import { useNoteStore } from '../../stores/note'
import { NOTE_COLORS, type Note, type NoteColor } from '../../lib/types/note'

interface Props {
  projectId: number
  chapterId?: number
  paperRef?: React.RefObject<HTMLDivElement | null>
}

const CARD_WIDTH = 232
const MINI_WIDTH = 176
const CARD_HEIGHT = 184
const MINI_HEIGHT = 42
const MIN_WIDTH = 180
const MAX_WIDTH = 560
const MIN_HEIGHT = 96

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(Math.round(value), Math.max(0, max)))
}

export default function NotePanel({ projectId, chapterId, paperRef }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [paperOffsetX, setPaperOffsetX] = useState(0)
  const { notes, loadAll, updateNote, deleteNote, togglePin } = useNoteStore()
  const visible = notes.filter(note => note.projectId === projectId
    && (note.chapterId === chapterId || note.chapterId == null))

  useEffect(() => { void loadAll(projectId) }, [projectId, loadAll])
  useEffect(() => {
    const update = () => setPaperOffsetX(paperRef?.current?.offsetLeft ?? 0)
    update()
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(update) : null
    if (rootRef.current) observer?.observe(rootRef.current)
    if (paperRef?.current) observer?.observe(paperRef.current)
    window.addEventListener('resize', update)
    return () => { observer?.disconnect(); window.removeEventListener('resize', update) }
  }, [paperRef])

  return (
    <div ref={rootRef} className="pointer-events-none absolute inset-0 z-10" data-testid="note-canvas">
      {visible.map((note, index) => (
        <CanvasNote key={note.id} note={note} index={index} canvasRef={rootRef}
          paperOffsetX={paperOffsetX}
          onUpdate={data => { if (note.id != null) void updateNote(note.id, data) }}
          onTogglePin={() => { if (note.id != null) void togglePin(note.id) }}
          onDelete={() => { if (note.id != null) void deleteNote(note.id) }} />
      ))}
    </div>
  )
}

function CanvasNote({ note, index, canvasRef, paperOffsetX, onUpdate, onTogglePin, onDelete }: {
  note: Note
  index: number
  canvasRef: React.RefObject<HTMLDivElement | null>
  paperOffsetX: number
  onUpdate: (data: Partial<Note>) => void
  onTogglePin: () => void
  onDelete: () => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const grabRef = useRef<{ x: number; y: number } | null>(null)
  const dragRef = useRef<Note['position']>(undefined)
  const [dragPosition, setDragPosition] = useState<Note['position']>()
  const resizeStart = useRef<{ x: number; y: number; width: number; height: number } | null>(null)
  const [resizing, setResizing] = useState<{ width: number; height: number } | null>(null)
  const collapsed = note.collapsed ?? false
  const width = resizing?.width ?? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, note.width ?? CARD_WIDTH))
  const height = resizing?.height ?? note.height
  const rawPosition = dragPosition ?? note.position ?? { x: 18 + index * 22, y: 150 + index * 64 }

  const bounded = (x: number, y: number, cardWidth = collapsed ? MINI_WIDTH : width,
    cardHeight = collapsed ? MINI_HEIGHT : height ?? CARD_HEIGHT) => {
    const canvas = canvasRef.current
    return {
      x: clamp(x, (canvas?.clientWidth ?? cardWidth) - cardWidth),
      y: clamp(y, (canvas?.clientHeight ?? cardHeight) - cardHeight),
    }
  }
  const position = bounded(rawPosition.x + paperOffsetX, rawPosition.y)
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const card = cardRef.current
    if (!card) return
    const rect = card.getBoundingClientRect()
    grabRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top }
    event.currentTarget.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const grab = grabRef.current
    const canvas = canvasRef.current
    if (!grab || !canvas) return
    const rect = canvas.getBoundingClientRect()
    const canvasPosition = bounded(event.clientX - rect.left - grab.x, event.clientY - rect.top - grab.y)
    const next = { x: canvasPosition.x - paperOffsetX, y: canvasPosition.y }
    dragRef.current = next
    setDragPosition(next)
  }
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!grabRef.current) return
    grabRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const finalPosition = dragRef.current
    if (finalPosition && (finalPosition.x !== note.position?.x || finalPosition.y !== note.position?.y)) {
      onUpdate({ position: finalPosition })
    }
    dragRef.current = undefined
    setDragPosition(undefined)
  }

  /**
   * 调整大小：卡片左上角固定，向右下扩展；同时受画布剩余空间限制。
   * 早前只有 textarea 的 resize-y，卡片宽度不变、内容被裁，作者无法把便签拉宽。
   */
  const startResize = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    const rect = cardRef.current?.getBoundingClientRect()
    if (!rect) return
    event.preventDefault()
    event.stopPropagation()
    resizeStart.current = { x: event.clientX, y: event.clientY, width: rect.width, height: rect.height }
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const moveResize = (event: PointerEvent<HTMLDivElement>) => {
    const start = resizeStart.current
    const canvas = canvasRef.current
    if (!start || !canvas) return
    const maxWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, canvas.clientWidth - position.x))
    const maxHeight = Math.max(MIN_HEIGHT, canvas.clientHeight - position.y)
    setResizing({
      width: Math.round(Math.max(MIN_WIDTH, Math.min(maxWidth, start.width + event.clientX - start.x))),
      height: Math.round(Math.max(MIN_HEIGHT, Math.min(maxHeight, start.height + event.clientY - start.y))),
    })
  }
  const endResize = (event: PointerEvent<HTMLDivElement>) => {
    if (!resizeStart.current) return
    resizeStart.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    const next = resizing
    setResizing(null)
    if (next && (next.width !== note.width || next.height !== note.height)) onUpdate(next)
  }

  return (
    <div ref={cardRef} data-testid={`note-${note.id}`} data-color={note.color}
      className={`sf-note pointer-events-auto absolute flex flex-col overflow-hidden rounded-lg border shadow-xl ${collapsed ? 'w-44' : ''}`}
      style={{
        left: position.x, top: position.y, zIndex: note.pinned ? 2 : 1,
        ...(collapsed ? {} : { width, ...(height != null ? { height } : {}) }),
      }}>
      <div className="sf-note-header flex cursor-grab touch-none items-center gap-1 px-2 py-1.5 active:cursor-grabbing"
        onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp}>
        <Grip className="h-3.5 w-3.5 shrink-0 opacity-60" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-[11px] font-semibold">
          {collapsed ? (note.content.trim().split('\n')[0] || '空便签') : `便签 #${note.id}`}
        </span>
        <button type="button" title={note.pinned ? '取消置顶' : '置顶便签'}
          aria-label={note.pinned ? '取消置顶' : '置顶便签'} aria-pressed={note.pinned}
          onPointerDown={event => event.stopPropagation()} onClick={onTogglePin} className="rounded p-0.5">
          <Pin className="h-3.5 w-3.5" />
        </button>
        <button type="button" title={collapsed ? '展开便签' : '缩小便签'}
          aria-label={collapsed ? '展开便签' : '缩小便签'}
          onPointerDown={event => event.stopPropagation()}
          onClick={() => onUpdate({ collapsed: !collapsed })} className="rounded p-0.5">
          {collapsed ? <Maximize2 className="h-3.5 w-3.5" /> : <Minimize2 className="h-3.5 w-3.5" />}
        </button>
        <button type="button" title="删除便签" aria-label="删除便签"
          onPointerDown={event => event.stopPropagation()} onClick={onDelete}
          className="rounded p-0.5"><Trash2 className="h-3.5 w-3.5" /></button>
      </div>
      {!collapsed && (
        <div className="flex min-h-0 flex-1 flex-col px-2 pb-2">
          <textarea value={note.content} onChange={event => onUpdate({ content: event.target.value })}
            aria-label={`便签 #${note.id} 内容`} placeholder="记录灵感或临时线索…" rows={5}
            className="sf-note-input min-h-0 w-full flex-1 resize-none bg-transparent px-1 py-1 text-xs leading-5 outline-none placeholder:opacity-60" />
          <div className="mt-1 flex gap-1" aria-label="便签颜色">
            {(Object.keys(NOTE_COLORS) as NoteColor[]).map(color => (
              <button type="button" key={color} title={NOTE_COLORS[color].label}
                aria-label={`${NOTE_COLORS[color].label}便签`}
                aria-pressed={note.color === color}
                onClick={() => onUpdate({ color })}
                className={`sf-note-swatch sf-note-swatch-${color} h-4 w-4 rounded-full border-2 ${note.color === color ? 'border-current' : 'border-transparent'}`} />
            ))}
            {note.chapterId != null && <span className="ml-auto text-[10px] opacity-70">本章</span>}
          </div>
        </div>
      )}
      {!collapsed && (
        <div role="separator" aria-label="拖动调整便签大小" aria-orientation="horizontal"
          title="拖动调整便签大小"
          onPointerDown={startResize} onPointerMove={moveResize} onPointerUp={endResize} onPointerCancel={endResize}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize touch-none opacity-40 hover:opacity-80"
          style={{ background: 'repeating-linear-gradient(135deg, currentColor 0 1px, transparent 1px 4px)' }} />
      )}
    </div>
  )
}
