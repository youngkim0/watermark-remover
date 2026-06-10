export const SITE_URL = 'https://unmark.live'
export const SITE_NAME = 'Unmark'

export const TAGLINE = 'Free AI watermark remover — in your browser'

export const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '01',
    title: 'Drop your image',
    body: 'Drag it in, paste from the clipboard, or pick a file. It opens instantly — nothing is uploaded.',
  },
  {
    n: '02',
    title: 'The watermark is erased automatically',
    body: 'Unmark masks the corner mark and rebuilds the pixels with a generative inpainting model. Brush over anything else you want gone.',
  },
  {
    n: '03',
    title: 'Download the clean image',
    body: 'Save a full-resolution PNG. Done in seconds, entirely on your device.',
  },
]

export const REASONS: { title: string; body: string }[] = [
  {
    title: 'Private by design',
    body: 'Images are processed locally with WebGPU and WebAssembly. They never leave your browser and nothing is stored.',
  },
  {
    title: 'Actually free',
    body: 'No sign-up, no credits, no daily caps. Because removal runs on your device, there are no server bills to pass on.',
  },
  {
    title: 'Studio quality',
    body: 'A MI-GAN inpainting model reconstructs real texture instead of smearing a blur over the spot.',
  },
]

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is Unmark free?',
    a: 'Yes. Unmark is completely free with no sign-up, no credits and no daily limits. Because the watermark removal runs on your own device, there are no server costs to pass on.',
  },
  {
    q: 'Are my images uploaded anywhere?',
    a: 'No. Every image is processed locally in your browser using WebGPU and WebAssembly. Your photos never leave your device and nothing is stored on a server.',
  },
  {
    q: 'What watermarks can Unmark remove?',
    a: 'The visible sparkle that Gemini, Nano Banana and other AI generators stamp on images, plus logos, text, captions, timestamps and small unwanted objects.',
  },
  {
    q: 'Does Unmark remove invisible watermarks like SynthID?',
    a: 'No. Unmark only removes visible marks. It does not detect or strip invisible provenance watermarks such as SynthID, and it should not be used to misrepresent AI-generated images.',
  },
  {
    q: 'What image formats and sizes are supported?',
    a: 'PNG, JPG and WebP up to 4096 pixels on the longest side. Cleaned images are saved as PNG.',
  },
  {
    q: 'Can I use it on any image?',
    a: 'Use Unmark only on images you own or have the rights to edit. Removing watermarks from other people’s copyrighted work may be illegal.',
  },
]
