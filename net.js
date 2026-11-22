// Forward pass of the RL policy network in plain JS (original code, MIT). Mirrors rl/net.py exactly:
// self MLP, entity attention + pooling, two small CNNs, core MLP, heads in bot/actions.js order (target = pointer).
// Heads missing from an older checkpoint return null (the Brain then falls back to its script for that decision).
import fs from 'node:fs'
import { SELF, NENT, ENT, NTGT, LC, G, MC, MH, MW } from './obs.js'
import { HEADS } from './actions.js'

export class PolicyNet {
  constructor(W) {
    this.W = {}
    for (const [k, v] of Object.entries(W)) this.W[k] = { data: Float32Array.from(v.flat(Infinity)), shape: shapeOf(v) }
  }
  static load(file) { return file.endsWith('.bin') ? PolicyNet.loadBin(file) : new PolicyNet(JSON.parse(fs.readFileSync(file, 'utf8'))) }
  // binary weights from tools/export_bin.mjs: [u32 header bytes][JSON [name, shape, offset]][float32 data]
  static loadBin(file) {
    const buf = fs.readFileSync(file), hl = buf.readUInt32LE(0)
    const header = JSON.parse(buf.subarray(4, 4 + hl).toString())
    const start = 4 + hl + ((4 - ((4 + hl) % 4)) % 4)
    const all = new Float32Array(buf.buffer.slice(buf.byteOffset + start, buf.byteOffset + buf.length))
    const net = Object.create(PolicyNet.prototype)
    net.W = {}
    for (const [k, shape, off] of header) net.W[k] = { data: all.subarray(off, off + shape.reduce((a, b) => a * b, 1)), shape }
    return net
  }

  lin(name, x) { // y = W x + b ; W [out, in]
    const w = this.W[name + '.weight'], b = this.W[name + '.bias']
    const [O, I] = w.shape, y = new Float32Array(O)
    for (let o = 0; o < O; o++) { let s = b.data[o]; const r = o * I; for (let i = 0; i < I; i++) s += w.data[r + i] * x[i]; y[o] = s }
    return y
  }
  conv(name, x, C, H, Wd, stride) { // 3x3, padding 1, ReLU fused
    const w = this.W[name + '.weight'].data, b = this.W[name + '.bias'].data
    const O = this.W[name + '.weight'].shape[0], Ho = Math.floor((H + 2 - 3) / stride) + 1, Wo = Math.floor((Wd + 2 - 3) / stride) + 1
    // zero-padded input so the inner loops need no bounds checks
    const Hp = H + 2, Wp = Wd + 2, xp = new Float32Array(C * Hp * Wp)
    for (let c = 0; c < C; c++) for (let i = 0; i < H; i++) xp.set(x.subarray((c * H + i) * Wd, (c * H + i + 1) * Wd), (c * Hp + i + 1) * Wp + 1)
    const y = new Float32Array(O * Ho * Wo)
    for (let o = 0; o < O; o++) {
      const yo = o * Ho * Wo, bo = b[o]
      for (let k = 0; k < Ho * Wo; k++) y[yo + k] = bo
      for (let c = 0; c < C; c++) {
        const wb = (o * C + c) * 9, xc = c * Hp * Wp
        const w0 = w[wb], w1 = w[wb + 1], w2 = w[wb + 2], w3 = w[wb + 3], w4 = w[wb + 4], w5 = w[wb + 5], w6 = w[wb + 6], w7 = w[wb + 7], w8 = w[wb + 8]
        for (let i = 0; i < Ho; i++) {
          const r0 = xc + i * stride * Wp, r1 = r0 + Wp, r2 = r1 + Wp, yr = yo + i * Wo
          for (let j = 0; j < Wo; j++) {
            const q = j * stride
            y[yr + j] += w0 * xp[r0 + q] + w1 * xp[r0 + q + 1] + w2 * xp[r0 + q + 2] + w3 * xp[r1 + q] + w4 * xp[r1 + q + 1] + w5 * xp[r1 + q + 2] + w6 * xp[r2 + q] + w7 * xp[r2 + q + 1] + w8 * xp[r2 + q + 2]
          }
        }
      }
      for (let k = 0; k < Ho * Wo; k++) if (y[yo + k] < 0) y[yo + k] = 0
    }
    return { y, C: O, H: Ho, W: Wo }
  }
  cnn(prefix, x, C, H, Wd) {
    let r = this.conv(prefix + '1', x, C, H, Wd, 1)
    r = this.conv(prefix + '2', r.y, r.C, r.H, r.W, 2)
    r = this.conv(prefix + '3', r.y, r.C, r.H, r.W, 2)
    return r.y
  }

  // inputs from ObsEncoder.encode(); returns logits per head in bot/actions.js HEADS order
  linRaw(wn, bn, x) {
    const w = this.W[wn], b = this.W[bn]
    const [O, I] = w.shape, y = new Float32Array(O)
    for (let o = 0; o < O; o++) { let s = b.data[o]; const r = o * I; for (let i = 0; i < I; i++) s += w.data[r + i] * x[i]; y[o] = s }
    return y
  }
  get isLstm() { return !!this.W['lstm.weight_ih'] }

