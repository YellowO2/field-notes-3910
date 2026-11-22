import { readFileSync } from 'node:fs'
import path from 'node:path'

const f32 = Math.fround
const F2_2 = f32(2.2), F3_1 = f32(3.1), F1_2 = f32(1.2), F1_4142 = f32(1.4142), F0_15 = f32(0.15), F0_01 = f32(0.01)
const GEO = 16
const BLK = 8
export const STEP_UP = 1.2
export const NAV_RADIUS = 2.6
export const nbrs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]
const N4 = nbrs.slice(0, 4)

export function goHypot(p, q) {
  p = Math.abs(p); q = Math.abs(q)
  if (p === Infinity || q === Infinity) return Infinity
  if (Number.isNaN(p) || Number.isNaN(q)) return NaN
  if (p === 0 && q === 0) return 0
  const mx = p > q ? p : q, mn = p > q ? q : p
  const r = mn / mx
  return mx * Math.sqrt(1 + r * r)
}

export function goRound(x) {
  const t = Math.trunc(x)
  return Math.abs(x - t) >= 0.5 ? t + Math.sign(x) : t
}

const PI4A = 7.85398125648498535156e-1, PI4B = 3.77489470793079817668e-8, PI4C = 2.69515142907905952645e-15
const SIN = [1.58962301576546568060e-10, -2.50507477628578072866e-8, 2.75573136213857245213e-6, -1.98412698295895385996e-4, 8.33333333332211858878e-3, -1.66666666666666307295e-1]
const COS = [-1.13585365213876817300e-11, 2.08757008419747316778e-9, -2.75573141792967388112e-7, 2.48015872888517045348e-5, -1.38888888888730564116e-3, 4.16666666666665929218e-2]
const FOUR_PI = 4 / Math.PI
const polyS = (z, zz) => z + z * zz * ((((((SIN[0] * zz) + SIN[1]) * zz + SIN[2]) * zz + SIN[3]) * zz + SIN[4]) * zz + SIN[5])
const polyC = (zz) => 1.0 - 0.5 * zz + zz * zz * ((((((COS[0] * zz) + COS[1]) * zz + COS[2]) * zz + COS[3]) * zz + COS[4]) * zz + COS[5])
function octant(x) {
  let j = Math.floor(x * FOUR_PI), y = j
  if (j % 2 === 1) { j++; y++ }
  j %= 8
  return [j, ((x - y * PI4A) - y * PI4B) - y * PI4C]
}
export function goSin(x) {
  if (x === 0 || Number.isNaN(x)) return x
  if (!Number.isFinite(x)) return NaN
  let sign = false
  if (x < 0) { x = -x; sign = true }
  if (x >= 536870912) return (sign ? -1 : 1) * Math.sin(x)
  let [j, z] = octant(x)
  if (j > 3) { sign = !sign; j -= 4 }
  const zz = z * z
  const y = j === 1 || j === 2 ? polyC(zz) : polyS(z, zz)
  return sign ? -y : y
}
export function goCos(x) {
  if (!Number.isFinite(x)) return NaN
  x = Math.abs(x)
  if (x >= 536870912) return Math.cos(x)
  let sign = false
  let [j, z] = octant(x)
  if (j > 3) { j -= 4; sign = !sign }
  if (j > 1) sign = !sign
  const zz = z * z
  const y = j === 1 || j === 2 ? polyS(z, zz) : polyC(zz)
  return sign ? -y : y
}
function xatan(x) {
  let z = x * x
  z = z * ((((-8.750608600031904122785e-01 * z + -1.615753718733365076637e+01) * z + -7.500855792314704667340e+01) * z + -1.228866684490136173410e+02) * z + -6.485021904942025371773e+01) /
    (((((z + 2.485846490142306297962e+01) * z + 1.650270098316988542046e+02) * z + 4.328810604912902668951e+02) * z + 4.853903996359136964868e+02) * z + 1.945506571482613964425e+02)
  return x * z + x
}
const MOREBITS = 6.123233995736765886130e-17
function satan(x) {
  if (x <= 0.66) return xatan(x)
  if (x > 2.41421356237309504880) return Math.PI / 2 - xatan(1 / x) + MOREBITS
  return Math.PI / 4 + xatan((x - 1) / (x + 1)) + 0.5 * MOREBITS
}
export function goAtan(x) { return x === 0 ? x : x > 0 ? satan(x) : -satan(-x) }
const PI3_4 = 2.356194490192345
export function goAtan2(y, x) {
  if (Number.isNaN(y) || Number.isNaN(x)) return NaN
  const sgn = (v, s) => (s < 0 || Object.is(s, -0) ? -Math.abs(v) : Math.abs(v))
  if (y === 0) return x >= 0 && !Object.is(x, -0) ? sgn(0, y) : sgn(Math.PI, y)
  if (x === 0) return sgn(Math.PI / 2, y)
  if (!Number.isFinite(x)) {
    if (x > 0) return !Number.isFinite(y) ? sgn(Math.PI / 4, y) : sgn(0, y)
    return !Number.isFinite(y) ? sgn(PI3_4, y) : sgn(Math.PI, y)
  }
  if (!Number.isFinite(y)) return sgn(Math.PI / 2, y)
  const q = goAtan(y / x)
  if (x < 0) return q <= 0 ? q + Math.PI : q - Math.PI
  return q
}

export function pointInPoly(e, x, y) {
  let inside = false
  for (let i = 0; i < e.length; i += 4) {
    const x0 = e[i], y0 = e[i + 1], x1 = e[i + 2], y1 = e[i + 3]
    if ((y0 > y) !== (y1 > y) && x < (x1 - x0) * (y - y0) / (y1 - y0) + x0) inside = !inside
  }
  return inside
}

