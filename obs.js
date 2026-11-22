// Observation encoder for the RL policy (original code, MIT). Turns one obs + the bot's memory into:
//   self  : Float32Array(SELF)            my state, zone, time
//   ents  : Float32Array(NENT * ENT)      entity list (enemies, drones, bullets, loot), egocentric
//   mask  : Float32Array(NENT)            1 = slot used
//   tmask : Float32Array(NTGT + 1)        valid target choices (enemy slots 0..NTGT-1, last = "auto")
//   tids  : array of enemy ids for the target slots
//   local : Float32Array(LC * G * G)      24x24 grid around me, rotated to my facing (5 m cells)
//   mini  : Float32Array(MC * MH * MW)    whole-map minimap, north up
// Egocentric frame: +u = where I aim (forward), +v = to my left.
import { MOVE_DIRS, LOOK_OFFS, LOOK_OBJ, PITCHES } from './actions.js'
export const G = 24, CELL = 5, LC = 5
export const MW = 32, MH = 22, MC = 6
export const UPGRADES = ['plating', 'armor', 'servos', 'capacitor', 'reactor', 'jets', 'nanites', 'gyros', 'sensors', 'gun_damage', 'gun_rate', 'gun_velocity', 'gun_mag', 'mortar_splash', 'mortar_reload', 'mortar_velocity', 'laser_charge', 'laser_damage', 'laser_pierce', 'lightning_chain', 'lightning_range', 'lightning_efficiency']
const UPMAX = [3, 3, 3, 3, 3, 2, 2, 2, 2, 3, 3, 2, 2, 2, 3, 2, 2, 3, 1, 2, 2, 2]
// appended (v4): damage direction 3, previous action 12, clock 6, recent sounds 8 x 7; (v5) helper path directions 4 x 4
export const NSND = 8
// previous-action input is off by default: with it, imitation scored 1.42 vs 2.88 without (the network learned to
// repeat itself). NO_PREV=0 turns it back on.
const NO_PREV = typeof process === 'undefined' || process.env?.NO_PREV !== '0'
export const OFFER_COL = 35 + UPGRADES.length // 57
export const NENT = 24, ENT = 24, NTGT = 8, SELF = 35 + UPGRADES.length + 1 + 3 * UPGRADES.length + 3 + 12 + 6 + NSND * 7 + 4 * 4
const WEAP = ['gun', 'mortar', 'laser', 'lightning']
const SND_FIRE = new Set(['gun', 'mortar', 'laser', 'laser_charge', 'lightning', 'npc_gun']), SND_MOVE = new Set(['step', 'boost', 'jet'])
const TYPES = ['enemy', 'npc', 'bullet', 'shell', 'pickup', 'cube', 'crate', 'drop']

export class ObsEncoder {
  constructor(map) {
    this.map = map
    const B = map.bounds
    this.mx0 = B.minX; this.my0 = B.minY
    this.mcw = (B.maxX - B.minX) / MW; this.mch = (B.maxY - B.minY) / MH
    // static minimap channel: tallest structure height above ground per cell (sampled)
    this.staticMini = new Float32Array(MH * MW)
    for (let j = 0; j < MH; j++)
      for (let i = 0; i < MW; i++) {
        let best = 0
        for (let a = 0; a < 6; a++)
          for (let b = 0; b < 6; b++) {
            const x = this.mx0 + (i + (a + 0.5) / 6) * this.mcw, y = this.my0 + (j + (b + 0.5) / 6) * this.mch
            best = Math.max(best, map.surface(x, y) - map.ground(x, y))
          }
        this.staticMini[j * MW + i] = Math.min(best / 30, 2)
      }
  }

