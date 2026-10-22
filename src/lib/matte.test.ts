import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MATTE_SIZE, cleanAlpha, orientPlane, outputToAlpha, toModelInput } from './matte.ts'

const N = MATTE_SIZE * MATTE_SIZE

const solid = (r: number, g: number, b: number, a: number) => {
  const px = new Uint8ClampedArray(N * 4)
  for (let i = 0; i < N; i++) px.set([r, g, b, a], i * 4)
  return px
}

test('cleanAlpha clamps the tails and smoothsteps between', () => {
  assert.equal(cleanAlpha(0), 0)
  assert.equal(cleanAlpha(0.06), 0)
  assert.equal(cleanAlpha(0.8), 1)
  assert.equal(cleanAlpha(1), 1)
  assert.ok(Math.abs(cleanAlpha(0.43) - 0.5) < 1e-9)
  for (let a = 0, prev = -1; a <= 1; a += 0.01) {
    const v = cleanAlpha(a)
    assert.ok(v >= prev)
    prev = v
  }
})

test('toModelInput normalises by the max and centres on zero, planar RGB', () => {
  const white = toModelInput(solid(255, 255, 255, 255))
  assert.equal(white.length, 3 * N)
  assert.ok(white.every((v) => v === 0.5))
  const px = solid(255, 255, 255, 255)
  px.set([255, 0, 0, 255], 0)
  const x = toModelInput(px)
  assert.equal(x[0], 0.5)
  assert.equal(x[N], -0.5)
  assert.equal(x[2 * N], -0.5)
})

test('toModelInput flattens transparent pixels on white', () => {
  const px = solid(255, 255, 255, 255)
  px.set([0, 0, 0, 0], 0)
  const x = toModelInput(px)
  assert.equal(x[0], 0.5)
  assert.equal(x[N], 0.5)
  assert.equal(x[2 * N], 0.5)
})

test('outputToAlpha min-max normalises, cleans, and packs white RGBA', () => {
  const out = new Float32Array(N).fill(0.5)
  out[0] = 0
  out[1] = 1
  const a = outputToAlpha(out)
  assert.equal(a.length, N * 4)
  assert.deepEqual([...a.subarray(0, 8)], [255, 255, 255, 0, 255, 255, 255, 255])
  assert.ok(Math.abs(a[2 * 4 + 3] - Math.round(cleanAlpha(0.5) * 255)) <= 1)
})

test('outputToAlpha on a constant map gives no subject', () => {
  const a = outputToAlpha(new Float32Array(N).fill(0.7))
  for (let i = 3; i < a.length; i += 4) if (a[i] !== 0) assert.fail(`alpha ${a[i]} at ${i}`)
})

test('orientPlane rotates and flips like orientImageData', () => {
  const p = { w: 3, h: 2, data: Uint8Array.from([1, 2, 3, 4, 5, 6]) }
  const cw = orientPlane(p, 'cw')
  assert.deepEqual([cw.w, cw.h, ...cw.data], [2, 3, 4, 1, 5, 2, 6, 3])
  const fh = orientPlane(p, 'flipH')
  assert.deepEqual([...fh.data], [3, 2, 1, 6, 5, 4])
  const back = orientPlane(cw, 'ccw')
  assert.deepEqual([back.w, back.h, ...back.data], [3, 2, 1, 2, 3, 4, 5, 6])
})
