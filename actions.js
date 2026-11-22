// Policy action heads (original code, MIT). Order matters: it is the label/action vector layout everywhere
// (env, imitation labels, network heads in rl/net.py and bot/net.js).
export const HEADS = [
  { name: 'move', n: 37 },    // 0 stop | 1-32 direction rel. to facing (11.25 deg steps) | 33 zone | 34 loot | 35 cover | 36 target
  { name: 'boost', n: 2 },
  { name: 'jump', n: 2 },
  { name: 'look', n: 46 },    // 0 auto (scripted aim at the target) | 1-44 raw aim: yaw offset LOOK_OFFS[i] | 45 scripted aim at the drone/crate nearest the aim line
  { name: 'target', n: 9 },   // pointer over enemy slots 0-7 | 8 auto
  { name: 'fire0', n: 2 },    // slot 0 trigger, raw (laser: held = charging, let go = fire)
  { name: 'fire1', n: 2 },    // slot 1 trigger, raw
  { name: 'speed', n: 3 },    // 0 full | 1 x0.7 | 2 x0.4 (silent, < 5 m/s, no boost)
  { name: 'reload', n: 2 },
  { name: 'take', n: 3 },     // 0 none | 1 take nearest pickup (swap out slot 1 if full) | 2 same, swap out slot 0
  { name: 'upgrade', n: 4 },  // 0-2 pick offer choice | 3 not now
  { name: 'pitch', n: 24 },    // raw aim pitch PITCHES[i] (used when look > 0; auto aim sets its own pitch)
]
export const NA = HEADS.length
// raw aim: yaw offset (rad, + = left) from the current facing; fine near 0 so tracking and shots stay precise.
// The torso turns at most 0.4 rad per tick, so 0.8 = full-rate turn.
const OFFS = [0.003, 0.006, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05, 0.065, 0.08, 0.1, 0.125, 0.15, 0.18, 0.22, 0.26, 0.3, 0.35, 0.4, 0.5, 0.8]
export const LOOK_OFFS = [null, 0, ...OFFS.flatMap((o) => [o, -o]), Math.PI]
export const LOOK_OBJ = LOOK_OFFS.length // 45
export const MOVE_DIRS = 32
export const SPEEDS = [1, 0.7, 0.4]
export const PITCHES = [0, ...[0.02, 0.04, 0.07, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6].flatMap((p) => [p, -p]), 0.8]
// initial control before the first decision (stand, auto aim, trigger released, full speed, no manual loot/upgrade)
export const DEFAULT_ACTION = [0, 0, 0, 0, 8, 0, 0, 0, 0, 0, 3, 0]
// a null/undefined entry (head missing from an older checkpoint) leaves that field unset: the Brain's script decides
export function toCtrl(a) {
  const v = (x) => (x == null ? undefined : x)
  return { move: a[0], boost: a[1], jump: a[2], look: a[3], target: a[4], fire: a[5] == null ? undefined : [a[5], a[6]], slow: v(a[7]), reload: v(a[8]), take: v(a[9]), upgrade: v(a[10]), pitch: v(a[11]) }
}
