import { useEffect, useMemo, useState } from 'react'
import { Brain, Check, Plus, X } from 'lucide-react'
import type { KnowledgeAction, KnowledgeEventStatus, Project } from '../../lib/types'
import { useKnowledgeLedgerStore } from '../../stores/knowledge-ledger'

const ACTION_LABEL: Record<KnowledgeAction, string> = {
  learn: '获知',
  mislearn: '误认',
  forget: '遗忘',
  correct: '纠正',
}

const STATUS_LABEL: Record<KnowledgeEventStatus, string> = {
  candidate: '待确认',
  confirmed: '已确认',
  rejected: '已否决',
  'source-missing': '来源缺失',
  'invalid-range': '时序失效',
}

const REVIEWABLE: KnowledgeEventStatus[] = ['candidate', 'source-missing', 'invalid-range']

export default function KnowledgeLedgerPanel({ project, onShowFacts }: {
  project: Project
  onShowFacts: () => void
}) {
  const { events, characters, chapters, loading, load, adopt, confirmEvent, rejectEvent } = useKnowledgeLedgerStore()
  const [status, setStatus] = useState<KnowledgeEventStatus>('candidate')
  const [characterId, setCharacterId] = useState('')
  const [knowledgeKey, setKnowledgeKey] = useState('')
  const [statement, setStatement] = useState('')
  const [action, setAction] = useState<KnowledgeAction>('learn')
  const [belief, setBelief] = useState('')
  const [sourceChapterId, setSourceChapterId] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (project.id != null) void load(project.id)
  }, [load, project.id])

  const counts = useMemo(() => {
    const result = new Map<KnowledgeEventStatus, number>()
    for (const event of events) result.set(event.status, (result.get(event.status) ?? 0) + 1)
    return result
  }, [events])
  const rows = events.filter(event => event.status === status)

  const addCandidate = async () => {
    if (project.id == null) return
    const character = characters.find(item => item.id === Number(characterId))
    if (!character || !knowledgeKey.trim() || !statement.trim()) {
      setMessage('请选择角色，并填写稳定知识 key 与命题文本。')
      return
    }
    if (action === 'mislearn' && !belief.trim()) {
      setMessage('误认事件必须填写角色实际相信的错误内容。')
      return
    }
    const result = await adopt(project.id, [{
      characterId: character.id!,
      characterName: character.name,
      worldGroupId: character.homeWorldGroupId ?? null,
      knowledgeKey: knowledgeKey.trim(),
      statement: statement.trim(),
      action,
      belief: action === 'mislearn' ? belief.trim() : null,
      sourceType: sourceChapterId ? 'chapter' : 'manual',
      sourceChapterId: sourceChapterId ? Number(sourceChapterId) : null,
      sourceQuote: '',
    }])
    setMessage(result.written ? '已加入待确认候选。' : `未写入（跳过 ${result.skipped} 条），请检查重复项或字段。`)
    if (result.written) {
      setKnowledgeKey('')
      setStatement('')
      setBelief('')
      setStatus('candidate')
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          <Brain className="w-5 h-5 text-violet-400" />
          <h1 className="text-lg font-bold text-text-primary">角色认知账本（CONSISTENCY-2）</h1>
        </div>
        <button onClick={onShowFacts} className="px-3 py-1.5 text-xs rounded-md bg-bg-elevated text-text-secondary hover:text-text-primary">
          查看世界事实
        </button>
      </div>
      <p className="text-xs text-text-muted mb-4">
        世界事实与角色认知分开保存；只有作者确认的事件才会进入后续章节认知投影。目标章自身的获知事件不会提前生效。
      </p>

      <div className="mb-4 p-3 rounded-lg border border-border bg-bg-elevated/60 space-y-2">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <select value={characterId} onChange={event => setCharacterId(event.target.value)}
            className="px-2 py-1.5 text-xs rounded bg-bg-base border border-border text-text-primary">
            <option value="">选择角色</option>
            {characters.map(character => <option key={character.id} value={character.id}>{character.name}</option>)}
          </select>
          <select value={action} onChange={event => setAction(event.target.value as KnowledgeAction)}
            className="px-2 py-1.5 text-xs rounded bg-bg-base border border-border text-text-primary">
            {(Object.keys(ACTION_LABEL) as KnowledgeAction[]).map(key =>
              <option key={key} value={key}>{ACTION_LABEL[key]}</option>)}
          </select>
          <select value={sourceChapterId} onChange={event => setSourceChapterId(event.target.value)}
            className="px-2 py-1.5 text-xs rounded bg-bg-base border border-border text-text-primary">
            <option value="">基线（人工/导入）</option>
            {chapters.map(chapter => <option key={chapter.id} value={chapter.id}>{chapter.title}</option>)}
          </select>
        </div>
        <input value={knowledgeKey} onChange={event => setKnowledgeKey(event.target.value)}
          placeholder="稳定知识 key，例如 enemy.true_identity"
          className="w-full px-2 py-1.5 text-xs rounded bg-bg-base border border-border text-text-primary placeholder:text-text-muted" />
        <textarea value={statement} onChange={event => setStatement(event.target.value)}
          placeholder="世界中的真实命题，例如：黑衣人是城主"
          className="w-full min-h-[56px] px-2 py-1.5 text-xs rounded bg-bg-base border border-border text-text-primary placeholder:text-text-muted" />
        {action === 'mislearn' && (
          <textarea value={belief} onChange={event => setBelief(event.target.value)}
            placeholder="角色实际相信的错误内容"
            className="w-full min-h-[48px] px-2 py-1.5 text-xs rounded bg-bg-base border border-border text-text-primary placeholder:text-text-muted" />
        )}
        <div className="flex items-center gap-2">
          <button onClick={() => void addCandidate()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-violet-500/15 text-xs text-violet-300 hover:bg-violet-500/25">
            <Plus className="w-3.5 h-3.5" /> 加入待确认
          </button>
          {message && <span className="text-[11px] text-text-muted">{message}</span>}
        </div>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {(Object.keys(STATUS_LABEL) as KnowledgeEventStatus[]).map(key => (
          <button key={key} onClick={() => setStatus(key)}
            className={`px-3 py-1.5 text-xs rounded-md ${status === key ? 'bg-violet-500/20 text-violet-300' : 'bg-bg-elevated text-text-muted hover:text-text-secondary'}`}>
            {STATUS_LABEL[key]}{counts.get(key) ? `（${counts.get(key)}）` : ''}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-text-muted">加载中…</p>}
      {!loading && !rows.length && <p className="text-sm text-text-muted py-8 text-center">暂无{STATUS_LABEL[status]}事件。</p>}
      <div className="space-y-2">
        {rows.map(event => (
          <div key={event.id} className="flex items-start gap-3 p-3 bg-bg-elevated rounded-lg border border-border">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary">
                <span className="font-medium">{event.characterName}</span>
                <span className="text-text-muted"> · {ACTION_LABEL[event.action]}：</span>
                <span>{event.statement}</span>
                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-bg-base text-text-muted">{event.knowledgeKey}</span>
              </p>
              {event.belief && <p className="text-xs text-amber-300 mt-1">实际相信：{event.belief}</p>}
              <p className="text-[11px] text-text-muted mt-1">
                来源：{event.sourceChapterId == null ? '基线' : chapters.find(chapter => chapter.id === event.sourceChapterId)?.title ?? `章节#${event.sourceChapterId}`}
              </p>
            </div>
            {REVIEWABLE.includes(event.status) && event.id != null && (
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => void confirmEvent(project.id!, event.id!)} title="确认事件"
                  className="p-1.5 text-emerald-400 hover:bg-emerald-500/15 rounded"><Check className="w-4 h-4" /></button>
                <button onClick={() => void rejectEvent(project.id!, event.id!)} title="否决事件"
                  className="p-1.5 text-rose-400 hover:bg-rose-500/15 rounded"><X className="w-4 h-4" /></button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
