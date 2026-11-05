/**
 * CLOUD-DB-1 · 云数据库弹窗的全局开关
 *
 * 登录/云端信息是**一个**弹窗，但触发点有很多：
 *   - 首页顶栏的账号按钮
 *   - 工作区顶栏的账号按钮
 *   - 数据管理卡片里的"登录"
 *   - 设置区菜单里的"云数据库"
 *
 * 所以状态放在 store 里、弹窗只在 `App` 挂一份。任何地方 `openCloudDialog()` 即可。
 * **不要**在各自页面里再复制一份弹窗 —— 那会立刻出现"两个弹窗叠在一起"的问题。
 */
import { create } from 'zustand'

/** 打开时希望用户先看到什么。 */
export type CloudDialogIntent =
  /** 登录 / 配置服务器（默认） */
  | 'login'
  /** 已登录时直接看云端占用 */
  | 'info'

interface CloudDialogState {
  open: boolean
  intent: CloudDialogIntent
  openCloudDialog: (intent?: CloudDialogIntent) => void
  closeCloudDialog: () => void
}

export const useCloudDialog = create<CloudDialogState>((set) => ({
  open: false,
  intent: 'login',
  openCloudDialog: (intent = 'login') => set({ open: true, intent }),
  closeCloudDialog: () => set({ open: false }),
}))

/** 供非组件代码（store / 事件）调用。 */
export function openCloudDialog(intent: CloudDialogIntent = 'login'): void {
  useCloudDialog.getState().openCloudDialog(intent)
}
