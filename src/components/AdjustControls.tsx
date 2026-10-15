'use client'

import type { Adjust } from '@/lib/adjust'
import type { OrientOp } from '@/lib/orient'

const ORIENT_BUTTONS: { op: OrientOp; glyph: string; label: string }[] = [
  { op: 'ccw', glyph: '↺', label: 'Rotate left' },
  { op: 'cw', glyph: '↻', label: 'Rotate right' },
  { op: 'flipH', glyph: '⇋', label: 'Flip horizontally' },
  { op: 'flipV', glyph: '⇵', label: 'Flip vertically' },
]

/** One bipolar slider: the two words name the ends, double-click centers. */
function Bipolar({
  left,
  right,
  value,
  disabled,
  onChange,
  label,
}: {
  left: string
  right: string
  value: number
  disabled: boolean
  onChange: (v: number) => void
  label: string
}) {
  return (
    <div className="ctrl flex items-center gap-2 px-3 h-9 sm:h-10" data-active={value !== 0}>
      <span className="label">{left}</span>
      <input
        type="range"
        min={-100}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => onChange(0)}
        className="w-20 sm:w-28"
        aria-label={label}
      />
      <span className="label">{right}</span>
    </div>
  )
}

/** Toolbar shown while the adjust tool is active. */
export default function AdjustControls({
  adjust,
  available,
  onChange,
  onOrient,
  onReset,
  onDone,
}: {
  adjust: Adjust
  /** False when WebGL2 is missing or the context was lost — rotation still
   *  works, the sliders don't. */
  available: boolean
  onChange: (patch: Partial<Adjust>) => void
  onOrient: (op: OrientOp) => void
  onReset: () => void
  onDone: () => void
}) {
  return (
    <div className="pb-3 sm:pb-6">
      <div className="px-3 sm:px-6 pb-1.5 sm:pb-2 flex justify-center gap-1.5 sm:gap-2">
        {ORIENT_BUTTONS.map((b) => (
          <button
            key={b.op}
            type="button"
            className="ctrl w-10 h-9 sm:h-10 cursor-pointer text-base"
            onClick={() => onOrient(b.op)}
            aria-label={b.label}
            title={b.label}
          >
            {b.glyph}
          </button>
        ))}
      </div>
      <div className="px-3 sm:px-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
        <Bipolar
          left="blur"
          right="sharp"
          value={adjust.sharp}
          disabled={!available}
          onChange={(sharp) => onChange({ sharp })}
          label="Blur or sharpen"
        />
        <Bipolar
          left="dark"
          right="bright"
          value={adjust.light}
          disabled={!available}
          onChange={(light) => onChange({ light })}
          label="Darken or brighten"
        />
        <button
          type="button"
          className="ctrl label px-3 h-9 sm:h-10 cursor-pointer"
          onClick={onReset}
          disabled={adjust.sharp === 0 && adjust.light === 0}
        >
          reset
        </button>
        <button
          type="button"
          onClick={onDone}
          className="label px-6 sm:px-7 h-9 sm:h-10 cursor-pointer"
          style={{ background: 'var(--amber)', color: '#181612', fontWeight: 500 }}
        >
          done
        </button>
      </div>
    </div>
  )
}
