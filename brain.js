import { GoRand } from './gorand.js'
import { nbrs, goHypot, goAtan2, goSin, goCos, goAtan } from './world.js'

const LAT = 0.075
const PI = Math.PI
const hyp = (x, y) => goHypot(x, y)
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const angDiff = (a, b) => {
  let d = (a - b) % (2 * PI)
  if (d > PI) d -= 2 * PI
  else if (d < -PI) d += 2 * PI
  return d
}
const WEAPON_STATS = ['damage', 'cooldown', 'speed', 'range', 'mag', 'reload', 'splash_radius', 'gravity', 'charge', 'min_charge', 'min_frac', 'hold_s', 'cookoff', 'cone_deg', 'energy']
const zeroStats = (s = {}) => { const o = { ...s }; for (const k of WEAPON_STATS) o[k] ??= 0; return o }
const holds = (list, kind) => list.includes(kind)
const findWeapon = (ws, kind) => { const i = ws.findIndex((w) => w && w.kind === kind); return [i, i >= 0 ? ws[i] : null] }

const ORDER = ['plating', 'armor', 'gun_damage', 'nanites', 'gun_rate', 'lightning_efficiency', 'lightning_range', 'laser_damage', 'servos', 'laser_charge', 'gun_mag', 'gun_velocity', 'gyros', 'lightning_chain', 'reactor', 'capacitor', 'mortar_reload', 'mortar_splash', 'mortar_velocity', 'sensors', 'jets', 'laser_pierce']
const ORDER_LASER = ['plating', 'armor', 'laser_damage', 'laser_charge', 'nanites', 'gun_damage', 'gun_rate', 'lightning_efficiency', 'lightning_range', 'servos', 'gun_mag', 'gun_velocity', 'gyros', 'lightning_chain', 'reactor', 'capacitor', 'mortar_reload', 'mortar_splash', 'mortar_velocity', 'sensors', 'jets', 'laser_pierce']
const WEAPON_RANK = { lightning: 3, laser: 2, mortar: 1 }

export const BASE = {
  retreatHP: 0.38, recoverHP: 0.8, gunRange: 85, lightRange: 28, laserRange: 85, engageDist: 60, farmNPC: true, ghost: true, homeExpo: 120,
  lootRadius: 90, crateUntil: 150, dodge: true, noMortar: true, peek: true, laserFirst: false, crowdHide: true, practice: true, opening: true,
  laserSeek: 0, stick: 0, hpw: 0, lowBonus: 0, maxTarget: 0, loseRule: false, fightLoot: 0, farmHP: 0, laserUp: false, finish: 0,
}
const squad = (p) => ({ ...p, ghost: false, peek: false, laserFirst: true, laserRange: 120, lootRadius: 150, crateUntil: 1e9, stick: 120, hpw: 0.2, lowBonus: 100, maxTarget: 240, loseRule: true, fightLoot: 40, farmHP: 0.5, laserSeek: 240, laserUp: true, finish: 20 })

function normalize(o, cfg) {
  const me = o.self
  const stats = me.stats && me.stats.radius ? me.stats : cfg.mech
  const weapons = (me.weapons ?? []).map((w) => (w ? { kind: w.kind ?? '', cooldown: w.cooldown ?? 0, ammo: w.ammo ?? 0, reload: w.reload ?? 0, charge: w.charge ?? 0, stats: zeroStats(w.stats) } : null))
  const self = { ...me, stats, weapons, hp: me.hp ?? 0, max_hp: me.max_hp ?? 0, energy: me.energy ?? 0, max_energy: me.max_energy ?? 0, cubes: me.cubes ?? 0, grounded: !!me.grounded, in_zone: !!me.in_zone, vel: me.vel ?? [0, 0, 0], aim: me.aim ?? [0, 0] }
  const mechs = (o.mechs ?? []).map((m) => ({ id: m.id, kind: m.kind ?? '', pos: m.pos, vel: m.vel ?? [0, 0, 0], aim: m.aim ?? [0, 0], hp: m.hp ?? 0, max_hp: m.max_hp ?? 0, cubes: m.cubes ?? 0, weapons: m.weapons ?? [], charging: !!m.charging }))
  const items = (l) => (l ?? []).map((it) => ({ id: it.id, kind: it.kind ?? '', pos: it.pos, hp: it.hp ?? 0 }))
  return { ...o, self, mechs, projectiles: o.projectiles ?? [], crates: items(o.crates), cubes: items(o.cubes), pickups: items(o.pickups), events: o.events ?? [], drops: o.drops ?? [], alive: o.alive ?? 0 }
}

export class GiddyBrain {
  constructor(hello, world) {
    this.W = world
    this.cfg = hello.config
    this.cfg.npc ??= {}
    this.slot = hello.slot
    this.rng = new GoRand(hello.seed ? hello.seed : hello.slot + 1)
    this.P = { ...BASE }
    this.base = null
    this.tracks = new Map()
    this.npcs = new Map()
    this.crates = new Map()
    this.cubes = new Map()
    this.pickups = new Map()
    this.bad = new Map()
    this.now = 0
    this.path = null
    this.pathGoal = [0, 0]
    this.pathAt = 0
    this.pathI = 0
    this.strafe = 1
    this.strafeUntil = 0
    this.retreat = false
    this.coverAt = 0
    this.coverGoal = [0, 0]
    this.coverOK = false
    this.lastHurt = -100
    this.hurtBearing = 0
    this.lootID = -1
    this.lootSince = 0
    this.hold = { x: 0, y: 0, r: 0 }
    this.holdStart = -1
    this.homeXY = [0, 0]
    this.homeAt = 0
    this.homeSet = false
    this.stuckSince = 0
    this.unstuckUntil = 0
    this.unstuckDir = [0, 0]
    this.lastThreatAt = -100
    this.lastAim = [0, 0]
    this.mode = ''
    this.esc = { launch: [0, 0], land: [0, 0], at: 0, ok: false, flying: false }
    this.pracOn = false
    this.openOn = false
    this.npcHurt = 0
    this.npcBearing = 0
    this.notPractice = false
    this.startAlive = 0
    this.kills = 0
    this.otherDead = 0
    this.stickID = 0
    this.stickAt = 0
    this.loseAt = 0
    this.ctl = null
  }

