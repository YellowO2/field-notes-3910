const CELL = 2

export class Nav {
  constructor(w) {
    this.w = w
    this.gnx = Math.floor((w.nx - 1) / CELL) + 1
    this.gny = Math.floor((w.ny - 1) / CELL) + 1
    const n = this.gnx * this.gny
    this.clear = w.clearLow
    this.need = 3.0
    this.now = 0
    this.lastPartial = false
    this.g = new Float32Array(n)
    this.par = new Int32Array(n)
    this.stamp = new Uint32Array(n)
    this.done = new Uint32Array(n)
    this.gen = 0
    this.hNode = new Int32Array(1 << 20)
    this.hKey = new Float32Array(1 << 20)
    this.hn = 0
    this.tmp = new Float32Array(n).fill(-1)
    this.comp = new Int32Array(n).fill(-1)
    this.mainComp = 0
    this.nearCache = new Map()
    this.q = new Int32Array(n)
    this.qd = new Int32Array(n)
    this.label()
    this.nearTo(this.mainComp)
  }

  *around(c, diag = null) {
    const { gnx, gny } = this
    const ci = c % gnx, cj = (c - ci) / gnx
    for (let dj = -1; dj <= 1; dj++) {
      const nj = cj + dj
      if (nj < 0 || nj >= gny) continue
      for (let di = -1; di <= 1; di++) {
        const ni = ci + di
        if ((di === 0 && dj === 0) || ni < 0 || ni >= gnx) continue
        if (diag && di !== 0 && dj !== 0 && !(diag(cj * gnx + ni) && diag(nj * gnx + ci))) continue
        yield nj * gnx + ni
      }
    }
  }

  label() {
    const { comp, q } = this
    const n = this.gnx * this.gny
    const ok = (c) => this.cellClear(c) >= 3.05
    let id = 0, bestSize = 0
    for (let s = 0; s < n; s++) {
      if (comp[s] !== -1 || !ok(s)) continue
      let head = 0, tail = 0
      q[tail++] = s
      comp[s] = id
      while (head < tail) {
        for (const nb of this.around(q[head++], ok)) {
          if (comp[nb] !== -1 || !ok(nb)) continue
          comp[nb] = id
          q[tail++] = nb
        }
      }
      if (tail < 12) { for (let k = 0; k < tail; k++) comp[q[k]] = -2; continue }
      if (tail > bestSize) { bestSize = tail; this.mainComp = id }
      id++
    }
    for (let c = 0; c < n; c++) if (comp[c] === -2) comp[c] = -1
  }

  ringSearch(x, y, maxRing, accept, score) {
    const c0 = this.cellOf(x, y)
    if (accept(c0)) return c0
    const ci0 = c0 % this.gnx, cj0 = (c0 - ci0) / this.gnx
    for (let r = 1; r <= maxRing; r++) {
      let best = -1, bd = Infinity
      for (let dj = -r; dj <= r; dj++) {
        const cj = cj0 + dj
        if (cj < 0 || cj >= this.gny) continue
        const edge = dj === -r || dj === r
        for (let di = -r; di <= r; di += edge ? 1 : 2 * r) {
          const ci = ci0 + di
          if (ci < 0 || ci >= this.gnx) continue
          const c = cj * this.gnx + ci
          if (!accept(c)) continue
          const dd = score(ci, cj, di, dj)
          if (dd < bd) { bd = dd; best = c }
        }
      }
      if (best >= 0) return best
    }
    return -1
  }

  nearComp(x, y, maxRing) { return this.ringSearch(x, y, maxRing, (c) => this.comp[c] >= 0, (ci, cj, di, dj) => di * di + dj * dj) }

  areaAt(x, y, maxRing = 4) {
    const c = this.nearComp(x, y, maxRing)
    return c < 0 ? -1 : this.comp[c]
  }

  nearestWalkable(x, y, maxRing) {
    return this.ringSearch(x, y, maxRing, (c) => this.walkable(c), (ci, cj) => {
      const dx = this.w.minX + ci * CELL - x, dy = this.w.minY + cj * CELL - y
      return dx * dx + dy * dy
    })
  }

