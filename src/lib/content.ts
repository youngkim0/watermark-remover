export const SITE_URL = 'https://unmark.live'
export const SITE_NAME = 'Unmark'

// Displayed in the footer. Bump together with package.json's "version".
export const VERSION = 'v1.1.0'

export const TAGLINE = 'Free AI watermark remover & magic eraser — in your browser'

// What the inpainting brush can remove. Watermarks lead; the rest shows breadth.
export const USE_CASES: { title: string; body: string }[] = [
  {
    title: 'AI watermarks',
    body: 'The ✦ sparkle that Gemini, Nano Banana and other generators stamp on images — found and erased automatically.',
  },
  {
    title: 'Objects & clutter',
    body: 'Power lines, signs, trash cans, a stray hand — brush over anything you wish weren’t in the frame.',
  },
  {
    title: 'People & photobombers',
    body: 'Wipe a stranger out of the background of an otherwise perfect shot.',
  },
  {
    title: 'Text, logos & captions',
    body: 'Stock-photo overlays, captions, brand marks and stamps lift cleanly off the image.',
  },
  {
    title: 'Dates & timestamps',
    body: 'Erase the orange camera date burned into old photos.',
  },
  {
    title: 'Blemishes & spots',
    body: 'Dust, sensor spots and small skin blemishes disappear into the background.',
  },
]

export const STEPS: { n: string; title: string; body: string }[] = [
  {
    n: '01',
    title: 'Drop your image',
    body: 'Drag it in, paste from the clipboard, or pick a file. It opens instantly — nothing is uploaded.',
  },
  {
    n: '02',
    title: 'Erase what you don’t want',
    body: 'Tap ✦ detect and the watermark is found and masked for you — or brush over any object, person or text. Press erase and the model rebuilds the background behind it.',
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
    body: 'No sign-up, no credits, no daily caps. Because everything runs on your device, there are no server bills to pass on.',
  },
  {
    title: 'Studio quality',
    body: 'A MI-GAN inpainting model rebuilds real texture behind whatever you erase, instead of smearing a blur over it.',
  },
]

export const FAQ: { q: string; a: string }[] = [
  {
    q: 'Is Unmark free?',
    a: 'Yes. Unmark is completely free with no sign-up, no credits and no daily limits. Because everything runs on your own device, there are no server costs to pass on.',
  },
  {
    q: 'Can Unmark remove objects and people, not just watermarks?',
    a: 'Yes — Unmark is a full magic eraser. Brush over any object, person, sign, text or blemish and the model reconstructs the background behind it. Detecting and removing the AI watermark is just the one-tap default.',
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
    a: 'Use Unmark only on images you own or have the rights to edit. Removing watermarks or content from other people’s copyrighted work may be illegal.',
  },
]
