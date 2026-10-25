import { create } from 'zustand'
import { db } from '../lib/db/schema'
import type { PromptTemplate, PromptModuleKey } from '../lib/types/prompt'
import { SYSTEM_PROMPT_SEEDS } from '../lib/ai/prompt-seeds'
import { log } from '../lib/logging/logger'

interface PromptStore {
  templates: PromptTemplate[]
  loaded: boolean

  /** 启动时调用一次：从 IndexedDB 加载，若空则注入系统 seed。 */
  init(): Promise<void>

  /** 同步获取某 moduleKey 当前激活的模板。
   *  正常情况从内存里取；若 store 未初始化或没找到，fallback 到 seed 数组兜底。
   */
  getActive(key: PromptModuleKey): PromptTemplate

  /** 保存（新增或更新）一个模板，并刷新 in-memory 列表。 */
  saveTemplate(t: PromptTemplate): Promise<number>

  /** 从已有模板克隆一份给用户编辑（scope='user'，isActive=false）。 */
  cloneTemplate(id: number, newName?: string): Promise<number>

  /** 把某模板设为对应 moduleKey 的激活模板（其他同 key 的取消激活）。 */
  setActive(id: number): Promise<void>

  /** 删除一个模板并刷新列表（UI 层不得直接 db.delete，必须走这里）。 */
  deleteTemplate(id: number): Promise<void>

  /** 强制重新从 DB 加载。 */
  reload(): Promise<void>
}

