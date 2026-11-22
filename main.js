// mechfight/1 entry point for the network bot (original code, MIT): JSON lines on stdin/stdout.
// A policy network picks the decisions every observation; the Brain carries them out. If the weights are missing or
// anything throws, the scripted Brain plays instead, so the bot always answers.
import readline from 'node:readline'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { BotMap } from './botmap.js'
import { Brain } from './brain.js'
import { ObsEncoder } from './obs.js'
import { PolicyNet } from './net.js'
import { PolicyAgentC } from './agent_c.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WFILE = path.join(HERE, 'w.bin')
let agent = null, fallback = null, warm = false, map = null, helloMsg = null
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

function handle(msg) {
  if (msg.type === 'hello') {
    map = new BotMap(msg.map.dir); helloMsg = msg
    fallback = new Brain(map, msg)
    try {
      if (fs.existsSync(WFILE)) agent = new PolicyAgentC(map, msg, PolicyNet.loadBin(WFILE), { encoder: new ObsEncoder(map) })
    } catch (e) { process.stderr.write('net load failed: ' + String(e?.stack ?? e) + '\n'); agent = null }
    out({ type: 'ready', name: 'fn' })
  } else if (msg.type === 'obs') {
    let a
    try {
      if (agent && !warm) { // JIT warm-up on the first observation (copies so the agent's memory is untouched)
        for (let k = 0; k < 3; k++) agent.net.act(agent.enc.encode(msg, new Brain(map, helloMsg)))
        warm = true
      }
      a = agent ? agent.act(msg) : fallback.act(msg)
    } catch (e) {
      process.stderr.write(String(e?.stack ?? e) + '\n')
      try { a = fallback.act(msg) } catch { a = { tick: msg.tick } }
    }
    out(a)
  } else if (msg.type === 'end') process.exit(0)
}

// keep only the newest queued observation
let pending = null, busy = false
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (msg.type === 'obs') { pending = msg; if (!busy) setImmediate(drain) } else handle(msg)
})
rl.on('close', () => process.exit(0))
function drain() {
  busy = true
  while (pending) { const m = pending; pending = null; handle(m) }
  busy = false
}
