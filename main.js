// mechfight/1 entry point (original code, MIT): JSON lines on stdin/stdout, answers the newest observation.
import readline from 'node:readline'
import { BotMap } from './botmap.js'
import { Brain } from './brain.js'

let brain = null
let pending = null
let busy = false
const out = (o) => process.stdout.write(JSON.stringify(o) + '\n')

function handle(msg) {
  if (msg.type === 'hello') {
    const map = new BotMap(msg.map.dir)
    brain = new Brain(map, msg)
    out({ type: 'ready', name: 'fn' })
  } else if (msg.type === 'obs') {
    let a
    try { a = brain.act(msg) } catch (e) { process.stderr.write(String(e?.stack ?? e) + '\n'); a = { tick: msg.tick } }
    out(a)
  } else if (msg.type === 'end') process.exit(0)
}

// keep only the newest queued observation
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
