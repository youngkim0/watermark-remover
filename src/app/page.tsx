'use client'

import { useState } from 'react'
import Dropzone from '@/components/Dropzone'
import Editor from '@/components/Editor'

export default function Home() {
  const [file, setFile] = useState<File | null>(null)

  return (
    <main className="h-dvh flex flex-col">
      <header
        className="flex items-center justify-between px-6 py-4 border-b shrink-0"
        style={{ borderColor: 'var(--line)' }}
      >
        <button
          type="button"
          onClick={() => setFile(null)}
          className="cursor-pointer"
          style={{ fontFamily: 'var(--font-serif), serif', fontSize: 22, fontStyle: 'italic' }}
        >
          Unmark<span className="text-amber not-italic">.</span>
        </button>
        <span className="label text-ink-faint hidden sm:block">
          on-device watermark eraser
        </span>
      </header>

      {file ? (
        <Editor key={`${file.name}-${file.lastModified}`} file={file} onReplace={() => setFile(null)} />
      ) : (
        <Dropzone onFile={setFile} />
      )}

      <footer
        className="flex items-center justify-between px-6 py-3 border-t shrink-0"
        style={{ borderColor: 'var(--line)' }}
      >
        <span className="label text-ink-faint hidden sm:block">
          mi-gan · onnx runtime · webgpu/wasm
        </span>
        <span className="label text-ink-faint">images never leave this device</span>
      </footer>
    </main>
  )
}
