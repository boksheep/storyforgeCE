import type { FieldGenerationMode } from '../../lib/ai/field-generation-context'
import { Button } from './Button'

interface Props {
  value: FieldGenerationMode
  onChange: (mode: FieldGenerationMode) => void
}

const MODES: [FieldGenerationMode, string][] = [
  ['expand', '扩写'],
  ['rewrite', '重写'],
  ['polish', '润色'],
]

export default function AIFieldModeTabs({ value, onChange }: Props) {
  return (
    <div className="flex shrink-0 items-center rounded-lg border border-border bg-bg-base p-0.5">
      {MODES.map(([key, text]) => (
        <Button
          key={key}
          variant="ghost"
          size="sm"
          pressed={value === key}
          onClick={() => onChange(key)}
        >
          {text}
        </Button>
      ))}
    </div>
  )
}
