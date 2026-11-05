/**
 * CLOUD-DB-1 · 项目云端身份的唯一写入口
 *
 * ## 为什么这个函数放在 registry 层而不是 cloud 层
 *
 * `check-architecture` 规则⑧ 禁止 `src/lib/**`（registry 目录除外）绕过 `adopt()`
 * 直接写受治理表。`projects` 已经有归属的 `ADOPTION_EXTENSIONS` 条目
 * （`step-restore-projects`，来自撤回系统），而同一个 target **不允许登记两次**。
 *
 * 正确的做法不是再加一条例外，也不是把 `syncUid` 塞进 AI 采纳流程
 * （它不是 AI 派生内容），而是：把"写 projects 的某一列"这件事放回它该在的地方
 * ——注册表层。`lifecycle.ts` / `adopt.ts` 同样在这个目录里做受治理的直接写库。
 *
 * 因此 `src/lib/cloud/project-identity.ts` 只负责**策略**（何时生成、如何查重），
 * 实际写库由这里完成。
 */
import { db } from '../db/schema'
import type { Project } from '../types'

/**
 * 写入 / 清除项目的云端身份。
 *
 * 只做**单字段 update**：不碰 `name`、不碰 `updatedAt`
 * —— 否则每次同步都会让项目"看起来被改过"，触发多余的备份与列表刷新。
 */
export async function setProjectSyncUid(projectId: number, syncUid: string | undefined): Promise<void> {
  await db.projects.update(projectId, { syncUid } as unknown as Partial<Project>)
}
