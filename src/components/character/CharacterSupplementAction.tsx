import { useState } from 'react'
import { Wand2, Loader2, X } from 'lucide-react'
import { useAIConfigStore } from '../../stores/ai-config'
import { useAIStream } from '../../hooks/useAIStream'
import { createAISessionKey } from '../../stores/ai-generation-session'
import { assembleContext } from '../../lib/registry/assemble-context'
import { adopt } from '../../lib/registry/adopt'
import {
  buildCharacterSupplementPrompt,
  parseCharacterSupplement,
} from '../../lib/ai/adapters/character-supplement-adapter'
import {
  CHARACTER_DIMENSIONS,
  filledDimensions,
  type CharacterDimensionKey,
} from '../../lib/character/character-dimensions'
import type { Character } from '../../lib/types'
import CharacterDimensionPicker from './CharacterDimensionPicker'

interface Props {
  character: Character
  projectId: number
  worldGroupId?: number | null
  /** 写回完成后回调（让父面板 loadAll 刷新） */
  onDone?: () => void
  /** 紧凑按钮（列表行用） */
  compact?: boolean
}

/**
 * C1「AI 补全设定」——给【已有角色】补全【选中维度】,与既有设定一致。
 * 读 = assembleContext(世界观等)；写 = adopt({ target:'characters', recordId }) 定点更新,只动选中字段。
 * 与「AI 设计角色」(从零造新角色)区别:此处不新建,只补全缺口。
 */
export default function CharacterSupplementAction({ character, projectId, worldGroupId, onDone, compact }: Props) {
  const { config: aiConfig } = useAIConfigStore()
  const ai = useAIStream(createAISessionKey(projectId, 'character.supplement', String(character.id)))
  const [open, setOpen] = useState(false)
  const [done, setDone] = useState<number | null>(null)
  // C2 反向哺喂：结合剧情已写内容（事实账本 + 正文召回）做补全
  const [useEvidence, setUseEvidence] = useState(false)
  // 默认勾选「当前为空」的维度（缺什么补什么）；若全填满则默认全选让用户自行决定重写哪些
  const [selected, setSelected] = useState<Set<CharacterDimensionKey>>(() => {
    const filled = new Set(filledDimensions(character))
    const empty = CHARACTER_DIMENSIONS.map(d => d.key).filter(k => !filled.has(k))
    return new Set(empty.length ? empty : CHARACTER_DIMENSIONS.map(d => d.key))
  })

  const run = async () => {
    const dims = [...selected]
    if (!dims.length || ai.isStreaming) return
    setDone(null)
    // 读：世界观/设定上下文（角色自身已有设定由 prompt 直接带，不重复注入 characters 源）
    const assembled = await assembleContext({
      projectId,
      worldGroupId: worldGroupId ?? null,
      provider: aiConfig.provider,
      model: aiConfig.model,
      sourceKeys: ['canonAssertions', 'worldview', 'storyCore', 'powerSystem', 'codex', 'creativeRules', 'worldRules', 'locations'],
    })
    // C2：反向哺喂——以该角色为主体，召回剧情里已确认的事实 + 正文真实表现作为硬约束
    let evidenceContext: string | undefined
    if (useEvidence) {
      const evidence = await assembleContext({
        projectId,
        worldGroupId: worldGroupId ?? null,
        provider: aiConfig.provider,
        model: aiConfig.model,
        subjectCharacterName: character.name,
        sourceKeys: ['characterFacts', 'characterPassages'],
      })
      evidenceContext = evidence.text.trim() || undefined
    }
    const messages = buildCharacterSupplementPrompt({
      character,
      dimensions: dims,
      worldContext: assembled.text,
      evidenceContext,
    })
    const text = await ai.start(messages, undefined, { category: 'character.supplement', projectId })
    if (!text) return
    const patch = parseCharacterSupplement(text, dims)
    if (Object.keys(patch).length === 0) return
    // 写：定点更新该角色，只动补全字段
    await adopt({ projectId, worldGroupId: worldGroupId ?? null, target: 'characters', recordId: character.id!, mode: 'merge-diffs', data: patch })
    // 真正补全的维度数 = 解析出的补丁字段数（adopt 结果含 role/轴等派生字段，不能用来计数）
    setDone(Object.keys(patch).length)
    onDone?.()
  }

  const empties = CHARACTER_DIMENSIONS.map(d => d.key).filter(k => !new Set(filledDimensions(character)).has(k)).length

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen(v => !v)}
        className={compact
          ? 'p-1 text-text-muted hover:text-accent flex-shrink-0'
          : 'flex items-center gap-1 px-2 py-1 text-xs text-text-secondary hover:text-accent border border-border rounded hover:border-accent/50 transition-colors'}
        title={`AI 补全设定${empties ? `（缺 ${empties} 项）` : ''}`}
      >
        <Wand2 className="w-4 h-4" />
        {!compact && <span>AI 补全设定{empties > 0 && <span className="text-accent ml-0.5">·缺{empties}</span>}</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full right-0 mt-1 z-50 bg-bg-surface border border-border rounded-lg shadow-lg p-3 w-[420px]">
            <div className="flex items-center justify-between mb-2">
              <div className="text-sm font-medium text-text-primary">
                AI 补全设定 · <span className="text-text-secondary">{character.name || '未命名'}</span>
              </div>
              <button onClick={() => setOpen(false)} className="p-0.5 text-text-muted hover:text-text-primary"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-[11px] text-text-muted mb-2">勾选要补全的维度（默认选中当前为空的）。AI 会参考该角色已有设定与世界观，只补这些字段、不覆盖其它。</p>

            <CharacterDimensionPicker selected={selected} onChange={setSelected} />

            {/* C2 反向哺喂开关 */}
            <label className="mt-2 flex items-start gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={useEvidence}
                onChange={e => setUseEvidence(e.target.checked)}
                className="mt-0.5 accent-accent"
              />
              <span className="text-[11px] text-text-secondary leading-snug">
                结合剧情已写内容（反向哺喂）
                <span className="block text-text-muted">把该角色在正文里已确认的事实 + 真实表现喂给 AI，补全更贴合实际剧情、不脱节。NPC 写着写着升成主角时尤其有用。</span>
              </span>
            </label>

            {ai.error && <div className="mt-2 text-xs text-error">{ai.error}</div>}
            {ai.isStreaming && (
              <div className="mt-2 max-h-32 overflow-y-auto text-[11px] text-text-muted whitespace-pre-wrap bg-bg-base border border-border rounded p-2">
                {ai.output || '正在生成…'}
              </div>
            )}
            {done != null && !ai.isStreaming && (
              <div className="mt-2 text-xs text-success">✅ 已补全 {done} 个维度，已写入该角色。</div>
            )}

            <button
              onClick={run}
              disabled={ai.isStreaming || selected.size === 0}
              className="mt-3 w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-accent text-white text-sm rounded disabled:opacity-40 hover:bg-accent-hover"
            >
              {ai.isStreaming ? <><Loader2 className="w-4 h-4 animate-spin" /> 补全中…</> : <><Wand2 className="w-4 h-4" /> 补全选中的 {selected.size} 个维度</>}
            </button>
          </div>
        </>
      )}
    </div>
  )
}
