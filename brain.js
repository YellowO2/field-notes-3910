// Decision logic (original code, MIT). One instance per match: new Brain(map, hello); act(obs) -> action.
const TAU = Math.PI * 2
const wrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

export const DEFAULTS = {
  fightMin: 35, fightMax: 95,       // preferred distance band to an enemy mech
  retreatHp: 0.38,                  // retreat below this hp fraction when threatened
  reengageHp: 0.8,                  // come back once regenerated above this
  strafeSwitch: [0.6, 1.4],         // seconds between strafe direction changes
  lootRadius: 110, crateRadius: 70, npcRadius: 70,
  zoneMargin: 0.8, zoneLead: 14,    // be inside next circle * margin this many s before shrink
  gunAimTol: 0.9,                   // fire gun when aim error < tol * target angular radius
  upgradePref: ['plating', 'nanites', 'armor', 'laser_damage', 'gun_damage', 'gun_rate', 'laser_charge', 'lightning_efficiency', 'gyros', 'servos', 'gun_mag', 'capacitor', 'reactor', 'jets', 'sensors'],
  weaponPref: { laser: 3, lightning: 2, mortar: 1, gun: 0 },
}

export class Brain {
  constructor(map, hello, params = {}) {
    this.map = map
    this.cfg = hello.config
    this.P = { ...DEFAULTS, ...params }
    this.id = hello.slot
    let s = hello.seed >>> 0
    this.rnd = () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
    this.enemies = new Map() // id -> {pos, vel, hp, maxHp, weapons, t, charging, aim}
    this.path = null; this.pathGoal = null; this.pathT = -99
    this.strafe = 1; this.strafeUntil = 0
    this.mode = 'loot'
    this.stuck = 0; this.prevPos = null
    this.lastDamage = { t: -99, bearing: 0, by: null }
    this.failedTakes = new Map()
  }

  act(obs) {
    const me = obs.self, t = obs.t, P = this.P
    const a = { tick: obs.tick, move: [0, 0], aim: [me.aim[0], me.aim[1]], fire: [false, false] }
    this.observe(obs)
    if (obs.offer) a.pick = this.pickUpgrade(obs.offer)

    const pos = me.pos
    const hpFrac = me.hp / me.max_hp
    const foes = [...this.enemies.values()].filter((e) => t - e.t < 4.5)
    const visible = foes.filter((e) => e.seenNow)
    // target: visible mech that is cheapest to kill, nearby
    let target = null, bestScore = Infinity
    for (const e of visible) {
      const dist = d3(pos, e.pos)
      const score = dist + e.hp * 0.05 + (e.id === this.lastTarget ? -25 : 0)
      if (score < bestScore) { bestScore = score; target = e }
    }
    this.lastTarget = target?.id
    const threatened = visible.length > 0 || t - this.lastDamage.t < 3
    // mode selection
    if (this.mode === 'retreat') { if (hpFrac > P.reengageHp || !threatened && hpFrac > 0.6) this.mode = 'loot' }
    else if (threatened && hpFrac < P.retreatHp) this.mode = 'retreat'
    const zone = obs.zone
    const zoneGoal = this.zoneTarget(obs)

    let goal = null, faceMove = true, speed = 1, boost = false
    if (zoneGoal.urgent) { goal = zoneGoal.p; boost = zoneGoal.veryUrgent && me.energy > 25 }
    else if (this.mode === 'retreat') {
      goal = this.retreatPoint(obs, foes)
      boost = me.energy > 20
    } else if (target) {
      // fight: hold a distance band, strafe
      faceMove = false
      const dist = d2(pos, target.pos)
      const toT = Math.atan2(target.pos[1] - pos[1], target.pos[0] - pos[0])
      if (t > this.strafeUntil) { this.strafe = this.rnd() < 0.5 ? -1 : 1; this.strafeUntil = t + P.strafeSwitch[0] + this.rnd() * (P.strafeSwitch[1] - P.strafeSwitch[0]) }
      let radial = 0
      const want = this.preferredRange(me)
      if (dist > want[1]) radial = 1; else if (dist < want[0]) radial = -1
      const side = toT + this.strafe * Math.PI / 2
      let mx = Math.cos(side) + radial * Math.cos(toT) * 0.9, my = Math.sin(side) + radial * Math.sin(toT) * 0.9
      // keep inside the zone while fighting
      if (d2([pos[0] + mx * 8, pos[1] + my * 8], zone.center) > zone.radius - 5) { const zc = Math.atan2(zone.center[1] - pos[1], zone.center[0] - pos[0]); mx += Math.cos(zc); my += Math.sin(zc) }
      const l = Math.hypot(mx, my) || 1
      a.move = this.avoidWalls(pos, [mx / l, my / l])
    } else {
      goal = this.lootGoal(obs) ?? zoneGoal.p
      if (foes.length) { // recently seen enemy: approach its last known position if healthy
        const f = foes.sort((x, y) => d2(pos, x.pos) - d2(pos, y.pos))[0]
        if (hpFrac > 0.7 && d2(pos, f.pos) < 160) goal = f.pos
      }
    }
    if (goal) a.move = this.steer(pos, goal, t, obs)
    a.move = [a.move[0] * speed, a.move[1] * speed]
    a.boost = boost

    // weapons and aim
    if (target) this.engage(obs, a, target)
    else {
      const sub = this.secondaryTarget(obs)
      if (sub) this.engageObject(obs, a, sub)
      else if (t - this.lastDamage.t < 2) a.aim = [this.lastDamage.bearing, 0]
      else if (faceMove && Math.hypot(a.move[0], a.move[1]) > 0.1) a.aim = [Math.atan2(a.move[1], a.move[0]), 0]
      this.releaseLaserIfIdle(obs, a)
    }
    this.handleLoot(obs, a)
    this.unstick(obs, a)
    return a
  }