  act(raw) {
    const o = normalize(raw, this.cfg)
    const act = { tick: o.tick, move: [0, 0], boost: false, jump: false, fire: [false, false], reload: false }
    try {
      this.step(o, act)
    } catch {
      return { tick: o.tick, move: [0, 0], boost: false, jump: false, aim: [...this.lastAim], fire: [false, false], reload: false }
    }
    if (act.aim) {
      if (!Number.isFinite(act.aim[0]) || !Number.isFinite(act.aim[1])) delete act.aim
      else this.lastAim = [...act.aim]
    }
    if (!Number.isFinite(act.move[0]) || !Number.isFinite(act.move[1])) act.move = [0, 0]
    return act
  }

  scaleOf(cubes) { return 1 + (this.cfg.cubes.size_per_cube ?? 0) * cubes }
  center(t) {
    const h = t.kind === 'npc' ? this.cfg.npc.height ?? 0 : this.cfg.mech.height * this.scaleOf(t.cubes)
    return [t.pos[0], t.pos[1], t.pos[2] + h * 0.5]
  }
  eye(t) { return [t.pos[0], t.pos[1], t.pos[2] + this.cfg.mech.eye_height * this.scaleOf(t.cubes ?? 0)] }

  observe(o) {
    const me = o.self, now = o.t, W = this.W
    const eye = [me.pos[0], me.pos[1], me.pos[2] + me.stats.eye_height]
    const muzzle = [me.pos[0], me.pos[1], me.pos[2] + me.stats.muzzle_height]
    for (const m of o.mechs) {
      const tab = m.kind === 'npc' ? this.npcs : this.tracks
      let t = tab.get(m.id)
      if (!t) { t = { hitMe: -100, closing: 0 }; tab.set(m.id, t) }
      Object.assign(t, m)
      t.seen = now
      const dx = m.pos[0] - me.pos[0], dy = m.pos[1] - me.pos[1]
      t.dist = hyp(dx, dy)
      t.los = W.clear(muzzle, this.center(t))
      if (!t.los && m.kind === 'mech') t.los = W.clear(muzzle, [m.pos[0], m.pos[1], m.pos[2] + this.cfg.mech.height * this.scaleOf(m.cubes) * 0.85])
      if (t.dist > 1) t.closing = -((m.vel[0] - me.vel[0]) * dx + (m.vel[1] - me.vel[1]) * dy) / t.dist
    }
    for (const [id, t] of this.tracks) if (now - t.seen > 20) this.tracks.delete(id)
    for (const [id, t] of this.npcs) if (now - t.seen > 120) this.npcs.delete(id)
    const upd = (tab, items) => {
      for (const it of items) {
        let k = tab.get(it.id)
        if (!k) { k = { id: it.id }; tab.set(it.id, k) }
        Object.assign(k, { kind: it.kind, pos: it.pos, hp: it.hp, seen: now })
      }
      for (const [id, k] of tab) {
        if (k.seen === now) continue
        if (hyp(k.pos[0] - me.pos[0], k.pos[1] - me.pos[1]) < 40 && now - k.seen > 0.35 && W.clear(eye, [k.pos[0], k.pos[1], k.pos[2] + 1.5])) tab.delete(id)
      }
    }
    upd(this.crates, o.crates)
    upd(this.cubes, o.cubes)
    upd(this.pickups, o.pickups)
    for (const e of o.events) {
      if (e.type === 'damaged') {
        if (e.weapon === 'npc' && e.bearing != null) { this.npcHurt = now; this.npcBearing = e.bearing }
        if (e.by != null) {
          this.lastHurt = now
          if (e.bearing != null) this.hurtBearing = e.bearing
          const t = this.tracks.get(e.by)
          if (t) t.hitMe = now
          const n = this.npcs.get(e.by)
          if (n) n.hitMe = now
        }
      } else if (e.type === 'kill') {
        this.kills++
        this.tracks.delete(e.target ?? 0)
      }
    }
    if (!this.base) { this.base = { ...this.P }; this.startAlive = o.alive }
    this.otherDead = this.startAlive - o.alive - this.kills > 0 ? this.otherDead + 1 : 0
    if (this.otherDead >= 5) this.notPractice = true
    const on = this.base.practice && !this.notPractice && now > 20
    if (on !== this.pracOn) { this.pracOn = on; this.P = on ? squad(this.base) : { ...this.base } }
    const open = this.base.opening && !this.notPractice && !this.pracOn && this.startAlive - o.alive - this.kills <= 0
    if (open !== this.openOn) {
      this.openOn = open
      this.P = open ? { ...this.base, laserFirst: true, laserSeek: 240, lootRadius: 150 } : this.pracOn ? squad(this.base) : { ...this.base }
    }
    const z = o.zone
    if (this.holdStart !== z.shrink_start) { this.holdStart = z.shrink_start; this.hold = { x: z.center[0], y: z.center[1], r: z.radius } }
    else if (now <= z.shrink_start) this.hold = { x: z.center[0], y: z.center[1], r: z.radius }
  }

  zoneAt(z, t) {
    if (t <= z.shrink_start || z.shrink_end <= z.shrink_start) return this.hold
    const f = clamp((t - z.shrink_start) / (z.shrink_end - z.shrink_start), 0, 1), h = this.hold
    return { x: h.x + (z.next_center[0] - h.x) * f, y: h.y + (z.next_center[1] - h.y) * f, r: h.r + (z.next_radius - h.r) * f }
  }

  curZone(z) {
    const live = { x: z.center[0], y: z.center[1], r: z.radius }
    if (this.now <= z.shrink_start || Math.abs(live.r - this.hold.r) > 0.01 || Math.abs(live.x - this.hold.x) > 0.01) return live
    return this.zoneAt(z, this.now)
  }

  zoneDeadline(z, x, y, pad) {
    if (hyp(x - z.next_center[0], y - z.next_center[1]) <= z.next_radius - pad) return Infinity
    for (let k = 0; k <= 24; k++) {
      const t = z.shrink_start + ((z.shrink_end - z.shrink_start) * k) / 24
      const c = this.zoneAt(z, t)
      if (hyp(x - c.x, y - c.y) > c.r - pad) return t
    }
    return z.shrink_end
  }

  zonePenalty(z, x, y) {
    const c = this.curZone(z)
    let p = 0
    const d = hyp(x - c.x, y - c.y) - c.r
    if (d > -5) p += 150 + 5 * (d + 5)
    const dn = hyp(x - z.next_center[0], y - z.next_center[1]) - z.next_radius
    if (dn > -5) p += clamp(1 - (z.shrink_start - this.now) / 25, 0.1, 1) * (25 + 0.8 * (dn + 5))
    return p
  }

