import { readFileSync } from 'node:fs'

const STEP_UP = 1.2
const MAX_SLOPE = 0.9

export class World {
  constructor(dir, files = ['v2/world.json', 'v2/terrain.i16']) {
    const spec = JSON.parse(readFileSync(`${dir}/${files.find((f) => f.endsWith('world.json')) ?? 'v2/world.json'}`, 'utf8'))
    const T = spec.terrain
    Object.assign(this, { nx: T.nx, ny: T.ny, minX: T.minX, minY: T.minY })
    if ((T.step ?? 1) !== 1) throw new Error('terrain step not supported')
    const scale = T.scale ?? 0.01
    const buf = readFileSync(`${dir}/${files.find((f) => f.endsWith('.i16')) ?? 'v2/terrain.i16'}`)
    const n = this.nx * this.ny
    this.ground = new Float32Array(n)
    for (let i = 0; i < n; i++) this.ground[i] = buf.readInt16LE(i * 2) * scale
    const b = spec.bounds ?? { minX: this.minX, maxX: this.minX + this.nx - 1, minY: this.minY, maxY: this.minY + this.ny - 1 }
    Object.assign(this, { bMinX: b.minX, bMaxX: b.maxX, bMinY: b.minY, bMaxY: b.maxY })
    this.top = new Float32Array(this.ground)
    this.ohBase = new Float32Array(n).fill(Infinity)
    this.ohTop = new Float32Array(n).fill(-Infinity)
    for (const p of spec.prisms ?? []) {
      this.scan([p.ring, ...(p.holes ?? [])], (i) => {
        const g = this.ground[i]
        if (p.base > g + 3) {
          if (p.base < this.ohBase[i]) this.ohBase[i] = p.base
          if (p.top > this.ohTop[i]) this.ohTop[i] = p.top
        } else if (p.top > this.top[i]) this.top[i] = p.top
      })
    }
    this.clearLow = this.clearance(9.4)
    this.clearTall = this.clearance(1e9)
  }

  scan(rings, cb) {
    const { nx, ny, minX, minY } = this
    const outer = rings[0]
    let y0 = Infinity, y1 = -Infinity
    for (let k = 1; k < outer.length; k += 2) { y0 = Math.min(y0, outer[k]); y1 = Math.max(y1, outer[k]) }
    const xs = []
    for (let j = Math.max(0, Math.ceil(y0 - minY)), j1 = Math.min(ny - 1, Math.floor(y1 - minY)); j <= j1; j++) {
      const y = minY + j + 1e-4
      xs.length = 0
      for (const r of rings) {
        const m = r.length >> 1
        for (let a = 0, c = m - 1; a < m; c = a++) {
          const ya = r[2 * a + 1], yc = r[2 * c + 1]
          if (ya > y !== yc > y) xs.push(r[2 * a] + ((y - ya) / (yc - ya)) * (r[2 * c] - r[2 * a]))
        }
      }
      xs.sort((p, q) => p - q)
      for (let k = 0; k + 1 < xs.length; k += 2)
        for (let i = Math.max(0, Math.ceil(xs[k] - minX)), i1 = Math.min(nx - 1, Math.floor(xs[k + 1] - minX)); i <= i1; i++) cb(j * nx + i)
    }
  }

  clearance(mechHeight) {
    const { nx, ny, minX, minY, ground, top, ohBase } = this
    const d = new Float32Array(nx * ny)
    for (let j = 0; j < ny; j++) {
      const y = minY + j
      for (let i = 0; i < nx; i++) {
        const x = minX + i, idx = j * nx + i, g = ground[idx]
        let blocked = x < this.bMinX + 0.5 || x > this.bMaxX - 0.5 || y < this.bMinY + 0.5 || y > this.bMaxY - 0.5 || top[idx] - g > STEP_UP || ohBase[idx] - g < mechHeight + 0.5
        if (!blocked && i > 0 && i < nx - 1 && j > 0 && j < ny - 1)
          blocked = Math.max(Math.abs(ground[idx - 1] - g), Math.abs(ground[idx + 1] - g), Math.abs(ground[idx - nx] - g), Math.abs(ground[idx + nx] - g)) > MAX_SLOPE
        d[idx] = blocked ? 0 : 1e6
      }
    }
    const pass = (j0, j1, dj, i0, i1, di) => {
      for (let j = j0; j !== j1; j += dj)
        for (let i = i0; i !== i1; i += di) {
          const idx = j * nx + i
          let v = d[idx]
          if (v === 0) continue
          const pi = i - di, pj = j - dj
          if (pi >= 0 && pi < nx && d[idx - di] + 1 < v) v = d[idx - di] + 1
          if (pj >= 0 && pj < ny) {
            const r = idx - dj * nx
            if (d[r] + 1 < v) v = d[r] + 1
            if (pi >= 0 && pi < nx && d[r - di] + Math.SQRT2 < v) v = d[r - di] + Math.SQRT2
            const qi = i + di
            if (qi >= 0 && qi < nx && d[r + di] + Math.SQRT2 < v) v = d[r + di] + Math.SQRT2
          }
          d[idx] = v
        }
    }
    pass(0, ny, 1, 0, nx, 1)
    pass(ny - 1, -1, -1, nx - 1, -1, -1)
    return d
  }

  index(x, y) {
    const i = Math.min(this.nx - 1, Math.max(0, Math.round(x - this.minX)))
    const j = Math.min(this.ny - 1, Math.max(0, Math.round(y - this.minY)))
    return j * this.nx + i
  }

  groundAt(x, y) {
    let fx = x - this.minX, fy = y - this.minY
    if (fx < 0) fx = 0
    else if (fx > this.nx - 1.001) fx = this.nx - 1.001
    if (fy < 0) fy = 0
    else if (fy > this.ny - 1.001) fy = this.ny - 1.001
    const i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j, k = j * this.nx + i, g = this.ground
    return (g[k] * (1 - u) + g[k + 1] * u) * (1 - v) + (g[k + this.nx] * (1 - u) + g[k + this.nx + 1] * u) * v
  }

  topAt(x, y) { return this.top[this.index(x, y)] }

  los(x0, y0, z0, x1, y1, z1) {
    const dx = x1 - x0, dy = y1 - y0, d = Math.hypot(dx, dy)
    if (d < 4) return true
    const n = Math.ceil(d), sx = dx / n, sy = dy / n, sz = (z1 - z0) / n
    const { nx, ny, top, ohBase, ohTop } = this
    let x = x0 + sx * 2 - this.minX + 0.5, y = y0 + sy * 2 - this.minY + 0.5, z = z0 + sz * 2
    for (let k = 2; k <= n - 2; k++) {
      const i = x | 0, j = y | 0
      if (i >= 0 && i < nx && j >= 0 && j < ny) {
        const idx = j * nx + i
        if (z < top[idx] || (z > ohBase[idx] && z < ohTop[idx])) return false
      }
      x += sx; y += sy; z += sz
    }
    return true
  }
}
