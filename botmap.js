// Map model for the bot (original code, MIT): terrain raster, prism solids rasterized to cells,
// line-of-sight checks and a ground-level navigation grid with A*.
import fs from 'node:fs'
import path from 'node:path'

export class BotMap {
  constructor(dir) {
    const world = JSON.parse(fs.readFileSync(path.join(dir, 'v2/world.json'), 'utf8'))
    const T = world.terrain
    const buf = fs.readFileSync(path.join(dir, 'v2', T.file))
    const raw = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2)
    this.T = T
    this.h = new Float32Array(raw.length)
    for (let i = 0; i < raw.length; i++) this.h[i] = raw[i] * T.scale
    this.bounds = world.bounds
    // solids raster: 1 m cells over the terrain grid; up to two solid spans per cell
    this.nx = T.nx; this.ny = T.ny; this.x0 = T.minX; this.y0 = T.minY
    const N = this.nx * this.ny
    this.lo0 = new Float32Array(N).fill(NaN); this.hi0 = new Float32Array(N).fill(NaN)
    this.lo1 = new Float32Array(N).fill(NaN); this.hi1 = new Float32Array(N).fill(NaN)
    this.pid = new Int16Array(N).fill(-1)
    world.prisms.forEach((p, id) => this.rasterPrism(p, id))
    this.buildNav()
  }

  ground(x, y) {
    const T = this.T
    let fx = (x - T.minX) / T.step, fy = (y - T.minY) / T.step
    fx = fx < 0 ? 0 : fx > T.nx - 1.000001 ? T.nx - 1.000001 : fx
    fy = fy < 0 ? 0 : fy > T.ny - 1.000001 ? T.ny - 1.000001 : fy
    const i = fx | 0, j = fy | 0, s = fx - i, t = fy - j, k = j * T.nx + i, h = this.h
    return (h[k] * (1 - s) + h[k + 1] * s) * (1 - t) + (h[k + T.nx] * (1 - s) + h[k + T.nx + 1] * s) * t
  }

  rasterPrism(p, id) {
    const loops = [p.ring, ...p.holes]
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (let k = 0; k < p.ring.length; k += 2) { minX = Math.min(minX, p.ring[k]); maxX = Math.max(maxX, p.ring[k]); minY = Math.min(minY, p.ring[k + 1]); maxY = Math.max(maxY, p.ring[k + 1]) }
    const i0 = Math.max(0, Math.floor(minX - this.x0)), i1 = Math.min(this.nx - 1, Math.ceil(maxX - this.x0))
    const j0 = Math.max(0, Math.floor(minY - this.y0)), j1 = Math.min(this.ny - 1, Math.ceil(maxY - this.y0))
    for (let j = j0; j <= j1; j++) {
      const y = this.y0 + j + 0.5
      // scanline crossings
      const xs = []
      for (const l of loops) {
        const n = l.length / 2
        for (let a = 0; a < n; a++) {
          const b = (a + 1) % n, ax = l[2 * a], ay = l[2 * a + 1], bx = l[2 * b], by = l[2 * b + 1]
          if ((ay > y) !== (by > y)) xs.push(ax + ((y - ay) * (bx - ax)) / (by - ay))
        }
      }
      xs.sort((a, b) => a - b)
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const ia = Math.max(i0, Math.ceil(xs[q] - this.x0 - 0.5)), ib = Math.min(i1, Math.floor(xs[q + 1] - this.x0 - 0.5))
        for (let i = ia; i <= ib; i++) this.addSpan(j * this.nx + i, p.base, p.top, id)
      }
    }
  }

  addSpan(k, lo, hi, id) {
    if (isNaN(this.lo0[k])) { this.lo0[k] = lo; this.hi0[k] = hi; this.pid[k] = id; return }
    // merge overlapping, else keep as second span (keep the two most relevant: lowest and highest)
    if (lo <= this.hi0[k] + 0.01 && hi >= this.lo0[k] - 0.01) { this.lo0[k] = Math.min(lo, this.lo0[k]); this.hi0[k] = Math.max(hi, this.hi0[k]); if (hi >= this.hi0[k]) this.pid[k] = id; return }
    if (isNaN(this.lo1[k])) { if (lo < this.lo0[k]) { this.lo1[k] = this.lo0[k]; this.hi1[k] = this.hi0[k]; this.lo0[k] = lo; this.hi0[k] = hi } else { this.lo1[k] = lo; this.hi1[k] = hi } return }
    this.lo1[k] = Math.min(this.lo1[k], lo); this.hi1[k] = Math.max(this.hi1[k], hi)
  }

  cellIdx(x, y) {
    const i = Math.floor(x - this.x0), j = Math.floor(y - this.y0)
    if (i < 0 || j < 0 || i >= this.nx || j >= this.ny) return -1
    return j * this.nx + i
  }

  solidAt(x, y, z) {
    if (z < this.ground(x, y)) return true
    const k = this.cellIdx(x, y)
    if (k < 0) return true
    return (z >= this.lo0[k] && z <= this.hi0[k]) || (z >= this.lo1[k] && z <= this.hi1[k])
  }

  // highest standing surface at (x, y) at or below maxZ
  surface(x, y, maxZ = Infinity) {
    let z = this.ground(x, y)
    const k = this.cellIdx(x, y)
    if (k < 0) return z
    if (this.hi0[k] <= maxZ && this.hi0[k] > z) z = this.hi0[k]
    if (this.hi1[k] <= maxZ && this.hi1[k] > z) z = this.hi1[k]
    return z
  }

  // straight segment clear of terrain and prisms (sampled every `step` m)
  los(ax, ay, az, bx, by, bz, step = 0.7) {
    const d = Math.hypot(bx - ax, by - ay, bz - az)
    const n = Math.max(1, Math.ceil(d / step))
    for (let s = 1; s < n; s++) {
      const t = s / n
      if (this.solidAt(ax + (bx - ax) * t, ay + (by - ay) * t, az + (bz - az) * t)) return false
    }
    return true
  }

  // ---------------- navigation (2 m cells, ground level)
  buildNav() {
    const C = 2
    this.C = C
    this.gnx = Math.ceil(this.nx / C); this.gny = Math.ceil(this.ny / C)
    const N = this.gnx * this.gny
    this.pass = new Uint8Array(N); this.gz = new Float32Array(N)
    // blocked 1 m cells: solid span overlapping the body band above standing height
    const blocked = new Uint8Array(this.nx * this.ny)
    for (let k = 0; k < blocked.length; k++) {
      const i = k % this.nx, j = (k / this.nx) | 0
      const g = this.h[k]
      const stand = Math.max(g, this.hi0[k] <= g + 1.2 ? this.hi0[k] : g)
      const lo = stand + 1.2, hi = stand + 9
      if ((this.hi0[k] > lo && this.lo0[k] < hi) || (this.hi1[k] > lo && this.lo1[k] < hi)) blocked[k] = 1
      else {
        // steep terrain
        if (i > 0 && j > 0 && i < this.nx - 1 && j < this.ny - 1) {
          const gx = (this.h[k + 1] - this.h[k - 1]) / 2, gy = (this.h[k + this.nx] - this.h[k - this.nx]) / 2
          if (Math.hypot(gx, gy) > 1.19) blocked[k] = 1
        }
      }
    }
    // dilate by body radius (2.5 m -> 3 cells)
    const R = 3
    for (let gj = 0; gj < this.gny; gj++)
      for (let gi = 0; gi < this.gnx; gi++) {
        const cx = gi * C + 1, cy = gj * C + 1
        let ok = cx > 30 && cy > 30 && cx < this.nx - 30 && cy < this.ny - 30
        for (let dj = -R; dj <= R && ok; dj++)
          for (let di = -R; di <= R && ok; di++) {
            if (di * di + dj * dj > R * R + 1) continue
            const i = cx + di, j = cy + dj
            if (i < 0 || j < 0 || i >= this.nx || j >= this.ny || blocked[j * this.nx + i]) ok = false
          }
        const k = gj * this.gnx + gi
        this.pass[k] = ok ? 1 : 0
        this.gz[k] = this.surface(this.x0 + cx, this.y0 + cy, this.h[Math.min(this.ny - 1, cy) * this.nx + Math.min(this.nx - 1, cx)] + 1.2)
      }
    this.gScore = new Float32Array(N); this.came = new Int32Array(N); this.mark = new Uint32Array(N); this.done = new Uint32Array(N); this.gen = 0
  }

  navCell(x, y) {
    const i = Math.floor((x - this.x0) / this.C), j = Math.floor((y - this.y0) / this.C)
    if (i < 0 || j < 0 || i >= this.gnx || j >= this.gny) return -1
    return j * this.gnx + i
  }
  navCenter(k) { return [this.x0 + (k % this.gnx) * this.C + 1, this.y0 + Math.floor(k / this.gnx) * this.C + 1] }

  nearestPass(x, y, maxR = 10) {
    const k0 = this.navCell(x, y)
    if (k0 >= 0 && this.pass[k0]) return k0
    const ci = Math.floor((x - this.x0) / this.C), cj = Math.floor((y - this.y0) / this.C)
    for (let r = 1; r <= maxR; r++)
      for (let dj = -r; dj <= r; dj++)
        for (let di = -r; di <= r; di++) {
          if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue
          const i = ci + di, j = cj + dj
          if (i < 0 || j < 0 || i >= this.gnx || j >= this.gny) continue
          if (this.pass[j * this.gnx + i]) return j * this.gnx + i
        }
    return -1
  }

  // A* with optional per-cell extra cost fn(k) (e.g. danger). Returns waypoints or null.
  path(ax, ay, bx, by, { cost, maxExpand = 30000 } = {}) {
    const s = this.nearestPass(ax, ay), t = this.nearestPass(bx, by)
    if (s < 0 || t < 0) return null
    if (s === t) return [[bx, by]]
    const gen = ++this.gen, nx = this.gnx, C = this.C
    const tx = t % nx, ty = (t / nx) | 0
    const h = (k) => { const dx = Math.abs((k % nx) - tx), dy = Math.abs(((k / nx) | 0) - ty); return (Math.max(dx, dy) + 0.4142 * Math.min(dx, dy)) * C }
    const heap = new Heap()
    this.gScore[s] = 0; this.mark[s] = gen; this.came[s] = -1; heap.push(s, h(s))
    let found = false, expanded = 0
    while (heap.n) {
      const k = heap.pop()
      if (this.done[k] === gen) continue
      this.done[k] = gen
      if (k === t) { found = true; break }
      if (++expanded > maxExpand) break
      const ki = k % nx, kj = (k / nx) | 0
      for (let d = 0; d < 8; d++) {
        const di = DI[d], dj = DJ[d], i = ki + di, j = kj + dj
        if (i < 0 || j < 0 || i >= nx || j >= this.gny) continue
        const n = j * nx + i
        if (!this.pass[n] || this.done[n] === gen) continue
        if (di && dj && (!this.pass[kj * nx + i] || !this.pass[j * nx + ki])) continue
        if (this.gz[n] - this.gz[k] > 2.4) continue
        const g = this.gScore[k] + DC[d] * C + (cost ? cost(n) : 0)
        if (this.mark[n] !== gen || g < this.gScore[n]) { this.mark[n] = gen; this.gScore[n] = g; this.came[n] = k; heap.push(n, g + h(n)) }
      }
    }
    if (!found) return null
    const cells = []
    for (let k = t; k !== -1; k = this.came[k]) cells.push(k)
    cells.reverse()
    const pts = cells.map((k) => this.navCenter(k))
    const out = []
    let a = 0
    while (a < pts.length - 1) {
      let b = Math.min(pts.length - 1, a + 40)
      while (b > a + 1 && !this.clearWalk(pts[a], pts[b])) b--
      out.push(pts[b]); a = b
    }
    if (out.length) out[out.length - 1] = [bx, by]
    return out
  }

  clearWalk(p, q) {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]), n = Math.ceil(d / 1)
    let zp = null
    for (let s = 0; s <= n; s++) {
      const k = this.navCell(p[0] + ((q[0] - p[0]) * s) / n, p[1] + ((q[1] - p[1]) * s) / n)
      if (k < 0 || !this.pass[k]) return false
      if (zp != null && this.gz[k] - zp > 1.6) return false
      zp = this.gz[k]
    }
    return true
  }
}

const DI = [1, -1, 0, 0, 1, 1, -1, -1], DJ = [0, 0, 1, -1, 1, -1, 1, -1], DC = [1, 1, 1, 1, 1.4142, 1.4142, 1.4142, 1.4142]

class Heap {
  constructor() { this.k = []; this.p = []; this.n = 0 }
  push(key, pri) {
    let i = this.n++
    while (i > 0) { const par = (i - 1) >> 1; if (this.p[par] <= pri) break; this.k[i] = this.k[par]; this.p[i] = this.p[par]; i = par }
    this.k[i] = key; this.p[i] = pri
  }
  pop() {
    const top = this.k[0], last = --this.n
    if (last > 0) {
      const key = this.k[last], pri = this.p[last]
      let i = 0
      for (;;) { let c = 2 * i + 1; if (c >= last) break; if (c + 1 < last && this.p[c + 1] < this.p[c]) c++; if (this.p[c] >= pri) break; this.k[i] = this.k[c]; this.p[i] = this.p[c]; i = c }
      this.k[i] = key; this.p[i] = pri
    }
    return top
  }
}
