/**
 * NS-4 · 事实账本 store（事实库 UI 的数据层）。
 * 所有事实变更走 lib/fact-ledger 单一入口（adopt/confirm/reject），store 不裸散写业务逻辑。
 */
import { create } from 'zustand'
import type { TemporalFact } from '../lib/types/temporal-fact'
import type { ExtractedFactCandidate } from '../lib/ai/adapters/fact-extract-adapter'
import {
  adoptFactCandidates,
  confirmFactCandidate,
  replaceConstitutionFactCandidate,
  rejectFactCandidate,
  listFacts,
  type ConfirmFactResult,
  type ReplaceConstitutionFactResult,
} from '../lib/fact-ledger/fact-ledger'
import {
  adoptSettingAssertionCandidates,
  type ExtractedSettingAssertion,
  type SettingAssertionSource,
} from '../lib/fact-ledger/setting-assertions'
import { importFactCandidateDiff, type ImportFactCandidateDiffResult } from '../lib/fact-ledger/human-readable-io'
import { log } from '../lib/logging/logger'

interface FactLedgerStore {
  facts: TemporalFact[]
  loading: boolean
  load: (projectId: number) => Promise<void>
  adopt: (args: { projectId: number; sourceChapterId: number; worldGroupId?: number | null; candidates: ExtractedFactCandidate[] }) => Promise<number>
  adoptSetting: (args: {
    projectId: number
    worldGroupId?: number | null
    candidates: readonly ExtractedSettingAssertion[]
    sources: readonly SettingAssertionSource[]
    subjects: {
      worldGroups: readonly { id: number | null; name: string }[]
      characters: readonly { id: number; name: string; worldGroupId?: number | null }[]
    }
  }) => Promise<{ written: number; skipped: number }>
  confirmFact: (projectId: number, factId: number) => Promise<ConfirmFactResult>
  replaceConstitutionFact: (projectId: number, factId: number) => Promise<ReplaceConstitutionFactResult>
  rejectFact: (projectId: number, factId: number) => Promise<void>
  importCandidateDiff: (projectId: number, raw: unknown) => Promise<ImportFactCandidateDiffResult>
}

export const useFactLedgerStore = create<FactLedgerStore>((set, get) => ({
  facts: [],
  loading: false,

  load: async (projectId) => {
    set({ loading: true })
    try {
      set({ facts: await listFacts(projectId) })
    } finally {
      set({ loading: false })
    }
  },

  adopt: async ({ projectId, sourceChapterId, worldGroupId, candidates }) => {
    const result = await adoptFactCandidates({ projectId, sourceChapterId, worldGroupId, candidates })
    await get().load(projectId)
    // 事实候选批量入账：记录写入/跳过规模，便于排查"为什么不少没进账本"。
    log.info(
      'FactLedgerStore',
      'fact.ledger.adopted',
      `采纳事实候选：写入 ${result.written} 条（跳过重复 ${result.skippedDuplicate}、未知谓词 ${result.skippedUnknownPredicate}、非法值 ${result.skippedInvalidValue}）`,
      {
        projectId,
        sourceChapterId,
        worldGroupId: worldGroupId ?? 0,
        written: result.written,
        skippedDuplicate: result.skippedDuplicate,
        skippedUnknownPredicate: result.skippedUnknownPredicate,
        skippedInvalidValue: result.skippedInvalidValue,
      },
    )
    return result.written
  },

  adoptSetting: async (args) => {
    const result = await adoptSettingAssertionCandidates(args)
    await get().load(args.projectId)
    log.info(
      'FactLedgerStore',
      'fact.ledger.setting.adopted',
      `采纳设定断言：写入 ${result.written} 条、跳过 ${result.skipped} 条`,
      { projectId: args.projectId, worldGroupId: args.worldGroupId ?? 0, written: result.written, skipped: result.skipped },
    )
    return result
  },

  confirmFact: async (projectId, factId) => {
    const result = await confirmFactCandidate(factId)
    await get().load(projectId)
    return result
  },

  replaceConstitutionFact: async (projectId, factId) => {
    const result = await replaceConstitutionFactCandidate(factId)
    await get().load(projectId)
    // 以新宪法取代旧断言属"覆盖性写入"，只有真正成功替换时才留痕。
    if (result.confirmed) {
      log.info(
        'FactLedgerStore',
        'fact.ledger.constitution.replaced',
        `已用新宪法事实 #${factId} 替换旧断言 ${result.replaced} 条`,
        { projectId, factId, replaced: result.replaced },
      )
    }
    return result
  },

  rejectFact: async (projectId, factId) => {
    await rejectFactCandidate(factId)
    await get().load(projectId)
  },

  importCandidateDiff: async (projectId, raw) => {
    const result = await importFactCandidateDiff(projectId, raw)
    await get().load(projectId)
    // 外部事实差异导入：覆盖/合并类写库，记录导入规模。
    log.info(
      'FactLedgerStore',
      'fact.ledger.import.diff',
      `导入事实候选差异：写入 ${result.written} 条（跳过非法 ${result.skippedInvalid}、重复 ${result.skippedDuplicate}）`,
      { projectId, written: result.written, skippedInvalid: result.skippedInvalid, skippedDuplicate: result.skippedDuplicate },
    )
    return result
  },
}))
