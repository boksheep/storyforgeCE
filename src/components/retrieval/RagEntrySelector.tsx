import { useEffect, useMemo, useState } from 'react'
import { Check, Database, Loader2, RefreshCw, Search } from 'lucide-react'
import { buildRagLibrary } from '../../lib/retrieval/rag-library'
import type { RagLibraryEntry } from '../../lib/types'

interface DocumentGroup {
  id: string
  sourceLabel: string
  title: string
  fields: RagLibraryEntry[]
}

export default function RagEntrySelector(props: {
  projectId: number
  worldGroupId: number | null
  selectedKeys: string[]
  onChange: (keys: string[]) => void
}) {
  const [entries, setEntries] = useState<RagLibraryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      setEntries(await buildRagLibrary({
        projectId: props.projectId,
        worldGroupId: props.worldGroupId,
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // load is bound to the active project/world identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.projectId, props.worldGroupId])

  const groups = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase('zh-CN')
    const filtered = normalized
      ? entries.filter(entry => (
          `${entry.sourceLabel} ${entry.title} ${entry.fieldLabel} ${entry.content}`
            .toLocaleLowerCase('zh-CN')
            .includes(normalized)
        ))
      : entries
    const map = new Map<string, DocumentGroup>()
    for (const entry of filtered) {
      const group = map.get(entry.documentId) ?? {
        id: entry.documentId,
        sourceLabel: entry.sourceLabel,
        title: entry.title,
        fields: [],
      }
      group.fields.push(entry)
      map.set(entry.documentId, group)
    }
    return [...map.values()]
  }, [entries, query])

  const selected = new Set(props.selectedKeys)
  const toggle = (key: string) => {
    props.onChange(selected.has(key)
      ? props.selectedKeys.filter(item => item !== key)
      : [...props.selectedKeys, key])
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <div>
          <p className="text-[10px] font-medium text-text-secondary">精确资料字段</p>
          <p className="text-[9px] leading-4 text-text-muted">
            已选 {props.selectedKeys.length} 项；执行时按资料库权重和预算冻结真实召回。
          </p>
        </div>
        <button
          type="button"
          title="刷新资料"
          onClick={() => void load()}
          className="rounded p-1 text-text-muted hover:bg-bg-hover hover:text-accent"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
      <label className="mb-2 flex items-center gap-1.5 rounded border border-border bg-bg-base px-2 py-1">
        <Search className="h-3 w-3 text-text-muted" />
        <input
          aria-label="搜索资料字段"
          value={query}
          onChange={event => setQuery(event.target.value)}
          placeholder="搜索角色、章节、设定或字段"
          className="min-w-0 flex-1 bg-transparent text-[10px] text-text-primary outline-none"
        />
      </label>
      <div className="max-h-[27rem] space-y-1.5 overflow-y-auto rounded border border-border bg-bg-base p-2">
        {loading && !entries.length ? (
          <p className="flex items-center justify-center gap-1 py-6 text-[10px] text-text-muted">
            <Loader2 className="h-3 w-3 animate-spin" /> 正在建立可见资料投影…
          </p>
        ) : error ? (
          <p className="rounded bg-error/10 p-2 text-[10px] text-error">{error}</p>
        ) : !groups.length ? (
          <p className="py-6 text-center text-[10px] text-text-muted">当前世界没有匹配的资料字段。</p>
        ) : groups.map(group => {
          const selectedCount = group.fields.filter(entry => selected.has(entry.key)).length
          return (
            <details key={group.id} open={selectedCount > 0} className="rounded border border-border/70 bg-bg-surface">
              <summary className="cursor-pointer list-none px-2 py-1.5 text-[10px] text-text-secondary">
                <span className="flex items-center gap-1">
                  <Database className="h-3 w-3 text-text-muted" />
                  <span className="min-w-0 flex-1 truncate">{group.sourceLabel} · {group.title}</span>
                  {selectedCount > 0 && (
                    <span className="rounded bg-accent/10 px-1 text-[9px] text-accent">{selectedCount}</span>
                  )}
                </span>
              </summary>
              <div className="border-t border-border/70 p-1">
                {group.fields.map(entry => (
                  <button
                    key={entry.key}
                    type="button"
                    disabled={!entry.enabled}
                    onClick={() => toggle(entry.key)}
                    title={entry.enabled
                      ? `${entry.tokenEstimate} tokens · 权重 ${entry.weight} · 上限 ${entry.tokenCap}`
                      : '该字段已在资料库停用'}
                    className={`flex w-full items-start gap-1.5 rounded px-1.5 py-1 text-left ${
                      selected.has(entry.key)
                        ? 'bg-accent/10 text-accent'
                        : entry.enabled
                          ? 'text-text-secondary hover:bg-bg-hover'
                          : 'cursor-not-allowed text-text-muted opacity-50'
                    }`}
                  >
                    <span className="mt-0.5 flex h-3 w-3 shrink-0 items-center justify-center rounded border border-current">
                      {selected.has(entry.key) && <Check className="h-2.5 w-2.5" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[10px]">{entry.fieldLabel}</span>
                      <span className="block truncate text-[9px] opacity-70">
                        {entry.tokenEstimate} tokens · {entry.vectorState === 'ready' ? '向量就绪' : entry.vectorState === 'keyword' ? '本地关键词' : '未建索引'}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </details>
          )
        })}
      </div>
    </section>
  )
}
