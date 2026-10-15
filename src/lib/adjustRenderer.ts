// WebGL2 renderer for the whole-image adjustment. The working canvas is
// uploaded as a texture and drawn onto a GL canvas that sits above it in the
// stage; the working pixels themselves are never touched, so erase keeps
// reading the raw photo and the sliders stay re-adjustable.
//
// Pass 1 (blur/sharpen only): horizontal Gaussian, src → mid framebuffer.
// Pass 2: vertical Gaussian over mid, blur/unsharp combine, gamma → canvas.

import { adjustParams, type Adjust } from './adjust'

// A full-screen triangle from gl_VertexID — no vertex buffers.
const VERT = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

// Shared Gaussian: centre tap plus up to 64 symmetric bilinear pairs.
const GAUSS = `
uniform vec2 uStep;
uniform int uN;
uniform float uW0;
uniform float uOff[64];
uniform float uW[64];
vec4 gauss(sampler2D t, vec2 uv) {
  vec4 c = texture(t, uv) * uW0;
  for (int i = 0; i < 64; i++) {
    if (i >= uN) break;
    vec2 d = uStep * uOff[i];
    c += (texture(t, uv + d) + texture(t, uv - d)) * uW[i];
  }
  return c;
}`

const BLUR_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
${GAUSS}
in vec2 vUv;
out vec4 o;
void main() { o = gauss(uSrc, vUv); }`

// Rendering to the default framebuffer flips rows relative to the uploaded
// texture (row 0 = image top), hence the 1 - y.
const FINAL_FRAG = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform sampler2D uMid;
uniform int uMode;
uniform float uAmount;
uniform float uGamma;
${GAUSS}
in vec2 vUv;
out vec4 o;
void main() {
  vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
  vec4 s = texture(uSrc, uv);
  vec4 c = s;
  if (uMode != 0) {
    vec4 b = gauss(uMid, uv);
    c = uMode == 1 ? b : clamp(s + uAmount * (s - b), 0.0, 1.0);
    c.rgb = min(c.rgb, vec3(c.a));
  }
  // Premultiplied in, premultiplied out; the curve applies to true colour.
  if (c.a > 0.0) c.rgb = pow(c.rgb / c.a, vec3(uGamma)) * c.a;
  o = c;
}`

type Taps = { n: number; w0: number; off: Float32Array; w: Float32Array }

/** Normalised Gaussian folded into bilinear pairs: two adjacent taps i, i+1
 *  become one fetch at their weighted midpoint (exact under LINEAR filtering). */
function gaussTaps(sigma: number): Taps {
  const r = Math.min(128, Math.ceil(sigma * 3))
  const k = new Float64Array(r + 2)
  let sum = 0
  for (let i = 0; i <= r; i++) {
    k[i] = Math.exp(-(i * i) / (2 * sigma * sigma))
    sum += i === 0 ? k[i] : 2 * k[i]
  }
  const off = new Float32Array(64)
  const w = new Float32Array(64)
  let n = 0
  for (let i = 1; i <= r; i += 2) {
    const a = k[i] / sum
    const b = i + 1 <= r ? k[i + 1] / sum : 0
    w[n] = a + b
    off[n] = (i * a + (i + 1) * b) / (a + b)
    n++
  }
  return { n, w0: k[0] / sum, off, w }
}

type Program = { prog: WebGLProgram; loc: (name: string) => WebGLUniformLocation | null }

export class AdjustRenderer {
  private gl: WebGL2RenderingContext
  private blur!: Program
  private final!: Program
  private src: WebGLTexture | null = null
  private mid: WebGLTexture | null = null
  private fbo: WebGLFramebuffer | null = null
  private size = { w: 0, h: 0 }
  private midSize = { w: 0, h: 0 }
  private version = -1
  private lost = false
  private raf = 0
  private pending: { source: HTMLCanvasElement; version: number; adjust: Adjust } | null = null
  readonly maxSize: number

  private constructor(
    readonly canvas: HTMLCanvasElement,
    gl: WebGL2RenderingContext,
    private onLost: () => void,
    private onRestored: () => void
  ) {
    this.gl = gl
    this.maxSize = Math.min(
      gl.getParameter(gl.MAX_TEXTURE_SIZE) as number,
      ...(gl.getParameter(gl.MAX_VIEWPORT_DIMS) as Int32Array)
    )
    this.init()
    canvas.addEventListener('webglcontextlost', this.handleLost)
    canvas.addEventListener('webglcontextrestored', this.handleRestored)
  }

