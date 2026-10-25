/**
 * 自适应文风学习 Store(FB-5)
 *
 * 每项目一份文风画像(userStyleProfiles,按 projectId 单例)。
 * 本 store 只管持久化(加载/保存/手改/开关);AI 学习(取样 + 调 style.learn)由
 * StyleLearningPanel 编排后调 saveProfile 落库,以便 store 可脱离 AI 单测。
 */
import { create } from 'zustand'
import { db } from '../lib/db/schema'
import { log } from '../lib/logging/logger'
import {
  createStyleCalibrationFeedback,
  createStyleRevisionPair,
  parseStyleCalibrationFeedback,
  parseStyleRevisionPairs,
  upsertStyleRevisionPair,
} from '../lib/style/style-learning'
import type {
  StyleCalibrationFeedback,
  StyleCalibrationVerdict,
  StyleRevisionPair,
  UserStyleProfile,
} from '../lib/types/user-style'

interface SaveProfileInput {
  profile: string
  sourceChapterIds: number[]
  sampleCount: number
  sampleWords: number
}

interface CaptureRevisionPairInput {
  sourceChapterId?: number | null
  chapterTitle: string
  beforeText: string
  afterText: string
  authorNote?: string
}

interface AddCalibrationFeedbackInput {
  verdict: StyleCalibrationVerdict
  note: string
  sourceText: string
  resultText: string
}

interface UserStyleState {
  profile: UserStyleProfile | null
  loading: boolean

  /** 加载项目文风画像(无则置 null,不自动建空记录) */
  loadProfile: (projectId: number) => Promise<void>
  /** 保存/覆盖画像(AI 学习完成后调;upsert,默认开启注入) */
  saveProfile: (projectId: number, input: SaveProfileInput) => Promise<void>
  /** 手动改写画像文本并保存 */
  updateProfileText: (text: string) => Promise<void>
  /** 开/关下游注入 */
  setEnabled: (enabled: boolean) => Promise<void>
  /** 保存一次有实际差异的改前/改后样本；相同样本会去重，最多保留 8 组 */
  captureRevisionPair: (
    projectId: number,
    input: CaptureRevisionPairInput,
  ) => Promise<StyleRevisionPair | null>
  /** 更新样本的人类说明，供后续学习优先使用 */
  updateRevisionPairNote: (pairId: string, note: string) => Promise<void>
  /** 删除不应参与文风学习的样本 */
  removeRevisionPair: (pairId: string) => Promise<void>
  /** 保存一条互动校准判断；只保留最近 12 条 */
  addCalibrationFeedback: (
    projectId: number,
    input: AddCalibrationFeedbackInput,
  ) => Promise<StyleCalibrationFeedback>
}

async function upsertProfileRow(
  projectId: number,
  patch: Partial<UserStyleProfile>,
): Promise<UserStyleProfile> {
  const now = Date.now()
  const existing = await db.userStyleProfiles.where('projectId').equals(projectId).first()
  const row: UserStyleProfile = {
    ...(existing ?? {}),
    projectId,
    profile: existing?.profile ?? '',
    enabled: existing?.enabled ?? false,
    sourceChapterIds: existing?.sourceChapterIds ?? '[]',
    sampleCount: existing?.sampleCount ?? 0,
    sampleWords: existing?.sampleWords ?? 0,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...patch,
  }
  if (existing?.id != null) {
    await db.userStyleProfiles.update(existing.id, row)
    return { ...row, id: existing.id }
  }
  const id = await db.userStyleProfiles.add(row)
  return { ...row, id: id as number }
}

