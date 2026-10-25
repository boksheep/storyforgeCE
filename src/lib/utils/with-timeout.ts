/**
 * 有界等待（超时即失败）。
 *
 * 为什么需要：生成前的"准备阶段"（连续性快照、章节记忆重建、上下文装配）会做**网络调用**
 * （检索/嵌入向量）。这些 fetch 没有超时，网络半死时 `await` 会挂到 TCP 超时为止 —— 而
 * 生成在途闸门是"从点击到结束"持有的，于是一挂就把整个生成入口锁死：
 * 界面一直显示"正在生成"，再点也没有任何反应（真实事故：日志里 21:25 之后再无任何 AI 事件）。
 *
 * 语义边界（诚实说明）：
 * - 超时**只是放弃等待**，底层 fetch 不会被取消（我们没有它的 AbortSignal）；
 *   因此这里返回失败、由调用方释放闸门并如实报错，而不是假装成功继续。
 * - 调用方必须把它当作"这次生成没开始"处理（不能继续用半套上下文去写正文）。
 */

export class TimeoutError extends Error {
  readonly label: string
  readonly timeoutMs: number

  constructor(label: string, timeoutMs: number) {
    super(`${label}超时（${Math.round(timeoutMs / 1000)} 秒未返回）。可能是检索或嵌入服务不可达；本次生成已取消。`)
    this.name = 'TimeoutError'
    this.label = label
    this.timeoutMs = timeoutMs
  }
}

/** 等待 `promise`，超过 `timeoutMs` 就以 `TimeoutError` 失败。 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new TimeoutError(label, timeoutMs)) }, timeoutMs)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** 生成准备阶段的超时预算（装配上下文做嵌入检索，给得比纯本地操作宽一些）。 */
export const PREP_TIMEOUT_MS = 20_000
/** 上下文装配的超时预算（可能触发批量嵌入）。 */
export const CONTEXT_ASSEMBLE_TIMEOUT_MS = 45_000
