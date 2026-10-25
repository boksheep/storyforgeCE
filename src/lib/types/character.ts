import type { RagDocumentMetadata } from './rag-library'

/** 角色定位（v3 §2.1 — 扩展 npc / extra 两类） */
export type CharacterRole =
  | 'protagonist'    // 主角
  | 'antagonist'     // 反派
  | 'supporting'     // 重要配角
  | 'minor'          // 次要角色
  | 'npc'            // NPC（紧凑列表展示）
  | 'extra'          // 路人（表格行：姓名/出场时间/章节/作用/结局）

/** 戏份权重（R1：与阵营正交） */
export type CharacterRoleWeight = 'main' | 'secondary' | 'npc' | 'extra'

/** 阵营九宫格：道德轴 */
export type CharacterMoralAxis = 'good' | 'neutral' | 'evil'

/** 阵营九宫格：秩序轴 */
export type CharacterOrderAxis = 'lawful' | 'neutral' | 'chaotic'

/** 旧二值阵营，仅为旧数据兼容保留。新代码使用 moralAxis/orderAxis。 */
export type CharacterAlignment = 'good' | 'evil'

/** 角色 */
export interface Character extends RagDocumentMetadata {
  id?: number
  projectId: number
  name: string
  /**
   * ALIAS-1：别称 / 曾用名 / 称呼（**字面称呼**，不是正则）。
   *
   * 用途：正文里出现任一称呼都能解析回同一个人 —— 编辑器高亮与 @ 补全、检索召回、
   * 事实/认知/存亡的按名绑定，以及"本章相关角色"的自动选入。
   * 归一化与上限见 `src/lib/entities/surface-match.ts`（`normalizeAliases`：最长 8 个、最短 2 字）。
   * 一个称呼被两个角色共用时按**歧义不猜**处理（解析返回 null），不按遍历顺序挑一个。
   */
  aliases?: string[]
  /** 兼容字段：始终由 roleWeight + moralAxis 派生，不再作为独立输入。 */
  role: CharacterRole
  roleWeight: CharacterRoleWeight
  moralAxis: CharacterMoralAxis
  orderAxis: CharacterOrderAxis
  /** @deprecated 旧二值阵营。新代码使用 moralAxis/orderAxis。 */
  alignment?: CharacterAlignment
  shortDescription: string   // 一句话简介
  appearance: string         // 外貌
  personality: string        // 性格
  background: string         // 背景故事
  motivation: string         // 动机
  abilities: string          // 能力
  relationships: string      // 关系描述（JSON string）
  arc: string                // 角色弧光/成长线

  // ── 扩展角色维度（可选；空=未填。注册于 FIELD_REGISTRY，由 CHARACTER_DIMENSIONS 描述符驱动呈现/生成）──
  identity?: string          // 身份/职业/势力归属
  profile?: string           // 年龄·性别·种族
  values?: string            // 价值观/信念
  strengths?: string         // 优点/长处
  weaknesses?: string        // 缺点/性格弱点
  fears?: string             // 恐惧/软肋/逆鳞
  goals?: string             // 目标（短期+长期）
  innerConflict?: string     // 核心矛盾/内心冲突
  keyEvents?: string         // 关键经历/转折事件
  powerLevel?: string        // 实力定位/境界等级
  speechStyle?: string       // 语言风格/口头禅
  habits?: string            // 习惯/小动作/癖好
  signatureItem?: string     // 标志性物品/形象符号

  // ── v3 §2.1 新字段：路人卡片用 ───────────────────────────────
  /** 常驻地点 / 起始地点 */
  location?: string
  /** 首次出场（章节号或自由文本） */
  firstAppearance?: string
  /** 在故事中扮演的角色作用（v3 §2.1 表格行字段） */
  storyRole?: string
  /** 结局走向 */
  ending?: string

  // ── Phase G2 新字段 ──
  /** 首次出场章节 ID */
  firstAppearChapterId?: number | null
  /** 活跃章节范围描述（如 "1-30, 45-60"） */
  activeChapterRange?: string
  /** 退场/死亡章节 ID */
  exitChapterId?: number | null

  // ── Phase 25.4 多世界 ──
  /** 角色原属世界组 ID（null = 主角/跨世界角色） */
  homeWorldGroupId?: number | null
  /** 是否跨世界角色（主角、系统精灵等，在所有世界中可见） */
  isCrossWorld?: boolean

  // ── WORLD-1 修炼/种族结构化关联 ──
  /** 所属种族词条（Codex race）；替代 profile 中不可校验的纯文本种族。 */
  raceEntryId?: number | null
  /** 主修体系；指向 cultivationSystems。 */
  cultivationSystemId?: number | null
  /** 当前设定境界（上游角色卡，不是逐章进度）；指向体系 stages 内的稳定字符串 ID。 */
  cultivationStageId?: string | null

  createdAt: number
  updatedAt: number
}

// （Faction 接口已随 C2 / DB v29 删除：势力并入「势力」词条。）