  zoneGoal(z, x, y) {
    const margin = clamp(0.3 * z.next_radius, 3, 30)
    if (z.next_radius <= 30) return [z.next_center[0], z.next_center[1]]
    const dx = x - z.next_center[0], dy = y - z.next_center[1], d = hyp(dx, dy)
    if (d < 1) return [x, y]
    const r = Math.max(0, z.next_radius - margin - 5)
    if (d <= r) return [x, y]
    return [z.next_center[0] + (dx / d) * r, z.next_center[1] + (dy / d) * r]
  }

  pickUpgrade(offer) {
    const order = this.P.laserUp ? ORDER_LASER : ORDER
    let best = 0, bestRank = 1 << 30
    offer.choices.forEach((c, i) => {
      const r = order.indexOf(c.id)
      const rank = r < 0 ? order.length : r
      if (rank < bestRank) { best = i; bestRank = rank }
    })
    return best
  }

  step(o, act) {
    const me = o.self, now = o.t, W = this.W
    this.now = now
    this.observe(o)
    const st = me.stats, [x, y, zf] = me.pos, z = o.zone
    const hpFrac = me.hp / Math.max(1, me.max_hp)
    if (o.offer && o.offer.choices?.length) act.pick = this.pickUpgrade(o.offer)
    const [, gun] = findWeapon(me.weapons, 'gun'), [, light] = findWeapon(me.weapons, 'lightning'), [, laser] = findWeapon(me.weapons, 'laser')
    const late = z.next_radius <= 70 || o.alive <= 3
    const ctl = this.ctl

    const seen = []
    let target = null, hidden = null, bestScore = Infinity
    const maxT = this.P.maxTarget > 0 ? this.P.maxTarget : 215, hpw = this.P.hpw > 0 ? this.P.hpw : 60 / 1400
    for (const t of this.tracks.values()) {
      if (now - t.seen > 2.5) continue
      t.engage = false
      seen.push(t)
      if (t.seen !== now) { t.los = false; continue }
      const toMe = goAtan2(y - t.pos[1], x - t.pos[0])
      const aimed = Math.abs(angDiff(t.aim[0], toMe)) < 0.22
      if (this.P.ghost) t.engage = t.dist < this.P.engageDist || now - t.hitMe < 4 || (aimed && t.charging && t.dist < 120) || (t.hp < 350 && t.dist < 120) || o.alive <= 2
      else t.engage = t.dist < this.P.engageDist || now - t.hitMe < 6 || late || (t.closing > 3 && t.dist < 180) || (t.hp < 0.4 * t.max_hp && t.dist < 160) || (aimed && t.dist < 190)
      if (ctl && ctl.engage === 1) t.engage = t.engage || t.dist < maxT
      if (t.engage && !t.los && t.dist < maxT && (!hidden || t.dist < hidden.dist)) hidden = t
      if (!t.engage || !t.los || t.dist > maxT) continue
      let s = t.dist + hpw * t.hp
      if (this.P.lowBonus > 0 && t.hp <= 0.3 * t.max_hp) s -= this.P.lowBonus
      if (this.P.stick > 0 && t.id === this.stickID && now - this.stickAt < 2) s -= this.P.stick
      if (now - t.hitMe < 4) s -= 40
      if (t.closing > 3) s -= 15
      if (ctl && t.id === ctl.target) s -= 1e6
      if (s < bestScore) { bestScore = s; target = t }
    }
    if (target) { this.stickID = target.id; this.stickAt = now }
    const foe = target ?? (this.P.peek ? hidden : null)
    let danger = false, crowd = 0
    for (const t of seen) {
      if (t.engage || now - t.hitMe < 4) danger = true
      if (t.seen === now && (t.engage || (t.los && t.dist < 150))) crowd++
    }
    if (danger || now - this.lastHurt < 3) this.lastThreatAt = now

    const finishing = !!target && target.dist < 120 && (target.hp < 200 || target.hp < me.hp * 0.5)
    const outgunned = !!target && holds(target.weapons, 'laser') && !laser && target.dist > 55 && hpFrac < 0.8
    const swamped = this.P.crowdHide && (crowd >= 3 || (crowd === 2 && hpFrac < 0.65) || outgunned)
    if (!this.retreat && ((hpFrac < this.P.retreatHP && now - this.lastThreatAt < 2) || swamped)) { this.retreat = true; this.coverAt = -1 }
    if (this.retreat && !swamped && (hpFrac > this.P.recoverHP || (now - this.lastThreatAt > 7 && hpFrac > 0.55))) this.retreat = false
    if (this.P.loseRule) {
      const near = seen.filter((t) => t.seen === now && t.dist < 160).length
      let losing = (near >= 2 && hpFrac < 0.55) || (near >= 3 && hpFrac < 0.8)
      if (target) {
        const tf = target.hp / Math.max(1, target.max_hp)
        if (hpFrac < 0.35 && tf > hpFrac + 0.1) losing = true
        if (tf < 0.25 && hpFrac > 0.2 && near <= 2) losing = false
      }
      if (losing) this.loseAt = now
      this.retreat = now - this.loseAt < 1.5 && this.loseAt > 0
    }
    if (ctl && ctl.stance === 1) this.retreat = false
    else if (ctl && ctl.stance === 2 && seen.length) this.retreat = true

    let mx = 0, my = 0, boost = false, mode = 'idle', farm = null, farmPos = null
    const [zgx, zgy] = this.zoneGoal(z, x, y)
    const zdist = hyp(zgx - x, zgy - y)
    const tNeed = (zdist * 1.45) / st.walk_speed + 4
    const deadline = this.zoneDeadline(z, x, y, 8)
    const zoneMust = !me.in_zone || now + tNeed + 3 >= deadline
    const zoneShould = now + tNeed + 14 >= deadline
    const set = (m) => { mx = m[0]; my = m[1] }
    const esc = this.escape(me)

    if (esc) { set(esc.move); boost = esc.boost; mode = 'escape'; if (esc.jump) act.jump = true }
    else if (now < this.unstuckUntil) { set(this.unstuckDir); mode = 'unstuck' }
    else if (this.dodgeShell(o, set)) { boost = me.energy > 15; mode = 'dodge' }
    else if (zoneMust && zdist > 2) { set(this.travel(me, zgx, zgy)); boost = (!me.in_zone || now + tNeed >= deadline) && me.energy > 5; mode = 'zone' }
    else if (this.retreat && !finishing && !late) {
      if (this.coverMove(o, seen, set)) { boost = me.energy > 10 && (mx !== 0 || my !== 0); mode = 'cover' }
      else if (target) { set(this.fightMove(o, target, seen, 1)); mode = 'cornered' }
      else {
        set(this.travel(me, zgx, zgy))
        if (this.npcHurt > 0 && now - this.npcHurt < 3 && mx === 0 && my === 0) {
          const side = now % 3 > 1.5 ? -1 : 1
          set([-goSin(this.npcBearing) * side, goCos(this.npcBearing) * side])
        }
        mode = 'flee'
      }
    } else if (!target && now - this.lastHurt < 2.5 && !late && this.P.ghost && this.hideFromBearing(o, seen, set)) { boost = me.energy > 30 && (mx !== 0 || my !== 0); mode = 'cover' }
    else if (foe) {
      let ready = !!gun && gun.ammo > 0 && gun.reload <= 0.25 && foe.dist <= gun.stats.range - 10
      const hot = !!laser && laser.charge >= laser.stats.charge - 0.3 && foe.dist <= laser.stats.range - 5
      if (hot || (light && foe.dist <= light.stats.range + 6 && me.energy >= light.stats.energy * 3)) ready = true
      if (!this.P.peek && (light || laser)) ready = true
      let wantLos = ready ? 1 : -1
      if (this.P.peek && !hot && seen.some((t) => t.seen === now && t.charging && Math.abs(angDiff(t.aim[0], goAtan2(y - t.pos[1], x - t.pos[0]))) < 0.3)) wantLos = -1.6
      if (this.P.finish > 0 && foe.hp < 0.38 * foe.max_hp && hpFrac > 0.42 && crowd <= 2) {
        const keep = this.P
        this.P = { ...keep, gunRange: keep.finish, laserRange: keep.finish, lightRange: keep.finish }
        set(this.fightMove(o, foe, seen, wantLos))
        this.P = keep
      } else set(this.fightMove(o, foe, seen, wantLos))
      if (light && foe.dist > 50 && me.energy > 55 && wantLos > 0) boost = true
      mode = 'fight'
      if (this.P.fightLoot > 0) {
        let r = this.P.fightLoot * (hpFrac <= 0.5 ? 0.57 : 1), bc = null
        for (const c of this.cubes.values()) { const d = hyp(c.pos[0] - x, c.pos[1] - y); if (d < r) { r = d; bc = c.pos } }
        if (bc) { set(this.travel(me, bc[0], bc[1])); mode = 'fight:cube' }
      }
    } else if (zoneShould && zdist > 2) { set(this.travel(me, zgx, zgy)); mode = 'zone' }
    else {
      const lc = this.chooseLoot(o, hpFrac, danger)
      if (lc) {
        mode = 'loot:' + lc.kind
        if (lc.kind === 'npc') {
          const t = this.npcs.get(lc.id)
          if (t && now - t.seen < 1 && t.los && t.dist < 75) { farm = t; set(this.fightMove(o, t, seen, 1)) }
          else set(this.travel(me, lc.pos[0], lc.pos[1]))
        } else if (lc.kind === 'crate') {
          const d = hyp(lc.pos[0] - x, lc.pos[1] - y)
          const cp = [lc.pos[0], lc.pos[1], lc.pos[2] + this.cfg.crates.height * 0.5]
          if (d < 50 && W.clear([x, y, zf + st.muzzle_height], cp)) {
            farmPos = cp
            if (d < 12) set([(x - lc.pos[0]) / Math.max(d, 0.1), (y - lc.pos[1]) / Math.max(d, 0.1)])
          } else set(this.travel(me, lc.pos[0], lc.pos[1]))
        } else {
          set(this.travel(me, lc.pos[0], lc.pos[1]))
          if (lc.kind === 'drop' && hyp(lc.pos[0] - x, lc.pos[1] - y) < 2.5) set([0, 0])
        }
      } else if (zdist > 3 && (!this.P.ghost || z.next_radius <= 30)) { set(this.travel(me, zgx, zgy)); mode = 'zone-walk' }
      else if (this.P.ghost) {
        const [hx, hy, ok] = this.home(o)
        if (ok && hyp(hx - x, hy - y) > 3) {
          set(this.travel(me, hx, hy))
          if (!danger && now - this.lastHurt > 6 && !this.openOn) { const q = Math.min(1, 4.6 / st.walk_speed); mx *= q; my *= q }
          mode = 'home'
        }
      }
    }

    if (this.P.dodge && mode !== 'unstuck' && mode !== 'escape') {
      const [dx, dy, lz] = this.dodge(o)
      if (dx !== 0 || dy !== 0) {
        mx = mx * 0.4 + dx * 0.9; my = my * 0.4 + dy * 0.9
        const l = hyp(mx, my)
        if (l > 1) { mx /= l; my /= l }
        if (lz && me.energy > 25) boost = true
      }
    }
    if (mode === 'escape') this.stuckSince = -1
    else if ((mx !== 0 || my !== 0) && hyp(me.vel[0], me.vel[1]) < 1.2 && me.grounded) {
      if (this.stuckSince < 0) this.stuckSince = now
      else if (now - this.stuckSince > 0.7) {
        const a = this.rng.float64() * 2 * PI
        this.unstuckDir = [goCos(a), goSin(a)]
        this.unstuckUntil = now + 0.5
        this.stuckSince = -1
        this.path = null
        act.jump = true
      }
    } else this.stuckSince = -1

    const muzzle = [x + me.vel[0] * LAT, y + me.vel[1] * LAT, zf + st.muzzle_height]
    let aim = [me.aim[0], 0], haveAim = false, tp = [0, 0, 0], tv = [0, 0, 0], tr = 0, th = 0, shootable = false, isMech = false, defend = false
    if (!target && this.npcHurt > 0 && now - this.npcHurt < 3) {
      let worst = null, bestOff = 0.7
      for (const n of this.npcs.values()) {
        if (now - n.seen > 0.5 || !n.los || n.dist > 150) continue
        const off = now - n.hitMe < 3 ? 0 : Math.abs(angDiff(goAtan2(n.pos[1] - y, n.pos[0] - x), this.npcBearing))
        if (off < bestOff) { bestOff = off; worst = n }
      }
      if (worst) { farm = worst; farmPos = null; defend = true }
    }
    if (target) {
      const sc = this.scaleOf(target.cubes)
      tr = this.cfg.mech.radius * sc; th = this.cfg.mech.height * sc
      tp = [target.pos[0], target.pos[1], target.pos[2] + th * 0.5]; tv = target.vel
      if (!W.clear(muzzle, tp)) tp[2] = target.pos[2] + th * 0.85
      shootable = isMech = true
    } else if (farm) {
      tr = this.cfg.npc.radius ?? 0; th = this.cfg.npc.height ?? 0
      tp = [farm.pos[0], farm.pos[1], farm.pos[2] + th * 0.5]; tv = farm.vel
      shootable = true
    } else if (farmPos) {
      tr = this.cfg.crates.radius; th = this.cfg.crates.height
      tp = farmPos
      shootable = true
    }
    if (!isMech && !target && (this.retreat || hpFrac < 0.5) && !defend) shootable = false
    if (ctl && ctl.hold && isMech) shootable = false

    if (shootable) {
      const dist = hyp(tp[0] - x, tp[1] - y), grounded = Math.abs(tv[2]) < 0.5
      let gy = 0, gp = 0, gunOK = false
      if (gun) { [gy, gp] = this.lead(muzzle, tp, tv, gun.stats.speed, grounded); gunOK = dist <= gun.stats.range * 0.96 }
      const dp = [tp[0] + tv[0] * (LAT + 0.05), tp[1] + tv[1] * (LAT + 0.05), tp[2]]
      const hy = goAtan2(dp[1] - muzzle[1], dp[0] - muzzle[0])
      const hp = goAtan2(dp[2] - muzzle[2], hyp(dp[0] - muzzle[0], dp[1] - muzzle[1]))
      aim = gun ? [gy, gp] : [hy, hp]
      haveAim = true
      const tolY = goAtan2(tr * 0.75, Math.max(dist, 1)), tolP = goAtan2(th * 0.4, Math.max(dist, 1))
      const slew = (wy, wp) => Math.max(0, Math.abs(angDiff(wy, me.aim[0])) - st.turn_rate * 0.05) < tolY && Math.max(0, Math.abs(wp - me.aim[1]) - st.pitch_rate * 0.05) < tolP
      me.weapons.forEach((w, i) => {
        if (!w || i > 1) return
        if (w.kind === 'gun') {
          if (gunOK && w.ammo > 0 && w.reload <= 0 && slew(gy, gp)) act.fire[i] = true
        } else if (w.kind === 'lightning') {
          const cone = (w.stats.cone_deg * PI) / 180
          if (dist < w.stats.range - 1.5 && Math.abs(angDiff(hy, me.aim[0])) < cone * 0.5 - 0.05 && me.energy >= w.stats.energy) act.fire[i] = true
        } else if (w.kind === 'laser') {
          if (!isMech || dist > w.stats.range * 0.97) return
          const full = w.stats.charge
          if (w.charge < full - 0.051) {
            act.fire[i] = true
            if (w.charge > full * 0.45) aim = [hy, hp]
          } else {
            aim = [hy, hp]
            act.fire[i] = !(Math.abs(angDiff(hy, me.aim[0])) < tolY * 0.9 && Math.abs(hp - me.aim[1]) < tolP)
          }
        } else if (w.kind === 'mortar') {
          if (!isMech || w.cooldown > 0.25 || dist < 16 || dist > 200) return
          const sol = this.mortar([muzzle[0], muzzle[1], zf + st.height + 0.5], [tp[0], tp[1], tp[2] - th * 0.5], tv, w.stats.speed, w.stats.gravity, st)
          if (sol) {
            if (!gun || gun.reload > 0 || gun.ammo === 0 || !gunOK) aim = sol
            const ey = Math.max(0, Math.abs(angDiff(sol[0], me.aim[0])) - st.turn_rate * 0.05)
            const ep = Math.max(0, Math.abs(sol[1] - me.aim[1]) - st.pitch_rate * 0.05)
            if (ey < 0.04 && ep < 0.03) act.fire[i] = true
          }
        }
      })
    }
    if (!target && foe) {
      me.weapons.forEach((w, i) => {
        if (w && i < 2 && w.kind === 'laser' && w.cooldown <= 0.05 && foe.dist < w.stats.range && w.charge < w.stats.charge + w.stats.hold_s - 0.35) act.fire[i] = true
      })
    }
    if (!haveAim) {
      let watch = null
      for (const t of seen) if ((t.engage || now - t.hitMe < 6) && (!watch || t.dist < watch.dist)) watch = t
      if (watch) aim[0] = goAtan2(watch.pos[1] - y, watch.pos[0] - x)
      else if (this.npcHurt > 0 && now - this.npcHurt < 2.5) aim[0] = this.npcBearing
      else if (now - this.lastHurt < 2.5) aim[0] = this.hurtBearing
      else if (mx !== 0 || my !== 0) aim[0] = goAtan2(my, mx) + 1.15 * goSin(now * 1.3)
      else aim[0] = me.aim[0] + 0.35
      aim[1] = 0
    }
    aim[1] = clamp(aim[1], st.min_pitch, st.max_pitch)
    act.aim = aim

    if (gun && gun.reload <= 0 && gun.ammo < gun.stats.mag && !target && !farm && !farmPos && (gun.ammo <= gun.stats.mag * 0.6 || now - this.lastThreatAt > 3)) act.reload = true

    const slot1 = me.weapons.length > 1 && me.weapons[1] ? me.weapons[1].kind : ''
    for (const p of o.pickups) {
      if (hyp(p.pos[0] - x, p.pos[1] - y) > this.cfg.loot.pickup_radius - 0.3 || Math.abs(p.pos[2] - zf) > 3.6 || !this.wantPickup(me, p.kind)) continue
      act.take = p.id
      if (slot1 !== '' && me.weapons.length > 0 && me.weapons[0]) {
        if (slot1 === 'laser' && me.weapons[1].charge > 0) { delete act.take; break }
        act.drop = 1
      }
      break
    }
    act.move = [mx, my]
    act.boost = boost && (mx !== 0 || my !== 0)
    this.mode = mode
  }