  encode(obs, brain) {
    // bring the bot's memory up to date with this observation first (idempotent), so the features never lag a tick
    // behind: imitation data was recorded after observe(), while play/eval encoded before the Brain acted
    if (brain?.observe) brain.observe(obs)
    const me = obs.self, t = obs.t, z = obs.zone, map = this.map
    const [px, py, pz] = me.pos
    const yaw = me.aim[0], cy = Math.cos(yaw), sy = Math.sin(yaw)
    const ego = (x, y) => { const dx = x - px, dy = y - py; return [dx * cy + dy * sy, -dx * sy + dy * cy] }
    const egoV = (vx, vy) => [vx * cy + vy * sy, -vx * sy + vy * cy]

    // ---------------- self
    const s = new Float32Array(SELF)
    let k = 0
    const W = me.weapons
    s[k++] = me.hp / me.max_hp; s[k++] = me.max_hp / 2500; s[k++] = me.energy / Math.max(1, me.max_energy); s[k++] = Math.min(me.cubes, 15) / 15
    for (let slot = 0; slot < 2; slot++) for (const w of WEAP) s[k++] = W[slot] && W[slot].kind === w ? 1 : 0
    const laser = W.find((w) => w && w.kind === 'laser'), gun = W.find((w) => w && w.kind === 'gun')
    s[k++] = laser ? Math.min(1, laser.charge / laser.stats.charge) : 0
    s[k++] = laser ? Math.min(1, laser.cooldown / 1.65) : 0
    s[k++] = gun ? (gun.reload > 0 ? 0 : gun.ammo / gun.stats.mag) : 0
    s[k++] = (px - this.mx0) / (this.mcw * MW) * 2 - 1; s[k++] = (py - this.my0) / (this.mch * MH) * 2 - 1; s[k++] = pz / 30
    const [vu, vv] = egoV(me.vel[0], me.vel[1])
    s[k++] = vu / 20; s[k++] = vv / 20; s[k++] = me.vel[2] / 10
    s[k++] = Math.cos(yaw); s[k++] = Math.sin(yaw); s[k++] = me.aim[1]
    s[k++] = me.grounded ? 1 : 0; s[k++] = me.in_zone ? 1 : 0
    const dz = Math.hypot(px - z.center[0], py - z.center[1]), dn = Math.hypot(px - z.next_center[0], py - z.next_center[1])
    s[k++] = clamp((z.radius - dz) / 100, -2, 2); s[k++] = clamp((z.next_radius - dn) / 100, -2, 2)
    s[k++] = clamp((z.shrink_start - t) / 60, -1, 2); s[k++] = clamp((z.shrink_end - t) / 60, -1, 2); s[k++] = z.dps / 260
    s[k++] = obs.alive / 16; s[k++] = t / 480
    const recent = brain.recentAttackers ? [...brain.recentAttackers.values()].filter((tt) => t - tt < 3).length : 0
    s[k++] = Math.min(recent, 4) / 4; s[k++] = t - (brain.lastDamage?.t ?? -99) < 1 ? 1 : 0
    // upgrade counts (k = 35..56), offer flag at k = 57 (rl/net.py OFFER_COL), then the pending offer's 3 choices
    const up = me.upgrades ?? []
    UPGRADES.forEach((u, j) => { s[k++] = up.filter((x) => x === u).length / UPMAX[j] })
    s[k++] = obs.offer ? 1 : 0
    for (let c = 0; c < 3; c++) {
      const ch = obs.offer?.choices?.[c]
      for (const u of UPGRADES) s[k++] = ch && ch.id === u ? 1 : 0
    }
    // direction of the last hit (ego frame) and its age
    const ld = brain.lastDamage, ldAge = t - (ld?.t ?? -99)
    if (ldAge < 5) { s[k++] = Math.cos(ld.bearing - yaw); s[k++] = Math.sin(ld.bearing - yaw); s[k++] = 1 - ldAge / 5 } else k += 3
    // previous action (what this bot was told to do last decision)
    const C = NO_PREV ? {} : (brain.ctrl ?? {}) // NO_PREV=1: previous-action input switched off (copycat test)
    if (C.move >= 1 && C.move <= MOVE_DIRS) { const r = (C.move - 1) * 2 * Math.PI / MOVE_DIRS; s[k++] = Math.cos(r); s[k++] = Math.sin(r); s[k++] = 1 } else k += 3
    s[k++] = C.move > MOVE_DIRS ? 1 : 0; s[k++] = (C.slow ?? 0) / 2
    s[k++] = C.look > 0 && C.look < LOOK_OBJ ? clamp(LOOK_OFFS[C.look] / 0.8, -4, 4) : 0
    s[k++] = !C.look ? 1 : 0; s[k++] = C.look === LOOK_OBJ ? 1 : 0
    s[k++] = C.look > 0 && C.look < LOOK_OBJ ? (PITCHES[C.pitch ?? 0] ?? 0) : 0
    s[k++] = C.fire?.[0] ? 1 : 0; s[k++] = C.fire?.[1] ? 1 : 0; s[k++] = C.boost ? 1 : 0
    // clock at a few rates (lets the policy keep rhythms such as a view sweep)
    for (const f of [0.5, 1.3, 3]) { s[k++] = Math.sin(t * f); s[k++] = Math.cos(t * f) }
    // most recent sounds (heard within 4 s): ego bearing, age, distance bucket, kind group
    const snd = (brain.sounds ?? []).filter((x) => t - x.t < 4).slice(-NSND).reverse()
    for (let j = 0; j < NSND; j++) {
      const x = snd[j]
      if (!x) { k += 7; continue }
      s[k++] = Math.cos(x.bearing - yaw); s[k++] = Math.sin(x.bearing - yaw); s[k++] = 1 - (t - x.t) / 4
      s[k++] = x.dist === 'near' ? 0.33 : x.dist === 'mid' ? 0.66 : 1
      const g = SND_FIRE.has(x.kind) ? 0 : SND_MOVE.has(x.kind) ? 1 : 2
      s[k++] = g === 0 ? 1 : 0; s[k++] = g === 1 ? 1 : 0; s[k++] = g === 2 ? 1 : 0
    }

    // path to each movement helper's goal (zone, loot, cover, nearest foe): ego direction of the next waypoint, length
    const nav = brain.navInfo ? brain.navInfo(obs) : [null, null, null, null]
    for (const n of nav) {
      if (!n) { k += 4; continue }
      s[k++] = Math.cos(n.dir - yaw); s[k++] = Math.sin(n.dir - yaw); s[k++] = Math.min(n.len, 400) / 400; s[k++] = 1
    }
    if (k !== SELF) throw new Error(`self vector size ${k} != ${SELF}`)
    // ---------------- entities
    const ents = new Float32Array(NENT * ENT), mask = new Float32Array(NENT), tmask = new Float32Array(NTGT + 1)
    const tids = []
    const rows = []
    const mz = pz + (me.stats?.muzzle_height ?? 7)
    const foes = [...(brain.enemies?.values() ?? [])].filter((e) => t - e.t < 8)
      .sort((a, b) => Math.hypot(a.pos[0] - px, a.pos[1] - py) - Math.hypot(b.pos[0] - px, b.pos[1] - py))
    for (const e of foes.slice(0, NTGT)) {
      const size = 1 + 0.05 * (e.cubes ?? 0)
      const lof = e.seenNow && map.los(px, py, mz, e.pos[0], e.pos[1], e.pos[2] + 4.5 * size) ? 1 : 0
      const bearingToMe = Math.atan2(py - e.pos[1], px - e.pos[0])
      const ws = new Set(e.weapons ?? [])
      rows.push({ type: 'enemy', pos: e.pos, vel: e.vel ?? [0, 0, 0], extra: [e.hp / Math.max(1, e.maxHp), e.maxHp / 2500, Math.min(e.cubes ?? 0, 15) / 15,
        ws.has('laser') ? 1 : 0, ws.has('lightning') ? 1 : 0, ws.has('mortar') ? 1 : 0, e.charging ? 1 : 0,
        e.aim ? Math.cos(bearingToMe - e.aim[0]) : 0, e.seenNow ? 1 : 0, Math.min(t - e.t, 8) / 8, lof] })
      tids.push(e.id)
    }
    const near = (arr) => arr.slice().sort((a, b) => Math.hypot(a.pos[0] - px, a.pos[1] - py) - Math.hypot(b.pos[0] - px, b.pos[1] - py))
    // drones, loot and cubes come from memory (seen recently), with age and a visible-now flag
    const visN = new Set(obs.mechs.filter((x) => x.kind === 'npc').map((x) => x.id))
    const visP = new Set(obs.pickups.map((x) => x.id)), visC = new Set(obs.cubes.map((x) => x.id))
    const npcMem = brain.npcs ? [...brain.npcs.entries()].map(([id, n]) => ({ id, ...n })) : obs.mechs.filter((x) => x.kind === 'npc').map((n) => ({ ...n, t }))
    for (const n of near(npcMem).slice(0, 4)) rows.push({ type: 'npc', pos: n.pos, vel: n.vel ?? [0, 0, 0], extra: [n.hp / 350, Math.min(t - n.t, 25) / 25, visN.has(n.id) ? 1 : 0] })
    for (const p of obs.projectiles.slice(0, 4)) rows.push({ type: p.kind === 'mortar' ? 'shell' : 'bullet', pos: p.pos, vel: p.vel, extra: [] })
    const pickMem = brain.pickMem ? [...brain.pickMem.entries()].map(([id, p]) => ({ id, ...p })) : obs.pickups.map((p) => ({ ...p, t }))
    for (const p of near(pickMem.filter((q) => q.kind !== 'gun')).slice(0, 3)) rows.push({ type: 'pickup', pos: p.pos, vel: [0, 0, 0], extra: [0, 0, 0, p.kind === 'laser' ? 1 : 0, p.kind === 'lightning' ? 1 : 0, p.kind === 'mortar' ? 1 : 0, Math.min(t - p.t, 40) / 40, visP.has(p.id) ? 1 : 0] })
    const cubeMem = brain.cubeMem ? [...brain.cubeMem.entries()].map(([id, c]) => ({ id, ...c })) : obs.cubes.map((c) => ({ ...c, t }))
    for (const c of near(cubeMem).slice(0, 3)) rows.push({ type: 'cube', pos: c.pos, vel: [0, 0, 0], extra: [Math.min(t - c.t, 40) / 40, visC.has(c.id) ? 1 : 0] })
    for (const c of near(obs.crates).slice(0, 1)) rows.push({ type: 'crate', pos: c.pos, vel: [0, 0, 0], extra: [c.hp / 300] })
    for (const d of obs.drops.slice(0, 1)) rows.push({ type: 'drop', pos: d.pos, vel: [0, 0, 0], extra: [Math.min(d.lands_in, 25) / 25, d.progress / d.capture_s, d.holder == null ? 0 : d.holder === me.id ? 1 : -1] })
    rows.slice(0, NENT).forEach((r, i) => {
      const o = i * ENT
      mask[i] = 1
      ents[o + TYPES.indexOf(r.type)] = 1
      const [u, v] = ego(r.pos[0], r.pos[1]), [ru, rv] = egoV(r.vel[0], r.vel[1])
      const d = Math.hypot(u, v)
      ents[o + 8] = u / 100; ents[o + 9] = v / 100; ents[o + 10] = (r.pos[2] - pz) / 20; ents[o + 11] = Math.min(d, 300) / 300
      ents[o + 12] = ru / 20; ents[o + 13] = rv / 20
      r.extra.forEach((x, j) => { if (14 + j < ENT) ents[o + 14 + j] = x })
    })
    for (let i = 0; i < tids.length; i++) tmask[i] = 1
    tmask[NTGT] = 1

    // ---------------- local grid (egocentric, rotated)
    const local = new Float32Array(LC * G * G)
    const GG = G * G, half = G / 2
    for (let j = 0; j < G; j++)
      for (let i = 0; i < G; i++) {
        const u = (j - half + 0.5) * CELL, v = (i - half + 0.5) * CELL // row j = forward distance, col i = left offset
        const x = px + u * cy - v * sy, y = py + u * sy + v * cy
        const c = j * G + i
        local[c] = clamp((map.surface(x, y, pz + 40) - pz) / 10, -2, 3)
        const nk = map.navCell(x, y)
        local[GG + c] = nk >= 0 && map.pass[nk] ? 1 : 0
        local[3 * GG + c] = Math.hypot(x - z.center[0], y - z.center[1]) <= z.radius ? 1 : Math.hypot(x - z.next_center[0], y - z.next_center[1]) <= z.next_radius ? 0.5 : 0
      }
    const stamp = (ch, x, y, val) => {
      const [u, v] = ego(x, y)
      const j = Math.floor(u / CELL + half), i = Math.floor(v / CELL + half)
      if (i >= 0 && j >= 0 && i < G && j < G) local[ch * GG + j * G + i] = Math.max(local[ch * GG + j * G + i], val)
    }
    for (const e of foes) stamp(2, e.pos[0], e.pos[1], e.seenNow ? 1 : 0.5 * (1 - Math.min(t - e.t, 8) / 8))
    for (const p of obs.projectiles) stamp(4, p.pos[0], p.pos[1], 1)

    // ---------------- minimap (north up)
    const mini = new Float32Array(MC * MH * MW)
    const MM = MH * MW
    mini.set(this.staticMini, 0)
    // zone layers are identical for every agent at a given moment: compute once per zone state
    const zk = `${z.center[0]},${z.center[1]},${z.radius},${z.next_center[0]},${z.next_center[1]},${z.next_radius}`
    if (this.zoneKey !== zk) {
      this.zoneKey = zk
      this.zoneLayers = new Float32Array(2 * MM)
      for (let j = 0; j < MH; j++)
        for (let i = 0; i < MW; i++) {
          const x = this.mx0 + (i + 0.5) * this.mcw, y = this.my0 + (j + 0.5) * this.mch, c = j * MW + i
          this.zoneLayers[c] = Math.hypot(x - z.center[0], y - z.center[1]) <= z.radius ? 1 : 0
          this.zoneLayers[MM + c] = Math.hypot(x - z.next_center[0], y - z.next_center[1]) <= z.next_radius ? 1 : 0
        }
    }
    mini.set(this.zoneLayers, MM)
    const mstamp = (ch, x, y, val) => {
      const i = Math.floor((x - this.mx0) / this.mcw), j = Math.floor((y - this.my0) / this.mch)
      if (i >= 0 && j >= 0 && i < MW && j < MH) mini[ch * MM + j * MW + i] = Math.max(mini[ch * MM + j * MW + i], val)
    }
    mstamp(3, px, py, 1)
    for (const e of brain.enemies?.values() ?? []) mstamp(4, e.pos[0], e.pos[1], Math.max(0.05, 1 - (t - e.t) / 12))
    for (const d of obs.drops) mstamp(5, d.pos[0], d.pos[1], 1)

    return { self: s, ents, mask, tmask, tids, local, mini }
  }
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }
