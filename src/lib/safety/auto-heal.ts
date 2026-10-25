/**
 * DB-SAFETY-1 · 启动自愈（Auto-Heal）
 *
 * 纯前端项目里，用户手稿只存在于浏览器。一旦程序逻辑把主库删了
 * （R-17b 真实事故：加一张表就在首次加载时清空了作者全部手稿），
 * 用户看到的就是"数据全没了"——而他此时**不该**需要懂什么是导出、什么是备份。
 *
 * 本模块在启动序列里做一次"体检 + 自愈"：
 *
 *   1. 主库里有项目            → 什么都不做（正常启动，零打扰）。
 *   2. 主库为空、哨兵里有副本  → **自动**把最新副本导入回来（无需用户任何操作）。
 *   3. 主库为空、哨兵也为空    → 什么都不做（全新用户，不该弹任何东西）。
 *
 * 恢复走既有 `importProjectJSON` 入口 → 产生**新项目**（导入刻意改名），
 * 因此自愈绝不会覆盖或破坏任何仍然存在的数据。
 */
import { db } from '../db/schema'
import { log } from '../logging/logger'
import { listRescue, restoreRescue } from './rescue-vault'

export interface AutoHealResult {
  /** 是否执行了恢复 */
  healed: boolean
  /** 恢复出来的项目 ID 列表 */
  restoredProjectIds: number[]
  /** 参与恢复的副本数量 */
  candidateCount: number
}

/**
 * 启动自愈入口。**绝不抛错**——启动路径上的任何异常都不能把应用带崩。
 *
 * @param maxProjects 单次最多恢复几个项目（防止哨兵里堆积的项目一次性灌爆启动）
 */
export async function autoHealEmptyDatabase(maxProjects = 3): Promise<AutoHealResult> {
  const result: AutoHealResult = { healed: false, restoredProjectIds: [], candidateCount: 0 }

  try {
    // (1) 主库还有项目 → 无需自愈。
    const existing = await db.projects.count()
    if (existing > 0) return result

    // (2) 主库空了，看哨兵里有没有东西。
    const candidates = await listRescue()
    if (candidates.length === 0) return result // 全新用户：静默

    result.candidateCount = candidates.length

    // 每个项目只取最新一份，避免同一项目的多个历史副本被重复导入。
    const newestPerProject = new Map<number, (typeof candidates)[number]>()
    for (const row of candidates) {
      if (!newestPerProject.has(row.projectId)) newestPerProject.set(row.projectId, row)
    }

    const picks = [...newestPerProject.values()].slice(0, maxProjects)
    for (const record of picks) {
      const newId = await restoreRescue(record)
      if (newId != null) result.restoredProjectIds.push(newId)
    }

    if (result.restoredProjectIds.length > 0) {
      result.healed = true
      log.info('RescueVault', 'rescue.autoheal',
        `[rescue] 启动自愈：主库为空，已从库外副本自动恢复 ${result.restoredProjectIds.length} 个项目`,
        { restored: result.restoredProjectIds.length, candidates: candidates.length })
    }
  } catch (err) {
    log.error('RescueVault', 'rescue.autoheal', '[rescue] 启动自愈失败(不影响主流程)', undefined, err)
  }

  return result
}
