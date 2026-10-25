/**
 * DB-SAFETY-1 · 库外哨兵写入调度
 *
 * 收口"什么时候往哨兵库写一份副本"的决策，避免每个 hook / 组件各写一套节流逻辑
 * （那正是项目宪法反复禁止的"散写"）。
 *
 * 设计要点：
 *   · **节流而非排队**：同一项目在 `THROTTLE_MS` 内的重复请求直接跳过。
 *     哨兵只需要"最近的一份"，写太频既费配额又拖慢主线程。
 *   · **写前先判定是否值得写**：主库为空时不写（没有项目可救），
 *     避免在删库之后又往哨兵里塞一份空数据把好副本挤掉。
 *   · **失败静默**：`writeRescue` 内部已经吞掉异常，这里只做簿记。
 */
import { writeRescue, listRescueForProject, type RescueReason } from './rescue-vault'

/** 同项目两次落盘的最小间隔（5 分钟，与既有自动备份节拍一致）。 */
export const RESCUE_THROTTLE_MS = 5 * 60 * 1000

/** 上次落盘时间（内存态，刷新即重置——刷新后重写一份是合理的）。 */
const lastWriteAt = new Map<number, number>()

/** 正在进行中的写入（防止并发重复写同一项目）。 */
const inFlight = new Set<number>()

/**
 * 请求为某项目落一份库外副本（受节流约束）。
 *
 * @param force 忽略节流强制写（用于"删库前"这种绝不能省的时刻）
 * @returns 是否真的写了
 */
export async function requestRescue(
  projectId: number | null | undefined,
  reason: RescueReason,
  options: { force?: boolean } = {},
): Promise<boolean> {
  if (projectId == null || !Number.isFinite(projectId)) return false
  if (inFlight.has(projectId)) return false

  const now = Date.now()
  if (!options.force) {
    const previous = lastWriteAt.get(projectId)
    if (previous != null && now - previous < RESCUE_THROTTLE_MS) return false
  }

  // 节流窗口内已经有副本就不必再写：哨兵要的是"最近一份"，不是堆积。
  if (!options.force) {
    const existing = await listRescueForProject(projectId)
    const newest = existing[0]
    if (newest && now - newest.createdAt < RESCUE_THROTTLE_MS) {
      lastWriteAt.set(projectId, newest.createdAt)
      return false
    }
  }

  inFlight.add(projectId)
  try {
    const ok = await writeRescue(projectId, reason)
    if (ok) lastWriteAt.set(projectId, now)
    return ok
  } finally {
    inFlight.delete(projectId)
  }
}

/** 重置节流簿记（仅供测试）。 */
export function resetRescueThrottle(): void {
  lastWriteAt.clear()
  inFlight.clear()
}
