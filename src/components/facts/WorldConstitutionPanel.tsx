import { useEffect, useMemo, useState } from 'react'
import { Check, Landmark, Loader2, ScanSearch, X } from 'lucide-react'
import type { FactStatus, Project } from '../../lib/types'
import { db } from '../../lib/db/schema'
import { useAIStream } from '../../hooks/useAIStream'
import { createAISessionKey } from '../../stores/ai-generation-session'
import { useFactLedgerStore } from '../../stores/fact-ledger'
import { getFactPredicate, isConstitutionPredicate } from '../../lib/registry/fact-predicate-registry'
import {
  buildSettingAssertionExtractPrompt,
  listSettingAssertionSources,
  parseSettingAssertionCandidates,
} from '../../lib/fact-ledger/setting-assertions'

type ConstitutionTab = 'candidate' | 'confirmed' | 'exceptions' | 'rejected'
const EXCEPTIONS: FactStatus[] = ['stale', 'source-missing', 'invalid-range']

const TAB_LABEL: Record<ConstitutionTab, string> = {
  candidate: '待确认',
  confirmed: '已确认',
  exceptions: '来源异常',
  rejected: '已否决',
}

export default function WorldConstitutionPanel({ project, onShowFacts }: {
  project: Project
  onShowFacts: () => void
}) {
  const {
    facts, loading, load, adoptSetting, confirmFact, replaceConstitutionFact, rejectFact,
  } = useFactLedgerStore()
  const ai = useAIStream(createAISessionKey(project.id!, 'canon.setting.extract'))
  const [tab, setTab] = useState<ConstitutionTab>('candidate')
  const [message, setMessage] = useState('')
  const [replacementCandidateId, setReplacementCandidateId] = useState<number | null>(null)

  useEffect(() => {
    if (project.id != null) void load(project.id)
  }, [load, project.id])

  const constitutionFacts = useMemo(
    () => facts.filter(fact => isConstitutionPredicate(fact.predicate)),
    [facts],
  )
  const rows = constitutionFacts.filter(fact =>
    tab === 'exceptions' ? EXCEPTIONS.includes(fact.status) : fact.status === tab)
  const counts = useMemo(() => ({
    candidate: constitutionFacts.filter(fact => fact.status === 'candidate').length,
    confirmed: constitutionFacts.filter(fact => fact.status === 'confirmed').length,
    exceptions: constitutionFacts.filter(fact => EXCEPTIONS.includes(fact.status)).length,
    rejected: constitutionFacts.filter(fact => fact.status === 'rejected').length,
  }), [constitutionFacts])

  const extractFromSettings = async () => {
    if (project.id == null) return
    setMessage('')
    const [sources, worldGroups, characters] = await Promise.all([
      listSettingAssertionSources(project.id),
      db.worldGroups.where('projectId').equals(project.id).toArray(),
      db.characters.where('projectId').equals(project.id).toArray(),
    ])
    if (!sources.length) {
      setMessage('当前世界观、力量体系、故事核心和角色档案中没有可扫描的已登记字段。')
      return
    }
    const subjects = {
      worldGroups: worldGroups.length
        ? worldGroups.map(item => ({ id: item.id!, name: item.name }))
        : [{ id: null, name: '默认世界' }],
      characters: characters
        .filter(item => item.id != null)
        .map(item => ({
          id: item.id!,
          name: item.name,
          worldGroupId: item.homeWorldGroupId ?? null,
        })),
    }
    try {
      const raw = await ai.start([
        {
          role: 'system',
          content: '你是设定断言抽取器。严格遵守闭集、逐字证据和 JSON 输出要求，不补写用户未提供的设定。',
        },
        { role: 'user', content: buildSettingAssertionExtractPrompt(sources, subjects) },
      ], undefined, { category: 'canon.setting.extract', projectId: project.id })
      const candidates = parseSettingAssertionCandidates(raw, sources, subjects)
      const result = await adoptSetting({
        projectId: project.id,
        candidates,
        sources,
        subjects,
      })
      setTab('candidate')
      setMessage(`扫描 ${sources.length} 个来源字段，解析 ${candidates.length} 条闭集候选；写入 ${result.written} 条，跳过 ${result.skipped} 条。`)
    } catch (error) {
      setMessage(`设定扫描失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const handleConfirm = async (factId: number) => {
    const result = await confirmFact(project.id!, factId)
    if (result.confirmed) {
      setReplacementCandidateId(null)
      setMessage('已确认为世界宪法，并会回注后续生成与一致性审校。')
      return
    }
    if (result.clashes.length) {
      setReplacementCandidateId(factId)
      const values = result.clashes.map(item => `“${item.confirmed.value}”`).join('、')
      setMessage(`确认被阻止：同一主体和主题已有互斥 Canon ${values}。请否决候选、修改来源，或先人工处理旧断言。`)
      return
    }
    if (result.reason === 'source-stale' || result.reason === 'source-missing') {
      setMessage(result.reason === 'source-stale'
        ? '确认被阻止：来源字段在提取后已经修改。请重新扫描设定，旧候选不会继续注入。'
        : '确认被阻止：来源记录或登记字段已缺失。请检查设定并重新扫描。')
      return
    }
    setMessage('该断言当前不可确认，请刷新后重试。')
  }

  const handleExplicitReplacement = async () => {
    if (replacementCandidateId == null) return
    const result = await replaceConstitutionFact(project.id!, replacementCandidateId)
    if (result.confirmed) {
      setMessage(`已明确取代 ${result.replaced} 条旧世界宪法；旧断言保留为“已取代”审计记录。`)
      setReplacementCandidateId(null)
    } else if (result.reason === 'locked-conflict') {
      setMessage('旧世界宪法已锁定，不能取代。请先在事实库解除锁定或保留旧断言。')
    } else {
      setMessage('取代失败：候选或来源状态已变化，请重新扫描并复核。')
      setReplacementCandidateId(null)
    }
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-2">
          <Landmark className="w-5 h-5 text-amber-400" />
          <h1 className="text-lg font-bold text-text-primary">世界宪法（CONSISTENCY-3）</h1>
        </div>
        <button onClick={onShowFacts}
          className="px-3 py-1.5 text-xs rounded-md bg-bg-elevated text-text-secondary hover:text-text-primary">
          查看世界事实
        </button>
      </div>
      <p className="text-xs text-text-muted mb-4">
        扫描只从登记过的设定字段和主题闭集中提取逐字证据，结果一律是候选。作者确认时，同一主体、同一主题的不同值会被硬性阻止。
      </p>

      <div className="mb-4 p-3 rounded-lg border border-border bg-bg-elevated/60">
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => void extractFromSettings()} disabled={ai.isStreaming}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500/15 text-xs text-amber-300 hover:bg-amber-500/25 disabled:opacity-50">
            {ai.isStreaming ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ScanSearch className="w-3.5 h-3.5" />}
            {ai.isStreaming ? '正在扫描设定…' : '扫描已登记设定'}
          </button>
          {message && <span className="text-[11px] text-text-muted">{message}</span>}
        </div>
        {replacementCandidateId != null && (
          <button onClick={() => void handleExplicitReplacement()}
            className="mt-2 px-3 py-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-xs text-rose-300 hover:bg-rose-500/20">
            明确以本候选取代互斥旧宪法
          </button>
        )}
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {(Object.keys(TAB_LABEL) as ConstitutionTab[]).map(key => (
          <button key={key} onClick={() => setTab(key)}
            className={`px-3 py-1.5 text-xs rounded-md ${tab === key ? 'bg-amber-500/20 text-amber-300' : 'bg-bg-elevated text-text-muted hover:text-text-secondary'}`}>
            {TAB_LABEL[key]}{counts[key] ? `（${counts[key]}）` : ''}
          </button>
        ))}
      </div>

      {loading && <p className="text-sm text-text-muted">加载中…</p>}
      {!loading && rows.length === 0 && (
        <p className="text-sm text-text-muted py-8 text-center">暂无{TAB_LABEL[tab]}世界宪法断言。</p>
      )}
      <div className="space-y-2">
        {rows.map(fact => (
          <div key={fact.id} className="flex items-start gap-3 p-3 bg-bg-elevated rounded-lg border border-border">
            <div className="flex-1 min-w-0">
              <p className="text-sm text-text-primary">
                <span className="font-medium">{fact.subjectName}</span>
                <span className="text-text-muted"> · {getFactPredicate(fact.predicate)?.label ?? fact.predicate}：</span>
                <span>{fact.value}</span>
              </p>
              <p className="text-[11px] text-text-muted mt-1">
                来源：{fact.sourceRecordTable ?? '未知'}.{fact.sourceField ?? '未知字段'}
                {fact.sourceQuote ? ` · 证据：“${fact.sourceQuote}”` : ''}
              </p>
            </div>
            {(['candidate', ...EXCEPTIONS] as FactStatus[]).includes(fact.status) && fact.id != null && (
              <div className="flex items-center gap-1 shrink-0">
                <button onClick={() => void handleConfirm(fact.id!)} title="确认世界宪法"
                  className="p-1.5 text-emerald-400 hover:bg-emerald-500/15 rounded">
                  <Check className="w-4 h-4" />
                </button>
                <button onClick={() => void rejectFact(project.id!, fact.id!)} title="否决"
                  className="p-1.5 text-rose-400 hover:bg-rose-500/15 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