  nearTo(target) {
    let near = this.nearCache.get(target)
    if (near) return near
    const { comp, q, qd } = this
    const n = this.gnx * this.gny
    near = new Int32Array(n).fill(-1)
    let head = 0, tail = 0
    for (let c = 0; c < n; c++) if (comp[c] === target) { near[c] = c; qd[c] = 0; q[tail++] = c }
    while (head < tail) {
      const c = q[head++]
      if (qd[c] >= 20) continue
      for (const nb of this.around(c)) {
        if (near[nb] >= 0) continue
        near[nb] = near[c]
        qd[nb] = qd[c] + 1
        q[tail++] = nb
      }
    }
    this.nearCache.set(target, near)
    return near
  }

  jetCost(cx, cy, mx, my) {
    const w = this.w
    const gap = Math.hypot(mx - cx, my - cy), g0 = w.groundAt(cx, cy)
    let rise = w.groundAt(mx, my) - g0
    const k = Math.max(1, Math.ceil(gap))
    for (let i = 0; i <= k; i++) {
      const idx = w.index(cx + ((mx - cx) * i) / k, cy + ((my - cy) * i) / k)
      rise = Math.max(rise, w.top[idx] - g0)
      if (w.ohBase[idx] < 1e8) return null
    }
    return { e: 1.5 * (Math.max(0, rise) + 3) + 1.3 * gap + 8, rise }
  }

  hopPlan(x, y, target, maxEnergy = 92) {
    const s = this.nearComp(x, y, 5)
    if (s < 0) return null
    const { comp, q, qd, stamp, gnx } = this
    const mine = comp[s]
    if (mine === target) return null
    const near = this.nearTo(target)
    const gen = ++this.gen
    let head = 0, tail = 0
    q[tail++] = s
    qd[s] = 0
    stamp[s] = gen
    let best = -1, bestScore = Infinity, bestE = 0, bestRise = 0
    const same = (c) => comp[c] === mine
    while (head < tail && head < 90000) {
      const c = q[head++]
      const walk = qd[c] * CELL
      if (walk * 0.5 >= bestScore) break
      const m = near[c]
      if (m >= 0) {
        const j = this.jetCost(this.cellX(c), this.cellY(c), this.cellX(m), this.cellY(m))
        if (j && j.e <= maxEnergy && walk * 0.5 + j.e < bestScore) { bestScore = walk * 0.5 + j.e; best = c; bestE = j.e; bestRise = j.rise }
      }
      for (const nb of this.around(c, same)) {
        if (stamp[nb] === gen || !same(nb)) continue
        stamp[nb] = gen
        qd[nb] = qd[c] + 1
        q[tail++] = nb
      }
    }
    if (best < 0) return null
    const lx = this.cellX(best), ly = this.cellY(best), m = near[best]
    let tx = this.cellX(m), ty = this.cellY(m)
    const d = Math.hypot(tx - lx, ty - ly)
    if (d > 0.1) {
      const ex = tx + ((tx - lx) / d) * 4, ey = ty + ((ty - ly) / d) * 4
      if (comp[this.cellOf(ex, ey)] === target) { tx = ex; ty = ey }
    }
    return { lx, ly, tx, ty, energy: bestE, rise: bestRise }
  }

  cellOf(x, y) {
    const ci = Math.min(this.gnx - 1, Math.max(0, Math.round((x - this.w.minX) / CELL)))
    const cj = Math.min(this.gny - 1, Math.max(0, Math.round((y - this.w.minY) / CELL)))
    return cj * this.gnx + ci
  }
  cellX(c) { return this.w.minX + (c % this.gnx) * CELL }
  cellY(c) { return this.w.minY + Math.floor(c / this.gnx) * CELL }
  cellClear(c) {
    const ci = c % this.gnx
    return this.clear[((c - ci) / this.gnx) * CELL * this.w.nx + ci * CELL]
  }
  walkable(c) { return this.tmp[c] <= this.now && this.cellClear(c) >= this.need }
  clearAt(x, y) { return this.clear[this.w.index(x, y)] }
  free(x, y, slack = 0) { return this.clear[this.w.index(x, y)] >= this.need - slack && this.tmp[this.cellOf(x, y)] <= this.now }

  segOk(x0, y0, x1, y1, slack = 0.35) {
    const dx = x1 - x0, dy = y1 - y0, n = Math.max(1, Math.ceil(Math.hypot(dx, dy))), lim = this.need - slack
    for (let k = 1; k <= n; k++) {
      const x = x0 + (dx * k) / n, y = y0 + (dy * k) / n
      if (this.clear[this.w.index(x, y)] < lim || this.tmp[this.cellOf(x, y)] > this.now) return false
    }
    return true
  }