  // ------------------------------------------------------------ perception
  observe(obs) {
    for (const e of this.enemies.values()) e.seenNow = false
    for (const m of obs.mechs) {
      if (m.kind !== 'mech') continue
      const prev = this.enemies.get(m.id)
      this.enemies.set(m.id, { id: m.id, pos: m.pos, vel: m.vel, hp: m.hp, maxHp: m.max_hp, weapons: m.weapons, charging: m.charging, aim: m.aim, t: obs.t, seenNow: true, cubes: m.cubes, firstSeen: prev?.firstSeen ?? obs.t })
    }
    for (const e of obs.events) {
      if (e.type === 'damaged' && e.by != null && e.weapon !== 'zone') this.lastDamage = { t: obs.t, bearing: e.bearing, by: e.by, weapon: e.weapon }
      if (e.type === 'kill') this.enemies.delete(e.target)
      if (e.type === 'take_failed') this.failedTakes.set(e.id, obs.t)
    }
    for (const id of [...this.enemies.keys()]) if (obs.t - this.enemies.get(id).t > 12) this.enemies.delete(id)
  }

  preferredRange(me) {
    const kinds = me.weapons.filter(Boolean).map((w) => w.kind)
    if (kinds.includes('lightning')) return [18, 38]
    return [this.P.fightMin, this.P.fightMax]
  }

  // ------------------------------------------------------------ aiming
  muzzle(me, h) { return [me.pos[0], me.pos[1], me.pos[2] + (h ?? me.stats.muzzle_height)] }

  leadPoint(me, tgt, speed, zOff = 4.5) {
    const s = 1 + 0.05 * (tgt.cubes ?? 0)
    const m = this.muzzle(me)
    let p = [tgt.pos[0], tgt.pos[1], tgt.pos[2] + zOff * s]
    const v = tgt.vel ?? [0, 0, 0]
    const age = 0.1 + Math.max(0, (this.now ?? 0) - tgt.t)
    if (!speed) return [p[0] + v[0] * age, p[1] + v[1] * age, p[2]]
    let tt = d3(m, p) / speed
    for (let k = 0; k < 3; k++) {
      const q = [p[0] + v[0] * (tt + age), p[1] + v[1] * (tt + age), p[2] + (v[2] ?? 0) * Math.min(tt + age, 0.3)]
      tt = d3(m, q) / speed
    }
    return [p[0] + v[0] * (tt + age), p[1] + v[1] * (tt + age), p[2] + (v[2] ?? 0) * Math.min(tt + age, 0.3)]
  }

  aimAt(me, p) {
    const m = this.muzzle(me)
    return [Math.atan2(p[1] - m[1], p[0] - m[0]), Math.atan2(p[2] - m[2], Math.hypot(p[0] - m[0], p[1] - m[1]))]
  }

