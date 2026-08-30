import { describe, it, expect } from 'vitest'
import { layoutTree, type Pt, type Size } from '../src/layout'

const size: Size = { w: 100, h: 20 }
const gaps = { h: 40, v: 10 }

describe('layoutTree', () => {
  // a → b, c ; b → d   (all cards 100×20)
  const kids: Record<string, string[]> = { a: ['b', 'c'], b: ['d'] }
  const childrenOf = (id: string): string[] => kids[id] ?? []
  const sizeOf = (): Size => size

  it('places children to the right, siblings stacked, parent centered', () => {
    const out = new Map<string, Pt>()
    const bbox = layoutTree('a', childrenOf, sizeOf, { x: 0, y: 0 }, gaps, out)
    // children band of a = b(20) + gap(10) + c(20) = 50; a centered against it → y=15
    expect(out.get('a')).toEqual({ x: 0, y: 15 })
    // depth 1 x = 0 + 100 + 40 = 140; b at band top 0, c stacked below (20+10)
    expect(out.get('b')).toEqual({ x: 140, y: 0 })
    expect(out.get('c')).toEqual({ x: 140, y: 30 })
    // depth 2 x = 140 + 100 + 40 = 280; single child centered on parent b
    expect(out.get('d')).toEqual({ x: 280, y: 0 })
    expect(bbox).toEqual({ w: 380, h: 50 })
  })

  it('honors the origin offset', () => {
    const out = new Map<string, Pt>()
    layoutTree('a', childrenOf, sizeOf, { x: 100, y: 200 }, gaps, out)
    expect(out.get('a')).toEqual({ x: 100, y: 215 })
    expect(out.get('b')).toEqual({ x: 240, y: 200 })
  })

  it('does not hang on a cycle', () => {
    const cyc: Record<string, string[]> = { x: ['y'], y: ['x'] }
    const out = new Map<string, Pt>()
    expect(() => layoutTree('x', (id) => cyc[id] ?? [], sizeOf, { x: 0, y: 0 }, gaps, out)).not.toThrow()
    expect(out.has('x')).toBe(true)
    expect(out.has('y')).toBe(true)
  })
})
