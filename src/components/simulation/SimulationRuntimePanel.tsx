import { useEffect, useMemo, useState } from 'react'
import {
  Box,
  Clock3,
  CopyPlus,
  Dices,
  GitBranch,
  Plus,
  Save,
  ScrollText,
  Trash2,
} from 'lucide-react'
import type { Project, SimulationSessionKind } from '../../lib/types'
import { useSimulationRuntimeStore } from '../../stores/simulation-runtime'
import { useDialog } from '../shared/Dialog'

const KIND_LABELS: Record<SimulationSessionKind, string> = {
  sandbox: '沙盒',
  'npc-evolution': 'NPC 演进',
  ttrpg: '跑团',
  chatgame: '角色聊天',
}

function eventSummary(type: string, payloadJson: string): string {
  try {
    const payload = JSON.parse(payloadJson) as Record<string, unknown>
    if (type === 'time.advanced') return `时间 +${payload.amount}`
    if (type === 'random.resolved') {
      const dice = Array.isArray(payload.dice) ? payload.dice.join(', ') : ''
      return `${payload.expression}: [${dice}] = ${payload.total}`
    }
    if (type === 'narrative.recorded') return String(payload.text ?? '')
    if (type.startsWith('entity.')) return String(payload.entityKey ?? type)
    return type
  } catch {
    return type
  }
}

