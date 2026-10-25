/**
 * CONSISTENCY-5（随 ALIAS-1 交付）· 细纲声明角色缺席对账（确定性、零 token）。
 *
 * 为什么值得单独查：`detailedOutlines.appearingCharacterIds` 是作者/工坊**显式确认**过的
 * "本章这些人要出场"，但此前**只写不读**——正文生成不看它，生成后也没人核对。
 * 结果是一个安静的失败：细纲说三个人在场，正文只写了两个人，没有任一处会提示。
 *
 * 判定口径（刻意保守，避免把"用代词/群像/代称"误报成缺失）：
 * - 只有细纲**显式声明**的角色才进入对账；没声明就不查；
 * - 命中判定用该角色的**全部称呼**（正名 + 别称），保证"正文写别称"也算在场；
 * - `severity: 'unknown'` 且**不带引文**（这是"缺失"型发现，没有可引用的正文），
 *   UI 侧必须能渲染空引文（`ReviewPanel` 已按此调整）；
 * - 空/纯空白正文不参与对账（作者还没写，报"全员缺席"只是噪声）；
 * - 只提示可能遗漏，不代表违规。
 */
import type { ConsistencyFinding } from '../ai/adapters/consistency-audit-adapter'
import { log } from '../logging/logger'

export interface DeclaredCastEntry {
  /** 角色 id（用于证据回查）。 */
  id?: number
  /** 规范正名。 */
  name: string
  /** 全部可匹配称呼（正名 + 别称）。 */
  surfaces: readonly string[]
}

/** 该角色是否在正文里被任一声称提到。 */
export function isCastPresent(chapterText: string, entry: DeclaredCastEntry): boolean {
  return entry.surfaces.some(surface => surface.length >= 2 && chapterText.includes(surface))
}

/**
 * 对账"细纲声明出场但正文未出现"的角色。声明为空时不产出任何发现。
 */
export function checkDeclaredCastCoverage(
  chapterText: string,
  declared: readonly DeclaredCastEntry[],
): ConsistencyFinding[] {
  // 空/纯空白正文不参与对账：作者还没写，报"全员缺席"只是噪声。
  if (!chapterText.trim() || declared.length === 0) return []
  const findings = declared
    .filter(entry => !isCastPresent(chapterText, entry))
    .map(entry => ({
      category: '细纲出场对账',
      severity: 'unknown' as const,
      // 缺失型发现没有可引用的正文；空引文是**有意**的，UI 必须容忍（不渲染引文行）。
      quote: '',
      evidence: [{
        sourceType: 'canon' as const,
        sourceId: entry.id ?? 0,
        quote: `细纲声明出场：${entry.name}`,
      }],
      reason: `本章细纲声明「${entry.name}」出场，但正文里没有出现该角色的任何称呼（正名或别称）`,
      suggestion: '确认是否漏写；若本章只是提及/回忆，或作者有意延后，可忽略此项。',
    }))
  log.info('Consistency', 'consistency.cast.checked', '细纲出场角色已对账', {
    declaredCount: declared.length, missingCount: findings.length, chapterChars: chapterText.length,
  })
  return findings
}