  aimErr(me, aim) { return Math.hypot(wrap(me.aim[0] - aim[0]), me.aim[1] - aim[1]) }

  engage(obs, a, tgt) {
    this.now = obs.t
    const me = obs.self, W = me.weapons, P = this.P
    const slot = (k) => W.findIndex((w) => w && w.kind === k)
    const gs = slot('gun'), ls = slot('laser'), zs = slot('lightning'), ms = slot('mortar')
    const dist = d3(me.pos, tgt.pos)
    const m = this.muzzle(me)
    const clear = tgt.seenNow && this.map.los(m[0], m[1], m[2], tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5)
    const angR = Math.atan2(2.5 * (1 + 0.05 * (tgt.cubes ?? 0)), Math.max(dist, 1))
    // primary aim: gun lead
    let aim = this.aimAt(me, this.leadPoint(me, tgt, W[gs]?.stats.speed ?? 252))
    if (ls >= 0 && (W[ls].charge > 0)) aim = this.aimAt(me, this.leadPoint(me, tgt, 0))
    if (zs >= 0 && dist < 50) aim = this.aimAt(me, this.leadPoint(me, tgt, 0))
    a.aim = aim
    const err = this.aimErr(me, aim)
    // lightning: instant, +-15 deg cone, 45 m
    if (zs >= 0) {
      const ws = W[zs].stats
      const yawErr = Math.abs(wrap(Math.atan2(tgt.pos[1] - me.pos[1], tgt.pos[0] - me.pos[0]) - me.aim[0]))
      if (dist < ws.range + 1 && yawErr < (ws.cone_deg / 2) * Math.PI / 180 * 0.9 && me.energy >= ws.energy) a.fire[zs] = true
    }
    // laser: charge while target is in view, release at full charge when aimed
    if (ls >= 0) {
      const w = W[ls], full = w.stats.charge
      if (w.charge > 0) {
        const ready = w.charge >= full - 0.02 && err < angR * 0.8 && clear
        const giveUp = !tgt.seenNow && w.charge >= full
        a.fire[ls] = !(ready || giveUp)
      } else if (w.cooldown <= 0 && clear && dist < w.stats.range - 10 && dist > 12) a.fire[ls] = true
    }
    // mortar: lob at targets behind cover or far
    if (ms >= 0) {
      const ws = W[ms].stats
      const dx = d2(me.pos, tgt.pos), dz = tgt.pos[2] - (me.pos[2] + me.stats.height + 0.5)
      const v = ws.speed, g = ws.gravity, disc = v ** 4 - g * (g * dx * dx + 2 * dz * v * v)
      if (disc > 0 && dx > 30 && dx < 220 && !(zs >= 0 && dist < 45)) {
        const pitch = Math.atan((v * v - Math.sqrt(disc)) / (g * dx))
        const lead = this.leadPoint(me, tgt, 0)
        const tof = dx / (v * Math.cos(pitch))
        const yaw = Math.atan2(lead[1] + (tgt.vel?.[1] ?? 0) * tof - me.pos[1], lead[0] + (tgt.vel?.[0] ?? 0) * tof - me.pos[0])
        if (!(ls >= 0 && W[ls].charge > 0) && W[ms].cooldown <= 0.15 && !clear) { a.aim = [yaw, pitch]; if (Math.abs(wrap(me.aim[0] - yaw)) < 0.03 && Math.abs(me.aim[1] - pitch) < 0.03) a.fire[ms] = true }
      }
    }
    // gun
    if (gs >= 0) {
      const w = W[gs]
      if (clear && dist < w.stats.range && err < Math.max(angR * P.gunAimTol, 0.004) && !(w.reload > 0)) a.fire[gs] = true
      if (!clear && w.ammo < w.stats.mag * 0.5 && !(w.reload > 0)) a.reload = true
    }
  }

  releaseLaserIfIdle(obs, a) {
    const W = obs.self.weapons
    const ls = W.findIndex((w) => w && w.kind === 'laser')
    if (ls >= 0 && W[ls].charge > 0 && a.fire[ls] !== true) a.fire[ls] = W[ls].charge < W[ls].stats.charge // keep charging toward full, then hold
  }

