import { GiddyBrain } from './brain.js'
import { loadWorld } from './world.js'

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n')
let bot = null, last = {}, buf = '', queued = false

function handle(lines) {
  let latest = null
  for (const line of lines) {
    let msg
    try { msg = JSON.parse(line) } catch { continue }
    if (msg.type === 'hello') {
      try { bot = new GiddyBrain(msg, loadWorld(msg.map?.dir ?? '/arena')) } catch (e) { process.stderr.write(String(e?.stack ?? e) + '\n') }
      send({ type: 'ready', name: 'fn' })
    } else if (msg.type === 'obs') latest = msg
    else if (msg.type === 'end') process.exit(0)
  }
  if (!latest) return
  let action = {}
  if (bot) {
    try {
      action = { ...bot.act(latest) }
      last = { move: action.move, aim: action.aim, boost: action.boost }
    } catch { action = { ...last } }
  }
  action.tick = latest.tick
  send(action)
}

function flush() {
  queued = false
  const lines = buf.split('\n')
  buf = lines.pop() ?? ''
  handle(lines.filter((l) => l.trim()))
}

process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buf += chunk
  if (queued) return
  queued = true
  setImmediate(flush)
})
process.stdin.on('end', () => { buf += '\n'; flush() })
