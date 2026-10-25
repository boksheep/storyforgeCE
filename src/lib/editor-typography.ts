/**
 * 正文编辑器排版偏好 · 单一事实源(全局持久)。
 *
 * 字体/字号/行距/段距是「阅读偏好」,应当全局生效、跨章保持、刷新不丢——
 * 因此存 localStorage + 写到 :root 的 CSS 变量(由 .tiptap-editor 消费),
 * 而不是写进每章正文(那样下一章就回默认了)。空值 = 用 CSS 内置默认。
 */
export interface EditorTypography {
  fontFamily: string
  fontSize: string
  lineHeight: string
  paragraphSpacing: string
}

const KEY = 'storyforge-editor-typography'

export const DEFAULT_TYPOGRAPHY: EditorTypography = {
  fontFamily: '',
  fontSize: '',
  lineHeight: '',
  paragraphSpacing: '',
}

export function loadEditorTypography(): EditorTypography {
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const obj = JSON.parse(raw)
      if (obj && typeof obj === 'object') return { ...DEFAULT_TYPOGRAPHY, ...obj }
    }
  } catch { /* ignore */ }
  return { ...DEFAULT_TYPOGRAPHY }
}

/** 写到 :root 的 CSS 变量;空值则移除该变量(回落到 CSS 内置默认)。 */
export function applyEditorTypography(t: EditorTypography): void {
  const root = document.documentElement
  const set = (name: string, val: string) => {
    if (val) root.style.setProperty(name, val)
    else root.style.removeProperty(name)
  }
  set('--editor-user-font-family', t.fontFamily)
  set('--editor-user-font-size', t.fontSize)
  set('--editor-user-line-height', t.lineHeight)
  set('--editor-user-paragraph-spacing', t.paragraphSpacing)
}

export function saveEditorTypography(t: EditorTypography): void {
  localStorage.setItem(KEY, JSON.stringify(t))
  applyEditorTypography(t)
}
