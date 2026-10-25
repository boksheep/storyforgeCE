import { useEffect, useRef, useState } from 'react'
import { useAIStream } from './useAIStream'
import { createAISessionKey } from '../stores/ai-generation-session'
import { useInspirationWorkspaceStore } from '../stores/inspiration-workspace'
import {
  buildInspirationReverseMultiWorldPrompt,
  buildInspirationReversePrompt,
  parseReverseMultiWorldOutput,
  parseReverseOutput,
  type ReverseMultiWorldResult,
  type ReverseResult,
} from '../lib/ai/inspiration-reverse'
import {
  diffInspirationResults,
  latestInspirationVersion,
  MAX_INSPIRATION_FRAGMENT_CHARS,
  type InspirationResultDiff,
} from '../lib/inspiration/workspace'
import { assembleContext } from '../lib/registry/assemble-context'
import type { Project } from '../lib/types'
import { log } from '../lib/logging/logger'
import type {
  InspirationResultMode,
  InspirationSourceKind,
  InspirationVersion,
} from '../lib/types/inspiration-workspace'

export function useIncrementalInspiration(
  project: Project,
  onGenerationStarted: () => void,
) {
  const isMultiWorld = !!project.enableMultiWorld
  const mode: InspirationResultMode = isMultiWorld ? 'multiworld' : 'single'
  const ai = useAIStream(createAISessionKey(project.id!, 'inspiration.reverse'))
  const workspace = useInspirationWorkspaceStore()
  const draftKey = `sf-inspiration-draft-${project.id}`
  const draftLoaded = useRef(false)

  const [inspiration, setInspiration] = useState('')
  const [userHint, setUserHint] = useState('')
  const [result, setResult] = useState<ReverseResult | null>(null)
  const [mwResult, setMwResult] = useState<ReverseMultiWorldResult | null>(null)
  const [mwAdopted, setMwAdopted] = useState(false)
  const [selectedChars, setSelectedChars] = useState<Set<number>>(new Set())
  const [fragmentLabel, setFragmentLabel] = useState('')
  const [sourceKind, setSourceKind] = useState<InspirationSourceKind>('author')
  const [selectedFragmentIds, setSelectedFragmentIds] = useState<Set<string>>(new Set())
  const [pendingDiff, setPendingDiff] = useState<InspirationResultDiff[] | null>(null)
  const [pendingFragmentIds, setPendingFragmentIds] = useState<string[]>([])
  const [pendingParent, setPendingParent] = useState<InspirationVersion | null>(null)
  const [confirmingFusion, setConfirmingFusion] = useState(false)
  const [awaitingResult, setAwaitingResult] = useState(false)
  const [fusionError, setFusionError] = useState('')

  const applyResult = (parsed: ReverseResult | ReverseMultiWorldResult, targetMode = mode) => {
    if (targetMode === 'multiworld') {
      setMwResult(parsed as ReverseMultiWorldResult)
      setResult(null)
      return
    }
    const single = parsed as ReverseResult
    setResult(single)
    setMwResult(null)
    setSelectedChars(new Set(single.characters.map((_, index) => index)))
  }

  useEffect(() => {
    let active = true
    setResult(null)
    setMwResult(null)
    setMwAdopted(false)
    setPendingDiff(null)
    setPendingFragmentIds([])
    setPendingParent(null)
    setAwaitingResult(false)
    setFusionError('')
    void workspace.load(project.id!).then(() => {
      if (!active) return
      const state = useInspirationWorkspaceStore.getState()
      setSelectedFragmentIds(new Set(state.fragments.map(fragment => fragment.id)))
      const latest = latestInspirationVersion(state.versions, mode)
      if (!latest) return
      try { applyResult(JSON.parse(latest.resultJson), mode) } catch (error) {
        log.warn('Inspiration', 'inspiration.version.parse.invalid', '灵感历史版本解析失败', {
          projectId: project.id, mode, resultChars: latest.resultJson.length,
          errorName: error instanceof Error ? error.name : typeof error,
        })
      }
    })
    return () => { active = false }
  // Store methods are stable Zustand actions; mode changes reload the matching latest version.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, mode])

  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey)
      if (saved) {
        const draft = JSON.parse(saved)
        setInspiration(draft.inspiration || '')
        setUserHint(draft.userHint || '')
        if (draft.result) applyResult(draft.result, 'single')
        if (draft.mwResult) {
          applyResult(draft.mwResult, 'multiworld')
          setMwAdopted(!!draft.mwAdopted)
        }
      }
    } catch (error) {
      log.warn('Inspiration', 'inspiration.draft.load.failed', '灵感草稿读取或解析失败', {
        projectId: project.id, errorName: error instanceof Error ? error.name : typeof error,
      })
    }
    draftLoaded.current = true
  // applyResult is a state-only helper and intentionally not a hook dependency.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draftKey])

  useEffect(() => {
    if (!draftLoaded.current) return
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(draftKey, JSON.stringify({
          inspiration,
          userHint,
          result,
          mwResult,
          mwAdopted,
        }))
      } catch (error) {
        log.warn('Inspiration', 'inspiration.draft.save.failed', '灵感草稿写入浏览器存储失败', {
          projectId: project.id, inputChars: inspiration.length, hintChars: userHint.length,
          errorName: error instanceof Error ? error.name : typeof error,
        })
      }
    }, 500)
    return () => clearTimeout(timer)
  }, [draftKey, project.id, inspiration, userHint, result, mwResult, mwAdopted])

  const acceptGeneratedResult = (output: string) => {
    setAwaitingResult(false)
    const latest = latestInspirationVersion(
      useInspirationWorkspaceStore.getState().versions,
      mode,
    )
    let previous: unknown = {}
    if (latest) {
      try { previous = JSON.parse(latest.resultJson) } catch (error) {
        log.warn('Inspiration', 'inspiration.previous.parse.invalid', '灵感上一版本解析失败，本次按空版本计算', {
          projectId: project.id, mode, resultChars: latest.resultJson.length,
          errorName: error instanceof Error ? error.name : typeof error,
        })
        previous = {}
      }
    }
    const parsed = isMultiWorld
      ? parseReverseMultiWorldOutput(output)
      : parseReverseOutput(output)
    if (!parsed) {
      setFusionError('Agnes 返回内容无法解析，请检查原始输出后重试')
      // AI 返回无法解析 = 本次生成无结果。记录的是"跑了但没结果"，
      // 与"没跑"在日志里必须可区分（LOGGING-DESIGN §7.1）。不写返回文本。
      log.warn(
        'Inspiration',
        'inspiration.reverse.parse.failed',
        `灵感反推结果无法解析（单/多世界 ${isMultiWorld ? 'multi' : 'single'}）`,
        { projectId: project.id ?? null, mode, outputLength: output.length },
      )
      return
    }
    setFusionError('')
    applyResult(parsed)
    setPendingDiff(diffInspirationResults(previous, parsed))
    setPendingParent(latest)
  }

  useEffect(() => {
    if (!awaitingResult || ai.isStreaming || !ai.output) return
    acceptGeneratedResult(ai.output)
    setAwaitingResult(false)
  // Completion intentionally reads the latest store snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ai.isStreaming, ai.output, awaitingResult, isMultiWorld])

  const addCurrentFragment = async () => {
    if (inspiration.trim().length > MAX_INSPIRATION_FRAGMENT_CHARS) {
      setFusionError(`单条灵感最多 ${MAX_INSPIRATION_FRAGMENT_CHARS} 字，请拆成多个碎片`)
      return null
    }
    try {
      const fragment = await workspace.addFragment(project.id!, {
        text: inspiration,
        label: fragmentLabel,
        sourceKind,
      })
      if (!fragment) return null
      setFusionError('')
      setSelectedFragmentIds(current => new Set(current).add(fragment.id))
      return fragment
    } catch (error) {
      setFusionError(error instanceof Error ? error.message : '灵感碎片保存失败')
      return null
    }
  }

  const generate = async () => {
    if (inspiration.trim().length > MAX_INSPIRATION_FRAGMENT_CHARS) {
      setFusionError(`单条灵感最多 ${MAX_INSPIRATION_FRAGMENT_CHARS} 字，请拆成多个碎片`)
      return
    }
    const selectedIds = new Set(selectedFragmentIds)
    if (inspiration.trim()) {
      const fragment = await addCurrentFragment()
      if (fragment) selectedIds.add(fragment.id)
    }
    const state = useInspirationWorkspaceStore.getState()
    if (selectedIds.size === 0 || state.fragments.length === 0) return
    const previousVersion = latestInspirationVersion(state.versions, mode)
    const assembled = await assembleContext({
      projectId: project.id!,
      sourceKeys: ['inspirationWorkspace'],
      inspirationFragmentIds: [...selectedIds],
      inspirationMode: mode,
    })
    const fusionInput = assembled.text
    if (!fusionInput) return

    setResult(null)
    setMwResult(null)
    setMwAdopted(false)
    setPendingDiff(null)
    setPendingFragmentIds([...selectedIds])
    setPendingParent(previousVersion)
    setFusionError('')
    onGenerationStarted()

    const genres = project.genres?.join('/') || project.genre || ''
    // 记录本次生成输入的真实规模：碎片数/模式 —— 便于事后判断"这次生成用了哪些灵感"。
    log.info(
      'Inspiration',
      'inspiration.reverse.start',
      `开始灵感反推（${isMultiWorld ? '多世界' : '单世界'}）：碎片 ${selectedIds.size} 个`,
      { projectId: project.id ?? null, mode, fragmentCount: selectedIds.size },
    )
    const messages = isMultiWorld
      ? buildInspirationReverseMultiWorldPrompt(project.name, genres, fusionInput, userHint || undefined)
      : buildInspirationReversePrompt(project.name, genres, fusionInput, userHint || undefined)
    setAwaitingResult(true)
    await ai.start(messages, undefined, {
      category: 'inspiration.reverse',
      projectId: project.id!,
    })
  }

  const confirmFusion = async () => {
    const pendingResult = mode === 'multiworld' ? mwResult : result
    if (!pendingResult || pendingDiff === null) return
    setConfirmingFusion(true)
    try {
      await workspace.saveVersion(project.id!, {
        mode,
        parentVersionId: pendingParent?.id ?? null,
        fragmentIds: pendingFragmentIds,
        result: pendingResult,
      })
      setPendingDiff(null)
      setPendingParent(null)
      setPendingFragmentIds([])
      setFusionError('')
      // 融合版本写入 IndexedDB：这是"灵感碎片 → 正式版本"的落盘点，成功后必须留痕。
      log.info(
        'Inspiration',
        'inspiration.fusion.adopted',
        `灵感融合版本已保存（${isMultiWorld ? '多世界' : '单世界'}）：合并碎片 ${pendingFragmentIds.length} 个`,
        {
          projectId: project.id ?? null,
          mode,
          fragmentCount: pendingFragmentIds.length,
          parentVersionId: pendingParent?.id ?? null,
        },
      )
    } catch (error) {
      setFusionError(error instanceof Error ? error.message : '融合版本保存失败')
      // 采用失败尤其重要：作者以为已保存，实际没有 —— 必须公布，且不写 error message。
      log.error(
        'Inspiration',
        'inspiration.fusion.save.failed',
        `灵感融合版本保存失败：碎片 ${pendingFragmentIds.length} 个未落盘`,
        { projectId: project.id ?? null, mode, fragmentCount: pendingFragmentIds.length },
        error,
      )
    } finally {
      setConfirmingFusion(false)
    }
  }

  const discardFusion = () => {
    const latest = latestInspirationVersion(
      useInspirationWorkspaceStore.getState().versions,
      mode,
    )
    if (latest) applyResult(JSON.parse(latest.resultJson))
    else {
      setResult(null)
      setMwResult(null)
    }
    setPendingDiff(null)
    setPendingParent(null)
    setPendingFragmentIds([])
  }

  const removeFragment = async (fragmentId: string) => {
    try {
      await workspace.removeFragment(project.id!, fragmentId)
      setFusionError('')
      setSelectedFragmentIds(current => {
        const next = new Set(current)
        next.delete(fragmentId)
        return next
      })
    } catch (error) {
      setFusionError(error instanceof Error ? error.message : '灵感碎片删除失败')
    }
  }

  return {
    ai,
    isMultiWorld,
    mode,
    workspace,
    inspiration,
    setInspiration,
    userHint,
    setUserHint,
    result,
    mwResult,
    mwAdopted,
    setMwAdopted,
    selectedChars,
    setSelectedChars,
    fragmentLabel,
    setFragmentLabel,
    sourceKind,
    setSourceKind,
    selectedFragmentIds,
    setSelectedFragmentIds,
    pendingDiff,
    confirmingFusion,
    fusionError,
    addCurrentFragment,
    generate,
    confirmFusion,
    discardFusion,
    removeFragment,
  }
}