function rayTrunk(cx, cy, r, z0, z1, x, y, z, dx, dy, dz, tmax) {
  const px = x - cx, py = y - cy, a = dx * dx + dy * dy
  if (a < 1e-9) return -1
  const b = 2 * (px * dx + py * dy), c = px * px + py * py - r * r, disc = b * b - 4 * a * c
  if (disc < 0) return -1
  const t = (-b - Math.sqrt(disc)) / (2 * a)
  if (t < 0 || t >= tmax) return -1
  const hz = z + dz * t
  return hz < z0 || hz > z1 ? -1 : t
}

function rayCrown(tr, x, y, z, dx, dy, dz) {
  const ox = (x - tr.cx) / tr.crownR, oy = (y - tr.cy) / tr.crownR, oz = (z - tr.cz) / tr.rz
  const ux = dx / tr.crownR, uy = dy / tr.crownR, uz = dz / tr.rz
  const a = ux * ux + uy * uy + uz * uz
  if (a < 1e-9) return null
  const b = 2 * (ox * ux + oy * uy + oz * uz), c = ox * ox + oy * oy + oz * oz - 1, disc = b * b - 4 * a * c
  if (disc <= 0) return null
  const s = Math.sqrt(disc), t0 = (-b - s) / (2 * a), t1 = (-b + s) / (2 * a)
  return t1 < 0 || t0 > 1 ? null : [t0, t1]
}

export class World {
  constructor({ minX, minY, nx, ny, bx0, bx1, by0, by1, ground }) {
    Object.assign(this, { minX, minY, nx, ny, bx0, bx1, by0, by1, ground })
    this.gen = 0
    this.heapF = []
    this.heapI = []
    this.mainNearArr = null
  }

  initGeo(prisms, trees, rules) {
    this.prisms = prisms
    this.trees = trees
    this.rules = { maxStep: rules.maxStep ?? 0, maxSlopeDeg: rules.maxSlopeDeg || 50, canopyDensity: rules.canopyDensity ?? 0, canopyBlockT: rules.canopyBlockT ?? 0 }
    if (!this.rules.canopyDensity) { this.rules.canopyDensity = 0.35; this.rules.canopyBlockT = 0.25 }
    this.maxSlopeTan = Math.tan(this.rules.maxSlopeDeg * Math.PI / 180)
    this.gx0 = this.bx0 - GEO
    this.gy0 = this.by0 - GEO
    this.gnx = Math.trunc(Math.ceil((this.bx1 - this.bx0) / GEO)) + 3
    this.gny = Math.trunc(Math.ceil((this.by1 - this.by0) / GEO)) + 3
    this.gridP = Array.from({ length: this.gnx * this.gny }, () => [])
    this.gridT = Array.from({ length: this.gnx * this.gny }, () => [])
    prisms.forEach((p, i) => this.forCells(p.minX, p.minY, p.maxX, p.maxY, (c) => this.gridP[c].push(i)))
    trees.forEach((t, i) => {
      const r = t.crownR
      this.forCells(Math.min(t.cx - r, t.x - t.trunkR), Math.min(t.cy - r, t.y - t.trunkR), Math.max(t.cx + r, t.x + t.trunkR), Math.max(t.cy + r, t.y + t.trunkR), (c) => this.gridT[c].push(i))
    })
    const bnx = Math.trunc((this.nx + 7) / 8), bny = Math.trunc((this.ny + 7) / 8)
    const bm = new Float32Array(bnx * bny).fill(-Infinity)
    for (let j = 0; j < this.ny; j++)
      for (let i = 0; i < this.nx; i++) {
        const b = Math.trunc(j / 8) * bnx + Math.trunc(i / 8), h = this.ground[j * this.nx + i]
        if (h > bm[b]) bm[b] = h
      }
    const bmax = new Float32Array(bm.length)
    for (let j = 0; j < bny; j++)
      for (let i = 0; i < bnx; i++) {
        let v = bm[j * bnx + i]
        if (i + 1 < bnx) v = Math.max(v, bm[j * bnx + i + 1])
        if (j + 1 < bny) v = Math.max(v, bm[(j + 1) * bnx + i])
        if (i + 1 < bnx && j + 1 < bny) v = Math.max(v, bm[(j + 1) * bnx + i + 1])
        bmax[j * bnx + i] = v
      }
    Object.assign(this, { bnx, bny, blockMax: bmax })
  }