  /** Null when WebGL2 (or shader compilation) is unavailable. */
  static create(
    canvas: HTMLCanvasElement,
    onLost: () => void,
    onRestored: () => void
  ): AdjustRenderer | null {
    try {
      const gl = canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
      })
      if (!gl) return null
      return new AdjustRenderer(canvas, gl, onLost, onRestored)
    } catch {
      return null
    }
  }

  fits(d: { w: number; h: number }) {
    return d.w <= this.maxSize && d.h <= this.maxSize
  }

  get isLost() {
    return this.lost
  }

  private init() {
    const gl = this.gl
    const compile = (frag: string): Program => {
      const shader = (type: number, text: string) => {
        const s = gl.createShader(type)!
        gl.shaderSource(s, text)
        gl.compileShader(s)
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(s) ?? 'shader compile failed')
        }
        return s
      }
      const prog = gl.createProgram()!
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT))
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, frag))
      gl.linkProgram(prog)
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(prog) ?? 'program link failed')
      }
      const cache = new Map<string, WebGLUniformLocation | null>()
      return {
        prog,
        loc: (name) => {
          if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name))
          return cache.get(name)!
        },
      }
    }
    this.blur = compile(BLUR_FRAG)
    this.final = compile(FINAL_FRAG)
  }

  private handleLost = (e: Event) => {
    e.preventDefault() // allow a restore
    this.lost = true
    this.cancelPending()
    this.src = this.mid = this.fbo = null
    this.size = { w: 0, h: 0 }
    this.midSize = { w: 0, h: 0 }
    this.version = -1
    this.onLost()
  }

  private handleRestored = () => {
    try {
      this.init()
      this.lost = false
      this.onRestored()
    } catch {
      // stays lost; the editor keeps the sliders disabled
    }
  }

  private cancelPending() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.raf = 0
    this.pending = null
  }

  private newTexture() {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  private setTaps(p: Program, taps: Taps, step: [number, number]) {
    const gl = this.gl
    gl.uniform2f(p.loc('uStep'), step[0], step[1])
    gl.uniform1i(p.loc('uN'), taps.n)
    gl.uniform1f(p.loc('uW0'), taps.w0)
    gl.uniform1fv(p.loc('uOff'), taps.off)
    gl.uniform1fv(p.loc('uW'), taps.w)
  }

  /** Schedule a render for the next frame; repeated calls within a frame
   *  (slider drags) collapse into one. */
  draw(source: HTMLCanvasElement, version: number, adjust: Adjust) {
    this.pending = { source, version, adjust }
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      const p = this.pending
      this.pending = null
      if (p) this.renderNow(p.source, p.version, p.adjust)
    })
  }

  /** Render synchronously. The result is readable (drawImage of `canvas`)
   *  until the current task ends. Returns false if nothing was drawn. */
  renderNow(source: HTMLCanvasElement, version: number, adjust: Adjust): boolean {
    if (this.lost) return false
    const gl = this.gl
    const w = source.width
    const h = source.height
    if (w === 0 || h === 0 || !this.fits({ w, h })) return false

    if (!this.src || w !== this.size.w || h !== this.size.h) {
      this.canvas.width = w
      this.canvas.height = h
      this.size = { w, h }
      if (!this.src) this.src = this.newTexture()
      this.version = -1
    }
    if (version !== this.version) {
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.src)
      // Canvas pixels are premultiplied internally; keep them that way so
      // the round trip is lossless and the blur doesn't fringe at alpha edges.
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
      this.version = version
    }

    const p = adjustParams(adjust, { w, h })
    const taps = p.mode === 'none' ? null : gaussTaps(p.sigma)

    if (taps) {
      // The intermediate plane exists only while a blur is in play.
      if (!this.mid || this.midSize.w !== w || this.midSize.h !== h) {
        if (!this.mid) this.mid = this.newTexture()
        gl.bindTexture(gl.TEXTURE_2D, this.mid)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        if (!this.fbo) this.fbo = gl.createFramebuffer()
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mid, 0)
        this.midSize = { w, h }
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
      gl.viewport(0, 0, w, h)
      gl.useProgram(this.blur.prog)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, this.src)
      gl.uniform1i(this.blur.loc('uSrc'), 0)
      this.setTaps(this.blur, taps, [1 / w, 0])
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    } else if (this.mid) {
      this.releaseMid()
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    gl.useProgram(this.final.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.src)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, taps ? this.mid : this.src)
    gl.uniform1i(this.final.loc('uSrc'), 0)
    gl.uniform1i(this.final.loc('uMid'), 1)
    gl.uniform1i(this.final.loc('uMode'), p.mode === 'none' ? 0 : p.mode === 'blur' ? 1 : 2)
    gl.uniform1f(this.final.loc('uAmount'), p.amount)
    gl.uniform1f(this.final.loc('uGamma'), p.gamma)
    if (taps) this.setTaps(this.final, taps, [0, 1 / h])
    else gl.uniform1i(this.final.loc('uN'), 0)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    return true
  }

  private releaseMid() {
    const gl = this.gl
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    if (this.mid) gl.deleteTexture(this.mid)
    this.fbo = this.mid = null
    this.midSize = { w: 0, h: 0 }
  }

  /** Free GPU planes while the adjustment is neutral; the next render
   *  re-uploads. */
  release() {
    this.cancelPending()
    if (!this.lost) {
      this.releaseMid()
      if (this.src) this.gl.deleteTexture(this.src)
    }
    this.src = null
    this.size = { w: 0, h: 0 }
    this.version = -1
    this.canvas.width = 1
    this.canvas.height = 1
  }

  dispose() {
    this.release()
    this.canvas.removeEventListener('webglcontextlost', this.handleLost)
    this.canvas.removeEventListener('webglcontextrestored', this.handleRestored)
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}
