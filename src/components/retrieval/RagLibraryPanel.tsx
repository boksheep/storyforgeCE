import { useEffect, useMemo, useState } from 'react'
import {
  ChevronDown,
  Database,
  FileSearch,
  Loader2,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react'
import {
  buildRagLibrary,
  readRecentRagRecalls,
  updateRagDocumentPolicy,
  updateRagFieldPolicy,
  type RecentRagRecall,
} from '../../lib/retrieval/rag-library'
import {
  clearProjectRetrievalCache,
  rebuildProjectNarrativeSummaries,
  rebuildProjectRetrievalChunks,
} from '../../lib/retrieval/retrieval'
import type { Project, RagLibraryEntry } from '../../lib/types'
import { useWorldGroupStore } from '../../stores/world-group'
import { useDialog } from '../shared/Dialog'
import { useToast } from '../shared/Toast'

interface DocumentGroup {
  id: string
  tableName: string
  recordId: number
  sourceLabel: string
  title: string
  updatedAt: number
  fields: RagLibraryEntry[]
}

const VECTOR_LABELS: Record<RagLibraryEntry['vectorState'], string> = {
  none: '未建章节索引',
  keyword: '本地关键词',
  partial: '部分向量',
  ready: '向量就绪',
}

export default function RagLibraryPanel({ project }: { project: Project }) {
  const projectId = project.id!
  const activeWorldGroupId = useWorldGroupStore(state => state.activeGroupId)
  const worldGroupId = project.enableMultiWorld ? activeWorldGroupId : null
  const toast = useToast()
  const dialog = useDialog()
  const [entries, setEntries] = useState<RagLibraryEntry[]>([])
  const [recalls, setRecalls] = useState<RecentRagRecall[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<'rebuild' | 'clear' | null>(null)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const [library, recent] = await Promise.all([
        buildRagLibrary({ projectId, worldGroupId }),
        readRecentRagRecalls(projectId),
      ])
      setEntries(library)
      setRecalls(recent)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // load is scoped by project/world identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, worldGroupId])

  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    const visible = normalized
      ? entries.filter(entry => (
          `${entry.sourceLabel} ${entry.title} ${entry.fieldLabel} ${entry.content}`
            .toLocaleLowerCase('zh-CN')
            .includes(normalized)
        ))
      : entries
    const map = new Map<string, DocumentGroup>()
    for (const entry of visible) {
      const current = map.get(entry.documentId) ?? {
        id: entry.documentId,
        tableName: entry.tableName,
        recordId: entry.recordId,
        sourceLabel: entry.sourceLabel,
        title: entry.title,
        updatedAt: entry.updatedAt,
        fields: [],
      }
      current.fields.push(entry)
      map.set(entry.documentId, current)
    }
    return [...map.values()]
  }, [entries, query])

  const stats = useMemo(() => ({
    documents: new Set(entries.map(entry => entry.documentId)).size,
    fields: entries.length,
    enabled: entries.filter(entry => entry.enabled).length,
    tokens: entries.filter(entry => entry.enabled).reduce((sum, entry) => sum + entry.tokenEstimate, 0),
    chunks: Math.max(0, ...entries.map(entry => entry.chunkCount)),
    totalChunks: [...new Map(entries.map(entry => [entry.documentId, entry.chunkCount])).values()]
      .reduce((sum, count) => sum + count, 0),
  }), [entries])

  const mutate = async (operation: () => Promise<void>) => {
    try {
      await operation()
      await load()
    } catch (reason) {
      toast.error(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const rebuild = async () => {
    setBusy('rebuild')
    try {
      const chunks = await rebuildProjectRetrievalChunks({ projectId })
      const summaries = await rebuildProjectNarrativeSummaries({ projectId })
      await load()
      toast.success(
        `索引已重建：${chunks.chunks} 个正文块，`
        + `${summaries.chapterNodes + summaries.volumeNodes + summaries.bookNodes} 个叙事摘要。`,
      )
    } catch (reason) {
      toast.error(`重建失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(null)
    }
  }

  const clear = async () => {
    const confirmed = await dialog.confirm({
      title: '删除可重建检索缓存？',
      message: '只会删除章节切块、向量和叙事摘要缓存；章节正文、角色、设定和资料策略不会删除。',
      confirmText: '删除派生缓存',
      tone: 'danger',
    })
    if (!confirmed) return
    setBusy('clear')
    try {
      const cleared = await clearProjectRetrievalCache(projectId)
      await load()
      toast.success(`已删除 ${cleared.chunks} 个检索块和 ${cleared.summaries} 个派生摘要；Canon 未改动。`)
    } catch (reason) {
      toast.error(`删除失败：${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="h-full overflow-y-auto bg-bg-base p-5">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-start gap-3">
          <div>
            <div className="flex items-center gap-2">
              <Database className="h-5 w-5 text-accent" />
              <h1 className="text-lg font-semibold text-text-primary">资料与检索库</h1>
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-text-secondary">
              这里实时投影项目 Canon，不复制第二份真相。你可以查看每条输入、控制字段是否参与创作、
              调整优先权与预算，并检查节点运行时真正召回了什么。
            </p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void rebuild()}
              className="flex items-center gap-1.5 rounded border border-border bg-bg-surface px-3 py-2 text-xs text-text-secondary hover:border-accent hover:text-accent disabled:opacity-50"
            >
              {busy === 'rebuild' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              重建派生索引
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={() => void clear()}
              className="flex items-center gap-1.5 rounded border border-error/40 px-3 py-2 text-xs text-error hover:bg-error/10 disabled:opacity-50"
            >
              {busy === 'clear' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              删除派生索引
            </button>
          </div>
        </header>

        <section className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            ['可见记录', stats.documents.toLocaleString()],
            ['可见字段', `${stats.enabled}/${stats.fields}`],
            ['启用内容估算', `${stats.tokens.toLocaleString()} tokens`],
            ['章节检索块', stats.totalChunks.toLocaleString()],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-bg-surface p-3">
              <p className="text-[10px] text-text-muted">{label}</p>
              <p className="mt-1 text-sm font-medium text-text-primary">{value}</p>
            </div>
          ))}
        </section>

        <section className="rounded-xl border border-border bg-bg-surface">
          <div className="flex flex-wrap items-center gap-3 border-b border-border p-3">
            <div>
              <h2 className="text-sm font-medium text-text-primary">输入资料</h2>
              <p className="text-[10px] text-text-muted">修改只影响检索策略，不改写作品正文或设定内容。</p>
            </div>
            <label className="ml-auto flex min-w-64 items-center gap-2 rounded border border-border bg-bg-base px-2 py-1.5">
              <Search className="h-3.5 w-3.5 text-text-muted" />
              <input
                aria-label="搜索资料库"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="搜索来源、记录、字段或正文"
                className="min-w-0 flex-1 bg-transparent text-xs text-text-primary outline-none"
              />
            </label>
          </div>
          {loading && !entries.length ? (
            <p className="flex items-center justify-center gap-2 py-16 text-xs text-text-muted">
              <Loader2 className="h-4 w-4 animate-spin" /> 正在读取项目资料…
            </p>
          ) : error ? (
            <p className="m-4 rounded bg-error/10 p-3 text-xs text-error">{error}</p>
          ) : !groups.length ? (
            <p className="py-16 text-center text-xs text-text-muted">当前世界没有匹配的可见资料。</p>
          ) : (
            <div className="divide-y divide-border">
              {groups.map(group => {
                const first = group.fields[0]
                const totalTokens = group.fields.reduce((sum, entry) => sum + entry.tokenEstimate, 0)
                const chunkCount = Math.max(...group.fields.map(entry => entry.chunkCount))
                const vectorState = group.fields.find(entry => entry.vectorState === 'ready')?.vectorState
                  ?? group.fields.find(entry => entry.vectorState === 'partial')?.vectorState
                  ?? group.fields.find(entry => entry.vectorState === 'keyword')?.vectorState
                  ?? 'none'
                return (
                  <details key={group.id} className="group">
                    <summary className="flex cursor-pointer list-none items-center gap-3 px-4 py-3 hover:bg-bg-hover">
                      <ChevronDown className="h-3.5 w-3.5 text-text-muted transition-transform group-open:rotate-180" />
                      <input
                        type="checkbox"
                        aria-label={`启用资料 ${group.title}`}
                        checked={first.documentEnabled}
                        onClick={event => event.stopPropagation()}
                        onChange={event => void mutate(() => updateRagDocumentPolicy({
                          projectId,
                          tableName: group.tableName,
                          recordId: group.recordId,
                          patch: { enabled: event.target.checked },
                        }))}
                        className="accent-[var(--color-accent)]"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-text-primary">
                          <span className="mr-2 text-text-muted">{group.sourceLabel}</span>{group.title}
                        </p>
                        <p className="mt-0.5 text-[10px] text-text-muted">
                          {group.fields.length} 字段 · {totalTokens.toLocaleString()} tokens ·
                          {' '}{chunkCount ? `${chunkCount} 块 · ` : ''}{VECTOR_LABELS[vectorState]} ·
                          {' '}更新 {group.updatedAt ? new Date(group.updatedAt).toLocaleString() : '未知'}
                        </p>
                      </div>
                      <label className="text-[10px] text-text-muted" onClick={event => event.stopPropagation()}>
                        默认权重
                        <input
                          type="number"
                          min={0.1}
                          max={5}
                          step={0.1}
                          value={first.documentWeight}
                          onChange={event => void mutate(() => updateRagDocumentPolicy({
                            projectId,
                            tableName: group.tableName,
                            recordId: group.recordId,
                            patch: { weight: Number(event.target.value) },
                          }))}
                          className="ml-1 w-16 rounded border border-border bg-bg-base px-1.5 py-1 text-[10px] text-text-primary"
                        />
                      </label>
                      <label className="text-[10px] text-text-muted" onClick={event => event.stopPropagation()}>
                        字段上限
                        <input
                          type="number"
                          min={100}
                          step={100}
                          value={first.documentTokenCap}
                          onChange={event => void mutate(() => updateRagDocumentPolicy({
                            projectId,
                            tableName: group.tableName,
                            recordId: group.recordId,
                            patch: { tokenCap: Number(event.target.value) },
                          }))}
                          className="ml-1 w-20 rounded border border-border bg-bg-base px-1.5 py-1 text-[10px] text-text-primary"
                        />
                      </label>
                    </summary>
                    <div className="grid gap-2 bg-bg-base/50 px-10 pb-4 pt-1 lg:grid-cols-2">
                      {group.fields.map(entry => (
                        <div key={entry.key} className="rounded border border-border bg-bg-surface p-2.5">
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              aria-label={`启用字段 ${entry.fieldLabel}`}
                              checked={entry.enabled}
                              disabled={!entry.documentEnabled}
                              onChange={event => void mutate(() => updateRagFieldPolicy({
                                projectId,
                                tableName: entry.tableName,
                                recordId: entry.recordId,
                                fieldKey: entry.fieldKey,
                                patch: { enabled: event.target.checked },
                              }))}
                              className="accent-[var(--color-accent)]"
                            />
                            <span className="text-[11px] font-medium text-text-secondary">{entry.fieldLabel}</span>
                            <span className="ml-auto text-[9px] text-text-muted">
                              {entry.tokenEstimate} tokens · 权重 {entry.weight} · 上限 {entry.tokenCap}
                            </span>
                          </div>
                          <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-[10px] leading-4 text-text-muted">
                            {entry.content}
                          </pre>
                        </div>
                      ))}
                    </div>
                  </details>
                )
              })}
            </div>
          )}
        </section>

        <section className="rounded-xl border border-border bg-bg-surface">
          <div className="flex items-center gap-2 border-b border-border p-3">
            <FileSearch className="h-4 w-4 text-accent" />
            <div>
              <h2 className="text-sm font-medium text-text-primary">最近实际召回</h2>
              <p className="text-[10px] text-text-muted">来自已保存的节点运行快照，不会因资料后来变化而重算。</p>
            </div>
          </div>
          {!recalls.length ? (
            <p className="p-6 text-center text-xs text-text-muted">尚无精确资料节点运行记录。</p>
          ) : (
            <div className="divide-y divide-border">
              {recalls.map(recall => (
                <details key={`${recall.runId}:${recall.nodeTitle}`} className="p-3">
                  <summary className="cursor-pointer text-xs text-text-secondary">
                    {recall.nodeTitle} · {new Date(recall.startedAt).toLocaleString()} ·
                    {' '}纳入 {recall.included.length} / 省略 {recall.omitted.length} / 裁剪 {recall.trimmed.length}
                  </summary>
                  <div className="mt-2 grid gap-2 text-[10px] text-text-muted md:grid-cols-3">
                    <p><strong className="text-text-secondary">已纳入</strong><br />{recall.included.join('\n') || '无'}</p>
                    <p><strong className="text-text-secondary">已省略</strong><br />{recall.omitted.join('\n') || '无'}</p>
                    <p><strong className="text-text-secondary">已裁剪</strong><br />{recall.trimmed.join('\n') || '无'}</p>
                  </div>
                </details>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