  escape(me) {
    const [x, y, zf] = me.pos, W = this.W, E = this.esc
    let jump = false
    if (me.grounded) {
      if ((zf - W.groundAt(x, y) > 3 && W.obst[W.vidx(x, y)]) || !W.offMain(x, y)) { E.ok = E.flying = false; return null }
      E.flying = false
      if (!E.ok || this.now - E.at > 6) {
        const p = W.escapePlan(x, y)
        E.launch = p.launch; E.land = p.land; E.ok = p.ok; E.at = this.now
        if (!E.ok) return null
      }
      if (hyp(E.launch[0] - x, E.launch[1] - y) > 2.5) return { move: this.travel(me, E.launch[0], E.launch[1]), boost: false, jump }
      if (me.energy < Math.min(70, me.max_energy * 0.7)) return { move: [0, 0], boost: false, jump }
      E.flying = true
      jump = true
    } else if (!E.flying) return null
    const dx = E.land[0] - x, dy = E.land[1] - y, d = hyp(dx, dy)
    if (d < 1.5) return { move: [0, 0], boost: false, jump, keep: true }
    const mx = dx / d, my = dy / d
    let need = -1e9
    for (let t = 0; t <= Math.min(d, 30); t += 1) need = Math.max(need, W.topAt(x + mx * t, y + my * t))
    return { move: [mx, my], boost: zf < need + 2.5 && me.energy > 1, jump }
  }

