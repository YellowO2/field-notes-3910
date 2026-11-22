import { World } from './world.js'
import { Nav } from './nav.js'

export const TAU = Math.PI * 2
export const wrap = (a) => {
  if (!Number.isFinite(a)) return 0
  a = a % TAU
  if (a > Math.PI) a -= TAU
  else if (a <= -Math.PI) a += TAU
  return a
}
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v)
const dist2 = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by)

export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function interceptTime(dx, dy, dz, vx, vy, vz, s) {
  const a = vx * vx + vy * vy + vz * vz - s * s
  const b = 2 * (dx * vx + dy * vy + dz * vz)
  const c = dx * dx + dy * dy + dz * dz
  if (Math.abs(a) < 1e-9) {
    if (Math.abs(b) < 1e-9) return -1
    const t = -c / b
    return t > 0 ? t : -1
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return -1
  const sq = Math.sqrt(disc)
  const t1 = (-b - sq) / (2 * a), t2 = (-b + sq) / (2 * a)
  const lo = Math.min(t1, t2), hi = Math.max(t1, t2)
  return lo > 1e-6 ? lo : hi > 1e-6 ? hi : -1
}

function lowArcPitch(d, dz, v, g) {
  if (d < 1e-3) return null
  const v2 = v * v
  const disc = v2 * v2 - g * (g * d * d + 2 * dz * v2)
  if (disc < 0) return null
  return Math.atan2(v2 - Math.sqrt(disc), g * d)
}

const WEAPON_VALUE = { laser: 4, lightning: 2.4, gun: 2, mortar: 1.2 }
const UPGRADE_ORDER = ['plating', 'nanites', 'armor', 'servos', 'laser_damage', 'gun_damage', 'jets', 'reactor', 'capacitor', 'gun_rate', 'laser_charge',
  'lightning_efficiency', 'lightning_range', 'lightning_chain', 'gun_mag', 'gun_velocity', 'gyros', 'sensors', 'laser_pierce', 'mortar_reload', 'mortar_splash', 'mortar_velocity']
const ALERT_SOUNDS = new Set(['step', 'boost', 'reload', 'jet', 'laser_charge', 'lightning', 'gun'])
const NDIR = 16
const DIRX = Float64Array.from({ length: NDIR }, (_, i) => Math.cos((i * TAU) / NDIR))
const DIRY = Float64Array.from({ length: NDIR }, (_, i) => Math.sin((i * TAU) / NDIR))

export class Pilot {
  constructor(hello, shared) {
    this.cfg = hello.config
    this.world = shared?.world ?? new World(hello.map.dir, hello.map.files)
    this.nav = shared?.nav ?? new Nav(this.world)
    this.rng = mulberry32((hello.seed ^ 0x9e3779b9) >>> 0)
    this.mode = 'init'
    this.tracks = new Map()
    this.pickups = new Map()
    this.crates = new Map()
    this.cubes = new Map()
    this.ignore = new Map()
    this.hurtBy = new Map()
    this.path = []
    this.pathI = 0
    this.pathGX = NaN
    this.pathGY = NaN
    this.pathT = -1e9
    this.pathPartial = false
    this.replan = false
    this.hx = new Float64Array(12)
    this.hy = new Float64Array(12)
    this.hWant = new Uint8Array(12)
    this.hN = 0
    this.stuckCount = 0
    this.jumpUntil = -1
    this.lastStuckT = -1e9
    this.targetId = -1
    this.strafe = 1
    this.strafeFlipT = 0
    this.evading = false
    this.coverX = NaN
    this.coverY = NaN
    this.coverT = -1e9
    this.coverPeek = false
    this.ffa = false
    this.myKills = 0
    this.chaseId = -1
    this.chaseBest = Infinity
    this.chaseT = 0
    this.alertYaw = 0
    this.alertUntil = -1
    this.lastHurtT = -1e9
    this.lastHurtBy = -1
    this.lastMechHurtT = -1e9
    this.lastThreatT = -1e9
    this.lastSawTargetT = -1e9
    this.hop = { plan: null, planT: -1e9, target: -1, fly: false, flyT: 0, fails: 0, ban: -1e9, startT: -1e9, seenT: -1e9, walkBest: Infinity, walkT: 0, walkX: 0, walkY: 0 }
    this.scanStartT = 0
    this.scanUntil = 1.8
    this.scanYaw0 = NaN
    this.nextScanT = 12
    this.lastDX = 0
    this.lastDY = 0
    this.idleX = NaN
    this.idleY = NaN
    this.idleKey = ''
    this.zKey = NaN
    this.zHoldR = NaN
    this.zSame = 0
    this.zStatic = false
    this.ctl = { stance: 0, target: -1, range: 1 }
  }

  act(obs) {
    const me = obs.self, S = me.stats
    const radius = S.radius ?? this.cfg.mech.radius ?? 2.5
    const height = S.height ?? this.cfg.mech.height ?? 9
    this.nav.now = obs.t
    this.nav.need = radius + 0.55
    this.nav.clear = height > 10.8 ? this.world.clearTall : this.world.clearLow
    this.remember(obs)
    const out = {}
    if (obs.offer) out.pick = this.pickUpgrade(obs)
    const c = this.assess(obs, radius, height)
    const goal = this.chooseGoal(obs, c)
    this.mode = goal.why
    if (this.jet(obs, c, goal, out)) this.mode = 'hop'
    else this.move(obs, c, goal, out)
    this.aimAndFire(obs, c, out)
    this.loot(obs, c, out)
    this.ctx = c
    return out
  }

  remember(obs) {
    const t = obs.t, me = obs.self, [x, y, z] = me.pos, cfg = this.cfg
    const mechR = cfg.mech.radius ?? 2.5, mechH = cfg.mech.height ?? 9
    for (const m of obs.mechs) {
      const cubes = m.cubes ?? 0, npc = m.kind === 'npc'
      const scale = 1 + (Number(cfg.cubes.size_per_cube) || 0) * cubes
      this.tracks.set(m.id, {
        id: m.id, kind: m.kind, x: m.pos[0], y: m.pos[1], z: m.pos[2], vx: m.vel[0], vy: m.vel[1], vz: m.vel[2], yaw: m.aim[0],
        hp: m.hp ?? m.max_hp ?? 1400, maxHp: m.max_hp ?? 1400, cubes, weapons: m.weapons ?? [], charging: !!m.charging, seen: t,
        r: npc ? (cfg.npc.radius ?? 1.8) : mechR * scale, h: npc ? (cfg.npc.height ?? 3.5) : mechH * scale, phantom: false,
      })
    }
    const guess = (id, px, py, weapon, fresh) => {
      const k = this.tracks.get(id)
      if (k && t - k.seen <= fresh) return
      const weapons = k?.weapons.length ? (k.weapons.includes(weapon) ? k.weapons : [...k.weapons, weapon]) : [weapon]
      this.tracks.set(id, {
        id, kind: 'mech', x: px, y: py, z: this.world.groundAt(px, py), vx: 0, vy: 0, vz: 0, yaw: Math.atan2(y - py, x - px),
        hp: k?.hp ?? 1400, maxHp: k?.maxHp ?? 1400, cubes: k?.cubes ?? 0, weapons, charging: false, seen: t, r: mechR, h: mechH, phantom: true,
      })
    }
    for (const b of obs.beams ?? []) if (b.by !== me.id && b.path?.length) guess(b.by, b.path[0][0], b.path[0][1], b.kind, 0.5)
    for (const [id, k] of this.tracks) if (t - k.seen > 25) this.tracks.delete(id)

    const eyeZ = z + (me.stats.eye_height ?? 8)
    const refresh = (mem, list, ttl) => {
      const now = new Set()
      for (const it of list) {
        now.add(it.id)
        mem.set(it.id, { id: it.id, x: it.pos[0], y: it.pos[1], z: it.pos[2], kind: it.kind ?? '', hp: it.hp ?? 0, seen: t, roof: it.pos[2] - this.world.groundAt(it.pos[0], it.pos[1]) > 2.5 })
      }
      for (const [id, it] of mem) {
        if (now.has(id)) continue
        if (t - it.seen > ttl || (dist2(x, y, it.x, it.y) < 38 && t - it.seen > 0.4 && this.world.los(x, y, eyeZ, it.x, it.y, it.z + 1))) mem.delete(id)
      }
    }
    refresh(this.pickups, obs.pickups, 150)
    refresh(this.crates, obs.crates, 150)
    refresh(this.cubes, obs.cubes, 60)

    for (const e of obs.events) {
      if (e.type === 'damaged') {
        if (e.weapon === 'zone') continue
        this.lastHurtT = t
        this.lastHurtBy = e.by ?? -1
        if (e.bearing == null) continue
        this.alertYaw = e.bearing
        this.alertUntil = t + 2.5
        if (e.by != null && e.by >= 0 && e.by < 100) {
          this.lastMechHurtT = t
          this.hurtBy.set(e.by, t)
          const k = this.tracks.get(e.by)
          const D = k ? clamp(dist2(x, y, k.x, k.y), 30, 250) : e.weapon === 'lightning' ? 35 : 110
          guess(e.by, x + Math.cos(e.bearing) * D, y + Math.sin(e.bearing) * D, e.weapon, 1)
        }
      } else if (e.type === 'took') this.pickups.delete(e.id)
      else if (e.type === 'take_failed') {
        if (e.reason === 'gone') this.pickups.delete(e.id)
        else this.ignore.set(e.id, t + (e.reason === 'range' ? 1 : 20))
      } else if (e.type === 'kill') {
        this.tracks.delete(e.target)
        this.myKills++
      }
    }
    if (!this.ffa && (cfg.match.mechs ?? 16) - obs.alive - this.myKills >= 3) this.ffa = true
    if (this.alertUntil < t) {
      const s = obs.sounds.find((s) => s.dist === 'near' && ALERT_SOUNDS.has(s.kind))
      if (s) { this.alertYaw = s.bearing; this.alertUntil = t + 1.5 }
    }
    const zn = obs.zone
    if (zn.shrink_end !== this.zKey) {
      this.zKey = zn.shrink_end
      this.zHoldR = zn.radius
      this.zSame = 0
      this.zStatic = false
    } else if (t > zn.shrink_start + 0.3 && t < zn.shrink_end - 0.3 && Math.abs(zn.radius - zn.next_radius) > 0.5) {
      if (Math.abs(zn.radius - this.zHoldR) < 1e-3) { if (++this.zSame >= 3) this.zStatic = true }
      else { this.zSame = 0; this.zStatic = false }
    }
  }

  zoneAt(obs, tt) {
    const z = obs.zone
    let f = 0
    if (tt > z.shrink_start && z.shrink_end > z.shrink_start) {
      if (this.zStatic) f = clamp((tt - z.shrink_start) / (z.shrink_end - z.shrink_start), 0, 1)
      else {
        const t0 = Math.max(obs.t, z.shrink_start)
        f = z.shrink_end > t0 ? clamp((tt - t0) / (z.shrink_end - t0), 0, 1) : 1
      }
    }
    return { cx: z.center[0] + (z.next_center[0] - z.center[0]) * f, cy: z.center[1] + (z.next_center[1] - z.center[1]) * f, r: z.radius + (z.next_radius - z.radius) * f }
  }

  edgeTime(obs, px, py) {
    const z = obs.zone
    for (let tt = Math.max(obs.t, z.shrink_start); ; tt += 1) {
      const last = tt >= z.shrink_end
      const c = this.zoneAt(obs, last ? z.shrink_end : tt)
      if (dist2(px, py, c.cx, c.cy) > c.r - 4) return Math.min(tt, z.shrink_end)
      if (last) return Infinity
    }
  }

  homePoint(obs, c) {
    const z = obs.zone
    const R = z.next_radius * (z.next_radius >= 140 ? 0.5 : z.next_radius >= 60 ? 0.35 : 0)
    const [ncx, ncy] = z.next_center
    const d = dist2(c.x, c.y, ncx, ncy)
    let hx = ncx, hy = ncy
    if (d <= R) { hx = c.x; hy = c.y }
    else if (R > 0) { hx = ncx + ((c.x - ncx) / d) * R; hy = ncy + ((c.y - ncy) / d) * R }
    const cell = this.nav.nearestWalkable(hx, hy, 16)
    if (cell >= 0) return [this.nav.cellX(cell), this.nav.cellY(cell)]
    const cell2 = this.nav.nearestWalkable(ncx, ncy, 30)
    return cell2 >= 0 ? [this.nav.cellX(cell2), this.nav.cellY(cell2)] : [ncx, ncy]
  }

  idleSpot(hx, hy, z) {
    const key = String(z.shrink_end)
    const inNext = (px, py) => dist2(px, py, z.next_center[0], z.next_center[1]) <= z.next_radius - 8
    if (key === this.idleKey && Number.isFinite(this.idleX) && inNext(this.idleX, this.idleY)) return [this.idleX, this.idleY]
    this.idleKey = key
    const w = this.world, need = this.nav.need
    let best = Infinity, bx = hx, by = hy
    for (let r = 0; r <= 48; r += 6) {
      for (let k = 0; k < (r === 0 ? 1 : NDIR); k++) {
        const px = hx + DIRX[k] * r, py = hy + DIRY[k] * r
        if (!inNext(px, py)) continue
        const cl = this.nav.clearAt(px, py)
        if (cl < need + 0.3 || cl > need + 6 || !this.nav.free(px, py)) continue
        const gz = w.groundAt(px, py) + 5
        let vis = 0
        for (let q = 0; q < NDIR; q++) {
          const ox = px + DIRX[q] * 70, oy = py + DIRY[q] * 70
          if (w.los(ox, oy, w.topAt(ox, oy) + 8, px, py, gz)) vis++
        }
        const s = vis + r / 12
        if (s < best) { best = s; bx = px; by = py }
      }
    }
    this.idleX = bx
    this.idleY = by
    return [bx, by]
  }

  assess(obs, radius, height) {
    const me = obs.self, t = obs.t, [x, y, z] = me.pos, S = me.stats, w = this.world
    const mh = S.muzzle_height ?? 7, walk = S.walk_speed ?? 11.7
    const hpFrac = me.hp / Math.max(1, me.max_hp)
    const slot = (kind) => me.weapons.findIndex((wp) => wp?.kind === kind)
    const sGun = slot('gun'), sLaser = slot('laser'), sLight = slot('lightning'), sMortar = slot('mortar')
    const zn = obs.zone
    const zone = this.zoneAt(obs, t)
    const dNext = dist2(x, y, zn.next_center[0], zn.next_center[1]) - zn.next_radius
    const insideNext = dNext < -6
    let mustGo = !me.in_zone
    if (!insideNext) {
      if (this.edgeTime(obs, x, y) - t < 5 + (Math.max(0, dNext) / walk) * 0.35) mustGo = true
      if (zn.dps >= 60 && t > zn.shrink_start - (Math.max(0, dNext) / (walk * 0.6) + 4)) mustGo = true
    }
    const king = zn.next_radius <= 25.5

    const threats = [...this.tracks.values()].filter((k) => k.kind === 'mech' && t - k.seen <= 3 && dist2(x, y, k.x, k.y) <= 300)
    if (threats.length) this.lastThreatT = t
    const underFire = t - this.lastMechHurtT < 3
    let target = null, targetLos = false, targetDist = Infinity, bestScore = -1e9, unseenShooter = false, exposed = false
    for (const k of threats) {
      if (k.phantom) {
        if (t - k.seen < 1.5) { exposed = true; unseenShooter = true }
        continue
      }
      if (k.seen < t - 0.01) continue
      const d = Math.hypot(k.x - x, k.y - y, k.z - z)
      let frac = 0.5
      let los = w.los(x, y, z + mh, k.x, k.y, k.z + k.h * 0.5)
      if (!los && w.los(x, y, z + mh, k.x, k.y, k.z + k.h * 0.86)) { los = true; frac = 0.86 }
      if (los) exposed = true
      let s = -d / 60 - (k.hp / Math.max(1, k.maxHp)) * 1.5 + (los ? 2.5 : 0)
      if (k.id === this.targetId) s += 0.6
      if (k.id === this.lastHurtBy && t - this.lastHurtT < 4) s += 1
      if (k.id === this.ctl.target) s += 1e6
      if (s > bestScore) { bestScore = s; target = { ...k, aimFrac: frac }; targetLos = los; targetDist = d }
    }
    const mechTarget = target
    this.targetId = mechTarget ? mechTarget.id : -1
    if (mechTarget && targetLos) this.lastSawTargetT = t

    const nT = threats.length
    const finishable = !!mechTarget && (mechTarget.hp < me.hp * 0.5 || (mechTarget.hp < 0.55 * mechTarget.maxHp && me.hp > mechTarget.hp * 1.3))
    const outgunned = !!mechTarget && mechTarget.weapons.includes('laser') && sLaser < 0 && targetDist > 55
    const stance = this.ctl.stance
    const ambush = stance === 3 ? true : stance === 4 ? false : this.ffa
    const hurtByMech = this.lastHurtBy >= 0 && this.lastHurtBy < 100 && t - this.lastHurtT < 4
    let hide = this.evading, fight
    if (ambush) {
      if (!hide) {
        if (nT > 0 && hpFrac < (nT >= 2 ? 0.7 : 0.45) && !finishable) hide = true
        if (nT >= 3) hide = true
        if (unseenShooter && underFire && !mechTarget) hide = true
        if (outgunned && hpFrac < 0.85 && !finishable) hide = true
      } else if (nT === 0) {
        if (hpFrac > 0.85 || t - this.lastThreatT > 10) hide = false
      } else if (nT === 1 && ((hpFrac > 0.85 && !unseenShooter && !outgunned) || finishable)) hide = false
      fight = nT > 0 && !hide && !!mechTarget && (targetDist <= 120 || hurtByMech || finishable)
    } else {
      if (!hide) {
        if (nT > 0 && hpFrac < 0.4 && !finishable) hide = true
        if (nT >= 6) hide = true
        if (nT === 2 && hpFrac < 0.5) hide = true
        if (unseenShooter && underFire && !mechTarget) hide = true
        if (outgunned && hpFrac < 0.8 && !finishable) hide = true
      } else if ((nT === 0 && (hpFrac > 0.75 || t - this.lastThreatT > 8)) || (nT === 1 && hpFrac > 0.85 && !unseenShooter && !outgunned) || (finishable && nT === 1)) hide = false
      fight = !hide && !!mechTarget && ((targetLos && targetDist <= 175) || targetDist <= 60 || hurtByMech)
    }
    if (stance === 1 && mechTarget) { hide = false; fight = true }
    else if (stance === 2 && nT > 0) hide = true
    if (king) hide = false
    this.evading = hide
    if (hide) fight = false
    const evade = hide || (ambush && nT > 0 && !fight && !king)

    if (!target) {
      let bd = Infinity
      const consider = (a, maxD, bonus) => {
        const d = Math.hypot(a.x - x, a.y - y, a.z - z)
        if (d > maxD || !w.los(x, y, z + mh, a.x, a.y, a.z + a.h * 0.5)) return
        if (d - bonus < bd) { bd = d - bonus; target = a; targetLos = true; targetDist = d }
      }
      const calm = nT === 0 && !underFire && !hide && hpFrac >= 0.9 && t - this.lastThreatT > 6 && me.cubes < 14 && me.in_zone
      for (const k of this.tracks.values()) {
        if (k.kind !== 'npc' || k.seen < t - 0.01) continue
        if (k.id === this.lastHurtBy && t - this.lastHurtT < 6) consider({ ...k, kind: 'npc' }, 200, 1000)
        else if (calm && hpFrac > 0.6) consider({ ...k, kind: 'npc' }, 110, 0)
      }
      if (calm) {
        const cr = this.cfg.crates
        for (const it of obs.crates) consider({ id: it.id, kind: 'crate', x: it.pos[0], y: it.pos[1], z: it.pos[2], vx: 0, vy: 0, vz: 0, r: cr.radius ?? 1.4, h: cr.height ?? 2.4, hp: it.hp ?? 300, maxHp: cr.hp ?? 300, weapons: [] }, 150, 60)
      }
    }

    let wantLos = 0
    if (nT > 0 && mechTarget && (ambush || fight)) {
      if (!fight) wantLos = -1.6
      else {
        const gun = sGun >= 0 ? me.weapons[sGun] : null, laser = sLaser >= 0 ? me.weapons[sLaser] : null, light = sLight >= 0 ? me.weapons[sLight] : null
        let ready = false, laserHot = false
        if (gun && (gun.ammo ?? 1) > 0 && (gun.reload ?? 0) <= 0.25 && (!ambush || targetDist <= Math.min((gun.stats.range ?? 230) - 10, (gun.stats.speed ?? 252) * 0.8))) ready = true
        if (laser && (laser.charge ?? 0) >= (laser.stats.charge ?? 0.75) - 0.3 && targetDist <= (laser.stats.range ?? 280) - 5) ready = laserHot = true
        if (light && targetDist <= (light.stats.range ?? 45) + 6 && me.energy >= (light.stats.energy ?? 3) * 3) ready = true
        const duck = threats.some((k) => k.charging && k.seen >= t - 0.3 && Math.abs(wrap(Math.atan2(y - k.y, x - k.x) - k.yaw)) < 0.3 && dist2(x, y, k.x, k.y) < 300)
        wantLos = duck && !laserHot ? -1.6 : ready ? 1 : -1
      }
    }
    return { x, y, z, t, radius, height, mh, hpFrac, walk, zone, insideNext, mustGo, king, evade, fight, ambush, cover: ambush, threats, target, targetLos, targetDist, wantLos, sGun, sLaser, sLight, sMortar, exposed }
  }

  chooseGoal(obs, c) {
    const me = obs.self, zn = obs.zone, { x, y, t } = c, live = c.zone
    const stay = { x, y, arrive: 1e9, why: 'hold', boost: false, travel: false }
    const late = t > zn.shrink_start - 20
    const myArea = me.grounded ? this.nav.areaAt(x, y, 4) : -1
    const zoneOk = (px, py) => (late ? dist2(px, py, zn.next_center[0], zn.next_center[1]) < zn.next_radius - 4 : dist2(px, py, live.cx, live.cy) < live.r - 6)
    const okSpot = (px, py) => zoneOk(px, py) && (myArea < 0 || this.nav.areaAt(px, py, 5) === myArea)
    const skip = (id) => (this.ignore.get(id) ?? -1) > t
    const chase = (id, d, limit) => {
      if (id !== this.chaseId || d < this.chaseBest - 2.5) { this.chaseId = id; this.chaseBest = d; this.chaseT = t }
      if (t - this.chaseT <= limit) return true
      this.ignore.set(id, t + 30)
      this.chaseId = -1
      return false
    }
    const go = (px, py, arrive, why, boost = false, travel = true) => ({ x: px, y: py, arrive, why, boost, travel })

    if (c.mustGo) {
      const [hx, hy] = this.homePoint(obs, c)
      return go(hx, hy, 3, 'zone', !me.in_zone)
    }
    if (c.king) {
      const cell = this.nav.nearestWalkable(zn.next_center[0], zn.next_center[1], 12)
      const snap = cell >= 0 && !this.nav.free(zn.next_center[0], zn.next_center[1], 0.5)
      const kx = snap ? this.nav.cellX(cell) : zn.next_center[0], ky = snap ? this.nav.cellY(cell) : zn.next_center[1]
      return go(kx, ky, 0.5, 'king', dist2(x, y, kx, ky) > zn.next_radius + 10)
    }

    if (c.sLaser < 0) {
      let sl = null, sd = 250
      for (const it of this.pickups.values()) {
        if (it.kind !== 'laser' || it.roof || skip(it.id) || !okSpot(it.x, it.y)) continue
        const d = dist2(x, y, it.x, it.y)
        if (d >= sd) continue
        if (c.threats.some((k) => { const kd = dist2(it.x, it.y, k.x, k.y); return kd < 20 || kd + 30 < d })) continue
        sd = d
        sl = it
      }
      if (sl && chase(sl.id, sd, 12)) return go(sl.x, sl.y, 1.2, 'seek-laser', c.threats.length > 0 && sd > 20 && me.energy > 30)
    }

    if (c.threats.length > 0 && c.hpFrac > 0.35) {
      const contested = (px, py, d) => c.threats.some((k) => dist2(px, py, k.x, k.y) + 10 < d)
      let gc = null, gd = c.ambush ? 25 : 45
      for (const it of this.cubes.values()) {
        if (it.roof || skip(it.id) || !okSpot(it.x, it.y)) continue
        const d = dist2(x, y, it.x, it.y)
        if (d < gd && !contested(it.x, it.y, d)) { gd = d; gc = it }
      }
      if (gc && chase(gc.id, gd, 6)) return go(gc.x, gc.y, 0.8, 'grab-cube')
      let gw = null, gs = 0
      for (const it of this.pickups.values()) {
        if (it.roof || skip(it.id) || !okSpot(it.x, it.y)) continue
        const gain = this.pickupGain(me.weapons, it.kind, live.r)
        const d = dist2(x, y, it.x, it.y)
        const reach = (it.kind === 'laser' ? 120 : gain >= 2 ? 60 : 0) * (c.ambush ? 0.6 : 1)
        if (gain <= 0 || d > reach || contested(it.x, it.y, d)) continue
        const s = gain / (d + 25)
        if (s > gs) { gs = s; gw = it }
      }
      if (gw && chase(gw.id, dist2(x, y, gw.x, gw.y), 9)) return go(gw.x, gw.y, 1.2, `grab-${gw.kind}`, c.exposed && me.energy > 50)
    }

    if (!c.cover) {
      if (c.evade) {
        const [cx, cy] = this.coverSpot(obs, c, false)
        return go(cx, cy, 1.5, 'evade', c.exposed && me.energy > 30)
      }
      if (c.fight && c.target) {
        const k = c.target, d = dist2(x, y, k.x, k.y)
        let [rmin, rmax] = c.sLaser >= 0 ? [125, 185] : c.sLight >= 0 && me.energy > 25 ? [12, 36] : k.weapons.includes('laser') ? [30, 60] : [45, 85]
        if (k.weapons.includes('lightning') && c.sLight < 0) rmin = Math.max(rmin, 60)
        if (k.hp < 0.3 * k.maxHp && c.hpFrac > 0.5) rmax = Math.min(rmax, 45)
        if (this.ctl.range !== 1) { rmin *= this.ctl.range; rmax *= this.ctl.range }
        rmax = Math.max(rmax, rmin + 15)
        const lost = t - this.lastSawTargetT > 4
        const inZone = dist2(k.x, k.y, zn.next_center[0], zn.next_center[1]) < zn.next_radius + 20 || t < zn.shrink_start - 25
        if (d > rmax + 4 && !lost && inZone) return go(k.x, k.y, rmax, 'fight-close')
        if (d < rmin - 4 && d > 0.5) {
          const back = this.retreatPoint(obs, c, k)
          if (back) return go(back[0], back[1], 2, 'fight-back', d < rmin - 15 && me.energy > 45, false)
        }
        return { ...stay, why: 'fight' }
      }
    }
    if (c.cover && (c.evade || c.fight) && c.threats.length > 0) {
      const k = c.fight ? c.target : null
      if (k && k.kind === 'mech' && k.hp < 0.25 * k.maxHp && c.hpFrac > 0.5 && c.threats.length === 1 && c.targetDist < 130) return go(k.x, k.y, 25, 'finish', me.energy > 40)
      const [cx, cy] = this.coverSpot(obs, c, c.fight)
      return go(cx, cy, 1.5, c.fight ? 'ambush' : 'hide', c.exposed && dist2(x, y, cx, cy) > 10 && me.energy > (c.fight ? 45 : 25))
    }
    if (t - this.lastThreatT < 6 && Number.isFinite(this.coverX) && t - this.coverT < 12 && dist2(x, y, this.coverX, this.coverY) < 40) return go(this.coverX, this.coverY, 2, 'wary', false, false)

    const quiet = c.threats.length === 0
    for (const d of obs.drops) {
      if (skip(d.id)) continue
      const dd = dist2(x, y, d.pos[0], d.pos[1])
      if (dd > 280 || d.lands_in > dd / c.walk + 16) continue
      if (!okSpot(d.pos[0], d.pos[1]) && d.lands_in > 0) continue
      if (!quiet && c.hpFrac < 0.5) continue
      if (dd > 6 && !chase(d.id, dd, 14)) continue
      return go(d.pos[0], d.pos[1], 1.5, 'drop')
    }
    let best = null, bd = 90
    for (const it of this.cubes.values()) {
      if (it.roof || !okSpot(it.x, it.y) || skip(it.id)) continue
      const d = dist2(x, y, it.x, it.y)
      if (d < bd) { bd = d; best = it }
    }
    if (best && chase(best.id, bd, 7)) return go(best.x, best.y, 0.8, 'cube')

    let bw = null, bs = 0
    for (const it of this.pickups.values()) {
      if (it.roof || !okSpot(it.x, it.y) || skip(it.id)) continue
      const gain = this.pickupGain(me.weapons, it.kind, live.r)
      if (gain <= 0) continue
      const d = dist2(x, y, it.x, it.y)
      if (d > (it.kind === 'laser' || !(me.weapons[1] && me.weapons[0]) ? 320 : 150)) continue
      const s = gain / (d + 25)
      if (s > bs) { bs = s; bw = it }
    }
    if (bw && chase(bw.id, dist2(x, y, bw.x, bw.y), 9)) return go(bw.x, bw.y, 1.2, `get-${bw.kind}`)

    if (quiet && me.cubes < 14 && c.hpFrac >= 0.9 && !c.evade) {
      let bc = null, bcd = 200
      for (const it of this.crates.values()) {
        if (it.roof || !okSpot(it.x, it.y) || skip(it.id)) continue
        const d = dist2(x, y, it.x, it.y)
        if (d < bcd) { bcd = d; bc = it }
      }
      if (bc) {
        if (c.target && c.target.id === bc.id) return { ...stay, why: 'crate' }
        if (chase(bc.id, bcd, 10)) return go(bc.x, bc.y, 6, 'to-crate')
      }
    }
    if (c.target) return { ...stay, why: 'farm' }
    const [hx, hy] = this.homePoint(obs, c)
    const [ix, iy] = this.idleSpot(hx, hy, zn)
    return go(ix, iy, 2, 'home')
  }

  retreatPoint(obs, c, k) {
    const { x, y, t } = c
    const soon = this.zoneAt(obs, t + 5), zn = obs.zone, late = t > zn.shrink_start - 25
    let best = -1e9, out = null
    for (const r of [22, 38]) {
      for (let i = 0; i < NDIR; i++) {
        const px = x + DIRX[i] * r, py = y + DIRY[i] * r
        if (!this.nav.free(px, py) || !this.nav.segOk(x, y, px, py)) continue
        if (dist2(px, py, soon.cx, soon.cy) > soon.r - 8) continue
        if (late && dist2(px, py, zn.next_center[0], zn.next_center[1]) > zn.next_radius - 6) continue
        let s = dist2(px, py, k.x, k.y), near = Infinity
        for (const th of c.threats) if (th.id !== k.id) near = Math.min(near, dist2(px, py, th.x, th.y))
        if (near < 90) s -= (90 - near) * 0.8
        if (s > best) { best = s; out = [px, py] }
      }
    }
    return out && best > dist2(x, y, k.x, k.y) + 6 ? out : null
  }

  pickupGain(weapons, kind, zoneR) {
    const val = (k) => (k === 'lightning' && zoneR <= 150 ? 3.3 : (WEAPON_VALUE[k] ?? 0))
    if (kind === 'gun' || weapons.some((wp) => wp?.kind === kind)) return 0
    if (weapons.some((wp) => !wp)) return val(kind)
    let worst = Infinity
    for (const wp of weapons) if (wp && wp.kind !== 'gun') worst = Math.min(worst, val(wp.kind))
    return worst === Infinity ? 0 : val(kind) - worst - 0.5
  }

  coverSpot(obs, c, peek) {
    const { x, y, t } = c, w = this.world
    const seenBy = (px, py) => {
      const gz = w.groundAt(px, py)
      let seen = 0
      for (const k of c.threats) {
        const ez = k.z + k.h * 0.89
        if (w.los(k.x, k.y, ez, px, py, gz + c.height * 0.5) || w.los(k.x, k.y, ez, px, py, gz + c.height - 0.5)) seen++
      }
      return seen
    }
    const have = Number.isFinite(this.coverX)
    if (have && t - this.coverT < 0.3) return [this.coverX, this.coverY]
    if (have && t - this.coverT < 1.5 && this.coverPeek === peek && seenBy(this.coverX, this.coverY) === 0) return [this.coverX, this.coverY]
    const zn = obs.zone, soon = this.zoneAt(obs, t + 6)
    const tk = peek && c.target && c.target.kind === 'mech' ? c.target : null
    const lead = zn.shrink_start - t
    const outPen = lead > 40 ? 0.5 : lead > 0 ? 0.5 + ((40 - lead) / 40) * 3.5 : 6
    let best = -1e9, bx = x, by = y, bestSeen = 99
    const consider = (px, py, r, bonus) => {
      if (!this.nav.free(px, py) || dist2(px, py, soon.cx, soon.cy) > soon.r - 5) return
      const seen = seenBy(px, py)
      let s = -3 * seen - r / 35 + bonus, near = Infinity
      for (const th of c.threats) near = Math.min(near, dist2(px, py, th.x, th.y))
      if (near < Infinity) s += Math.min(near, 150) / 75
      if (dist2(px, py, zn.next_center[0], zn.next_center[1]) > zn.next_radius - 5) s -= outPen
      if (tk && seen === 0) {
        const tz = tk.z + tk.h * 0.5
        for (let k = 0; k < NDIR; k += 2) {
          const qx = px + DIRX[k] * 7, qy = py + DIRY[k] * 7
          if (this.nav.free(qx, qy) && w.los(qx, qy, w.groundAt(qx, qy) + c.mh, tk.x, tk.y, tz)) { s += 1.2; break }
        }
      }
      if (s > best) { best = s; bx = px; by = py; bestSeen = seen }
    }
    if (have) consider(this.coverX, this.coverY, dist2(x, y, this.coverX, this.coverY), 0.8)
    const ring = (r) => { for (let k = 0; k < (r === 0 ? 1 : NDIR); k++) consider(x + DIRX[k] * r, y + DIRY[k] * r, r, 0) }
    for (const r of [0, 6, 12, 20, 30, 42, 56, 72]) ring(r)
    if (bestSeen > 0) for (const r of [95, 125]) ring(r)
    Object.assign(this, { coverX: bx, coverY: by, coverT: t, coverPeek: peek })
    return [bx, by]
  }

  follow(x, y, gx, gy, t, onGround) {
    const direct = () => { const d = dist2(x, y, gx, gy); return d > 1e-6 ? [(gx - x) / d, (gy - y) / d] : [0, 0] }
    const dGoal = dist2(x, y, gx, gy)
    if (dGoal < 5 || this.nav.segOk(x, y, gx, gy)) { this.path.length = 0; return direct() }
    const P = () => this.path
    let need = this.replan || P().length === 0 || dist2(gx, gy, this.pathGX, this.pathGY) > Math.max(4, 0.12 * dGoal) || t - this.pathT > (this.pathPartial ? 1.2 : 4)
    if (!need && P().length && dist2(x, y, P()[2 * this.pathI], P()[2 * this.pathI + 1]) > 14) need = true
    if (need && t - this.pathT > 0.25) {
      this.path = this.nav.findPath(x, y, gx, gy)
      Object.assign(this, { pathPartial: this.nav.lastPartial, pathI: 0, pathGX: gx, pathGY: gy, pathT: t, replan: false })
    }
    const p = this.path, n = p.length >> 1
    if (n === 0) return direct()
    const dAt = (k) => dist2(x, y, p[2 * k], p[2 * k + 1])
    while (this.pathI < n - 1 && dAt(this.pathI) < 3) this.pathI++
    let bestI = this.pathI, bestD = dAt(bestI)
    for (let k = this.pathI + 1; k < Math.min(n, this.pathI + 8); k++) { const d = dAt(k); if (d < bestD) { bestD = d; bestI = k } }
    this.pathI = bestI
    let aim = this.pathI
    if (onGround) {
      for (const look of [18, 12, 8, 5, 3, 1]) {
        const j = Math.min(n - 1, this.pathI + look)
        if (j > aim && this.nav.segOk(x, y, p[2 * j], p[2 * j + 1])) { aim = j; break }
      }
    } else aim = Math.min(n - 1, this.pathI + 1)
    const ax = p[2 * aim] - x, ay = p[2 * aim + 1] - y, d = Math.hypot(ax, ay)
    return d > 1e-6 ? [ax / d, ay / d] : direct()
  }

  jet(obs, c, goal, out) {
    const me = obs.self, { x, y, z, t } = c, nav = this.nav, w = this.world, H = this.hop
    if (H.fly) {
      const p = H.plan
      if (!p || t - H.flyT > 14) { H.fly = false; return false }
      if (me.grounded && t - H.flyT > 0.5) {
        H.fly = false
        H.planT = -1e9
        this.replan = true
        this.path.length = 0
        if (nav.areaAt(x, y, 3) === H.target) H.fails = 0
        else if (++H.fails >= 2) { H.ban = t + 25; H.fails = 0 }
        return false
      }
      const dx = p.tx - x, dy = p.ty - y, d = Math.hypot(dx, dy)
      const ux = d > 1e-6 ? dx / d : 0, uy = d > 1e-6 ? dy / d : 0
      let need = w.topAt(x, y)
      for (let s = 1; s <= Math.min(d, 30); s++) need = Math.max(need, w.topAt(x + ux * s, y + uy * s))
      const sp = Math.min(1, (2.2 * d) / Math.max(1, c.walk))
      out.move = d > 0.6 ? [ux * sp, uy * sp] : [0, 0]
      out.boost = z < need + 2.5 && me.energy > 1
      return true
    }
    if (t < H.ban || (goal.why !== 'zone' && goal.why !== 'king' && goal.why !== 'home')) return false
    if (!me.grounded || z - w.groundAt(x, y) > 3) return false
    const mine = nav.areaAt(x, y, 4)
    if (mine < 0) return false
    let target = nav.areaAt(goal.x, goal.y, 14)
    if (goal.why === 'home' && mine !== nav.mainComp) target = nav.mainComp
    if (target < 0 || target === mine) { H.plan = null; return false }
    if (H.target !== target || t - H.seenT > 3) { H.startT = t; H.walkBest = Infinity; H.walkT = t; H.plan = null }
    H.seenT = t
    if (t - H.startT > 40) { H.ban = t + 25; return false }
    if (!H.plan || H.target !== target || t - H.planT > 6) { H.plan = nav.hopPlan(x, y, target); H.target = target; H.planT = t }
    const p = H.plan
    if (!p) return false
    const dl = dist2(x, y, p.lx, p.ly)
    if (!Number.isFinite(H.walkBest) || dist2(x, y, H.walkX, H.walkY) > 2) Object.assign(H, { walkBest: dl, walkX: x, walkY: y, walkT: t })
    const stalled = dl > 2.5 && t - H.walkT > 3
    if (stalled && dl > 18) { H.ban = t + 20; return false }
    if (dl > 2.5 && !stalled) {
      this.move(obs, c, { x: p.lx, y: p.ly, arrive: 1, why: goal.why, boost: goal.boost && dl > 25, travel: true }, out)
      return true
    }
    out.move = [0, 0]
    out.boost = false
    if (me.energy < Math.min((me.stats.energy ?? 100) - 4, p.energy + 6 + (stalled ? dl * 1.3 : 0))) return true
    H.fly = true
    H.flyT = t
    out.jump = true
    const d = dist2(x, y, p.tx, p.ty)
    if (d > 1e-6) out.move = [(p.tx - x) / d, (p.ty - y) / d]
    return true
  }

  incoming(obs, c) {
    const { x, y, z, t } = c, shots = []
    if (c.king && obs.zone.next_radius <= 0.5 && t > obs.zone.shrink_start) return shots
    const mortar = this.cfg.weapons.mortar
    for (const p of obs.projectiles) {
      const rx = p.pos[0] - x, ry = p.pos[1] - y
      const sp2 = p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1]
      if (sp2 < 1) continue
      const sp = Math.sqrt(sp2)
      if (p.kind === 'mortar') {
        const g = mortar.gravity ?? 22, dz = p.pos[2] - z
        const tl = (p.vel[2] + Math.sqrt(Math.max(0, p.vel[2] * p.vel[2] + 2 * g * dz))) / g
        const lx = p.pos[0] + p.vel[0] * tl, ly = p.pos[1] + p.vel[1] * tl
        const lr = (mortar.splash_radius ?? 7) + c.radius + 2.5
        if (dist2(lx, ly, x, y) < lr + 14) shots.push({ th: Math.min(tl, 1.4), w: 2.5, land: true, lx, ly, lr })
        continue
      }
      const th = -(rx * p.vel[0] + ry * p.vel[1]) / sp2
      if (th <= 0 || th > 1.4) continue
      if (Math.abs(rx * (p.vel[1] / sp) - ry * (p.vel[0] / sp)) > 14) continue
      const bz = p.pos[2] + p.vel[2] * th
      if (bz < z - 2 || bz > z + c.height + 2) continue
      shots.push({ px: p.pos[0], py: p.pos[1], ux: p.vel[0] / sp, uy: p.vel[1] / sp, th, w: p.kind === 'npc' ? 0.6 : 1, land: false })
    }
    return shots
  }

  move(obs, c, goal, out) {
    const me = obs.self, S = me.stats, { x, y, z, t } = c, w = this.world, nav = this.nav
    const vx = me.vel[0], vy = me.vel[1], accel = S.ground_accel ?? 58.5
    const laser = c.sLaser >= 0 ? me.weapons[c.sLaser] : null
    const charging = !!laser && (laser.charge ?? 0) > 0
    const onGround = z - w.groundAt(x, y) < 3
    let boost = goal.boost && me.energy > 6 && !charging
    const speed = (boost ? (S.boost_speed ?? 19.5) : c.walk) * (charging ? (S.charge_move_mult ?? 0.5) : 1)
    const gdist = dist2(x, y, goal.x, goal.y)
    let [gdx, gdy] = gdist > goal.arrive ? this.follow(x, y, goal.x, goal.y, t, onGround) : [0, 0]

    const hi = this.hN % 12
    this.hx[hi] = x
    this.hy[hi] = y
    this.hWant[hi] = goal.travel && gdist > goal.arrive + 4 ? 1 : 0
    this.hN++
    if (this.hN >= 12) {
      const old = this.hN % 12
      const all = this.hWant.every((v) => v === 1)
      const moved = dist2(x, y, this.hx[old], this.hy[old])
      if (moved > 6) this.stuckCount = 0
      if (all && moved < 1.8 && t - this.lastStuckT > 1) {
        this.lastStuckT = t
        this.stuckCount++
        nav.block(x + gdx * 3.5, y + gdy * 3.5, 3.5, t + 20)
        this.replan = true
        this.pathT = -1e9
        if (this.stuckCount >= 2 || !onGround) this.jumpUntil = t + 0.9
        this.hWant.fill(0)
      }
    }
    if (t < this.jumpUntil) {
      out.move = [gdx, gdy]
      out.jump = me.grounded
      out.boost = me.energy > 10
      return
    }

    const shots = this.incoming(obs, c)
    const forced = goal.why === 'zone' || goal.why === 'king'
    const grabbing = goal.why.startsWith('grab')
    const goalW = forced ? 4 : grabbing ? 2.5 : goal.why === 'fight-back' ? 2.5 : 1
    const coverW = forced ? 0.3 : grabbing ? 0.5 : 1
    const mechTarget = c.target && c.target.kind === 'mech' ? c.target : null
    const tk = (c.cover ? c.fight || c.evade : c.fight) ? mechTarget : null
    const jink = !tk ? 0 : c.cover ? (c.targetLos ? (c.fight ? 0.7 : 0.4) : 0) : c.targetLos ? 0.7 : 0.2
    let sx = 0, sy = 0
    if (tk) {
      if (t >= this.strafeFlipT) {
        this.strafe = -this.strafe
        this.strafeFlipT = t + 0.45 + this.rng() * 0.7
      }
      const d = dist2(x, y, tk.x, tk.y)
      if (d > 0.5) { sx = (-(tk.y - y) / d) * this.strafe; sy = ((tk.x - x) / d) * this.strafe }
    }
    const zSoon = this.zoneAt(obs, t + 1)
    const insideNow = dist2(x, y, zSoon.cx, zSoon.cy) < zSoon.r - 2
    const curClear = nav.clearAt(x, y)
    const zn = obs.zone
    const pred = (dx, dy, sp, tau) => {
      const ex = dx * sp - vx, ey = dy * sp - vy, tr = Math.hypot(ex, ey) / accel
      if (tr < 1e-6) return [x + vx * tau, y + vy * tau]
      if (tau <= tr) return [x + vx * tau + 0.5 * (ex / tr) * tau * tau, y + vy * tau + 0.5 * (ey / tr) * tau * tau]
      return [x + (vx + 0.5 * ex) * tr + dx * sp * (tau - tr), y + (vy + 0.5 * ey) * tr + dy * sp * (tau - tr)]
    }
    const coverWeight = c.evade || c.threats.length > 1 ? (c.evade ? 1.2 : 0.45) * coverW : 0
    let best = -1e9, bx = 0, by = 0
    const evalDir = (dx, dy, moving) => {
      const sp = moving ? speed : 0
      const [p1x, p1y] = pred(dx, dy, sp, 0.45)
      const [p2x, p2y] = pred(dx, dy, sp, 1.0)
      let s = (dx * gdx + dy * gdy) * goalW
      if (onGround && moving && !nav.segOk(x, y, p1x, p1y, 0.5) && !(curClear < nav.need && nav.clearAt(p1x, p1y) > curClear)) s -= 6
      for (const sh of shots) {
        const [mx, my] = pred(dx, dy, sp, sh.th)
        if (sh.land) {
          const d = dist2(mx, my, sh.lx, sh.ly)
          if (d < sh.lr) s -= 10 * sh.w * (1 - d / sh.lr)
        } else {
          const miss = Math.abs((mx - sh.px) * sh.uy - (my - sh.py) * sh.ux), safe = c.radius + 2
          if (miss < safe) { const q = 1 - miss / safe; s -= 10 * sh.w * q * q }
        }
      }
      if (c.king) s -= dist2(p1x, p1y, zn.next_center[0], zn.next_center[1]) * 0.8
      else if (insideNow && dist2(p2x, p2y, zSoon.cx, zSoon.cy) > zSoon.r - 2) s -= 2.5
      if (tk) {
        s += jink * (dx * sx + dy * sy)
        if (c.wantLos !== 0) {
          const tz = tk.z + tk.h * 0.5
          const l1 = w.los(p1x, p1y, w.groundAt(p1x, p1y) + c.mh, tk.x, tk.y, tz)
          const l2 = w.los(p2x, p2y, w.groundAt(p2x, p2y) + c.mh, tk.x, tk.y, tz)
          s += coverW * c.wantLos * ((l1 ? 1 : -1) * 1.3 + (l2 ? 0.6 : -0.6))
        }
      }
      if (coverWeight) {
        const g1 = w.groundAt(p1x, p1y) + c.height * 0.5
        let n = 0
        for (const k of c.threats) {
          if (tk && k.id === tk.id) continue
          if (++n > 6) break
          if (w.los(k.x, k.y, k.z + k.h * 0.89, p1x, p1y, g1)) s -= coverWeight
        }
      }
      s += 0.15 * (dx * this.lastDX + dy * this.lastDY)
      if (s > best) { best = s; bx = moving ? dx : 0; by = moving ? dy : 0 }
    }
    if (gdx !== 0 || gdy !== 0) evalDir(gdx, gdy, true)
    for (let k = 0; k < NDIR; k++) evalDir(DIRX[k], DIRY[k], true)
    evalDir(0, 0, false)

    let mag = 1
    if (!tk && shots.length === 0 && gdist <= Math.max(goal.arrive, 0) + 3 && goal.arrive < 100) mag = clamp((gdist - goal.arrive * 0.5) / 3, 0, 1)
    if (c.king && gdist < 3) mag = clamp(gdist / 2, 0.15, 1)
    this.lastDX = bx
    this.lastDY = by
    if (c.evade && c.exposed && me.energy > 30 && !charging) boost = true
    out.move = [bx * mag, by * mag]
    out.boost = boost && (bx !== 0 || by !== 0)
  }

  aimAndFire(obs, c, out) {
    const me = obs.self, S = me.stats, { x, y, z, t } = c
    const mz = z + c.mh, fire = [false, false]
    const minPitch = S.min_pitch ?? -0.7, maxPitch = S.max_pitch ?? 1.3
    const T = c.target
    const cubeMult = 1 + (Number(this.cfg.cubes.damage_per_cube) || 0) * Math.min(me.cubes, Number(this.cfg.cubes.stat_cap) || 10)
    let yaw = me.aim[0], pitch = 0
    const mechT = !!T && T.kind === 'mech'
    const repairing = mechT && c.evade && c.hpFrac < 0.85 && t - this.lastHurtT > 1 && T.hp > 0.25 * T.maxHp && c.targetDist > 45
    const unprovoked = mechT && c.ambush && !c.fight && t - this.lastMechHurtT > 3 && T.hp > 0.35 * T.maxHp
    const holdFire = repairing || unprovoked
    const mayCharge = !c.evade || c.threats.length <= 1 || c.hpFrac > 0

    if (T) {
      const frac = T.aimFrac ?? 0.5, cz = T.z + T.h * frac
      const ext = (lat) => [T.x + (T.vx - me.vel[0]) * lat - x, T.y + (T.vy - me.vel[1]) * lat - y, cz + (T.vz - me.vel[2]) * lat - mz]
      const [dx, dy, dz] = ext(0.05)
      const dist = Math.hypot(dx, dy, dz)
      const dYaw = Math.atan2(dy, dx), dPitch = Math.atan2(dz, Math.hypot(dx, dy))
      const tolYaw = Math.atan2(T.r * 0.6, dist) + 0.002
      const tolPitch = Math.atan2(T.h * 0.8 * Math.min(frac, 1 - frac), dist) + 0.002
      const errYaw = Math.abs(wrap(dYaw - me.aim[0])), errPitch = Math.abs(dPitch - me.aim[1])
      const los = c.targetLos
      const [ax, ay, az] = ext(0.1)
      yaw = Math.atan2(ay, ax)
      pitch = Math.atan2(az, Math.hypot(ax, ay))
      let prio = 0
      for (let s = 0; s < 2; s++) {
        const wp = me.weapons[s]
        if (!wp) continue
        const st = wp.stats
        if (wp.kind === 'gun') {
          const [lx0, ly0, lz0] = ext(0.075)
          const tl = interceptTime(lx0, ly0, lz0, T.vx, T.vy, T.vz, st.speed ?? 252)
          if (tl <= 0) continue
          const lx = lx0 + T.vx * tl, ly = ly0 + T.vy * tl, lz = lz0 + T.vz * tl
          const gy = Math.atan2(ly, lx), gp = Math.atan2(lz, Math.hypot(lx, ly))
          const ready = (wp.ammo ?? 1) > 0 && (wp.reload ?? 0) <= 0
          const inRange = (st.speed ?? 252) * tl <= (st.range ?? 230) - 4
          const worth = T.kind !== 'mech' || tl <= 0.8 || Math.hypot(T.vx, T.vy) < 3
          let onAim = Math.abs(wrap(gy - me.aim[0])) <= tolYaw && Math.abs(gp - me.aim[1]) <= tolPitch
          if (!onAim) {
            const turn = (S.turn_rate ?? 4) * 0.05, tilt = (S.pitch_rate ?? 3) * 0.05
            const ey = wrap(gy - me.aim[0]), ep = gp - me.aim[1]
            onAim = Math.abs(ey - clamp(ey, -turn, turn)) <= tolYaw && Math.abs(ep - clamp(ep, -tilt, tilt)) <= tolPitch
          }
          if (ready && inRange && worth && los && onAim && !holdFire) fire[s] = true
          if (ready && inRange && prio < 1) { prio = 1; yaw = gy; pitch = gp }
        } else if (wp.kind === 'laser') {
          const full = st.charge ?? 0.75, ch = wp.charge ?? 0
          const inRange = dist <= (st.range ?? 280) - 3
          const closing = dist > 1 ? -(dx * T.vx + dy * T.vy) / dist : 0
          const recently = t - this.lastSawTargetT < 1.5 || (dist < 70 && closing > 2)
          let hold = inRange && (ch > 0 || (wp.cooldown <= 0.05 && mayCharge && !holdFire)) && (los || recently || ch > 0)
          if (ch > 0) {
            const minFrac = st.min_frac ?? 0.35
            let dmg = (st.damage ?? 315) * (minFrac + (1 - minFrac) * Math.min(1, ch / full)) * cubeMult
            if (T.weapons.includes('mortar')) dmg *= 1 + (st.cookoff ?? 0)
            if (los && inRange && errYaw <= tolYaw && errPitch <= tolPitch && ch >= (st.min_charge ?? 0.15) && (ch >= full - 0.02 || dmg >= T.hp)) hold = false
            if (ch >= full - 0.3 && prio < 3) { prio = 3; yaw = Math.atan2(ay, ax); pitch = Math.atan2(az, Math.hypot(ax, ay)) }
          }
          fire[s] = hold
        } else if (wp.kind === 'lightning') {
          const cone = ((st.cone_deg ?? 30) * Math.PI) / 180
          if (dist <= (st.range ?? 45) - 2 && los && me.energy >= (st.energy ?? 3) + (T.kind === 'mech' ? 0 : 40) && errYaw <= cone * 0.45 && !holdFire) fire[s] = true
        } else if (wp.kind === 'mortar') {
          const v = st.speed ?? 72, g = st.gravity ?? 22, tz0 = z + c.height + 0.5
          let px = T.x, py = T.y, sol = null, tf = 0
          for (let it = 0; it < 2; it++) {
            const d = dist2(x, y, px, py)
            sol = lowArcPitch(d, T.z + 1 - tz0, v, g)
            if (sol == null) break
            tf = d / (v * Math.cos(sol))
            px = T.x + T.vx * Math.min(tf, 1.5)
            py = T.y + T.vy * Math.min(tf, 1.5)
          }
          const d = dist2(x, y, px, py)
          const slow = Math.hypot(T.vx, T.vy) < 4
          const gun = c.sGun >= 0 ? me.weapons[c.sGun] : null
          const gunBusy = !gun || (gun.ammo ?? 1) <= 0 || (gun.reload ?? 0) > 0
          if (sol != null && sol <= maxPitch - 0.02 && wp.cooldown <= 0.15 && d >= (st.splash_radius ?? 7) + c.radius + 5 && (slow || tf < 0.85) && los && T.kind !== 'crate') {
            const my = Math.atan2(py - y, px - x)
            if ((gunBusy || prio < 1) && prio < 2) { prio = 2; yaw = my; pitch = sol }
            if (Math.abs(wrap(my - me.aim[0])) < 0.025 && Math.abs(sol - me.aim[1]) < 0.02 && !holdFire) fire[s] = true
          }
        }
      }
    } else {
      if (!Number.isFinite(this.scanYaw0)) this.scanYaw0 = me.aim[0]
      if (t >= this.nextScanT && c.threats.length === 0) Object.assign(this, { scanStartT: t, scanUntil: t + 1.8, scanYaw0: me.aim[0], nextScanT: t + 11 })
      let recent = null
      for (const k of this.tracks.values()) if (k.kind === 'mech' && t - k.seen < 12 && (!recent || k.seen > recent.seen)) recent = k
      if (this.alertUntil > t) yaw = this.alertYaw
      else if (t < this.scanUntil) yaw = this.scanYaw0 + (t - this.scanStartT + 0.1) * (S.turn_rate ?? 4) * 0.9
      else if (recent) yaw = Math.atan2(recent.y - y, recent.x - x)
      else if (Math.hypot(me.vel[0], me.vel[1]) > 2) yaw = Math.atan2(me.vel[1], me.vel[0]) + 0.9 * Math.sin(t * 1.3)
      else yaw = me.aim[0] + 0.35
      pitch = 0
    }
    out.aim = [wrap(yaw), clamp(pitch, minPitch, maxPitch)]
    out.fire = fire

    const gun = c.sGun >= 0 ? me.weapons[c.sGun] : null
    if (gun && (gun.reload ?? 0) <= 0) {
      const ammo = gun.ammo ?? 1, mag = gun.stats.mag ?? 12
      if (ammo <= 0 || (!c.target && ammo < mag * 0.7 && t - this.lastSawTargetT > 1.5) || (c.fight && !c.targetLos && ammo < mag * 0.34 && t - this.lastSawTargetT > 0.8)) out.reload = true
    }
  }

  pickUpgrade(obs) {
    const ch = obs.offer?.choices ?? []
    let best = 0, rank = Infinity
    ch.forEach((o, i) => {
      const r = UPGRADE_ORDER.indexOf(o.id)
      const rr = r < 0 ? 50 : r
      if (rr < rank) { rank = rr; best = i }
    })
    return best
  }

  loot(obs, c, out) {
    const me = obs.self, reach = (this.cfg.loot.pickup_radius ?? 4) - 0.3
    let best = 0, pick = null
    for (const p of obs.pickups) {
      if (dist2(c.x, c.y, p.pos[0], p.pos[1]) > reach || Math.abs(p.pos[2] - c.z) > 3.7 || (this.ignore.get(p.id) ?? -1) > c.t) continue
      const g = this.pickupGain(me.weapons, p.kind, c.zone.r)
      if (g > best) { best = g; pick = p }
    }
    if (!pick) return
    if (me.weapons.some((wp) => !wp)) { out.take = pick.id; return }
    let slot = -1, worst = Infinity
    for (let s = 0; s < 2; s++) {
      const wp = me.weapons[s]
      if (!wp || wp.kind === 'gun' || (wp.kind === 'laser' && (wp.charge ?? 0) > 0)) continue
      const v = WEAPON_VALUE[wp.kind] ?? 0
      if (v < worst) { worst = v; slot = s }
    }
    if (slot >= 0) { out.take = pick.id; out.drop = slot }
  }
}
