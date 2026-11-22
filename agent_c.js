// Low-level policy agent (original code, MIT): every `every` observations (default 1 = 10 Hz) the network picks
// the action heads in bot/actions.js; the scripted Brain executes them (exact aiming, movement details).
import { Brain, laserFirst, LASER_R, rangeKeep, RANGE_KEEP } from './brain.js'
import { ObsEncoder } from './obs.js'
import { PolicyNet } from './net.js'
import { DEFAULT_ACTION, toCtrl } from './actions.js'

export class PolicyAgentC {
  constructor(map, hello, net, { every = +(process.env.POLICY_EVERY ?? 1), encoder } = {}) {
    this.brain = new Brain(map, hello)
    this.brain.ctrl = toCtrl(DEFAULT_ACTION)
    this.enc = encoder ?? new ObsEncoder(map)
    this.net = net
    this.every = every
    this.n = 0
    this.state = null // LSTM memory
  }
  act(obs) {
    if (this.n++ % this.every === 0) {
      const e = this.enc.encode(obs, this.brain)
      this.brain.tids = e.tids
      const a = this.net.act(e, this.state)
      if (this.net.isLstm) this.state = this.net.lastState
      this.brain.ctrl = toCtrl(a)
      if (LASER_R > 0) laserFirst(this.brain, obs, LASER_R)
      if (RANGE_KEEP) rangeKeep(this.brain, obs)
    }
    return this.brain.act(obs)
  }
}

export function loadNet(file) { return PolicyNet.load(file) }