  secondaryTarget(obs) {
    const me = obs.self, P = this.P
    // crates and drones for cubes when nothing else is happening
    let best = null, bd = Infinity
    for (const c of obs.crates) { const d = d3(me.pos, c.pos); if (d < P.crateRadius && d < bd) { best = { kind: 'crate', pos: [c.pos[0], c.pos[1], c.pos[2] + 1.2], vel: [0, 0, 0], id: c.id }; bd = d } }
    if (me.hp > me.max_hp * 0.6)
      for (const n of obs.mechs) if (n.kind === 'npc') { const d = d3(me.pos, n.pos); if (d < P.npcRadius && d < bd + 20) { best = { kind: 'npc', pos: [n.pos[0], n.pos[1], n.pos[2] + 1.75], vel: n.vel, id: n.id }; bd = d } }
    return best
  }

  engageObject(obs, a, o) {
    const me = obs.self, W = me.weapons
    const m = this.muzzle(me)
    if (!this.map.los(m[0], m[1], m[2], o.pos[0], o.pos[1], o.pos[2])) { a.aim = this.aimAt(me, o.pos); return }
    const gs = W.findIndex((w) => w && w.kind === 'gun')
    const zs = W.findIndex((w) => w && w.kind === 'lightning')
    const speed = W[gs]?.stats.speed ?? 252
    const tt = d3(m, o.pos) / speed
    const p = [o.pos[0] + o.vel[0] * (tt + 0.1), o.pos[1] + o.vel[1] * (tt + 0.1), o.pos[2]]
    a.aim = this.aimAt(me, p)
    const err = this.aimErr(me, a.aim)
    const dist = d3(me.pos, o.pos)
    if (gs >= 0 && err < Math.atan2(1.3, dist) && !(W[gs].reload > 0)) a.fire[gs] = true
    if (zs >= 0 && dist < 44 && me.energy > 40) a.fire[zs] = true
  }

  // ------------------------------------------------------------ movement
  zoneTarget(obs) {
    const z = obs.zone, me = obs.self, P = this.P, t = obs.t
    const dNext = d2(me.pos, z.next_center)
    const dCur = d2(me.pos, z.center)
    const timeToShrink = z.shrink_start - t
    const inNext = dNext < z.next_radius * P.zoneMargin
    const travel = Math.max(0, dNext - z.next_radius * P.zoneMargin) / 11
    const urgent = !me.in_zone || dCur > z.radius - 6 || (!inNext && timeToShrink < travel + P.zoneLead) || (t > z.shrink_start && !inNext)
    if (!this.zoneSpot || d2(this.zoneSpot.c, z.next_center) > 1 || this.zoneSpot.r !== z.next_radius) {
      const ang = this.rnd() * TAU, r = Math.sqrt(this.rnd()) * z.next_radius * 0.45
      this.zoneSpot = { c: z.next_center, r: z.next_radius, p: [z.next_center[0] + Math.cos(ang) * r, z.next_center[1] + Math.sin(ang) * r] }
    }
    return { urgent, veryUrgent: !me.in_zone || (timeToShrink < travel + 3 && !inNext), p: this.zoneSpot.p }
  }

  retreatPoint(obs, foes) {
    const me = obs.self
    const z = obs.zone
    // pick a point ~40 m away that breaks line of sight to known foes and stays in the safe circle
    let best = null, bs = -Infinity
    for (let k = 0; k < 16; k++) {
      const ang = (k / 16) * TAU, r = 35
      const p = [me.pos[0] + Math.cos(ang) * r, me.pos[1] + Math.sin(ang) * r]
      const nk = this.map.navCell(p[0], p[1])
      if (nk < 0 || !this.map.pass[nk]) continue
      const pz = this.map.gz[nk] + 6
      let s = 0
      for (const f of foes) {
        const hidden = !this.map.los(f.pos[0], f.pos[1], f.pos[2] + 8, p[0], p[1], pz)
        s += hidden ? 40 : 0
        s += Math.min(60, d2(p, f.pos)) * 0.5
      }
      if (d2(p, z.next_center) > z.next_radius * 0.9) s -= 50
      if (d2(p, z.center) > z.radius - 5) s -= 200
      if (s > bs) { bs = s; best = p }
    }
    return best ?? z.next_center
  }