export const useUserStyleStore = create<UserStyleState>((set, get) => ({
  profile: null,
  loading: false,

  loadProfile: async (projectId: number) => {
    set({ loading: true })
    try {
      const profile = await db.userStyleProfiles.where('projectId').equals(projectId).first()
      set({ profile: profile ?? null })
    } finally {
      set({ loading: false })
    }
  },

  saveProfile: async (projectId, input) => {
    const now = Date.now()
    const existing = await db.userStyleProfiles.where('projectId').equals(projectId).first()
    const row: UserStyleProfile = {
      ...(existing ?? {}),
      projectId,
      profile: input.profile,
      // 只有既有非空画像的开关才是作者显式选择；“先有样本、后学习”的空壳记录
      // 默认保持关闭，但首次真正生成画像后应按既有产品语义自动开启。
      enabled: existing?.profile.trim() ? existing.enabled : true,
      sourceChapterIds: JSON.stringify(input.sourceChapterIds),
      sampleCount: input.sampleCount,
      sampleWords: input.sampleWords,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    if (existing?.id != null) {
      await db.userStyleProfiles.update(existing.id, row)
      set({ profile: { ...row, id: existing.id } })
    } else {
      const id = await db.userStyleProfiles.add(row)
      set({ profile: { ...row, id: id as number } })
    }
    log.info('UserStyleStore', 'style.profile.saved', '作者文风画像已保存', {
      projectId, profileId: get().profile?.id, profileChars: input.profile.length,
      sourceChapterCount: input.sourceChapterIds.length, sampleCount: input.sampleCount,
      sampleWords: input.sampleWords,
    })
  },

  updateProfileText: async (text) => {
    const { profile } = get()
    if (!profile?.id) {
      log.warn('UserStyleStore', 'style.profile.update.missing', '文风画像文本更新目标不存在', { textChars: text.length })
      return
    }
    const updatedAt = Date.now()
    await db.userStyleProfiles.update(profile.id, { profile: text, updatedAt })
    set({ profile: { ...profile, profile: text, updatedAt } })
    log.info('UserStyleStore', 'style.profile.text-updated', '作者文风画像文本已更新', { projectId: profile.projectId, profileId: profile.id, textChars: text.length })
  },

  setEnabled: async (enabled) => {
    const { profile } = get()
    if (!profile?.id) {
      log.warn('UserStyleStore', 'style.profile.toggle.missing', '文风画像开关目标不存在', { enabled })
      return
    }
    const updatedAt = Date.now()
    await db.userStyleProfiles.update(profile.id, { enabled, updatedAt })
    set({ profile: { ...profile, enabled, updatedAt } })
    log.info('UserStyleStore', 'style.profile.toggled', '作者文风画像开关已更新', { projectId: profile.projectId, profileId: profile.id, enabled })
  },

  captureRevisionPair: async (projectId, input) => {
    const pair = createStyleRevisionPair(input)
    if (!pair) {
      log.warn('UserStyleStore', 'style.revision-pair.invalid', '修改对样本无效，未记录', { projectId })
      return null
    }
    const existing = await db.userStyleProfiles.where('projectId').equals(projectId).first()
    const revisionPairs = upsertStyleRevisionPair(
      parseStyleRevisionPairs(existing?.revisionPairs),
      pair,
    )
    const row = await upsertProfileRow(projectId, {
      revisionPairs: JSON.stringify(revisionPairs),
    })
    set({ profile: row })
    log.info('UserStyleStore', 'style.revision-pair.captured', '作者修改对已记录', { projectId, profileId: row.id, pairCount: revisionPairs.length })
    return pair
  },

  updateRevisionPairNote: async (pairId, note) => {
    const { profile } = get()
    if (profile?.id == null) {
      log.warn('UserStyleStore', 'style.revision-note.missing-profile', '修改对备注缺少文风画像', { pairIdLength: pairId.length, noteChars: note.length })
      return
    }
    const revisionPairs = parseStyleRevisionPairs(profile.revisionPairs)
      .map(pair => pair.id === pairId
        ? { ...pair, authorNote: note.trim().slice(0, 240) || undefined }
        : pair)
    const updatedAt = Date.now()
    const serialized = JSON.stringify(revisionPairs)
    await db.userStyleProfiles.update(profile.id, { revisionPairs: serialized, updatedAt })
    set({ profile: { ...profile, revisionPairs: serialized, updatedAt } })
    log.info('UserStyleStore', 'style.revision-note.updated', '修改对备注已更新', { projectId: profile.projectId, profileId: profile.id, pairCount: revisionPairs.length, noteChars: note.length })
  },

  removeRevisionPair: async (pairId) => {
    const { profile } = get()
    if (profile?.id == null) {
      log.warn('UserStyleStore', 'style.revision-pair.remove.missing-profile', '删除修改对时缺少文风画像', { pairIdLength: pairId.length })
      return
    }
    const revisionPairs = parseStyleRevisionPairs(profile.revisionPairs)
      .filter(pair => pair.id !== pairId)
    const updatedAt = Date.now()
    const serialized = JSON.stringify(revisionPairs)
    await db.userStyleProfiles.update(profile.id, { revisionPairs: serialized, updatedAt })
    set({ profile: { ...profile, revisionPairs: serialized, updatedAt } })
    log.info('UserStyleStore', 'style.revision-pair.removed', '修改对删除已执行', { projectId: profile.projectId, profileId: profile.id, remainingCount: revisionPairs.length })
  },

  addCalibrationFeedback: async (projectId, input) => {
    const feedback = createStyleCalibrationFeedback(input)
    const existing = await db.userStyleProfiles.where('projectId').equals(projectId).first()
    const calibrationFeedback = [
      feedback,
      ...parseStyleCalibrationFeedback(existing?.calibrationFeedback)
        .filter(item => item.id !== feedback.id),
    ].slice(0, 12)
    const row = await upsertProfileRow(projectId, {
      calibrationFeedback: JSON.stringify(calibrationFeedback),
    })
    set({ profile: row })
    log.info('UserStyleStore', 'style.calibration.recorded', '文风校准反馈已记录', { projectId, profileId: row.id, feedbackCount: calibrationFeedback.length })
    return feedback
  },
}))