  wantPickup(me, kind) {
    if (kind === 'gun') return me.weapons.length > 0 && !me.weapons[0]
    if (findWeapon(me.weapons, kind)[0] >= 0) return false
    if (kind === 'mortar' && this.P.noMortar) return false
    const rank = (k) => (this.P.laserFirst && k === 'laser' ? 4 : WEAPON_RANK[k] ?? 0)
    const cur = me.weapons.length > 1 && me.weapons[1] ? rank(me.weapons[1].kind) : 0
    return rank(kind) > cur
  }

  lead(m, tp, tv, speed, grounded) {
    if (speed <= 0) speed = 252
    let t = 0, px = 0, py = 0, pz = 0
    for (let k = 0; k < 4; k++) {
      const tt = LAT + t
      px = tp[0] + tv[0] * tt; py = tp[1] + tv[1] * tt; pz = tp[2]
      if (!grounded) pz += tv[2] * tt * 0.5
      const d = Math.sqrt((px - m[0]) * (px - m[0]) + (py - m[1]) * (py - m[1]) + (pz - m[2]) * (pz - m[2]))
      t = Math.max(0, d - 3) / speed
    }
    return [goAtan2(py - m[1], px - m[0]), goAtan2(pz - m[2], hyp(px - m[0], py - m[1]))]
  }