  lootGoal(obs) {
    const me = obs.self, P = this.P
    const kinds = new Set(me.weapons.filter(Boolean).map((w) => w.kind))
    let best = null, bs = Infinity
    for (const p of obs.pickups) {
      if (p.kind === 'gun' || kinds.has(p.kind) || this.failedTakes.has(p.id)) continue
      if (Math.abs(p.pos[2] - this.map.surface(p.pos[0], p.pos[1], me.pos[2] + 1.5)) > 1.5 && p.pos[2] > me.pos[2] + 3) continue // on a roof
      const have2 = me.weapons[1] != null
      const gain = (P.weaponPref[p.kind] ?? 0) - (have2 ? P.weaponPref[me.weapons[1].kind] ?? 0 : -1)
      if (gain <= 0) continue
      const d = d2(me.pos, p.pos)
      if (d < P.lootRadius && d / gain < bs) { bs = d / gain; best = p.pos }
    }
    for (const c of obs.cubes) {
      if (Math.abs(c.pos[2] - me.pos[2]) > 3) continue
      const d = d2(me.pos, c.pos)
      if (d < P.lootRadius && d * 0.7 < bs) { bs = d * 0.7; best = c.pos }
    }
    for (const dr of obs.drops) {
      if (dr.lands_in > 8) continue
      const d = d2(me.pos, dr.pos)
      if (d < 200 && me.hp > me.max_hp * 0.4 && d * 0.5 < bs) { bs = d * 0.5; best = dr.pos }
    }
    return best
  }

  handleLoot(obs, a) {
    const me = obs.self, P = this.P
    for (const p of obs.pickups) {
      if (d2(me.pos, p.pos) > 3.8 || Math.abs(me.pos[2] - p.pos[2]) > 3.8 || p.kind === 'gun') continue
      if (this.failedTakes.has(p.id) && obs.t - this.failedTakes.get(p.id) < 3) continue
      const W = me.weapons
      if (W.some((w) => w && w.kind === p.kind)) continue
      if (!W[1]) { a.take = p.id; return }
      const cur = W[1]
      if ((P.weaponPref[p.kind] ?? 0) > (P.weaponPref[cur.kind] ?? 0) && !(cur.kind === 'laser' && cur.charge > 0)) { a.take = p.id; a.drop = 1; return }
    }
  }

  steer(pos, goal, t, obs) {
    if (d2(pos, goal) < 2.5) return [0, 0]
    if (!this.path || !this.pathGoal || d2(this.pathGoal, goal) > 10 || t - this.pathT > 3) {
      this.path = this.map.path(pos[0], pos[1], goal[0], goal[1]) ?? [goal]
      this.pathGoal = goal; this.pathT = t
    }
    while (this.path.length > 1 && d2(pos, this.path[0]) < 3.5) this.path.shift()
    const wp = this.path[0]
    const dx = wp[0] - pos[0], dy = wp[1] - pos[1], l = Math.hypot(dx, dy) || 1
    return [dx / l, dy / l]
  }

  avoidWalls(pos, dir) {
    // probe ahead; rotate the move direction if blocked
    for (const rot of [0, 0.5, -0.5, 1.0, -1.0, 1.6, -1.6, Math.PI]) {
      const c = Math.cos(rot), s = Math.sin(rot)
      const dx = dir[0] * c - dir[1] * s, dy = dir[0] * s + dir[1] * c
      const k = this.map.navCell(pos[0] + dx * 5, pos[1] + dy * 5)
      if (k >= 0 && this.map.pass[k]) return [dx, dy]
    }
    return dir
  }

  unstick(obs, a) {
    const pos = obs.self.pos
    const moving = Math.hypot(a.move[0], a.move[1]) > 0.5
    if (this.prevPos && moving && d2(this.prevPos, pos) < 0.2) this.stuck += 0.1
    else this.stuck = Math.max(0, this.stuck - 0.05)
    this.prevPos = pos
    if (this.stuck > 0.5) {
      a.jump = true
      if (this.stuck > 1.0 && obs.self.energy > 20) a.boost = true
      if (this.stuck > 2.5) { this.path = null; this.stuck = 0 }
    }
  }

  pickUpgrade(offer) {
    const pref = this.P.upgradePref
    let best = 0, br = 1e9
    offer.choices.forEach((c, i) => { const r = pref.indexOf(c.id); const rr = r < 0 ? 100 : r; if (rr < br) { br = rr; best = i } })
    return best
  }
}
