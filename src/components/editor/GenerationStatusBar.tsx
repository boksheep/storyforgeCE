/**
 * 生成状态悬浮条（第四次事故回归）。
 *
 * 作者的原话："取消生成在哪呢，没看见，加载中的动画也没看见"。
 * 原因很实在：上一版把圆环与取消只加在**工具栏那一行**，而
 *   ① 工具栏在编辑区顶部，滚动到正文中间就看不见；
 *   ② 生成前协商用的是非流式 `chat()`，工具栏看的 `isStreaming` / 在途闸门在那一阶段都是 false，
 *      于是"协商正在跑"在外观上等于"什么都没发生"。
 *
 * 所以这里做一个**固定悬浮**的状态条：只要有任何 AI 长任务在跑（流式生成或协商三步），
 * 它就在屏幕上（不随滚动消失），带圆环、说明在跑什么/用哪个模型，并提供一个**永远有效**的取消。
 * 它是"看得见"的兜底，不替代工具栏里"取消按在点击处"的交互。
 */
import { PersistentTaskStatusBar, useHasPersistentTaskProvider, usePersistentTask } from '../shared/PersistentTaskStatusBar'

/**
 * 状态条该不该出现。
 *
 * ⚠️ 关键区分（作者反馈："预览还没发送生成，悬浮条就出现了，不符合逻辑"）：
 * - **在途闸门（claim）**：从点击到这次生成彻底结束都持有，用来防止重复发起；
 *   其中"作者正在看发送前预览"这一段时间**不是**"正在生成"。
 * - **正在跑（running）**：真的在读上下文 / 等模型 / 收 token。
 * 状态条只反映后者，否则作者会以为生成已经开始了。
 */
export function shouldShowGenerationStatus(input: {
  isStreaming: boolean
  /** 真的在工作（装配中、等待模型、流式输出中）。 */
  running: boolean
  /** 协商的模型调用在跑。 */
  negotiationBusy: boolean
}): boolean {
  return input.isStreaming || input.running || input.negotiationBusy
}

export function getGenerationStatusTitle(input: {
  isStreaming: boolean
  running: boolean
  negotiationBusy: boolean
  operation: string | null
}): string {
  if (input.isStreaming) {
    if (input.operation === 'continue') return '正在续写正文'
    if (input.operation === 'polish') return '正在润色'
    if (input.operation === 'expand') return '正在扩写'
    return '正在生成正文'
  }
  if (input.running) {
    return input.operation === 'continue' ? '正在准备续写内容' : '正在拼接发送内容'
  }
  if (input.negotiationBusy) return '生成前协商进行中（摘要 → 提问 → 申报）'
  return ''
}

interface Props {
  /** 是否显示（任一长任务在跑）。 */
  visible: boolean
  /** 在跑什么，如「正在生成正文」「生成前协商 · 第 2/3 步」。 */
  title: string
  /** 用哪个模型/槽位（可空）。 */
  detail?: string
  /** 取消按钮文案，如「取消生成」「取消协商」。 */
  cancelLabel: string
  onCancel: () => void
}

export default function GenerationStatusBar({ visible, title, detail, cancelLabel, onCancel }: Props) {
  const hasProvider = useHasPersistentTaskProvider()
  const task = { title, detail, cancelLabel, onCancel, testId: 'generation-status-bar' }
  usePersistentTask(task, hasProvider && visible)
  if (!visible || hasProvider) return null
  return <PersistentTaskStatusBar task={{ ...task, id: 'chapter-generation' }} floating />
}