  rasterize(rawPrisms) {
    const n = this.nx * this.ny, cells = new Map(), xs = []
    for (const p of rawPrisms) {
      const rings = [p.ring, ...(p.holes ?? [])]
      let minY = Infinity, maxY = -Infinity
      for (let k = 1; k < p.ring.length; k += 2) { minY = Math.min(minY, p.ring[k]); maxY = Math.max(maxY, p.ring[k]) }
      const j0 = Math.trunc(Math.ceil(minY - this.minY)), j1 = Math.trunc(Math.floor(maxY - this.minY))
      const iv = { base: f32(p.base), top: f32(p.top), bridge: p.kind === 'bridge' }
      for (let j = Math.max(j0, 0); j <= j1 && j < this.ny; j++) {
        const y = this.minY + j + 1e-4
        xs.length = 0
        for (const r of rings) {
          const m = Math.trunc(r.length / 2)
          for (let a = 0; a < m; a++) {
            const b = (a + 1) % m, x0 = r[a * 2], y0 = r[a * 2 + 1], x1 = r[b * 2], y1 = r[b * 2 + 1]
            if ((y0 <= y) !== (y1 <= y)) xs.push(x0 + (y - y0) / (y1 - y0) * (x1 - x0))
          }
        }
        xs.sort((u, v) => u - v)
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.trunc(Math.ceil(xs[k] - this.minX)), i1 = Math.trunc(Math.floor(xs[k + 1] - this.minX))
          for (let i = Math.max(i0, 0); i <= i1 && i < this.nx; i++) {
            const idx = j * this.nx + i
            let l = cells.get(idx)
            if (!l) cells.set(idx, (l = []))
            l.push(iv)
          }
        }
      }
    }
    this.top = new Float32Array(this.ground)
    this.walk = new Float32Array(this.ground)
    this.obst = new Uint8Array(n)
    this.low = new Uint8Array(n)
    this.hasSlab = new Uint8Array(n)
    this.slabs = new Map()
    for (const [idx, ivs] of cells) {
      ivs.sort((a, b) => a.base - b.base)
      const g = this.ground[idx]
      let top = g, deck = f32(-1e9), low = false
      for (const iv of ivs) {
        if (iv.top <= top) continue
        if (iv.base <= f32(top + 1.5)) { top = iv.top; continue }
        let l = this.slabs.get(idx)
        if (!l) this.slabs.set(idx, (l = []))
        l.push({ base: iv.base, top: iv.top })
        this.hasSlab[idx] = 1
        if (f32(iv.base - top) < 10.5) {
          if (iv.bridge && f32(iv.top - g) < 6.5) deck = iv.top
          else low = true
        }
      }
      this.top[idx] = top
      this.walk[idx] = deck > top ? deck : top
      this.low[idx] = low ? 1 : 0
      this.obst[idx] = f32(top - g) > F1_2 || low ? 1 : 0
    }
  }

  buildNav() {
    this.ns = 2
    this.nnx = Math.trunc((this.nx + 1) / 2)
    this.nny = Math.trunc((this.ny + 1) / 2)
    const n = this.nnx * this.nny
    this.blocked = new Uint8Array(n)
    this.surf = new Float32Array(n)
    for (let c = 0; c < n; c++) {
      const [x, y] = this.cellPos(c)
      const [z, id] = this.stackKind(x, y, true)
      this.surf[c] = z
      const roof = id >= 0 && this.prisms[id].kind !== 'bridge' && z - this.groundAt(x, y) > 1.5
      this.blocked[c] = roof || !this.standable(x, y, z, NAV_RADIUS) ? 1 : 0
    }
    const cl = (this.clearance = new Float32Array(n))
    const q = []
    for (let c = 0; c < n; c++) {
      if (this.blocked[c]) { cl[c] = 0; q.push(c) }
      else cl[c] = 1e9
    }
    for (let h = 0; h < q.length; h++) {
      const c = q[h], d = f32(cl[c] + 2)
      if (d > 20) continue
      const ci = c % this.nnx, cj = Math.trunc(c / this.nnx)
      for (const [di, dj] of N4) {
        const i = ci + di, j = cj + dj
        if (i < 0 || j < 0 || i >= this.nnx || j >= this.nny) continue
        const nb = j * this.nnx + i
        if (cl[nb] > d) { cl[nb] = d; q.push(nb) }
      }
    }
    for (let c = 0; c < n; c++) if (cl[c] > 20) cl[c] = 20
    const comp = (this.comp = new Int32Array(n))
    let label = 0, bestN = 0, bestSize = 0
    for (let c0 = 0; c0 < n; c0++) {
      if (this.blocked[c0] || comp[c0] !== 0) continue
      comp[c0] = ++label
      q.length = 0
      q.push(c0)
      for (let h = 0; h < q.length; h++) {
        const c = q[h], ci = c % this.nnx, cj = Math.trunc(c / this.nnx)
        for (const [di, dj] of N4) {
          const i = ci + di, j = cj + dj
          if (i < 0 || j < 0 || i >= this.nnx || j >= this.nny) continue
          const nb = j * this.nnx + i
          if (comp[nb] === 0 && this.canStep(c, nb, false) && this.canStep(nb, c, false)) { comp[nb] = label; q.push(nb) }
        }
      }
      if (q.length > bestSize) { bestSize = q.length; bestN = label }
    }
    this.mainComp = bestN
    this.g = new Float32Array(n)
    this.came = new Int32Array(n)
    this.stamp = new Uint32Array(n)
    this.closed = new Uint32Array(n)
  }

  vidx(x, y) {
    let i = goRound(x - this.minX), j = goRound(y - this.minY)
    if (i < 0) i = 0
    else if (i >= this.nx) i = this.nx - 1
    if (j < 0) j = 0
    else if (j >= this.ny) j = this.ny - 1
    return j * this.nx + i
  }

  inBounds(x, y) { return x > this.bx0 && x < this.bx1 && y > this.by0 && y < this.by1 }

  groundAt(x, y) {
    let fx = x - this.minX, fy = y - this.minY
    fx = Math.max(0, Math.min(fx, this.nx - 1 - 1e-6))
    fy = Math.max(0, Math.min(fy, this.ny - 1 - 1e-6))
    const i = Math.trunc(fx), j = Math.trunc(fy), tx = fx - i, ty = fy - j, G = this.ground, k = j * this.nx + i
    return (G[k] * (1 - tx) + G[k + 1] * tx) * (1 - ty) + (G[k + this.nx] * (1 - tx) + G[k + this.nx + 1] * tx) * ty
  }

  groundGradient(x, y) { return [(this.groundAt(x + 1, y) - this.groundAt(x - 1, y)) / 2, (this.groundAt(x, y + 1) - this.groundAt(x, y - 1)) / 2] }

  stackKind(x, y, deck) {
    const g = this.groundAt(x, y)
    let z = g, id = -1
    const c = this.cellOf(x, y)
    if (c < 0) return [z, id]
    const ps = this.gridP[c]
    for (let pass = 0; pass < 8; pass++) {
      let moved = false
      for (const pi of ps) {
        const p = this.prisms[pi]
        if (p.top <= z || x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue
        if (!(p.base <= z + 1.5 || (deck && p.kind === 'bridge' && p.top - g < 6.5))) continue
        if (pointInPoly(p.edges, x, y)) { z = p.top; id = pi; moved = true }
      }
      if (!moved) break
    }
    return [z, id]
  }

  walkAt(x, y) { return this.stackKind(x, y, true)[0] }
  topAt(x, y) { return this.stackKind(x, y, false)[0] }

  surfaceKind(x, y, maxZ) {
    let z = this.groundAt(x, y), id = -1
    const c = this.cellOf(x, y)
    if (c < 0) return [z, id]
    for (const pi of this.gridP[c]) {
      const p = this.prisms[pi]
      if (p.top > maxZ || p.top <= z || x < p.minX || x > p.maxX || y < p.minY || y > p.maxY || !pointInPoly(p.edges, x, y)) continue
      z = p.top; id = pi
    }
    return [z, id]
  }
  surfaceAt(x, y, maxZ) { return this.surfaceKind(x, y, maxZ)[0] }

  solid(x, y, z) {
    if (z < this.groundAt(x, y)) return true
    const c = this.cellOf(x, y)
    if (c < 0) return false
    for (const pi of this.gridP[c]) {
      const p = this.prisms[pi]
      if (z > p.base && z < p.top && x >= p.minX && x <= p.maxX && y >= p.minY && y <= p.maxY && pointInPoly(p.edges, x, y)) return true
    }
    return false
  }

  solidRaster(x, y, z) {
    const idx = this.vidx(x, y)
    if (z < this.top[idx] - 0.05) return true
    if (this.hasSlab[idx]) for (const s of this.slabs.get(idx)) if (z > s.base && z < s.top) return true
    return false
  }

  clearRaster(a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2]
    const n = Math.trunc(Math.sqrt(dx * dx + dy * dy + dz * dz) / 1.0) + 1, inv = 1 / n
    for (let k = 1; k < n; k++) {
      const t = k * inv
      if (this.solidRaster(a[0] + dx * t, a[1] + dy * t, a[2] + dz * t)) return false
    }
    return true
  }

  standable(x, y, z, r) {
    if (x < this.bx0 + r || x > this.bx1 - r || y < this.by0 + r || y > this.by1 - r) return false
    return !this.wallWithin(x, y, z, r, 9)
  }
  canStand(x, y, z, r) { return this.standable(x, y, z, r) }

  wallWithin(x, y, z, r, h) {
    const lo = z + STEP_UP, hi = z + h, r2 = r * r
    let found = false
    this.forCells(x - r, y - r, x + r, y + r, (c) => {
      if (found) return
      for (const pi of this.gridP[c]) {
        const p = this.prisms[pi]
        if (p.top <= lo || p.base >= hi || x + r < p.minX || x - r > p.maxX || y + r < p.minY || y - r > p.maxY) continue
        const e = p.edges
        for (let i = 0; i < e.length; i += 4) {
          const x0 = e[i], y0 = e[i + 1], ux = e[i + 2] - x0, uy = e[i + 3] - y0, l2 = ux * ux + uy * uy
          const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((x - x0) * ux + (y - y0) * uy) / l2)) : 0
          const mx = x0 + ux * t - x, my = y0 + uy * t - y
          if (mx * mx + my * my < r2) { found = true; return }
        }
        if (pointInPoly(e, x, y)) { found = true; return }
      }
    })
    return found
  }

  cell(x, y) {
    let ci = goRound((x - this.minX) / this.ns), cj = goRound((y - this.minY) / this.ns)
    if (ci < 0) ci = 0
    else if (ci >= this.nnx) ci = this.nnx - 1
    if (cj < 0) cj = 0
    else if (cj >= this.nny) cj = this.nny - 1
    return cj * this.nnx + ci
  }
  cellPos(c) { return [this.minX + (c % this.nnx) * this.ns, this.minY + Math.trunc(c / this.nnx) * this.ns] }
  free(x, y) { return !this.blocked[this.cell(x, y)] }

  nearestFree(c) {
    if (!this.blocked[c]) return c
    const ci = c % this.nnx, cj = Math.trunc(c / this.nnx)
    let best = -1, bestD = 1 << 30
    for (let r = 1; r <= 20; r++) {
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const i = ci + di, j = cj + dj
          if (i < 0 || j < 0 || i >= this.nnx || j >= this.nny) continue
          if (!this.blocked[j * this.nnx + i]) {
            const d = di * di + dj * dj
            if (d < bestD) { best = j * this.nnx + i; bestD = d }
          }
        }
      if (best >= 0) return best
    }
    return -1
  }

  canStep(a, b, diag) {
    if (this.blocked[b]) return false
    return f32(this.surf[b] - this.surf[a]) <= (diag ? F3_1 : F2_2)
  }

  push(f, idx) {
    const F = this.heapF, I = this.heapI
    F.push(f); I.push(idx)
    let i = F.length - 1
    while (i > 0) {
      const p = Math.trunc((i - 1) / 2)
      if (F[p] <= F[i]) break
      const tf = F[p]; F[p] = F[i]; F[i] = tf
      const ti = I[p]; I[p] = I[i]; I[i] = ti
      i = p
    }
  }

  pop() {
    const F = this.heapF, I = this.heapI
    const top = I[0], last = F.length - 1
    F[0] = F[last]; I[0] = I[last]
    F.length = last; I.length = last
    let i = 0
    for (;;) {
      const l = 2 * i + 1, r = 2 * i + 2
      let m = i
      if (l < last && F[l] < F[m]) m = l
      if (r < last && F[r] < F[m]) m = r
      if (m === i) break
      const tf = F[m]; F[m] = F[i]; F[i] = tf
      const ti = I[m]; I[m] = I[i]; I[i] = ti
      i = m
    }
    return top
  }

  path(sx, sy, gx, gy, maxExpand) {
    const s = this.nearestFree(this.cell(sx, sy)), g = this.nearestFree(this.cell(gx, gy))
    if (s < 0 || g < 0) return { path: null, reached: false }
    if (s === g) return { path: [s], reached: true }
    const gen = (this.gen = (this.gen + 1) >>> 0)
    this.heapF.length = 0
    this.heapI.length = 0
    const NNX = this.nnx, NNY = this.nny, G = this.g, came = this.came, stamp = this.stamp, closed = this.closed, ns = this.ns
    const gi = g % NNX, gj = Math.trunc(g / NNX)
    const h = (c) => {
      const dx = Math.abs((c % NNX) - gi), dy = Math.abs(Math.trunc(c / NNX) - gj)
      return f32((Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) * ns * 1.15)
    }
    G[s] = 0; came[s] = -1; stamp[s] = gen
    this.push(h(s), s)
    let best = s, bestH = h(s), found = false
    for (let n = 0; this.heapF.length > 0 && n < maxExpand; n++) {
      const c = this.pop()
      if (closed[c] === gen) continue
      closed[c] = gen
      if (c === g) { found = true; best = c; break }
      const hc = h(c)
      if (hc < bestH) { best = c; bestH = hc }
      const ci = c % NNX, cj = Math.trunc(c / NNX)
      for (let k = 0; k < 8; k++) {
        const i = ci + nbrs[k][0], j = cj + nbrs[k][1]
        if (i < 0 || j < 0 || i >= NNX || j >= NNY) continue
        const nb = j * NNX + i, diag = k >= 4
        if (closed[nb] === gen || !this.canStep(c, nb, diag)) continue
        let step = f32(ns)
        if (diag) {
          if (this.blocked[cj * NNX + i] || this.blocked[j * NNX + ci]) continue
          step = f32(step * F1_4142)
        }
        const cl = this.clearance[nb]
        if (cl < 4) step = f32(step * f32(1 + f32(f32(4 - cl) * F0_15)))
        const ng = f32(G[c] + step)
        if (stamp[nb] !== gen || ng < G[nb]) {
          G[nb] = ng; came[nb] = c; stamp[nb] = gen
          this.push(f32(ng + h(nb)), nb)
        }
      }
    }
    const out = []
    for (let c = best; c >= 0; c = came[c]) { out.push(c); if (c === s) break }
    out.reverse()
    return { path: out, reached: found }
  }

  lineWalkable(x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0, n = Math.trunc(goHypot(dx, dy) / 1.0) + 1
    let prev = this.cell(x0, y0)
    for (let k = 1; k <= n; k++) {
      const t = k / n, c = this.cell(x0 + dx * t, y0 + dy * t)
      if (c === prev) continue
      if (this.blocked[c] || f32(this.surf[c] - this.surf[prev]) > F3_1) return false
      prev = c
    }
    return true
  }

  mainNear(c) {
    if (!this.mainNearArr) {
      const n = this.nnx * this.nny, near = new Int32Array(n).fill(-1), depth = new Uint8Array(n), q = []
      for (let i = 0; i < n; i++) if (!this.blocked[i] && this.comp[i] === this.mainComp) { near[i] = i; q.push(i) }
      for (let h = 0; h < q.length; h++) {
        const c0 = q[h]
        if (depth[c0] >= 20) continue
        const ci = c0 % this.nnx, cj = Math.trunc(c0 / this.nnx)
        for (const [di, dj] of nbrs) {
          const i = ci + di, j = cj + dj
          if (i < 0 || j < 0 || i >= this.nnx || j >= this.nny) continue
          const nb = j * this.nnx + i
          if (near[nb] < 0) { near[nb] = near[c0]; depth[nb] = depth[c0] + 1; q.push(nb) }
        }
      }
      this.mainNearArr = near
    }
    return this.mainNearArr[c]
  }

  offMain(x, y) {
    const c = this.nearestFree(this.cell(x, y))
    return c < 0 || this.comp[c] !== this.mainComp
  }

  reachable(x, y) {
    const c = this.cell(x, y)
    return !this.blocked[c] && this.comp[c] === this.mainComp
  }

  escapePlan(x, y) {
    const none = { launch: [0, 0], land: [0, 0], ok: false }
    const s = this.nearestFree(this.cell(x, y))
    if (s < 0) return none
    const gen = (this.gen = (this.gen + 1) >>> 0)
    const NNX = this.nnx, NNY = this.nny, G = this.g, stamp = this.stamp, queue = [s]
    stamp[s] = gen
    G[s] = 0
    let best = -1, bestS = Infinity
    for (let h = 0; h < queue.length && h < 60000; h++) {
      const c = queue[h], ci = c % NNX, cj = Math.trunc(c / NNX)
      const m = this.mainNear(c)
      if (m >= 0) {
        const [cx, cy] = this.cellPos(c), [mx, my] = this.cellPos(m)
        const sc = G[c] * this.ns + 4 * goHypot(mx - cx, my - cy)
        if (sc < bestS) { best = c; bestS = sc }
      }
      for (let k = 0; k < 8; k++) {
        const i = ci + nbrs[k][0], j = cj + nbrs[k][1]
        if (i < 0 || j < 0 || i >= NNX || j >= NNY) continue
        const nb = j * NNX + i
        if (stamp[nb] === gen || !this.canStep(c, nb, k >= 4)) continue
        if (k >= 4 && (this.blocked[cj * NNX + i] || this.blocked[j * NNX + ci])) continue
        stamp[nb] = gen
        G[nb] = G[c] + 1
        queue.push(nb)
      }
    }
    if (best < 0) return none
    const [lx, ly] = this.cellPos(best)
    let [mx, my] = this.cellPos(this.mainNear(best))
    const d = goHypot(mx - lx, my - ly)
    if (d > 0.1) {
      const ex = mx + (mx - lx) / d * 5, ey = my + (my - ly) / d * 5
      if (this.inBounds(ex, ey) && this.reachable(ex, ey)) { mx = ex; my = ey }
    }
    return { launch: [lx, ly], land: [mx, my], ok: true }
  }

  exposure(x, y) {
    const z = this.walkAt(x, y) + 7
    let total = 0
    for (let k = 0; k < 24; k++) {
      const a = k * Math.PI / 12, c = goCos(a), s = goSin(a)
      let d = 2.5
      for (; d < 200; d += 2.5) {
        const px = x + c * d, py = y + s * d
        if (!this.inBounds(px, py) || this.solidRaster(px, py, z)) break
      }
      total += d
    }
    return total / (24 * 200)
  }

  cellOf(x, y) {
    const i = Math.trunc(Math.floor((x - this.gx0) / GEO)), j = Math.trunc(Math.floor((y - this.gy0) / GEO))
    return i < 0 || j < 0 || i >= this.gnx || j >= this.gny ? -1 : j * this.gnx + i
  }

  forCells(x0, y0, x1, y1, f) {
    const i0 = Math.max(0, Math.trunc(Math.floor((x0 - this.gx0) / GEO))), i1 = Math.min(this.gnx - 1, Math.trunc(Math.floor((x1 - this.gx0) / GEO)))
    const j0 = Math.max(0, Math.trunc(Math.floor((y0 - this.gy0) / GEO))), j1 = Math.min(this.gny - 1, Math.trunc(Math.floor((y1 - this.gy0) / GEO)))
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) f(j * this.gnx + i)
  }

  walkCells(x0, y0, x1, y1, f) {
    const dx = x1 - x0, dy = y1 - y0
    let ci = Math.trunc(Math.floor((x0 - this.gx0) / GEO)), cj = Math.trunc(Math.floor((y0 - this.gy0) / GEO))
    const ei = Math.trunc(Math.floor((x1 - this.gx0) / GEO)), ej = Math.trunc(Math.floor((y1 - this.gy0) / GEO))
    const si = dx > 0 ? 1 : -1, sj = dy > 0 ? 1 : -1
    let tdx = Infinity, tdy = Infinity, tmx = Infinity, tmy = Infinity
    if (Math.abs(dx) > 1e-9) {
      tdx = GEO / Math.abs(dx)
      tmx = dx > 0 ? ((ci + 1) * GEO + this.gx0 - x0) / Math.abs(dx) : (x0 - (ci * GEO + this.gx0)) / Math.abs(dx)
    }
    if (Math.abs(dy) > 1e-9) {
      tdy = GEO / Math.abs(dy)
      tmy = dy > 0 ? ((cj + 1) * GEO + this.gy0 - y0) / Math.abs(dy) : (y0 - (cj * GEO + this.gy0)) / Math.abs(dy)
    }
    let best = Infinity, tin = 0
    for (let k = 0; k < 4096; k++) {
      if (ci >= 0 && cj >= 0 && ci < this.gnx && cj < this.gny) best = f(cj * this.gnx + ci, tin, Math.min(1, Math.min(tmx, tmy)))
      if (ci === ei && cj === ej) return
      let t
      if (tmx < tmy) { t = tmx; tmx += tdx; ci += si }
      else { t = tmy; tmy += tdy; cj += sj }
      if (t > 1 || best < t) return
      tin = t
    }
  }

  rayPrism(pi, x, y, z, dx, dy, dz, tmax) {
    const p = this.prisms[pi]
    let t0 = 0, t1 = tmax
    const slab = (o, d, lo, hi) => {
      if (Math.abs(d) < 1e-9) return o >= lo && o <= hi
      let a = (lo - o) / d, b = (hi - o) / d
      if (a > b) { const s = a; a = b; b = s }
      t0 = Math.max(t0, a); t1 = Math.min(t1, b)
      return t0 <= t1
    }
    if (!slab(x, dx, p.minX, p.maxX) || !slab(y, dy, p.minY, p.maxY) || !slab(z, dz, p.base, p.top)) return null
    if (z >= p.base && z <= p.top && pointInPoly(p.edges, x, y)) {
      const l = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-300
      return { t: 0, x, y, z, nx: -dx / l, ny: -dy / l, nz: -dz / l, kind: p.kind, id: pi }
    }
    let hit = null, best = tmax
    const e = p.edges
    for (let i = 0; i < e.length; i += 4) {
      const ex = e[i + 2] - e[i], ey = e[i + 3] - e[i + 1], den = dx * ey - dy * ex
      if (Math.abs(den) < 1e-9) continue
      const px = e[i] - x, py = e[i + 1] - y, t = (px * ey - py * ex) / den, s = (px * dy - py * dx) / den
      if (t < 0 || t >= best || s < 0 || s > 1) continue
      const hz = z + dz * t
      if (hz < p.base || hz > p.top) continue
      const l = goHypot(ex, ey)
      best = t
      hit = { t, x: x + dx * t, y: y + dy * t, z: hz, nx: ey / l, ny: -ex / l, nz: 0, kind: p.kind, id: pi }
    }
    if (Math.abs(dz) > 1e-9) {
      for (const [cz, cn] of [[p.top, 1], [p.base, -1]]) {
        const t = (cz - z) / dz
        if (t < 0 || t >= best || (cn > 0 && dz > 0) || (cn < 0 && dz < 0)) continue
        const hx = x + dx * t, hy = y + dy * t
        if (pointInPoly(e, hx, hy)) { best = t; hit = { t, x: hx, y: hy, z: cz, nx: 0, ny: 0, nz: cn, kind: p.kind, id: pi } }
      }
    }
    return hit
  }

  rayTerrain(x, y, z, x1, y1, z1, tmax) {
    const dx = x1 - x, dy = y1 - y, dz = z1 - z, hl = goHypot(dx, dy)
    const above = (t) => z + dz * t - this.groundAt(x + dx * t, y + dy * t)
    if (above(0) < 0) return { t: 0, x, y, z, nx: 0, ny: 0, nz: 1, kind: 'terrain', id: -1 }
    const step = hl > 1e-9 ? 0.5 / hl : 1.0
    let t = 0
    for (let it = 0; t < tmax; it++) {
      if (it > 100000) return null
      const px = x + dx * t, py = y + dy * t
      const bi = Math.trunc(Math.floor((px - this.minX) / BLK)), bj = Math.trunc(Math.floor((py - this.minY) / BLK))
      const inb = bi >= 0 && bj >= 0 && bi < this.bnx && bj < this.bny
      let tb = tmax
      if (hl > 1e-9) {
        const ex = this.minX + bi * BLK, ey = this.minY + bj * BLK
        let nx = Infinity, ny = Infinity
        if (dx > 1e-9) nx = (ex + BLK - px) / dx
        else if (dx < -1e-9) nx = (ex - px) / dx
        if (dy > 1e-9) ny = (ey + BLK - py) / dy
        else if (dy < -1e-9) ny = (ey - py) / dy
        tb = Math.min(t + Math.max(0, Math.min(nx, ny)) + 1e-6, tmax)
      }
      if (inb && Math.min(z + dz * t, z + dz * tb) > this.blockMax[bj * this.bnx + bi]) { t = tb; continue }
      const s = Math.min(t + step, tmax)
      if (above(s) < 0) {
        let lo = t, hi = s
        for (let k = 0; k < 20; k++) {
          const m = (lo + hi) / 2
          if (above(m) < 0) hi = m
          else lo = m
        }
        const hx = x + dx * hi, hy = y + dy * hi, [gx, gy] = this.groundGradient(hx, hy), l = Math.sqrt(gx * gx + gy * gy + 1)
        return { t: hi, x: hx, y: hy, z: this.groundAt(hx, hy), nx: -gx / l, ny: -gy / l, nz: 1 / l, kind: 'terrain', id: -1 }
      }
      if (s >= tmax) break
      t = s
    }
    return null
  }

  raycast(a, b, o = {}) {
    const x = a[0], y = a[1], z = a[2], dx = b[0] - x, dy = b[1] - y, dz = b[2] - z
    let best = null
    const tmax = () => (best ? best.t : 1)
    const seenP = new Set(), seenT = new Set()
    this.walkCells(x, y, b[0], b[1], (c) => {
      for (const pi of this.gridP[c]) {
        if (seenP.has(pi)) continue
        seenP.add(pi)
        const h = this.rayPrism(pi, x, y, z, dx, dy, dz, tmax())
        if (h) best = h
      }
      for (const ti of this.gridT[c]) {
        if (seenT.has(ti)) continue
        seenT.add(ti)
        const tr = this.trees[ti]
        if (!o.noTrunks) {
          const t = rayTrunk(tr.x, tr.y, tr.trunkR, tr.z - 1, tr.trunkTop, x, y, z, dx, dy, dz, tmax())
          if (t >= 0) best = { t, x: x + dx * t, y: y + dy * t, z: z + dz * t, nx: 0, ny: 0, nz: 0, kind: 'trunk', id: ti }
        }
        if (o.canopy) {
          const r = rayCrown(tr, x, y, z, dx, dy, dz)
          if (r && r[0] < tmax()) {
            const t = Math.max(r[0], 0)
            best = { t, x: x + dx * t, y: y + dy * t, z: z + dz * t, nx: 0, ny: 0, nz: 0, kind: 'canopy', id: ti }
          }
        }
      }
      return tmax()
    })
    if (!o.noTerrain) {
      const h = this.rayTerrain(x, y, z, b[0], b[1], b[2], tmax())
      if (h) best = h
    }
    return best
  }

  crownMeters(a, b, limit) {
    const x = a[0], y = a[1], z = a[2], dx = b[0] - x, dy = b[1] - y, dz = b[2] - z, l = Math.sqrt(dx * dx + dy * dy + dz * dz)
    let sum = 0
    this.walkCells(x, y, b[0], b[1], (c, c0, c1) => {
      for (const ti of this.gridT[c]) {
        const r = rayCrown(this.trees[ti], x, y, z, dx, dy, dz)
        if (r) {
          const t0 = Math.max(r[0], c0), t1 = Math.min(r[1], c1)
          if (t1 > t0) sum += (t1 - t0) * l
        }
      }
      return sum > limit ? -1 : 1
    })
    return sum
  }

  canopyTransmittance(a, b) { return Math.exp(-this.rules.canopyDensity * this.crownMeters(a, b, Infinity)) }

  lineOfSight(a, b) {
    if (this.anyHit(a, b, true)) return false
    const lim = -Math.log(this.rules.canopyBlockT) / this.rules.canopyDensity
    return this.crownMeters(a, b, lim) <= lim
  }

  shotClear(a, b) { return !this.anyHit(a, b, false) }
  clear(a, b) { return !this.anyHit(a, b, false) }

  anyHit(a, b, trunks) {
    const x = a[0], y = a[1], z = a[2], dx = b[0] - x, dy = b[1] - y, dz = b[2] - z
    const seenP = [], seenT = []
    let hit = false
    this.walkCells(x, y, b[0], b[1], (c) => {
      for (const pi of this.gridP[c]) {
        if (seenP.includes(pi)) continue
        if (seenP.length < 64) seenP.push(pi)
        if (this.rayPrism(pi, x, y, z, dx, dy, dz, 1)) { hit = true; return -1 }
      }
      if (trunks) {
        for (const ti of this.gridT[c]) {
          if (seenT.includes(ti)) continue
          if (seenT.length < 64) seenT.push(ti)
          const tr = this.trees[ti]
          if (rayTrunk(tr.x, tr.y, tr.trunkR, tr.z - 1, tr.trunkTop, x, y, z, dx, dy, dz, 1) >= 0) { hit = true; return -1 }
        }
      }
      return 1
    })
    return hit || this.rayTerrain(x, y, z, b[0], b[1], b[2], 1) !== null
  }

  inCanopy(x, y, z) {
    const c = this.cellOf(x, y)
    if (c < 0) return -1
    for (const ti of this.gridT[c]) {
      const t = this.trees[ti], a = (x - t.cx) / t.crownR, b = (y - t.cy) / t.crownR, d = (z - t.cz) / t.rz
      if (a * a + b * b + d * d <= 1) return ti
    }
    return -1
  }
}