export default function SimulationRuntimePanel(props: {
  project: Project
  worldGroupId: number | null
}) {
  const store = useSimulationRuntimeStore()
  const dialog = useDialog()
  const [newTitle, setNewTitle] = useState('')
  const [newKind, setNewKind] = useState<SimulationSessionKind>('sandbox')
  const [dice, setDice] = useState('1d20')
  const [timeAmount, setTimeAmount] = useState('1')
  const [narrative, setNarrative] = useState('')
  const [checkpointName, setCheckpointName] = useState('')
  const [branchTitle, setBranchTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  useEffect(() => {
    void store.load(props.project.id!)
  // Zustand action identity is stable; project change is the actual reload boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.project.id])

  const selected = useMemo(
    () => store.sessions.find(session => session.id === store.selectedSessionId) ?? null,
    [store.selectedSessionId, store.sessions],
  )

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setActionError('')
    try {
      await action()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-[36rem] bg-bg-base">
      <aside className="w-72 shrink-0 overflow-y-auto border-r border-border bg-bg-surface p-4">
        <div className="mb-4">
          <div className="mb-1 flex items-center gap-2">
            <Box className="h-4 w-4 text-accent" />
            <h2 className="font-semibold text-text-primary">互动运行时</h2>
          </div>
          <p className="text-xs leading-relaxed text-text-muted">
            NPC、跑团和角色聊天共用的独立存档。这里的事件不会反写小说 Canon。
          </p>
        </div>

        <div className="mb-4 space-y-2 rounded-lg border border-border bg-bg-base p-3">
          <input
            value={newTitle}
            onChange={event => setNewTitle(event.target.value)}
            placeholder="新会话名称"
            className="w-full rounded border border-border bg-bg-surface px-2 py-1.5 text-sm text-text-primary"
          />
          <select
            value={newKind}
            onChange={event => setNewKind(event.target.value as SimulationSessionKind)}
            aria-label="运行时类型"
            className="w-full rounded border border-border bg-bg-surface px-2 py-1.5 text-sm text-text-primary"
          >
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <button
            disabled={busy || !newTitle.trim()}
            onClick={() => void run(async () => {
              await store.createSession({
                projectId: props.project.id!,
                worldGroupId: props.worldGroupId,
                kind: newKind,
                title: newTitle,
              })
              setNewTitle('')
            })}
            className="flex w-full items-center justify-center gap-1.5 rounded bg-accent px-3 py-1.5 text-sm text-white disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            新建独立会话
          </button>
        </div>

        <div className="space-y-1">
          {store.sessions.map(session => (
            <button
              key={session.id}
              onClick={() => void store.select(session.id!)}
              className={`w-full rounded px-3 py-2 text-left ${
                session.id === store.selectedSessionId
                  ? 'bg-accent/10 text-accent'
                  : 'text-text-secondary hover:bg-bg-hover'
              }`}
            >
              <div className="truncate text-sm font-medium">{session.title}</div>
              <div className="mt-0.5 text-[11px] text-text-muted">
                {KIND_LABELS[session.kind]} · {session.status}
              </div>
            </button>
          ))}
          {!store.loading && store.sessions.length === 0 && (
            <p className="py-6 text-center text-xs text-text-muted">还没有互动存档</p>
          )}
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto p-6">
        {!selected ? (
          <div className="flex h-full items-center justify-center text-sm text-text-muted">
            创建一个沙盒会话，开始验证共享运行时。
          </div>
        ) : (
          <div className="mx-auto max-w-5xl space-y-5">
            <header className="flex items-start justify-between gap-4">
              <div>
                <div className="mb-1 text-xs text-text-muted">体验中心 · {KIND_LABELS[selected.kind]}</div>
                <h1 className="text-xl font-semibold text-text-primary">{selected.title}</h1>
                <p className="mt-1 text-xs text-text-muted">
                  规则 v{selected.rulesetVersion} · 事件 {store.runtimeState.lastSequence} · 检查点 {store.checkpoints.length}
                </p>
              </div>
              <button
                onClick={() => void run(async () => {
                  const confirmed = await dialog.confirm({
                    title: `删除互动会话“${selected.title}”？`,
                    message: '该会话的全部事件和检查点将一并删除；子分支会保留并解除父会话关联。',
                    confirmText: '删除',
                    tone: 'danger',
                  })
                  if (confirmed) await store.remove(selected.id!)
                })}
                className="rounded p-2 text-danger hover:bg-danger/10"
                title="删除会话"
                aria-label={`删除会话 ${selected.title}`}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </header>

            {(store.error || actionError) && (
              <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
                {actionError || store.error}
              </div>
            )}

            <section className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-bg-surface p-4">
                <Clock3 className="mb-2 h-4 w-4 text-accent" />
                <div className="text-2xl font-semibold text-text-primary">{store.runtimeState.clock}</div>
                <div className="text-xs text-text-muted">逻辑时间</div>
              </div>
              <div className="rounded-lg border border-border bg-bg-surface p-4">
                <Box className="mb-2 h-4 w-4 text-accent" />
                <div className="text-2xl font-semibold text-text-primary">
                  {Object.keys(store.runtimeState.entities).length}
                </div>
                <div className="text-xs text-text-muted">运行时实体</div>
              </div>
              <div className="rounded-lg border border-border bg-bg-surface p-4">
                <ScrollText className="mb-2 h-4 w-4 text-accent" />
                <div className="text-2xl font-semibold text-text-primary">
                  {store.runtimeState.narratives.length}
                </div>
                <div className="text-xs text-text-muted">叙事记录</div>
              </div>
            </section>

            <section className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-3 rounded-lg border border-border bg-bg-surface p-4">
                <h3 className="text-sm font-semibold text-text-primary">确定性动作</h3>
                <div className="flex gap-2">
                  <input
                    value={timeAmount}
                    onChange={event => setTimeAmount(event.target.value)}
                    aria-label="推进时间"
                    className="min-w-0 flex-1 rounded border border-border bg-bg-base px-2 py-1.5 text-sm"
                  />
                  <button
                    disabled={busy}
                    onClick={() => void run(() => store.advanceTime(Number(timeAmount)))}
                    className="rounded border border-border px-3 py-1.5 text-sm hover:bg-bg-hover"
                  >
                    推进时间
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    value={dice}
                    onChange={event => setDice(event.target.value)}
                    aria-label="骰式"
                    className="min-w-0 flex-1 rounded border border-border bg-bg-base px-2 py-1.5 text-sm"
                  />
                  <button
                    disabled={busy}
                    onClick={() => void run(() => store.rollDice(dice))}
                    className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm hover:bg-bg-hover"
                  >
                    <Dices className="h-3.5 w-3.5" />
                    判定
                  </button>
                </div>
                <textarea
                  value={narrative}
                  onChange={event => setNarrative(event.target.value)}
                  placeholder="记录只属于该会话的叙事…"
                  className="min-h-20 w-full rounded border border-border bg-bg-base px-2 py-1.5 text-sm"
                />
                <button
                  disabled={busy || !narrative.trim()}
                  onClick={() => void run(async () => {
                    await store.recordNarrative(narrative)
                    setNarrative('')
                  })}
                  className="rounded border border-border px-3 py-1.5 text-sm hover:bg-bg-hover disabled:opacity-40"
                >
                  追加叙事事件
                </button>
              </div>

              <div className="space-y-3 rounded-lg border border-border bg-bg-surface p-4">
                <h3 className="text-sm font-semibold text-text-primary">存档与分支</h3>
                <div className="flex gap-2">
                  <input
                    value={checkpointName}
                    onChange={event => setCheckpointName(event.target.value)}
                    placeholder="检查点名称"
                    className="min-w-0 flex-1 rounded border border-border bg-bg-base px-2 py-1.5 text-sm"
                  />
                  <button
                    disabled={busy}
                    onClick={() => void run(async () => {
                      await store.checkpoint(checkpointName)
                      setCheckpointName('')
                    })}
                    className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm hover:bg-bg-hover"
                  >
                    <Save className="h-3.5 w-3.5" />
                    保存
                  </button>
                </div>
                <div className="flex gap-2">
                  <input
                    value={branchTitle}
                    onChange={event => setBranchTitle(event.target.value)}
                    placeholder="新分支名称"
                    className="min-w-0 flex-1 rounded border border-border bg-bg-base px-2 py-1.5 text-sm"
                  />
                  <button
                    disabled={busy || !branchTitle.trim()}
                    onClick={() => void run(async () => {
                      await store.branch(branchTitle)
                      setBranchTitle('')
                    })}
                    className="flex items-center gap-1 rounded border border-border px-3 py-1.5 text-sm hover:bg-bg-hover disabled:opacity-40"
                  >
                    <GitBranch className="h-3.5 w-3.5" />
                    分支
                  </button>
                </div>
                <div className="space-y-2">
                  {store.checkpoints.map(checkpoint => (
                    <div key={checkpoint.id} className="flex items-center gap-2 rounded bg-bg-base px-2 py-1.5 text-xs">
                      <CopyPlus className="h-3.5 w-3.5 text-text-muted" />
                      <span className="flex-1 truncate">{checkpoint.name}</span>
                      <span className="text-text-muted">#{checkpoint.throughSequence}</span>
                    </div>
                  ))}
                  {store.checkpoints.length === 0 && (
                    <p className="text-xs text-text-muted">暂无检查点</p>
                  )}
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-border bg-bg-surface">
              <div className="border-b border-border px-4 py-3">
                <div className="text-sm font-semibold text-text-primary">当前叙事状态</div>
                <p className="mt-0.5 text-xs text-text-muted">
                  包含从父会话继承的叙事；下方事件日志只记录当前会话自身追加的事件。
                </p>
              </div>
              <div className="divide-y divide-border">
                {store.runtimeState.narratives.map((narrativeItem, index) => (
                  <div
                    key={`${narrativeItem.eventSequence}-${index}`}
                    className="flex gap-3 px-4 py-3 text-sm"
                  >
                    <span className="w-10 shrink-0 font-mono text-xs text-text-muted">
                      #{narrativeItem.eventSequence}
                    </span>
                    <span className="min-w-0 flex-1 break-words text-text-secondary">
                      {narrativeItem.text}
                    </span>
                  </div>
                ))}
                {store.runtimeState.narratives.length === 0 && (
                  <p className="px-4 py-6 text-center text-sm text-text-muted">暂无叙事状态</p>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-border bg-bg-surface">
              <div className="border-b border-border px-4 py-3 text-sm font-semibold text-text-primary">
                追加事件日志
              </div>
              <div className="divide-y divide-border">
                {[...store.events].reverse().map(event => (
                  <div key={event.id} className="flex gap-3 px-4 py-3 text-sm">
                    <span className="w-10 shrink-0 font-mono text-xs text-text-muted">#{event.sequence}</span>
                    <span className="w-32 shrink-0 text-xs text-accent">{event.type}</span>
                    <span className="min-w-0 flex-1 break-words text-text-secondary">
                      {eventSummary(event.type, event.payloadJson)}
                    </span>
                  </div>
                ))}
                {store.events.length === 0 && (
                  <p className="px-4 py-8 text-center text-sm text-text-muted">尚无事件</p>
                )}
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}
