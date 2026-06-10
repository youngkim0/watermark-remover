'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

export default function Dropzone({ onFile }: { onFile: (file: File) => void }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  const accept = useCallback(
    (file: File | null | undefined) => {
      if (file && file.type.startsWith('image/')) onFile(file)
    },
    [onFile]
  )

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find((i) =>
        i.type.startsWith('image/')
      )
      if (item) accept(item.getAsFile())
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [accept])

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center p-6 fade-up">
      {/* A <label> opens the native file picker on click with no JS — the most
          reliable pattern. The input is a sibling, never nested in a button. */}
      <label
        onDragOver={(e) => {
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          accept(e.dataTransfer.files[0])
        }}
        className="group relative block w-full max-w-3xl border border-dashed px-8 py-24 text-center transition-colors duration-200 cursor-pointer"
        style={{
          borderColor: over ? 'var(--amber-soft)' : 'var(--line-strong)',
          background: over ? 'rgba(232,163,61,0.04)' : 'transparent',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          aria-label="Upload an image"
          onChange={(e) => {
            accept(e.target.files?.[0])
            e.target.value = ''
          }}
        />
        <span
          aria-hidden
          className="block text-amber transition-transform duration-300 group-hover:scale-110"
          style={{ fontSize: 28, lineHeight: 1 }}
        >
          ✦
        </span>
        <span className="label mt-8 block text-ink-dim">
          Free AI watermark remover · in your browser
        </span>
        <h1
          className="mt-4 text-ink"
          style={{ fontFamily: 'var(--font-serif), serif', fontSize: 'clamp(34px, 5vw, 52px)', lineHeight: 1.1 }}
        >
          Erase the mark.
          <br />
          <em className="text-amber">Keep the picture.</em>
        </h1>
        <span className="label mt-10 block text-ink-dim">
          drop an image — click to browse — or paste
        </span>
        <span className="label mt-3 block text-ink-faint">
          the watermark is removed automatically · nothing is uploaded
        </span>
      </label>
    </div>
  )
}
