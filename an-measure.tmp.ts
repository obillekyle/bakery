// Row 10 claims, measured before anything is changed.
//   19: the per-minute flush stalls on one synchronous SQLite batch, and
//       computeStats runs once per connected console per second.
//    8: dbHits has no producer; the 1h accumulators are never persisted.
//   self-ping: the tick's own request lands in routeHits.
import * as core from './packages/plugins/analytics/src/core'
import { computeStats } from './packages/plugins/analytics/src/endpoints/stats'

function control(): number {
  const t0 = Bun.nanoseconds()
  let x = 0
  for (let i = 0; i < 4_000_000; i++) x = (x * 31 + i) % 1000003
  if (x === -1) console.log(x)
  return (Bun.nanoseconds() - t0) / 1e6
}
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)]!

// A realistic tally: 2,000 distinct paths, 60k hits.
for (let i = 0; i < 60_000; i++) {
  core.recordRouteHit('GET', '/page/' + (i % 2000))
}
core.pushAnalyticsSnapshot({
  timestamp: Date.now(), memoryUsed: 80, activeLoggers: 0, activeSessions: 2, ping: 1,
})

console.log('computeStats, one call')
console.log('round  control     per call')
const t: number[] = []
for (let r = 0; r < 4; r++) {
  const c = control()
  const t0 = Bun.nanoseconds()
  for (let i = 0; i < 20; i++) computeStats('1m', true, '1d')
  const per = (Bun.nanoseconds() - t0) / 20 / 1e6
  t.push(per)
  console.log('  ' + (r + 1) + '    ' + c.toFixed(0).padStart(4) + 'ms  ' + per.toFixed(2).padStart(7) + 'ms')
}
const m = med(t)
console.log('')
console.log('median ' + m.toFixed(2) + ' ms per call')
for (const n of [1, 3, 5, 10]) {
  console.log('  ' + String(n).padStart(2) + ' consoles: ' + (m * n).toFixed(1).padStart(6) + ' ms of every second, ' + ((m * n) / 10).toFixed(1) + '% of one core')
}