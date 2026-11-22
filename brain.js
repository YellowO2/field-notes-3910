// Decision logic (original code, MIT). One instance per match: new Brain(map, hello); act(obs) -> action.
const TAU = Math.PI * 2
const wrap = (a) => { a = (a + Math.PI) % TAU; if (a < 0) a += TAU; return a - Math.PI }
const d2 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1])
const d3 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

export const DEFAULTS = {
  fightMin: 35, fightMax: 95,       // preferred distance band to an enemy mech
  multiRetreat: false, multiHp: 0.75, // with 2+ foes engaging us, break line of sight below this hp
  farmDrones: false, farmUntil: 150, farmRadius: 160, // actively hunt remembered NPC drones early
  lightningClose: true,             // close in to lightning range when holding lightning
  retreatHp: 0.38,                  // retreat below this hp fraction when threatened
  reengageHp: 0.8,                  // come back once regenerated above this
  strafeSwitch: [0.6, 1.4],         // seconds between strafe direction changes
  lootRadius: 110, crateRadius: 70, npcRadius: 70,
  zoneMargin: 0.8, zoneLead: 14,    // be inside next circle * margin this many s before shrink
  gunAimTol: 0.9,                   // fire gun when aim error < tol * target angular radius
  upgradePref: ['plating', 'nanites', 'armor', 'laser_damage', 'gun_damage', 'gun_rate', 'laser_charge', 'lightning_efficiency', 'gyros', 'servos', 'gun_mag', 'capacitor', 'reactor', 'jets', 'sensors'],
  weaponPref: { laser: 3, lightning: 2, mortar: 1, gun: 0 },
}

