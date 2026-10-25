/**
 * ALIAS-1 · 别称编辑控件（角色 / 词条 / 地点共用）。
 *
 * 为什么是一个独立小控件而不是塞进维度表：`CHARACTER_DIMENSIONS` 都是**文本**维度，
 * 别称是字符串数组，硬塞进去会让"维度=文本"这条不变量破掉（维度渲染、生成勾选、AI 解析
 * 都建立在它之上）。因此别称作为一等字段，用这个小控件编辑，三个实体类型共用一套规则：
 * 归一、去重、最短 2 字、最多 8 个、与正名相同则拒绝 —— 与 `normalizeAliases` 同源，
 * 避免"UI 能存进去、字段注册表却拒绝"这种两边规则不一致。
 *
 * 冲突提示是**只读提示**：真正的裁决在身份解析侧（一个称呼被两个实体占用 → 歧义不猜），
 * 这里只负责让作者提前看见。
 */
import { useState } from 'react'
import { AlertTriangle, Plus, X } from 'lucide-react'
import { MAX_ENTITY_ALIASES, MIN_SURFACE_LENGTH, normalizeAlias, normalizeAliases } from '../../lib/entities/surface-match'

interface Props {
  /** 规范正名：用于拒绝"别称 == 正名"。 */
  canonicalName: string
  aliases: readonly string[]
  onChange: (aliases: string[]) => void
  /** 项目里其它实体已经在用的称呼（折叠后比较），用于提示冲突。 */
  conflictingSurfaces?: ReadonlySet<string>
  label?: string
  disabled?: boolean
}

function fold(value: string): string {
  return value.normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
}

export default function AliasChipsField({
  canonicalName,
  aliases,
  onChange,
  conflictingSurfaces,
  label = '别称 / 曾用名',
  disabled,
}: Props) {
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')

  const add = () => {
    const value = normalizeAlias(draft, canonicalName)
    if (!value) {
      setError(`别称需至少 ${MIN_SURFACE_LENGTH} 个字，且不能与正名相同`)
      return
    }
    if (aliases.some(alias => fold(alias) === fold(value))) {
      setError('这个别称已经加过了')
      return
    }
    if (aliases.length >= MAX_ENTITY_ALIASES) {
      setError(`最多 ${MAX_ENTITY_ALIASES} 个别称`)
      return
    }
    setDraft('')
    setError('')
    onChange(normalizeAliases([...aliases, value], canonicalName) ?? [...aliases])
  }

  const remove = (alias: string) => {
    setError('')
    onChange(normalizeAliases(aliases.filter(item => item !== alias), canonicalName) ?? [...aliases])
  }

  return (
    <div className="flex gap-2">
      <span className="w-20 flex-shrink-0 pt-1.5 text-xs text-text-muted">{label}</span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1">
          {aliases.map(alias => {
            const conflict = conflictingSurfaces?.has(fold(alias))
            return (
              <span
                key={alias}
                className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] ${
                  conflict ? 'bg-warning/15 text-warning' : 'bg-bg-hover text-text-secondary'
                }`}
                title={conflict ? '这个称呼与其它实体的称呼冲突：正文里无法可靠判定归属' : undefined}
              >
                {alias}
                {!disabled && (
                  <button
                    type="button"
                    onClick={() => remove(alias)}
                    aria-label={`删除别称 ${alias}`}
                    className="text-text-muted hover:text-error"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </span>
            )
          })}
          {aliases.length === 0 && <span className="text-[11px] text-text-muted">（未填）</span>}
        </div>
        {!disabled && (
          <div className="mt-1 flex items-center gap-1">
            <input
              type="text"
              value={draft}
              aria-label="新增别称"
              placeholder="输入后在正文里也能认出是同一人"
              onChange={event => { setDraft(event.target.value); setError('') }}
              onKeyDown={event => {
                if (event.key === 'Enter') { event.preventDefault(); add() }
              }}
              className="min-w-0 flex-1 rounded border border-border bg-bg-base px-2 py-1 text-xs text-text-primary focus:border-accent focus:outline-none"
            />
            <button
              type="button"
              onClick={add}
              disabled={!draft.trim()}
              className="flex items-center gap-1 rounded border border-border px-2 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />添加
            </button>
          </div>
        )}
        {error && (
          <p className="mt-1 flex items-center gap-1 text-[11px] text-error">
            <AlertTriangle className="h-3 w-3" />{error}
          </p>
        )}
      </div>
    </div>
  )
}
