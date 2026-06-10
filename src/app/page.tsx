'use client'

import { useState } from 'react'
import Dropzone from '@/components/Dropzone'
import Editor from '@/components/Editor'
import { STEPS, REASONS, FAQ } from '@/lib/content'

function Header({ onHome }: { onHome: () => void }) {
  return (
    <header
      className="flex items-center justify-between px-6 py-4 border-b shrink-0"
      style={{ borderColor: 'var(--line)' }}
    >
      <button
        type="button"
        onClick={onHome}
        className="cursor-pointer"
        style={{ fontFamily: 'var(--font-serif), serif', fontSize: 22, fontStyle: 'italic' }}
      >
        Unmark<span className="text-amber not-italic">.</span>
      </button>
      <span className="label text-ink-faint hidden sm:block">on-device watermark eraser</span>
    </header>
  )
}

function Footer() {
  return (
    <footer
      className="flex items-center justify-between px-6 py-3 border-t shrink-0"
      style={{ borderColor: 'var(--line)' }}
    >
      <span className="label text-ink-faint hidden sm:block">
        mi-gan · onnx runtime · webgpu/wasm
      </span>
      <span className="label text-ink-faint">images never leave this device</span>
    </footer>
  )
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null)

  if (file) {
    return (
      <main className="h-dvh flex flex-col">
        <Header onHome={() => setFile(null)} />
        <Editor key={`${file.name}-${file.lastModified}`} file={file} onReplace={() => setFile(null)} />
        <Footer />
      </main>
    )
  }

  return (
    <main className="min-h-dvh flex flex-col">
      <Header onHome={() => setFile(null)} />

      {/* hero — fills the first screen */}
      <div className="flex flex-col" style={{ minHeight: 'calc(100dvh - 116px)' }}>
        <Dropzone onFile={setFile} />
      </div>

      {/* crawlable content below the fold */}
      <div className="px-6 pb-24">
        <div className="mx-auto w-full max-w-3xl">
          <Section kicker="how it works" title="Remove a watermark in three steps">
            <ol className="mt-10 grid gap-px sm:grid-cols-3" style={{ background: 'var(--line)' }}>
              {STEPS.map((s) => (
                <li key={s.n} className="bg-bg p-6">
                  <span className="label text-amber">{s.n}</span>
                  <h3
                    className="mt-4 text-ink"
                    style={{ fontFamily: 'var(--font-serif), serif', fontSize: 21, lineHeight: 1.2 }}
                  >
                    {s.title}
                  </h3>
                  <p className="mt-3 text-ink-dim" style={{ fontSize: 14, lineHeight: 1.6 }}>
                    {s.body}
                  </p>
                </li>
              ))}
            </ol>
          </Section>

          <Section kicker="why unmark" title="A watermark remover that respects your image">
            <div className="mt-10 grid gap-px sm:grid-cols-3" style={{ background: 'var(--line)' }}>
              {REASONS.map((r) => (
                <div key={r.title} className="bg-bg p-6">
                  <h3 className="text-ink" style={{ fontSize: 15, fontWeight: 500 }}>
                    {r.title}
                  </h3>
                  <p className="mt-3 text-ink-dim" style={{ fontSize: 14, lineHeight: 1.6 }}>
                    {r.body}
                  </p>
                </div>
              ))}
            </div>
          </Section>

          <Section kicker="faq" title="Questions, answered">
            <dl className="mt-10 border-t" style={{ borderColor: 'var(--line)' }}>
              {FAQ.map((f) => (
                <div key={f.q} className="border-b py-6" style={{ borderColor: 'var(--line)' }}>
                  <dt
                    className="text-ink"
                    style={{ fontFamily: 'var(--font-serif), serif', fontSize: 20, lineHeight: 1.25 }}
                  >
                    {f.q}
                  </dt>
                  <dd className="mt-3 text-ink-dim" style={{ fontSize: 14.5, lineHeight: 1.65 }}>
                    {f.a}
                  </dd>
                </div>
              ))}
            </dl>
          </Section>
        </div>
      </div>

      <Footer />
    </main>
  )
}

function Section({
  kicker,
  title,
  children,
}: {
  kicker: string
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-24">
      <span className="label text-ink-faint">{kicker}</span>
      <h2
        className="mt-3 text-ink"
        style={{ fontFamily: 'var(--font-serif), serif', fontSize: 'clamp(26px, 4vw, 36px)', lineHeight: 1.15 }}
      >
        {title}
      </h2>
      {children}
    </section>
  )
}