export const usePromptStore = create<PromptStore>((set, get) => ({
  templates: [],
  loaded: false,

  init: async () => {
    if (get().loaded) return
    const existing = await db.promptTemplates.toArray()
    const now = Date.now()
    const { NOVEL_CONTENT_PROMPT_SEEDS } = await import('../lib/ai/prompt-seeds-novel')
    // 系统 seed 以名称为身份；同名定义以最后一份为准，与旧库刷新路径一致。
    const allSystemSeeds = [...new Map(
      [...SYSTEM_PROMPT_SEEDS, ...NOVEL_CONTENT_PROMPT_SEEDS].map(seed => [seed.name, seed] as const),
    ).values()]

    let added = 0
    let updated = 0
    let deduplicated = 0
    if (existing.length === 0) {
      // 全新库：注入全部 seed
      const rows: PromptTemplate[] = allSystemSeeds.map(seed => ({
        ...seed,
        createdAt: now,
        updatedAt: now,
      }))
      await db.promptTemplates.bulkAdd(rows)
      added = rows.length
    } else {
      // 已有库：补缺 seed + 更新现有 system seed 的内容（保留用户的 isActive 选择）
      // Phase 13: 同一 moduleKey 下可能有多套 seed（不同 genre），用 name 作为唯一键
      const managedNames = new Set(allSystemSeeds.map(seed => seed.name))
      const existingSystemMap = new Map<string, PromptTemplate>()
      const duplicateIds: number[] = []
      for (const template of existing.filter(t => t.scope === 'system' && managedNames.has(t.name))) {
        const prior = existingSystemMap.get(template.name)
        if (!prior) {
          existingSystemMap.set(template.name, template)
          continue
        }
        const keep = template.isActive && !prior.isActive ? template : prior
        const discard = keep === template ? prior : template
        existingSystemMap.set(template.name, keep)
        if (discard.id != null) duplicateIds.push(discard.id)
      }
      if (duplicateIds.length) {
        await db.promptTemplates.bulkDelete(duplicateIds)
        deduplicated = duplicateIds.length
      }

      for (const seed of allSystemSeeds) {
        const old = existingSystemMap.get(seed.name)
        if (!old) {
          // 缺 → 补
          await db.promptTemplates.add({ ...seed, createdAt: now, updatedAt: now })
          added++
        } else {
          // 已有 → 用代码里的最新内容刷新（除了 isActive，保留用户的激活选择）
          const refreshed: Partial<PromptTemplate> = {
            name: seed.name,
            moduleKey: seed.moduleKey,
            description: seed.description,
            systemPrompt: seed.systemPrompt,
            userPromptTemplate: seed.userPromptTemplate,
            variables: seed.variables,
            promptType: seed.promptType,
            modelOverride: seed.modelOverride,
            isDefault: seed.isDefault,
            genres: seed.genres,
            parameters: seed.parameters,
            examples: seed.examples,
            lengthMode: seed.lengthMode,
            continuityMode: seed.continuityMode,
            assetId: seed.assetId,
            variableBindings: seed.variableBindings,
            applicability: seed.applicability,
            updatedAt: now,
          }
          await db.promptTemplates.update(old.id!, refreshed)
          updated++
        }
      }
    }

    const reloaded = await db.promptTemplates.toArray()
    set({ templates: reloaded, loaded: true })
    // 启动时注入/刷新系统提示词 seed：属覆盖/合并类写库，记录前后规模与模式。
    log.info(
      'PromptStore',
      'prompt.seed.synced',
      `提示词 seed 同步：${existing.length === 0 ? '全新注入' : '增量刷新'}（原 ${existing.length} → 现 ${reloaded.length}，新增 ${added}、更新 ${updated}）`,
      { mode: existing.length === 0 ? 'fresh' : 'refresh', before: existing.length, after: reloaded.length, added, updated, deduplicated },
    )
  },

  getActive: (key: PromptModuleKey): PromptTemplate => {
    const list = get().templates
    // 优先用户激活的
    const userActive = list.find(t => t.moduleKey === key && t.scope === 'user' && t.isActive)
    if (userActive) return userActive
    // 其次系统激活的
    const sysActive = list.find(t => t.moduleKey === key && t.scope === 'system' && t.isActive)
    if (sysActive) return sysActive
    // 再次任意同 key 模板
    const any = list.find(t => t.moduleKey === key)
    if (any) return any
    // 最后兜底：seed 数组（store 未初始化时保命用）
    const seed = SYSTEM_PROMPT_SEEDS.find(s => s.moduleKey === key)
    if (seed) {
      const now = Date.now()
      return { ...seed, createdAt: now, updatedAt: now }
    }
    throw new Error(`[prompt-store] no template found for moduleKey: ${key}`)
  },

  saveTemplate: async (t: PromptTemplate): Promise<number> => {
    const now = Date.now()
    const row: PromptTemplate = { ...t, updatedAt: now, createdAt: t.createdAt || now }
    const id = await db.promptTemplates.put(row)
    await get().reload()
    return id as number
  },

  cloneTemplate: async (id: number, newName?: string): Promise<number> => {
    const src = await db.promptTemplates.get(id)
    if (!src) throw new Error(`template ${id} not found`)
    const now = Date.now()
    const { id: _drop, ...rest } = src
    void _drop
    const cloneRow: PromptTemplate = {
      ...rest,
      scope: 'user',
      name: newName || `${src.name} (副本)`,
      parentId: src.id,
      isActive: false,
      createdAt: now,
      updatedAt: now,
    }
    const newId = await db.promptTemplates.add(cloneRow)
    await get().reload()
    return newId as number
  },

  setActive: async (id: number): Promise<void> => {
    const target = await db.promptTemplates.get(id)
    if (!target) throw new Error(`template ${id} not found`)
    // 同 moduleKey 的其他模板取消激活
    const siblings = await db.promptTemplates.where('moduleKey').equals(target.moduleKey).toArray()
    const now = Date.now()
    await db.transaction('rw', db.promptTemplates, async () => {
      for (const s of siblings) {
        if (s.id === id) {
          await db.promptTemplates.update(s.id!, { isActive: true, updatedAt: now })
        } else if (s.isActive) {
          await db.promptTemplates.update(s.id!, { isActive: false, updatedAt: now })
        }
      }
    })
    await get().reload()
  },

  deleteTemplate: async (id: number): Promise<void> => {
    await db.promptTemplates.delete(id)
    await get().reload()
    // 删除提示词模板=丢弃一份作者可能配置的模板，属不可逆操作。
    log.warn(
      'PromptStore',
      'prompt.template.deleted',
      `已删除提示词模板 #${id}`,
      { templateId: id, count: 1 },
    )
  },

  reload: async () => {
    const all = await db.promptTemplates.toArray()
    set({ templates: all })
  },
}))