  block(x, y, r, until) {
    const c0 = this.cellOf(x, y), ci0 = c0 % this.gnx, cj0 = (c0 - ci0) / this.gnx, rr = Math.ceil(r / CELL)
    for (let dj = -rr; dj <= rr; dj++)
      for (let di = -rr; di <= rr; di++) {
        const ci = ci0 + di, cj = cj0 + dj
        if (ci < 0 || cj < 0 || ci >= this.gnx || cj >= this.gny || di * di + dj * dj > rr * rr) continue
        const c = cj * this.gnx + ci
        if (this.tmp[c] < until) this.tmp[c] = until
      }
  }

  clearBlocks() { this.tmp.fill(-1) }

  push(node, key) {
    if (this.hn >= this.hNode.length) return
    const hN = this.hNode, hK = this.hKey
    let i = this.hn++
    while (i > 0) {
      const p = (i - 1) >> 1
      if (hK[p] <= key) break
      hN[i] = hN[p]; hK[i] = hK[p]; i = p
    }
    hN[i] = node; hK[i] = key
  }

  pop() {
    const hN = this.hNode, hK = this.hKey, top = hN[0], n = --this.hn
    if (n > 0) {
      const node = hN[n], key = hK[n]
      let i = 0
      for (;;) {
        let c = 2 * i + 1
        if (c >= n) break
        if (c + 1 < n && hK[c + 1] < hK[c]) c++
        if (hK[c] >= key) break
        hN[i] = hN[c]; hK[i] = hK[c]; i = c
      }
      hN[i] = node; hK[i] = key
    }
    return top
  }

  findPath(sx, sy, gx, gy, maxExpand = 45000) {
    this.lastPartial = false
    const s = this.nearestWalkable(sx, sy, 10), e = this.nearestWalkable(gx, gy, 14)
    if (s < 0 || e < 0) return []
    const { gnx, gny, g, par, stamp, done, clear, need, now, tmp } = this
    const wnx = this.w.nx, soft = need + 3
    const ei = e % gnx, ej = (e - ei) / gnx
    const gen = ++this.gen
    const cl = (i, j) => clear[j * CELL * wnx + i * CELL]
    this.hn = 0
    g[s] = 0; par[s] = -1; stamp[s] = gen
    this.push(s, 0)
    let best = s, bestH = Infinity, expanded = 0, found = false
    while (this.hn > 0) {
      const cur = this.pop()
      if (done[cur] === gen) continue
      done[cur] = gen
      if (cur === e) { found = true; break }
      if (++expanded > maxExpand) break
      const ci = cur % gnx, cj = (cur - ci) / gnx, gc = g[cur]
      for (let dj = -1; dj <= 1; dj++) {
        const nj = cj + dj
        if (nj < 0 || nj >= gny) continue
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue
          const ni = ci + di
          if (ni < 0 || ni >= gnx) continue
          const nb = nj * gnx + ni
          if (done[nb] === gen) continue
          const c = cl(ni, nj)
          if (c < need || tmp[nb] > now) continue
          const diag = di !== 0 && dj !== 0
          if (diag && (cl(ni, cj) < need || cl(ci, nj) < need || tmp[cj * gnx + ni] > now || tmp[nj * gnx + ci] > now)) continue
          const ng = gc + (diag ? 2.8284 : 2) * (1 + (c < soft ? (soft - c) * 0.12 : 0))
          if (stamp[nb] === gen && ng >= g[nb]) continue
          g[nb] = ng; par[nb] = cur; stamp[nb] = gen
          const ax = Math.abs(ni - ei), ay = Math.abs(nj - ej)
          const h = 2 * (ax > ay ? ax + 0.4142 * ay : ay + 0.4142 * ax)
          if (h < bestH) { bestH = h; best = nb }
          this.push(nb, ng + h * 1.15)
        }
      }
    }
    let end = e
    if (!found) {
      this.lastPartial = true
      end = best
      if (end === s) return []
    }
    const cells = []
    for (let c = end; c >= 0; c = par[c]) { cells.push(c); if (cells.length > 20000) break }
    const out = []
    for (let k = cells.length - 1; k >= 0; k--) out.push(this.cellX(cells[k]), this.cellY(cells[k]))
    if (found) out.push(gx, gy)
    return out
  }
}
