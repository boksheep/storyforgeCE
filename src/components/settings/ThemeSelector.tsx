import { THEME_OPTIONS, type StoryForgeTheme } from '../../lib/theme'

interface Props {
  value: StoryForgeTheme
  onChange: (theme: StoryForgeTheme) => void
}

export default function ThemeSelector({ value, onChange }: Props) {
  return (
    <div className="bg-bg-surface border border-border rounded-xl p-5">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h3 className="text-base font-semibold text-text-primary">主题</h3>
          <p className="mt-1 text-xs text-text-muted">主题只影响当前浏览器，不会修改作品内容。</p>
        </div>
        <span className="text-[10px] text-text-muted border border-border rounded px-2 py-1">{THEME_OPTIONS.length} 种</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {THEME_OPTIONS.map(theme => {
          const isActive = value === theme.value
          return (
            <button key={theme.value} onClick={() => onChange(theme.value)} aria-pressed={isActive}
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border text-left transition-all ${
                isActive ? 'border-accent bg-accent/10' : 'border-border hover:border-border-hover hover:bg-bg-hover'
              }`}>
              <div className="flex items-end gap-1 flex-shrink-0">
                {theme.swatches.map((color, index) => (
                  <div key={color} style={{
                    width: index === 0 ? 28 : 18,
                    height: index === 0 ? 28 : 18,
                    background: color,
                    borderRadius: index === 0 ? 6 : 4,
                    border: '1px solid rgba(0,0,0,0.08)',
                    marginBottom: index === 0 ? 0 : 5,
                    flexShrink: 0,
                  }} />
                ))}
              </div>
              <div className="flex-1">
                <p className="text-sm text-text-primary font-medium leading-none mb-1">{theme.emoji} {theme.label}</p>
                <p className="text-xs text-text-muted">{theme.desc}</p>
              </div>
              {isActive && (
                <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center flex-shrink-0" aria-label="当前主题">
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M20 6 9 17 4 12"/>
                  </svg>
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