  mortar(tube, foot, tv, v, g, st) {
    if (v <= 0 || g <= 0) return null
    let t = 0, pitch = 0, yaw = 0
    for (let k = 0; k < 3; k++) {
      const px = foot[0] + tv[0] * (LAT + t), py = foot[1] + tv[1] * (LAT + t)
      const dx = hyp(px - tube[0], py - tube[1]), dz = foot[2] - tube[2]
      const disc = v * v * v * v - g * (g * dx * dx + 2 * dz * v * v)
      if (disc < 0 || dx < 1) return null
      pitch = goAtan((v * v - Math.sqrt(disc)) / (g * dx))
      yaw = goAtan2(py - tube[1], px - tube[0])
      t = dx / (v * goCos(pitch))
    }
    if (pitch < st.min_pitch || pitch > st.max_pitch) return null
    const c = goCos(pitch), s = goSin(pitch)
    for (let tt = 0.1; tt < t * 0.9; tt += 0.1) {
      const d = v * c * tt
      if (this.W.solid(tube[0] + goCos(yaw) * d, tube[1] + goSin(yaw) * d, tube[2] + v * s * tt - 0.5 * g * tt * tt)) return null
    }
    return [yaw, pitch]
  }

  dodgeShell(o, set) {
    const me = o.self, mw = zeroStats(this.cfg.weapons.mortar)
    const g = mw.gravity > 0 ? mw.gravity : 22
    const rad = mw.splash_radius + me.stats.radius + 2
    for (const p of o.projectiles) {
      if (p.kind !== 'mortar') continue
      let [px, py, pz] = p.pos, vz = p.vel[2]
      for (let t = 0; t < 4; t += 0.05) {
        px += p.vel[0] * 0.05; py += p.vel[1] * 0.05; pz += vz * 0.05; vz -= g * 0.05
        if (!this.W.solid(px, py, pz)) continue
        let d = hyp(px - me.pos[0], py - me.pos[1])
        if (d < rad && t < 2.5) {
          let dx = me.pos[0] - px, dy = me.pos[1] - py
          if (d < 0.5) { dx = -p.vel[1]; dy = p.vel[0]; d = hyp(dx, dy) }
          dx /= d; dy /= d
          for (const rot of [0, 0.7, -0.7, 1.4, -1.4]) {
            const c = goCos(rot), s = goSin(rot), ex = dx * c - dy * s, ey = dx * s + dy * c
            if (this.W.lineWalkable(me.pos[0], me.pos[1], me.pos[0] + ex * 6, me.pos[1] + ey * 6)) { set([ex, ey]); return true }
          }
        }
        break
      }
    }
    return false
  }

  travel(me, gx, gy) {
    const [x, y] = me.pos, W = this.W
    const d = hyp(gx - x, gy - y)
    if (d < 0.8) return [0, 0]
    const unit = (tx, ty) => { const l = hyp(tx - x, ty - y); return l < 1e-6 ? [0, 0] : [(tx - x) / l, (ty - y) / l] }
    if (me.pos[2] - W.groundAt(x, y) > 3 && W.obst[W.vidx(x, y)]) return unit(gx, gy)
    if (d < 45 && W.lineWalkable(x, y, gx, gy)) return unit(gx, gy)
    if (!this.path || hyp(gx - this.pathGoal[0], gy - this.pathGoal[1]) > 5 || this.now - this.pathAt > 2.5) {
      this.path = W.path(x, y, gx, gy, 22000).path
      this.pathGoal = [gx, gy]
      this.pathAt = this.now
      this.pathI = 0
    }
    const path = this.path
    if (!path || path.length === 0) return unit(gx, gy)
    let bi = this.pathI, bd = Infinity
    for (let i = this.pathI; i < path.length && i < this.pathI + 10; i++) {
      const [px, py] = W.cellPos(path[i]), dd = hyp(px - x, py - y)
      if (dd < bd) { bi = i; bd = dd }
    }
    this.pathI = bi
    if (bd > 12) { this.path = null; return unit(gx, gy) }
    for (let i = Math.min(bi + 14, path.length - 1); i > bi; i--) {
      const [px, py] = W.cellPos(path[i])
      if (W.lineWalkable(x, y, px, py)) return i === path.length - 1 && hyp(px - gx, py - gy) < 4 && W.lineWalkable(x, y, gx, gy) ? unit(gx, gy) : unit(px, py)
    }
    if (bi + 1 < path.length) { const [px, py] = W.cellPos(path[bi + 1]); return unit(px, py) }
    return unit(gx, gy)
  }

  prefRange(me, t) {
    const [, light] = findWeapon(me.weapons, 'lightning'), [, laser] = findWeapon(me.weapons, 'laser')
    let r = light && me.energy > 12 ? this.P.lightRange : laser ? this.P.laserRange : this.P.gunRange
    if (t.kind === 'npc') return 58
    if (!light) {
      if (holds(t.weapons, 'lightning')) r = Math.max(r, 64)
      if (holds(t.weapons, 'mortar')) r = Math.max(r, 80)
    }
    return this.ctl && t.kind === 'mech' ? r * this.ctl.range : r
  }