import { LOOK_OFFS, PITCHES, LOOK_OBJ, SPEEDS, MOVE_DIRS } from './actions.js'
const ZONE_ASSIST = ((typeof process !== 'undefined' && process.env?.ZONE_ASSIST) || 'on') === 'on' // outside the zone: walk back in (safety net)
const MOVE_ASSIST = ((typeof process !== 'undefined' && process.env?.MOVE_ASSIST) || 'off') === 'on' // wall steering, unstick
const AIM_V2 = ((typeof process !== 'undefined' && process.env?.AIM_V2) || 'on') === 'on' // own-motion compensation + aim over cover
// Shot timing, derived from the simulator (sim/match.js): our command applies at the next physics tick; in each tick
// mechs move first, then weapons fire, then bullets fly that same tick; a decision spans 2 ticks and the gun fires in
// whichever its cooldown allows. So the target gets ~0.025 s extra lead on top of the flight time (0 if tick 1, 0.05 if
// tick 2), our muzzle has moved ~0.075 s (0.05 or 0.1), and flight starts at the barrel tip (radius + 0.5 along the aim).
// At 100 m these refinements move the aim point < 1 m against a 2.5 m mech radius, so match scores can't separate
// them. Measured gun hit rate (96 matches each): lead 0 / 0.025 / 0.05 / 0.1 / 0.15 s -> 77.6 / 79.1 / 77.7 / 80.9 / 78.4 %.
// Flat, as expected; 0.1 s was best and is used.
const LEAD_DELAY = +((typeof process !== 'undefined' && process.env?.LEAD_DELAY) || 0.1)
const SHOT_DELAY = +((typeof process !== 'undefined' && process.env?.SHOT_DELAY) || 0.075)
const AIM_BARREL = (typeof process !== 'undefined' && process.env?.AIM_BARREL) !== 'off'
const AIM_AIR = (typeof process !== 'undefined' && process.env?.AIM_AIR) !== 'off'
const AIM_UNIFIED = ((typeof process !== 'undefined' && process.env?.AIM_UNIFIED) || 'on') === 'on' // look = offset from reference (exact shot if a target is chosen, else facing)
const NTGT_ = 8
const SCRIPT_AIM = ((typeof process !== 'undefined' && process.env?.SCRIPT_AIM) || 'off') === 'on' // brain/script split: script owns aim + trigger
const FIRE_MODE = (typeof process !== 'undefined' && process.env?.FIRE_MODE) || 'raw' // raw | gated (old: 1 = fire when aimed)
const LASER_MODE = (typeof process !== 'undefined' && process.env?.LASER_MODE) || 'script' // script (default) | raw | hybrid; relay tests: raw/hybrid scored 5.02 vs script 5.92
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
    else if (P.multiRetreat && hpFrac < P.multiHp) {
      const engaging = [...this.recentAttackers.entries()].filter(([, tt]) => t - tt < 4).length
      if (engaging >= 2 || visible.length >= 2 && visible.filter((e) => d3(pos, e.pos) < 130).length >= 2) this.mode = 'retreat'
    }
    const zone = obs.zone
    const zoneGoal = this.zoneTarget(obs)

    let goal = null, faceMove = true, speed = 1, boost = false
    const fightMove = (band) => {
      // hold a distance band to the target while strafing
      faceMove = false
      const dist = d2(pos, target.pos)
      const toT = Math.atan2(target.pos[1] - pos[1], target.pos[0] - pos[0])
      if (t > this.strafeUntil) { this.strafe = this.rnd() < 0.5 ? -1 : 1; this.strafeUntil = t + P.strafeSwitch[0] + this.rnd() * (P.strafeSwitch[1] - P.strafeSwitch[0]) }
      let radial = 0
      if (dist > band[1]) radial = 1; else if (dist < band[0]) radial = -1
      const side = toT + this.strafe * Math.PI / 2
      let mx = Math.cos(side) + radial * Math.cos(toT) * 0.9, my = Math.sin(side) + radial * Math.sin(toT) * 0.9
      if (d2([pos[0] + mx * 8, pos[1] + my * 8], zone.center) > zone.radius - 5) { const zc = Math.atan2(zone.center[1] - pos[1], zone.center[0] - pos[0]); mx += Math.cos(zc); my += Math.sin(zc) }
      const l = Math.hypot(mx, my) || 1
      a.move = this.avoidWalls(pos, [mx / l, my / l])
    }
    const nearestFoe = () => foes.slice().sort((x, y) => d2(pos, x.pos) - d2(pos, y.pos))[0]
    const C = this.ctrl // low-level control from a policy: {move, boost, jump, look, target}
    if (C) return this.actLow(obs, a, C, { target, foes, zoneGoal, hpFrac, nearestFoe })
    const opt = this.option // set by an external policy (RL); null = built-in rules
    if (opt != null) {
      // high-level option chosen by a policy; staying alive in the zone always wins
      if (zoneGoal.veryUrgent) { goal = zoneGoal.p; boost = me.energy > 25; this.why = 'zone!' }
      else if (opt === 'fight' || opt === 'fightfar') {
        if (target) fightMove(opt === 'fight' ? this.preferredRange(me) : [90, 140])
        else { const f = nearestFoe(); goal = f ? f.pos : this.lootGoal(obs) ?? zoneGoal.p }
      } else if (opt === 'retreat') { goal = this.retreatPoint(obs, foes); boost = me.energy > 20 }
      else if (opt === 'farm') goal = this.lootGoal(obs) ?? zoneGoal.p
      else if (opt === 'zone') goal = zoneGoal.p
      else if (opt === 'hold') { faceMove = false; const f = nearestFoe(); if (f && !target) a.aim = [Math.atan2(f.pos[1] - pos[1], f.pos[0] - pos[0]), 0] }
      else if (opt === 'chase') { const f = nearestFoe(); goal = f ? f.pos : this.lootGoal(obs) ?? zoneGoal.p }
    } else if (zoneGoal.urgent) { goal = zoneGoal.p; boost = zoneGoal.veryUrgent && me.energy > 25; this.labelMove = 9 }
    else if (this.mode === 'retreat') {
      goal = this.retreatPoint(obs, foes)
      boost = me.energy > 20
      this.labelMove = 11
    } else if (target) { fightMove(this.preferredRange(me)); this.labelMove = -1 }
    else {
      const lg = this.lootGoal(obs)
      goal = lg ?? zoneGoal.p
      this.labelMove = lg ? 10 : 9
      if (foes.length) { // recently seen enemy: approach its last known position if healthy
        const f = nearestFoe()
        if (hpFrac > 0.7 && d2(pos, f.pos) < 160) { goal = f.pos; this.labelMove = 12 }
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
    if (opt == null) this.makeLabel(obs, a, target)
    const why = opt != null ? `[${opt}]${target ? ' →' + target.id : ''}` : zoneGoal.urgent ? 'zone' : this.mode === 'retreat' ? 'retreat' : target ? `fight ${target.id}` : goal && this.lootGoalWhy ? this.lootGoalWhy : 'roam'
    a.debug = { label: `${why} ${Math.round(hpFrac * 100)}%` }
    return a
  }

  // Express what the scripted logic just did in the policy's action format (for imitation learning).
  makeLabel(obs, a, target) {
    let move = this.labelMove ?? 0
    if (move === -1) { // direct movement (fight strafe): quantize relative to facing
      const ml = Math.hypot(a.move[0], a.move[1])
      if (ml < 0.1) move = 0
      else {
        const rel = Math.atan2(a.move[1], a.move[0]) - obs.self.aim[0]
        move = 1 + (((Math.round(rel / (Math.PI / 4)) % 8) + 8) % 8)
      }
    }
    const NT = 8
    let tgt = NT
    if (target && this.tids) { const i = this.tids.indexOf(target.id); if (i >= 0) tgt = i }
    this.label = [move, a.boost ? 1 : 0, a.jump ? 1 : 0, 0, tgt]
  }

  // ------------------------------------------------------------ low-level policy control
  // move: 0 stop | 1-8 direction relative to facing (1 fwd, 3 left, 5 back, 7 right) | 9 path to zone spot
  //       | 10 path to loot | 11 path to cover | 12 path to target. look: 0 auto | 1-26 raw yaw offset LOOK_OFFS (bot/actions.js).
  // target: index into the encoder's target slots (this.tids), or NTGT/-1 for auto.
  actLow(obs, a, C, { target, foes, zoneGoal, hpFrac, nearestFoe }) {
    const me = obs.self, pos = me.pos, t = obs.t
    if (C.target != null && this.tids && C.target < this.tids.length) {
      const pick = this.enemies.get(this.tids[C.target])
      if (pick && pick.seenNow) target = pick
    }
    let goal = null
    const yaw = me.aim[0]
    if (!me.in_zone && this.P.zoneAssist !== false && ZONE_ASSIST) goal = zoneGoal.p
    else if (this.forceGoal) goal = this.forceGoal
    else if (C.move >= 1 && C.move <= MOVE_DIRS) {
      const ang = yaw + (C.move - 1) * 2 * Math.PI / MOVE_DIRS, dir = [Math.cos(ang), Math.sin(ang)]
      a.move = MOVE_ASSIST ? this.avoidWalls(pos, dir) : dir
    } else if (C.move === MOVE_DIRS + 1) goal = zoneGoal.p
    else if (C.move === MOVE_DIRS + 2) goal = this.lootGoal(obs) ?? zoneGoal.p
    else if (C.move === MOVE_DIRS + 3) goal = this.retreatPoint(obs, foes)
    else if (C.move === MOVE_DIRS + 4) { const f = target ?? nearestFoe(); goal = f ? f.pos : zoneGoal.p }
    if (goal) a.move = this.steer(pos, goal, t, obs)
    a.boost = !!C.boost
    a.jump = !!C.jump
    if (SCRIPT_AIM) this.aimScripted(obs, a, target)
    else if (C.look === LOOK_OBJ) {
      // scripted (leading) aim at the drone or crate closest to the current aim line
      let best = null, bb = 0.6
      for (const n of obs.mechs) if (n.kind === 'npc') { const b = Math.abs(wrap(Math.atan2(n.pos[1] - pos[1], n.pos[0] - pos[0]) - yaw)); if (b < bb) { bb = b; best = { kind: 'npc', pos: [n.pos[0], n.pos[1], n.pos[2] + 1.75], vel: n.vel ?? [0, 0, 0], id: n.id } } }
      for (const c of obs.crates) { const b = Math.abs(wrap(Math.atan2(c.pos[1] - pos[1], c.pos[0] - pos[0]) - yaw)); if (b < bb) { bb = b; best = { kind: 'crate', pos: [c.pos[0], c.pos[1], c.pos[2] + 1.2], vel: [0, 0, 0], id: c.id } } }
      if (best) this.engageObject(obs, a, best); else a.aim = [yaw, 0]
    } else if (AIM_UNIFIED && target && C.target != null && C.target < NTGT_ && target.seenNow) {
      // unified aim: one look output = offset from a reference; with a chosen target the reference is the exact shot
      const ref = this.aimSolution(obs, target)
      a.aim = [ref[0] + (LOOK_OFFS[C.look] ?? 0), ref[1] + (PITCHES[C.pitch ?? 0] ?? 0)]
    } else if (C.look > 0) {
      a.aim = [yaw + LOOK_OFFS[C.look], PITCHES[C.pitch ?? 0] ?? 0]
      this.releaseLaserIfIdle(obs, a)
    } else if (target) this.engage(obs, a, target)
    else {
      const sub = this.secondaryTarget(obs)
      if (sub) this.engageObject(obs, a, sub)
      else if (t - this.lastDamage.t < 2) a.aim = [this.lastDamage.bearing, 0]
      else if (Math.hypot(a.move[0], a.move[1]) > 0.1) a.aim = [Math.atan2(a.move[1], a.move[0]), 0]
      this.releaseLaserIfIdle(obs, a)
    }
    // --- decisions now made by the policy (each falls back to the old script when the field is absent)
    if (SCRIPT_AIM) { /* trigger set by engage / engageObject */ }
    else if (C.fire && FIRE_MODE !== 'gated') { a.fire = [!!C.fire[0], !!C.fire[1]] } // raw trigger
    else if (C.fire) for (let sl = 0; sl < 2; sl++) {
      const w = me.weapons[sl]
      if (w && w.kind === 'laser' && LASER_MODE !== 'script') {
        // laser trigger chosen by the policy: 1 = hold (charge, or keep a full charge ready), 0 = let go.
        // hybrid: letting go of a charge waits (up to the auto-fire) until the aim is on the engaged target.
        if (C.fire[sl]) a.fire[sl] = true
        else if (w.charge > 0 && LASER_MODE === 'hybrid' && target && Math.abs(wrap(me.aim[0] - a.aim[0])) > 0.03) a.fire[sl] = true
        else a.fire[sl] = false
        continue
      }
      if (C.fire[sl]) continue
      a.fire[sl] = !!(w && w.kind === 'laser' && w.charge > 0) // hold: never start/fire; keep a charging laser held
    }
    if (C.slow) { const k = SPEEDS[C.slow] ?? 0.4; a.move = [a.move[0] * k, a.move[1] * k]; if (C.slow === 2) a.boost = false }
    if (C.reload != null) a.reload = !!C.reload
    if (C.take != null) {
      delete a.take; delete a.drop
      if (C.take > 0) {
        const have = new Set(me.weapons.filter(Boolean).map((w) => w.kind))
        let best = null, bd = 3.8
        for (const p of obs.pickups) {
          const d = d2(me.pos, p.pos)
          if (d < bd && Math.abs(me.pos[2] - p.pos[2]) < 3.8 && !have.has(p.kind)) { bd = d; best = p }
        }
        if (best) { a.take = best.id; if (me.weapons[0] && me.weapons[1]) a.drop = C.take === 1 ? 1 : 0 }
      }
    } else this.handleLoot(obs, a)
    if (C.upgrade != null) {
      delete a.pick
      if (obs.offer && UPG_PREF) { let best = 0, br = 1e9; obs.offer.choices.forEach((c, i) => { const r = UPG_PREF.indexOf(c.id); const rr = r < 0 ? 100 : r; if (rr < br) { br = rr; best = i } }); a.pick = best }
      else if (obs.offer && C.upgrade < obs.offer.choices.length) a.pick = C.upgrade
    }
    if (C.move !== 0 && !C.jump && MOVE_ASSIST) this.unstick(obs, a)
    a.debug = { label: `m${C.move}${C.slow ? 's' : ''}${C.boost ? 'b' : ''}${C.jump ? 'j' : ''} l${C.look} ${target ? '→' + target.id : ''}${C.fire && !C.fire[0] && !C.fire[1] ? ' hold' : ''} ${Math.round(hpFrac * 100)}%` }
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
    this.npcs ??= new Map()
    for (const m of obs.mechs) if (m.kind === 'npc') this.npcs.set(m.id, { pos: m.pos, vel: m.vel, t: obs.t, hp: m.hp })
    // remembered loot and cubes: kept for 40 s; dropped if we are close and it is no longer there
    this.pickMem ??= new Map(); this.cubeMem ??= new Map()
    const me = obs.self.pos, t = obs.t
    for (const p of obs.pickups) this.pickMem.set(p.id, { kind: p.kind, pos: p.pos, t })
    for (const c of obs.cubes) this.cubeMem.set(c.id, { pos: c.pos, t })
    for (const [mem, life, near] of [[this.pickMem, 40, 25], [this.cubeMem, 40, 18], [this.npcs, 25, 30]])
      for (const [id, o] of mem) if (o.t !== t && (t - o.t > life || Math.hypot(o.pos[0] - me[0], o.pos[1] - me[1]) < near)) mem.delete(id)
    // heard sounds (kept 5 s); idempotent per tick
    this.sounds ??= []
    if (this.soundTick !== obs.tick) {
      this.soundTick = obs.tick
      for (const x of obs.sounds ?? []) this.sounds.push({ bearing: x.bearing, kind: x.kind, dist: x.dist, t: obs.t - (x.age ?? 0) })
      this.sounds = this.sounds.filter((x) => obs.t - x.t < 5).slice(-32)
    }
    this.recentAttackers ??= new Map()
    for (const e of obs.events) if (e.type === 'damaged' && e.by != null && e.by < 100) this.recentAttackers.set(e.by, obs.t)
    for (const e of obs.events) if (e.type === 'hit' && e.target >= 100 && e.target < 1000) { const n = this.npcs.get(e.target); if (n && n.hp - e.amount <= 0) this.npcs.delete(e.target) }
    for (const e of obs.events) {
      if (e.type === 'damaged' && e.by != null && e.weapon !== 'zone') this.lastDamage = { t: obs.t, bearing: e.bearing, by: e.by, weapon: e.weapon }
      if (e.type === 'kill') this.enemies.delete(e.target)
      if (e.type === 'take_failed') this.failedTakes.set(e.id, obs.t)
    }
    for (const id of [...this.enemies.keys()]) if (obs.t - this.enemies.get(id).t > 12) this.enemies.delete(id)
  }

  preferredRange(me) {
    const kinds = me.weapons.filter(Boolean).map((w) => w.kind)
    if (kinds.includes('lightning') && this.P.lightningClose) return [18, 38]
    return [this.P.fightMin, this.P.fightMax]
  }

  // ------------------------------------------------------------ aiming
  muzzle(me, h) { return [me.pos[0], me.pos[1], me.pos[2] + (h ?? me.stats.muzzle_height)] }

  leadPoint(me, tgt, speed, zOff = 4.5) {
    // Where the target will be when the shot arrives. Timing (from the simulator): the command applies at the next
    // physics tick (see LEAD_DELAY above), the bullet starts at the barrel tip (radius + 0.5 along the aim), then flies straight.
    const s = 1 + 0.05 * (tgt.cubes ?? 0)
    const m = this.muzzle(me)
    const p = [tgt.pos[0], tgt.pos[1], tgt.pos[2] + zOff * s]
    const v = tgt.vel ?? [0, 0, 0]
    const age = (AIM_V2 ? LEAD_DELAY : 0.1) + Math.max(0, (this.now ?? 0) - tgt.t)
    const g = me.stats?.gravity ?? 30, air = AIM_AIR && Math.abs(v[2] ?? 0) > 0.5
    const at = (T) => [p[0] + v[0] * T, p[1] + v[1] * T,
      air ? p[2] + v[2] * Math.min(T, 1) - 0.5 * g * Math.min(T, 1) ** 2 : p[2] + (v[2] ?? 0) * Math.min(T, 0.3)]
    if (!speed) return at(age)
    const barrel = AIM_BARREL ? (me.stats?.radius ?? 2.5) + 0.5 : 0
    let tt = Math.max(0, d3(m, p) - barrel) / speed
    for (let k = 0; k < 4; k++) tt = Math.max(0, d3(m, at(tt + age)) - barrel) / speed
    return at(tt + age)
  }


  aimAt(me, p) {
    // the shot leaves after the next physics tick: start from where our muzzle will be by then (own motion, incl. vertical)
    const m0 = this.muzzle(me), v = me.vel ?? [0, 0, 0], L = AIM_V2 ? SHOT_DELAY : 0
    const m = [m0[0] + v[0] * L, m0[1] + v[1] * L, m0[2] + v[2] * L]
    return [Math.atan2(p[1] - m[1], p[0] - m[0]), Math.atan2(p[2] - m[2], Math.hypot(p[0] - m[0], p[1] - m[1]))]
  }

  aimErr(me, aim) { return Math.hypot(wrap(me.aim[0] - aim[0]), me.aim[1] - aim[1]) }

  // the exact shot solution for a target (what the scripted engage would aim at), without touching the real action
  aimSolution(obs, tgt) {
    const me = obs.self, tmp = { aim: [me.aim[0], me.aim[1]], fire: [false, false] }
    this.engage(obs, tmp, tgt)
    return tmp.aim
  }

  engage(obs, a, tgt) {
    this.now = obs.t
    const me = obs.self, W = me.weapons, P = this.P
    const slot = (k) => W.findIndex((w) => w && w.kind === k)
    const gs = slot('gun'), ls = slot('laser'), zs = slot('lightning'), ms = slot('mortar')
    const dist = d3(me.pos, tgt.pos)
    const m = this.muzzle(me)
    const sc = 1 + 0.05 * (tgt.cubes ?? 0)
    const losMid = this.map.los(m[0], m[1], m[2], tgt.pos[0], tgt.pos[1], tgt.pos[2] + 4.5 * sc)
    // aim at the middle; if cover hides it but the upper body is exposed, aim there instead
    const zAim = !AIM_V2 || losMid ? 4.5 : this.map.los(m[0], m[1], m[2], tgt.pos[0], tgt.pos[1], tgt.pos[2] + 7.6 * sc) ? 7.6 : 4.5
    const clear = tgt.seenNow && (losMid || (AIM_V2 && zAim === 7.6))
    const angR = Math.atan2(2.5 * sc, Math.max(dist, 1))
    // primary aim: gun lead
    let aim = this.aimAt(me, this.leadPoint(me, tgt, W[gs]?.stats.speed ?? 252, zAim))
    if (ls >= 0 && (W[ls].charge > 0)) aim = this.aimAt(me, this.leadPoint(me, tgt, 0, zAim))
    if (zs >= 0 && dist < 50) aim = this.aimAt(me, this.leadPoint(me, tgt, 0, zAim))
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
    if (ls >= 0 && W[ls].charge > 0 && a.fire[ls] !== true) a.fire[ls] = W[ls].charge < W[ls].stats.charge // keep charging toward full, then let go (holding the charge scored worse: 5.67 vs 5.92)
  }

  secondaryTarget(obs) {
    const me = obs.self, P = this.P
    // crates and drones for cubes when nothing else is happening
    let best = null, bd = Infinity
    for (const c of obs.crates) { const d = d3(me.pos, c.pos); if (d < P.crateRadius && d < bd) { best = { kind: 'crate', pos: [c.pos[0], c.pos[1], c.pos[2] + 1.2], vel: [0, 0, 0], id: c.id }; bd = d } }
    if (me.hp > me.max_hp * 0.6)
      for (const n of obs.mechs) if (n.kind === 'npc') { const d = d3(me.pos, n.pos); if (d < (P.farmDrones && obs.t < P.farmUntil ? 120 : P.npcRadius) && d < bd + 20) { best = { kind: 'npc', pos: [n.pos[0], n.pos[1], n.pos[2] + 1.75], vel: n.vel, id: n.id }; bd = d } }
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
    this.lootGoalWhy = null
    for (const p of obs.pickups) {
      if (p.kind === 'gun' || kinds.has(p.kind) || this.failedTakes.has(p.id)) continue
      if (Math.abs(p.pos[2] - this.map.surface(p.pos[0], p.pos[1], me.pos[2] + 1.5)) > 1.5 && p.pos[2] > me.pos[2] + 3) continue // on a roof
      const have2 = me.weapons[1] != null
      const gain = (P.weaponPref[p.kind] ?? 0) - (have2 ? P.weaponPref[me.weapons[1].kind] ?? 0 : -1)
      if (gain <= 0) continue
      const d = d2(me.pos, p.pos)
      if (d < P.lootRadius && d / gain < bs) { bs = d / gain; best = p.pos; this.lootGoalWhy = `get ${p.kind}` }
    }
    for (const c of obs.cubes) {
      if (Math.abs(c.pos[2] - me.pos[2]) > 3) continue
      const d = d2(me.pos, c.pos)
      if (d < P.lootRadius && d * 0.7 < bs) { bs = d * 0.7; best = c.pos; this.lootGoalWhy = 'cube' }
    }
    if (P.farmDrones && obs.t < P.farmUntil && me.hp > me.max_hp * 0.7 && this.npcs) {
      for (const [id, n] of this.npcs) {
        if (obs.t - n.t > 60) continue
        const d = d2(me.pos, n.pos)
        if (d < P.farmRadius && d * 0.9 < bs) { bs = d * 0.9; best = [n.pos[0], n.pos[1], n.pos[2]]; this.lootGoalWhy = `farm ${id}` }
      }
    }
    for (const dr of obs.drops) {
      if (dr.lands_in > 8) continue
      const d = d2(me.pos, dr.pos)
      if (d < 200 && me.hp > me.max_hp * 0.4 && d * 0.5 < bs) { bs = d * 0.5; best = dr.pos; this.lootGoalWhy = 'drop' }
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

  // Path directions to the movement helpers' goals (zone, loot, cover, nearest foe), from our A* with a per-goal cache.
  // One stale goal is re-planned per tick (round robin) so the cost stays small. Used as network inputs and to label
  // teacher moves that follow one of these paths. Returns [{dir, len} | null] x 4, in helper order (move 33..36).
  navInfo(obs) {
    if (this._navTick === obs.tick && this._nav) return this._nav
    const me = obs.self, pos = me.pos, t = obs.t
    const foes = [...this.enemies.values()].filter((e) => t - e.t < 4.5)
    const near = foes.slice().sort((x, y) => d2(pos, x.pos) - d2(pos, y.pos))[0]
    const goals = [this.zoneTarget(obs).p, this.lootGoal(obs) ?? null, foes.length ? this.retreatPoint(obs, foes) : null, near ? near.pos : null]
    this._navCache ??= [null, null, null, null]
    this._navRR = ((this._navRR ?? -1) + 1) % 4
    const res = goals.map((g, i) => {
      if (!g) { this._navCache[i] = null; return null }
      let c = this._navCache[i]
      const moved = !c || d2(c.goal, g) > 10
      if (!c || (i === this._navRR && (moved || t - c.t > 1))) {
        const path = d2(pos, g) < 120 && this.map.clearWalk(pos, g) ? [g] : (this.map.path(pos[0], pos[1], g[0], g[1], { maxExpand: 6000 }) ?? [g])
        c = this._navCache[i] = { goal: g, path: path.slice(), t }
      }
      while (c.path.length > 1 && d2(pos, c.path[0]) < 3.5) c.path.shift()
      const wp = c.path[0]
      let len = d2(pos, wp)
      for (let k = 1; k < c.path.length; k++) len += d2(c.path[k - 1], c.path[k])
      return { dir: Math.atan2(wp[1] - pos[1], wp[0] - pos[0]), len }
    })
    this._navTick = obs.tick; this._nav = res
    return res
  }

  steer(pos, goal, t, obs) {
    if (d2(pos, goal) < 2.5) return [0, 0]
    if (!this.path || !this.pathGoal || d2(this.pathGoal, goal) > 10 || t - this.pathT > 3) {
      // straight line when walkable, else A* (bounded search)
      this.path = d2(pos, goal) < 120 && this.map.clearWalk(pos, goal) ? [goal] : this.map.path(pos[0], pos[1], goal[0], goal[1], { maxExpand: 12000 }) ?? [goal]
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

  // SCRIPT_AIM: aim, trigger and laser timing are scripted; the policy only picks target, movement, loot, upgrades
  aimScripted(obs, a, target) {
    if (target) return this.engage(obs, a, target)
    const sub = this.secondaryTarget(obs)
    if (sub) this.engageObject(obs, a, sub)
    else if (obs.t - this.lastDamage.t < 2) a.aim = [this.lastDamage.bearing, 0]
    else if (Math.hypot(a.move[0], a.move[1]) > 0.1) a.aim = [Math.atan2(a.move[1], a.move[0]), 0]
    this.releaseLaserIfIdle(obs, a)
  }

  pickUpgrade(offer) {
    const pref = this.P.upgradePref
    let best = 0, br = 1e9
    offer.choices.forEach((c, i) => { const r = pref.indexOf(c.id); const rr = r < 0 ? 100 : r; if (rr < br) { br = rr; best = i } })
    return best
  }
}

// laser first (default on, R = 300 m; MECH_LASER=0 turns it off): with no laser held and hp > 50%, walk to a remembered laser pickup within R m and take it.
// The policy's other heads (aim, fire) still apply. R = 0 turns it off.
export const LASER_R = +(globalThis.process?.env?.MECH_LASER ?? 300)
export function laserFirst(b, obs, R) {
  const me = obs?.self
  b.forceGoal = null
  if (!me || me.weapons.some((w) => w && w.kind === 'laser') || me.hp < me.max_hp * 0.5 || !b.pickMem) return
  let best = null, bd = R
  for (const p of b.pickMem.values()) {
    if (p.kind !== 'laser' || Math.abs(p.pos[2] - me.pos[2]) > 3) continue
    const d = Math.hypot(p.pos[0] - me.pos[0], p.pos[1] - me.pos[1])
    if (d < bd) { bd = d; best = p }
  }
  if (best) { b.forceGoal = best.pos; if (bd < 3.5) b.ctrl.take = 1; return }
  // cube first (MECH_CUBE=R): no enemy seen within 50 m -> walk to the nearest remembered cube within R m
  if (!CUBE_R || !b.cubeMem) return
  for (const e of b.enemies.values()) if (e.seenNow && Math.hypot(e.pos[0] - me.pos[0], e.pos[1] - me.pos[1]) < 50) return
  bd = CUBE_R
  for (const c of b.cubeMem.values()) {
    if (Math.abs(c.pos[2] - me.pos[2]) > 3) continue
    const d = Math.hypot(c.pos[0] - me.pos[0], c.pos[1] - me.pos[1])
    if (d < bd) { bd = d; best = c }
  }
  if (best) b.forceGoal = best.pos
}
export const CUBE_R = +(globalThis.process?.env?.MECH_CUBE ?? 0)
// MECH_UPG=1 (test): fixed upgrade order instead of the policy's upgrade head
export const UPG_PREF = globalThis.process?.env?.MECH_UPG === '1' ? ['nanites', 'armor', 'plating', 'servos', 'laser_damage', 'gun_damage', 'reactor', 'laser_charge', 'gun_rate', 'capacitor'] : null

// range keeping (RANGE_KEEP=on): while a visible enemy is within 300 m and hp > 40%, the script positions us at a
// distance that suits our weapons (laser 125-185 m: out of reach of dodgeable gun fire; gun 45-85 m; lightning 12-36 m),
// overriding the policy's movement. Call after laserFirst (a laser run keeps priority).
export const RANGE_KEEP = (globalThis.process?.env?.RANGE_KEEP ?? 'off') === 'on'
export function rangeKeep(b, obs) {
  const me = obs?.self
  if (!me || b.forceGoal || me.hp < me.max_hp * 0.4 || !b.enemies) return
  let f = null, fd = 300
  for (const e of b.enemies.values()) {
    if (!e.seenNow) continue
    const d = Math.hypot(e.pos[0] - me.pos[0], e.pos[1] - me.pos[1])
    if (d < fd || e.id === b.lastTarget && d < 300) { fd = d; f = e; if (e.id === b.lastTarget) break }
  }
  if (!f) return
  const has = (k) => me.weapons.some((w) => w && w.kind === k)
  const theirs = new Set(f.weapons ?? [])
  let rmin = 45, rmax = 85
  if (has('laser')) { rmin = 125; rmax = 185 }
  else if (has('lightning') && me.energy > 25) { rmin = 12; rmax = 36 }
  else if (theirs.has('laser')) { rmin = 30; rmax = 60 }
  if (theirs.has('lightning') && !has('lightning')) rmin = Math.max(rmin, 60)
  if (f.hp != null && f.maxHp && f.hp < 0.3 * f.maxHp && me.hp > 0.5 * me.max_hp) rmax = Math.min(rmax, 45)
  rmax = Math.max(rmax, rmin + 15)
  if (fd > rmax + 4) b.forceGoal = f.pos
  else if (fd < rmin - 4) { const foes = [...b.enemies.values()].filter((e) => obs.t - e.t < 4.5); b.forceGoal = b.retreatPoint(obs, foes) ?? null }
  else b.forceGoal = me.pos
}