  // state: {h, c} from the previous step (LSTM only); after the call, this.lastState holds the new state.
  // heads: head list (default bot/actions.js HEADS); a target head with autoFirst puts "auto" at index 0 (bot/brain_heads.js)
  forward(e, state, heads = HEADS) {
    const relu = (v) => v.map((x) => (x > 0 ? x : 0))
    // weights wider than the self vector (trained with OBS_V2=1, run without) would read past its end -> NaN; fail loudly.
    // Narrower weights (older checkpoint, OBS_V2 inputs appended) just ignore the tail, same as load_warm's zero pad.
    const nSelf = this.W['self_fc.weight'].shape[1]
    if (nSelf > e.self.length) throw new Error(`policy expects a self vector of ${nSelf}, encoder gives ${e.self.length} (OBS_V2 mismatch?)`)
    const hs = relu(this.lin('self_fc', e.self))
    const E = this.W['ent_fc.weight'].shape[0]
    const ents = []
    for (let n = 0; n < NENT; n++) ents.push(relu(this.lin('ent_fc', e.ents.subarray(n * ENT, (n + 1) * ENT))))
    const q = ents.map((v) => this.lin('q', v)), k = ents.map((v) => this.lin('k', v)), vv = ents.map((v) => this.lin('v', v))
    const sc = 1 / Math.sqrt(E)
    const e2 = []
    for (let n = 0; n < NENT; n++) {
      const att = new Float32Array(NENT)
      let mx = -Infinity
      for (let m = 0; m < NENT; m++) { att[m] = e.mask[m] < 0.5 ? -1e9 : dot(q[n], k[m]) * sc; if (att[m] > mx) mx = att[m] }
      let sum = 0
      for (let m = 0; m < NENT; m++) { att[m] = Math.exp(att[m] - mx); sum += att[m] }
      const mixed = new Float32Array(E)
      for (let m = 0; m < NENT; m++) { const a = att[m] / sum; if (a === 0) continue; for (let d = 0; d < E; d++) mixed[d] += a * vv[m][d] }
      const o = this.lin('o', mixed)
      const r = new Float32Array(E)
      for (let d = 0; d < E; d++) r[d] = ents[n][d] + o[d]
      e2.push(relu(this.lin('ent_fc2', r)))
    }
    const mean = new Float32Array(E), maxv = new Float32Array(E)
    let cnt = 0
    for (let d = 0; d < E; d++) maxv[d] = -1e9
    for (let n = 0; n < NENT; n++) {
      if (e.mask[n] < 0.5) continue
      cnt++
      for (let d = 0; d < E; d++) { mean[d] += e2[n][d]; if (e2[n][d] > maxv[d]) maxv[d] = e2[n][d] }
    }
    for (let d = 0; d < E; d++) { mean[d] /= Math.max(cnt, 1); if (maxv[d] < 0) maxv[d] = 0 }
    const hl = relu(this.lin('local_fc', this.cnn('l', e.local, LC, G, G)))
    const hm = relu(this.lin('mini_fc', this.cnn('m', e.mini, MC, MH, MW)))
    const cat = new Float32Array(hs.length + 2 * E + hl.length + hm.length)
    cat.set(hs, 0); cat.set(mean, hs.length); cat.set(maxv, hs.length + E); cat.set(hl, hs.length + 2 * E); cat.set(hm, hs.length + 2 * E + hl.length)
    const z1 = relu(this.lin('core1', cat))
    let z
    if (this.W['lstm.weight_ih']) {
      // LSTM cell (PyTorch gate order: input, forget, cell, output)
      const Hn = this.W['lstm.weight_hh'].shape[1]
      const h0 = state?.h ?? new Float32Array(Hn), c0 = state?.c ?? new Float32Array(Hn)
      const gi = this.linRaw('lstm.weight_ih', 'lstm.bias_ih', z1), gh = this.linRaw('lstm.weight_hh', 'lstm.bias_hh', h0)
      const h = new Float32Array(Hn), c = new Float32Array(Hn)
      for (let j = 0; j < Hn; j++) {
        const ig = sig(gi[j] + gh[j]), fg = sig(gi[Hn + j] + gh[Hn + j]), gg = Math.tanh(gi[2 * Hn + j] + gh[2 * Hn + j]), og = sig(gi[3 * Hn + j] + gh[3 * Hn + j])
        c[j] = fg * c0[j] + ig * gg
        h[j] = og * Math.tanh(c[j])
      }
      this.lastState = { h, c }
      if (this.W['mem_out.weight']) {  // residual memory (train_mem.py): core2 path + mem_out(h)
        const a = relu(this.lin('core2', z1)), b = this.lin('mem_out', h)
        z = new Float32Array(a.length); for (let j = 0; j < a.length; j++) z[j] = a[j] + b[j]
      } else z = h
    } else z = relu(this.lin('core2', z1))
    const tq = this.lin('t_query', z)
    const tl = new Float32Array(NTGT + 1)
    for (let n = 0; n < NTGT; n++) tl[n] = e.tmask[n] < 0.5 ? -1e9 : dot(tq, e2[n]) * sc
    tl[NTGT] = e.tmask[NTGT] < 0.5 ? -1e9 : this.lin('t_auto', z)[0]
    return heads.map((h, i) => {
      if (h.name === 'target') { if (!h.autoFirst) return tl; const r = new Float32Array(NTGT + 1); r[0] = tl[NTGT]; r.set(tl.subarray(0, NTGT), 1); return r }
      return this.W['h_' + h.name + '.weight'] ? this.lin('h_' + h.name, z) : null
    })
  }

  // MECH_BIAS (test only): JSON {headIndex: [per-class logit offsets]} added before argmax
  act(e, state, heads) { return this.forward(e, state, heads).map((v, i) => (v ? argmax(BIAS[i] ? v.map((x, j) => x + (BIAS[i][j] || 0)) : v) : null)) }
}

function sig(x) { return 1 / (1 + Math.exp(-x)) }
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const BIAS = (() => { try { return JSON.parse(process.env.MECH_BIAS || '{}') } catch { return {} } })()
function argmax(v) { let b = 0; for (let i = 1; i < v.length; i++) if (v[i] > v[b]) b = i; return b }
function shapeOf(v) { const s = []; let x = v; while (Array.isArray(x)) { s.push(x.length); x = x[0] } return s }