  fightMove(o, tg, seen, wantLos) {
    const me = o.self, [x, y] = me.pos, W = this.W
    const rp = this.prefRange(me, tg)
    const bx = tg.pos[0] - x, by = tg.pos[1] - y, bd = hyp(bx, by) + 1e-9, ux = bx / bd, uy = by / bd
    if (this.now >= this.strafeUntil) {
      if (this.rng.float64() < 0.6) this.strafe = -this.strafe
      this.strafeUntil = this.now + 0.3 + this.rng.float64() * 0.7
    }
    const sx = -uy * this.strafe, sy = ux * this.strafe
    const tc = this.center(tg), mh = me.stats.muzzle_height
    let cube = null
    for (const c of this.cubes.values()) {
      const d = hyp(c.pos[0] - x, c.pos[1] - y)
      if (d < 40 && (!cube || d < hyp(cube.pos[0] - x, cube.pos[1] - y)) && Math.abs(c.pos[2] - me.pos[2]) < 4) cube = c
    }
    let best = -Infinity, mx = 0, my = 0, blockedSide = false
    const rings = this.P.peek ? 2 : 1
    for (let k = -1; k < 16 * rings; k++) {
      let cx = x, cy = y, dx = 0, dy = 0, r = 0
      if (k >= 0) {
        const a = ((k % 16) * PI) / 8
        r = 6 * (1 + Math.trunc(k / 16))
        dx = goCos(a); dy = goSin(a)
        cx = x + dx * r; cy = y + dy * r
        if (!W.lineWalkable(x, y, cx, cy) || !W.free(cx, cy)) {
          if (k < 16 && dx * sx + dy * sy > 0.9) blockedSide = true
          continue
        }
      }
      const cz = W.walkAt(cx, cy), d = hyp(tg.pos[0] - cx, tg.pos[1] - cy)
      let s = -1.1 * Math.abs(d - rp) - r * 0.4
      const los = W.clear([cx, cy, cz + mh], tc)
      if (los) s += 45 * wantLos
      if (this.P.peek && k >= 0 && k < 16 && los === wantLos > 0) {
        for (let q = 0; q < 16; q += 2) {
          const qx = cx + goCos((q * PI) / 8) * 7, qy = cy + goSin((q * PI) / 8) * 7
          if (W.free(qx, qy) && W.clear([qx, qy, W.walkAt(qx, qy) + mh], tc) !== los) { s += 8; break }
        }
      }
      const body = [cx, cy, cz + me.stats.height * 0.6]
      for (const e of seen) if (e !== tg && hyp(e.pos[0] - cx, e.pos[1] - cy) <= 170 && W.clear(this.eye(e), body)) s -= 30
      s -= this.zonePenalty(o.zone, cx, cy)
      if (cube) s += 1.5 * (hyp(cube.pos[0] - x, cube.pos[1] - y) - hyp(cube.pos[0] - cx, cube.pos[1] - cy))
      const cl = W.clearance[W.cell(cx, cy)]
      if (cl < 4) s -= (4 - cl) * 2.5
      if (wantLos > 0) s += 9 * (dx * sx + dy * sy)
      if (k < 0) { s -= 8; if (wantLos < 0 && !los) s += 14 }
      if (s > best) { best = s; mx = dx; my = dy }
    }
    if (blockedSide) { this.strafe = -this.strafe; this.strafeUntil = this.now + 0.5 }
    return [mx, my]
  }

  coverMove(o, seen, set) {
    const me = o.self, [x, y] = me.pos, W = this.W
    let threats = seen.filter((t) => hyp(t.pos[0] - x, t.pos[1] - y) < 230)
    if (!threats.length) return false
    if (threats.length > 4) threats = threats.sort((a, b) => hyp(a.pos[0] - x, a.pos[1] - y) - hyp(b.pos[0] - x, b.pos[1] - y)).slice(0, 4)
    const hidden = (cx, cy) => {
      const cz = W.walkAt(cx, cy)
      return threats.every((t) => { const e = this.eye(t); return !W.clear(e, [cx, cy, cz + me.stats.height]) && !W.clear(e, [cx, cy, cz + me.stats.height * 0.5]) })
    }
    if (this.coverOK && this.now - this.coverAt < 0.4) { set(this.travelCover(me)); return true }
    this.coverAt = this.now
    if (hidden(x, y) && this.zonePenalty(o.zone, x, y) === 0) { this.coverOK = true; this.coverGoal = [x, y]; set([0, 0]); return true }
    const s0 = W.nearestFree(W.cell(x, y))
    if (s0 < 0) return false
    const gen = ++W.gen
    const queue = [s0]
    W.stamp[s0] = gen
    W.g[s0] = 0
    let bestC = -1, bestS = Infinity, checked = 0
    for (let h = 0; h < queue.length && checked < 350; h++) {
      const c = queue[h], ci = c % W.nnx, cj = Math.trunc(c / W.nnx), steps = W.g[c]
      if (steps > 50 || (bestC >= 0 && steps * 2 > bestS + 30)) break
      if ((ci + cj) % 2 === 0 && steps > 0) {
        const [cx, cy] = W.cellPos(c)
        checked++
        if (hidden(cx, cy)) {
          let sc = steps * 2 + this.zonePenalty(o.zone, cx, cy), near = Infinity
          for (const t of threats) near = Math.min(near, hyp(t.pos[0] - cx, t.pos[1] - cy))
          sc -= Math.min(near, 80) * 0.25
          if (sc < bestS) { bestC = c; bestS = sc }
        }
      }
      nbrs.forEach(([di, dj], k) => {
        const i = ci + di, j = cj + dj
        if (i < 0 || j < 0 || i >= W.nnx || j >= W.nny) return
        const nb = j * W.nnx + i
        if (W.stamp[nb] === gen || !W.canStep(c, nb, k >= 4)) return
        if (k >= 4 && (W.blocked[cj * W.nnx + i] || W.blocked[j * W.nnx + ci])) return
        W.stamp[nb] = gen
        W.g[nb] = W.g[c] + 1
        queue.push(nb)
      })
    }
    if (bestC < 0) { this.coverOK = false; return false }
    this.coverOK = true
    this.coverGoal = W.cellPos(bestC)
    set(this.travelCover(me))
    return true
  }

  travelCover(me) {
    if (hyp(this.coverGoal[0] - me.pos[0], this.coverGoal[1] - me.pos[1]) < 1.5) return [0, 0]
    return this.travel(me, this.coverGoal[0], this.coverGoal[1])
  }