const lowerKeys = (o) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k.toLowerCase(), v]))

export function loadWorld(dir) {
  const wj = JSON.parse(readFileSync(path.join(dir, 'v2', 'world.json'), 'utf8'))
  const tb = readFileSync(path.join(dir, 'v2', 'terrain.i16'))
  const T = lowerKeys(wj.terrain), B = lowerKeys(wj.bounds)
  const nx = Math.trunc(T.nx ?? 0), ny = Math.trunc(T.ny ?? 0), n = nx * ny
  if (tb.length < n * 2 || n === 0) throw new Error('terrain size mismatch')
  const ground = new Float32Array(n)
  for (let i = 0; i < n; i++) ground[i] = f32(tb.readInt16LE(i * 2) * F0_01)
  const w = new World({ minX: T.minx ?? 0, minY: T.miny ?? 0, nx, ny, bx0: B.minx ?? 0, bx1: B.maxx ?? 0, by0: B.miny ?? 0, by1: B.maxy ?? 0, ground })
  const raw = (wj.prisms ?? []).map((p0) => {
    const p = lowerKeys(p0)
    return { kind: p.kind ?? '', base: p.base ?? 0, top: p.top ?? 0, ring: p.ring ?? [], holes: p.holes ?? [] }
  })
  const prisms = raw.map((p) => {
    const q = { kind: p.kind, base: p.base, top: p.top, minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
    const edges = []
    for (const r of [p.ring, ...p.holes]) {
      const m = Math.trunc(r.length / 2)
      for (let a = 0; a < m; a++) {
        const b = (a + 1) % m
        edges.push(r[a * 2], r[a * 2 + 1], r[b * 2], r[b * 2 + 1])
        q.minX = Math.min(q.minX, r[a * 2]); q.maxX = Math.max(q.maxX, r[a * 2])
        q.minY = Math.min(q.minY, r[a * 2 + 1]); q.maxY = Math.max(q.maxY, r[a * 2 + 1])
      }
    }
    q.edges = Float64Array.from(edges)
    return q
  })
  const trees = []
  const tr = lowerKeys(wj.trees), fields = tr.fields ?? [], data = tr.data ?? [], nf = fields.length
  if (nf > 0) {
    const col = new Map(fields.map((f, i) => [f, i]))
    const get = (row, name, def) => (col.has(name) ? row[col.get(name)] : def)
    for (let k = 0; k + nf <= data.length; k += nf) {
      const row = data.slice(k, k + nf)
      const t = { x: get(row, 'x', 0), y: get(row, 'y', 0), z: get(row, 'z', 0), height: get(row, 'height', 0), crownR: get(row, 'crownR', 1), crownBase: get(row, 'crownBase', 0), trunkR: get(row, 'trunkR', 0) }
      t.cx = get(row, 'crownX', t.x)
      t.cy = get(row, 'crownY', t.y)
      const cb = t.z + t.crownBase, top = t.z + t.height
      t.trunkTop = t.z + Math.max(t.crownBase + 0.5 * (t.height - t.crownBase), 3)
      t.cz = (cb + top) / 2
      t.rz = Math.max((top - cb) / 2, 0.5)
      trees.push(t)
    }
  }
  const R = lowerKeys(wj.rules)
  const rules = { maxStep: R.maxstep || 1.5, maxSlopeDeg: R.maxslopedeg ?? 0, canopyDensity: R.canopydensity ?? 0, canopyBlockT: R.canopyblockt ?? 0 }
  w.initGeo(prisms, trees, rules)
  w.rasterize(raw)
  w.buildNav()
  return w
}

export function flatWorld() {
  const nx = 1070, ny = 724
  const w = new World({ minX: -513, minY: -334, nx, ny, bx0: -512, bx1: 555, by0: -333, by1: 388, ground: new Float32Array(nx * ny) })
  w.initGeo([], [], { maxStep: 1.5 })
  w.top = new Float32Array(nx * ny)
  w.walk = new Float32Array(nx * ny)
  w.obst = new Uint8Array(nx * ny)
  w.low = new Uint8Array(nx * ny)
  w.hasSlab = new Uint8Array(nx * ny)
  w.slabs = new Map()
  w.buildNav()
  return w
}
