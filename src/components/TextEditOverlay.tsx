'use client'

import { useEffect, useRef } from 'react'
import { fontById } from '@/lib/fonts'
import { LINE_HEIGHT, type TextItem } from '@/lib/text'

/**
 * Inline text editor: a contentEditable positioned over the item on the
 * image, styled identically to the canvas rendering, so the user types with
 * a real caret in place. The canvas skips the item while this is mounted.
 * Commit happens on blur; callers that unmount it another way (e.g. the
 * "done" button) blur the active element first so no typing is lost.
 */
export default function TextEditOverlay({
  item,
  scale,
  onCommit,
}: {
  item: TextItem
  scale: number
  onCommit: (text: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  // Initialize content and select it once per editing session — never write
  // innerText from state afterwards, or the caret would jump while typing.
  useEffect(() => {
    const el = ref.current!
    el.innerText = item.text
    el.focus()
    const range = document.createRange()
    range.selectNodeContents(el)
    const sel = window.getSelection()
    if (sel) {
      sel.removeAllRanges()
      sel.addRange(range)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id])

  const font = fontById(item.fontId)
  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      role="textbox"
      aria-label="Edit text"
      onBlur={() => onCommit(ref.current!.innerText)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          ref.current!.blur()
        }
        e.stopPropagation()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      className="absolute"
      style={{
        left: item.x / scale,
        top: item.y / scale,
        transform: 'translate(-50%, -50%)',
        fontFamily: font.family,
        fontWeight: item.weight,
        fontSize: item.size / scale,
        lineHeight: LINE_HEIGHT,
        color: item.color,
        textAlign: 'center',
        whiteSpace: 'pre',
        minWidth: '1ch',
        outline: '1px dashed var(--amber-soft)',
        outlineOffset: 4,
        caretColor: 'var(--amber)',
        background: 'transparent',
      }}
    />
  )
}