  chooseLoot(o, hpFrac, danger) {
    const me = o.self, [x, y] = me.pos, z = o.zone, now = this.now, W = this.W, P = this.P
    const cur = this.curZone(z)
    let best = null, bestU = 0
    const consider = (kind, id, pos, value) => {
      if ((this.bad.get(id) ?? -Infinity) > now) return
      const d = hyp(pos[0] - x, pos[1] - y)
      if (d > 260 || hyp(pos[0] - cur.x, pos[1] - cur.y) > cur.r - 6) return
      if (now + (d * 1.4) / me.stats.walk_speed + 5 > this.zoneDeadline(z, pos[0], pos[1], 6)) return
      if (pos[2] - W.groundAt(pos[0], pos[1]) > 3.2) return
      const nf = W.nearestFree(W.cell(pos[0], pos[1]))
      if (nf < 0 || W.comp[nf] !== W.mainComp) return
      let u = value / (d + 18)
      if (id === this.lootID) u *= 1.35
      if (u > bestU) { bestU = u; best = { kind, id, pos, value } }
    }
    for (const p of this.pickups.values()) {
      let rad = P.lootRadius
      const seek = p.kind === 'laser' && P.laserSeek > rad
      if (seek) rad = P.laserSeek
      if (this.wantPickup(me, p.kind) && hyp(p.pos[0] - x, p.pos[1] - y) < rad) {
        let v = me.weapons.length > 1 && !me.weapons[1] ? 130 : 60
        if (seek) v = Math.max(v, 150)
        consider('pickup', p.id, p.pos, v)
      }
    }
    const cubeV = me.cubes >= this.cfg.cubes.stat_cap ? 25 : 75
    for (const c of this.cubes.values()) if (hyp(c.pos[0] - x, c.pos[1] - y) < Math.max(60, P.lootRadius * 0.7)) consider('cube', c.id, c.pos, cubeV)
    const farmHP = P.farmHP > 0 ? P.farmHP : 0.7
    if (hpFrac > farmHP && !danger && now < P.crateUntil) {
      for (const c of this.crates.values()) if (hyp(c.pos[0] - x, c.pos[1] - y) < P.lootRadius) consider('crate', c.id, c.pos, cubeV * 0.6)
      if (P.farmNPC && me.cubes < this.cfg.cubes.stat_cap)
        for (const n of this.npcs.values()) if (now - n.seen < 12 && hyp(n.pos[0] - x, n.pos[1] - y) < P.lootRadius) consider('npc', n.id, n.pos, 85)
    }
    if (!best) { this.lootID = -1; return null }
    if (best.id !== this.lootID) { this.lootID = best.id; this.lootSince = now }
    else if (now - this.lootSince > 30) { this.bad.set(best.id, now + 60); this.lootID = -1; return null }
    return best
  }

  homeCost(o, px, py) {
    const z = o.zone
    let crowd = 0
    for (const t of this.tracks.values()) if (this.now - t.seen < 20) crowd += Math.max(0, 80 - hyp(t.pos[0] - px, t.pos[1] - py)) / 80
    for (const d of o.drops) crowd += Math.max(0, 60 - hyp(d.pos[0] - px, d.pos[1] - py)) / 60
    const edge = hyp(px - z.next_center[0], py - z.next_center[1]) / Math.max(30, z.next_radius)
    return this.P.homeExpo * this.W.exposure(px, py) + 0.25 * hyp(px - o.self.pos[0], py - o.self.pos[1]) + 40 * crowd + 10 * edge
  }

  home(o) {
    const z = o.zone
    const out = !this.homeSet || hyp(this.homeXY[0] - z.next_center[0], this.homeXY[1] - z.next_center[1]) > z.next_radius * 0.8
    if (out || this.now - this.homeAt > 12) {
      this.homeAt = this.now
      let best = [0, 0], bestC = Infinity
      for (let k = 0; k < 40; k++) {
        const a = this.rng.float64() * 2 * PI
        const r = Math.sqrt(this.rng.float64()) * z.next_radius * 0.7
        const px = z.next_center[0] + goCos(a) * r, py = z.next_center[1] + goSin(a) * r
        if (!this.W.inBounds(px, py) || !this.W.reachable(px, py)) continue
        const c = this.homeCost(o, px, py)
        if (c < bestC) { best = [px, py]; bestC = c }
      }
      if (bestC !== Infinity && (out || bestC < this.homeCost(o, this.homeXY[0], this.homeXY[1]) - 15)) { this.homeXY = best; this.homeSet = true }
    }
    return [this.homeXY[0], this.homeXY[1], this.homeSet]
  }

  hideFromBearing(o, seen, set) {
    const me = o.self
    const ghost = { pos: [me.pos[0] + goCos(this.hurtBearing) * 80, me.pos[1] + goSin(this.hurtBearing) * 80, me.pos[2]], cubes: 0 }
    return this.coverMove(o, [ghost, ...seen], set)
  }

  dodge(o) {
    const me = o.self, cx = me.pos[0], cy = me.pos[1], cz = me.pos[2] + me.stats.height * 0.56, reach = me.stats.radius + 1.1
    let dx = 0, dy = 0, laser = false
    for (const p of o.projectiles) {
      if (p.kind === 'mortar') continue
      const v2 = p.vel[0] * p.vel[0] + p.vel[1] * p.vel[1] + p.vel[2] * p.vel[2]
      if (v2 < 1) continue
      const tc = ((cx - p.pos[0]) * p.vel[0] + (cy - p.pos[1]) * p.vel[1] + (cz - p.pos[2]) * p.vel[2]) / v2
      if (tc <= 0 || tc > 0.7) continue
      const mxx = p.pos[0] + p.vel[0] * tc - cx, myy = p.pos[1] + p.vel[1] * tc - cy
      if (hyp(mxx, myy) >= reach) continue
      const vh = hyp(p.vel[0], p.vel[1])
      if (vh < 1) continue
      let px = -p.vel[1] / vh, py = p.vel[0] / vh
      if (px * mxx + py * myy > 0) { px = -px; py = -py }
      dx += px; dy += py
    }
    for (const m of o.mechs) {
      if (m.kind !== 'mech' || !m.charging) continue
      const toMe = goAtan2(cy - m.pos[1], cx - m.pos[0])
      if (Math.abs(angDiff(m.aim[0], toMe)) > 0.15) continue
      dx += goCos(toMe + (PI / 2) * this.strafe) * 1.5
      dy += goSin(toMe + (PI / 2) * this.strafe) * 1.5
      laser = true
    }
    const l = hyp(dx, dy)
    return l > 0.01 ? [dx / l, dy / l, laser] : [0, 0, false]
  }
}
