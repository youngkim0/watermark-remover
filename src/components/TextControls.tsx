'use client'

import { TEXT_FONTS, fontById } from '@/lib/fonts'
import type { TextItem } from '@/lib/text'

const SWATCHES = ['#ffffff', '#181612', '#e8a33d', '#d96c47', '#5b8bd9']

/** Toolbar shown while the text tool is active. */
export default function TextControls({
  selected,
  onUpdate,
  onAdd,
  onDelete,
  onDone,
}: {
  selected: TextItem | null
  onUpdate: (patch: Partial<TextItem>) => void
  onAdd: () => void
  onDelete: () => void
  onDone: () => void
}) {
  const font = selected ? fontById(selected.fontId) : null
  return (
    <div className="px-3 sm:px-6 pb-3 sm:pb-6 flex flex-wrap items-center justify-center gap-1.5 sm:gap-2">
      {selected && font ? (
        <>
          <textarea
            value={selected.text}
            onChange={(e) => onUpdate({ text: e.target.value })}
            rows={1}
            className="ctrl px-3 py-2 h-9 sm:h-10 resize-none w-40 sm:w-52"
            style={{ fontFamily: font.family, fontSize: 14, color: 'var(--ink)' }}
            aria-label="Text content"
          />
          <select
            value={selected.fontId}
            onChange={(e) => {
              const next = fontById(e.target.value as TextItem['fontId'])
              onUpdate({
                fontId: next.id,
                // Clamp the weight to what the new family actually ships.
                weight: next.weights.includes(selected.weight) ? selected.weight : next.weights[0],
              })
            }}
            className="ctrl label px-2 h-9 sm:h-10 cursor-pointer bg-transparent"
            aria-label="Font"
          >
            {TEXT_FONTS.map((f) => (
              <option key={f.id} value={f.id} style={{ background: 'var(--surface)' }}>
                {f.label}
              </option>
            ))}
          </select>
          <div className="ctrl flex items-center gap-2 sm:gap-3 px-3 sm:px-4 h-9 sm:h-10">
            <span className="label">size</span>
            <input
              type="range"
              min={12}
              max={300}
              value={selected.size}
              onChange={(e) => onUpdate({ size: Number(e.target.value) })}
              className="w-20 sm:w-24"
              aria-label="Text size"
            />
          </div>
          <div className="ctrl flex items-center gap-1.5 px-3 h-9 sm:h-10">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => onUpdate({ color: c })}
                className="w-4 h-4 rounded-full cursor-pointer"
                style={{
                  background: c,
                  outline: selected.color === c ? '2px solid var(--amber)' : '1px solid var(--line-strong)',
                  outlineOffset: 1,
                }}
                aria-label={`Color ${c}`}
              />
            ))}
            <input
              type="color"
              value={selected.color}
              onChange={(e) => onUpdate({ color: e.target.value })}
              className="w-5 h-5 cursor-pointer bg-transparent border-0 p-0"
              aria-label="Custom color"
            />
          </div>
          {font.weights.includes(700) && (
            <button
              type="button"
              className="ctrl label px-3 h-9 sm:h-10 cursor-pointer"
              data-active={selected.weight === 700}
              onClick={() => onUpdate({ weight: selected.weight === 700 ? 400 : 700 })}
            >
              bold
            </button>
          )}
          <button
            type="button"
            className="ctrl label px-3 h-9 sm:h-10 cursor-pointer"
            onClick={onDelete}
          >
            delete
          </button>
        </>
      ) : (
        <span className="label text-ink-faint px-2">tap text on the image to edit it</span>
      )}
      <button type="button" className="ctrl label px-3 sm:px-4 h-9 sm:h-10 cursor-pointer" onClick={onAdd}>
        + add text
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
  )
}
