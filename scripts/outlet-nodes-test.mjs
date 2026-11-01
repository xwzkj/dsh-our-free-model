/**
 * The node book: latency ranks, 429 keeps a node out for five hours, a plain
 * failure only for ten minutes.
 *
 * These are the rules an operator reasons about ("that node was limited five
 * hours ago, it should be back"), so they are pinned as arithmetic on a clock
 * the test controls — not as a description of mihomo's behaviour.
 *
 * Run: node scripts/outlet-nodes-test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DIRECT_ROUTE, emptyNodeTable, loadNodeTable, noteNode429, noteNodeDelay, oldestLimitedNode,
  rankNodes, routeCandidates, saveNodeTable,
} from '../src/outlet-nodes.js'

const HOUR = 3_600_000
const now = 1_800_000_000_000

// --- ranking: fastest first, unmeasured last -------------------------------
const book = emptyNodeTable()
noteNodeDelay(book, 'seoul', 480, now - HOUR)
noteNodeDelay(book, 'hongkong', 210, now - HOUR)
assert.deepEqual(rankNodes(book, { now }), ['hongkong', 'seoul'], 'measured nodes rank by latency')

// A latency reading is a routing hint, not a verdict: an hour-old number still
// ranks a node, because the alternative is refusing to use a working node.
assert.deepEqual(rankNodes(book, { now, cooldownHours: 0 }), ['hongkong', 'seoul'])

// A node that just failed the health check is out until its short window passes.
noteNodeDelay(book, 'tokyo', 0, now - 60_000)
assert.deepEqual(rankNodes(book, { now }), ['hongkong', 'seoul'], 'a failure a minute ago excludes the node')
// …and comes back afterwards, unranked but usable.
noteNodeDelay(book, 'tokyo', 0, now - 11 * 60_000)
assert.deepEqual(rankNodes(book, { now }).at(-1), 'tokyo', 'after ten minutes it is a candidate again, ranked last')

// --- the five-hour rule ----------------------------------------------------
const limited = emptyNodeTable()
noteNodeDelay(limited, 'a', 200, now)
noteNode429(limited, 'a', now - 4 * HOUR - 59 * 60_000)
assert.deepEqual(rankNodes(limited, { now }), [], 'still limited at four hours fifty-nine')

noteNode429(limited, 'a', now - 5 * HOUR - 60_000)
assert.deepEqual(rankNodes(limited, { now }), ['a'], 'back in the running after five hours')

// The same stamp under a different configured window.
noteNode429(limited, 'a', now - 2 * HOUR)
assert.deepEqual(rankNodes(limited, { now, cooldownHours: 1 }), ['a'], 'the window is a setting, not a constant')
assert.deepEqual(rankNodes(limited, { now, cooldownHours: 3 }), [], 'and a longer window keeps it out')

// --- exclusions and the last resort ---------------------------------------
const pool = emptyNodeTable()
for (const [name, delay] of [['fast', 100], ['mid', 300], ['slow', 700]]) noteNodeDelay(pool, name, delay, now)
assert.deepEqual(rankNodes(pool, { now, exclude: ['fast'] }), ['mid', 'slow'])
assert.deepEqual(rankNodes(pool, { now, exclude: ['fast', 'mid', 'slow'] }), [], 'nothing left to try')

noteNode429(pool, 'fast', now - 1 * HOUR)
noteNode429(pool, 'mid', now - 3 * HOUR)
noteNode429(pool, 'slow', now - 2 * HOUR)
assert.deepEqual(rankNodes(pool, { now }), [], 'all three are cooling')
assert.equal(oldestLimitedNode(pool), 'mid', 'the last resort is the one whose window is closest to expiring')

// --- one pool: direct is a member with latency zero -----------------------
const pool2 = emptyNodeTable()
noteNodeDelay(pool2, 'hk', 213, now)
noteNodeDelay(pool2, 'jp', 382, now)
// Healthy direct wins every time, because zero beats any measured node.
assert.deepEqual(routeCandidates(pool2, { now }).map(r => r.name), ['direct', 'hk', 'jp'])

// Once direct is refused it sits out the window like any node.
noteNode429(pool2, DIRECT_ROUTE, now - HOUR)
assert.deepEqual(routeCandidates(pool2, { now }).map(r => r.name), ['hk', 'jp'], 'a refused direct is skipped, fastest node leads')

// …and comes back when the window passes, ahead of the nodes again.
noteNode429(pool2, DIRECT_ROUTE, now - 5 * HOUR - 60_000)
assert.deepEqual(routeCandidates(pool2, { now }).map(r => r.name), ['direct', 'hk', 'jp'])

// The same rule for a node, applied to the whole pool.
noteNode429(pool2, 'hk', now - HOUR)
assert.deepEqual(routeCandidates(pool2, { now }).map(r => r.name), ['direct', 'jp'], 'the limited node drops out, direct is unaffected')

// --- a refusal outranks a fast reading ------------------------------------
// The ordering that made the pool look broken: the fastest exits are the ones
// most likely to be spent, so latency alone sent every turn at the same
// exhausted nodes while untried ones waited at the bottom of the ladder.
const spent = emptyNodeTable()
noteNodeDelay(spent, 'fast-but-spent', 180, now)
noteNodeDelay(spent, 'slow-but-fresh', 900, now)
noteNode429(spent, 'fast-but-spent', now - 6 * HOUR)   // past the window: eligible again
assert.deepEqual(rankNodes(spent, { now }), ['slow-but-fresh', 'fast-but-spent'],
  'a node that has never said 429 leads one that has, however fast that one is')

// Latency still decides inside a group — it is the tiebreak, not the rule.
noteNodeDelay(spent, 'slow-fresh', 400, now)
noteNodeDelay(spent, 'fast-fresh', 120, now)
assert.deepEqual(rankNodes(spent, { now }), ['fast-fresh', 'slow-fresh', 'slow-but-fresh', 'fast-but-spent'])

// The same ordering over the whole pool, with direct in it.
const spentPool = emptyNodeTable()
noteNodeDelay(spentPool, 'fast-but-spent', 180, now)
noteNodeDelay(spentPool, 'slow-but-fresh', 900, now)
noteNode429(spentPool, 'fast-but-spent', now - 6 * HOUR)
assert.deepEqual(routeCandidates(spentPool, { now }).map(r => r.name), ['direct', 'slow-but-fresh', 'fast-but-spent'],
  'a fresh node is tried before a node that was refused hours ago')

// A node whose only reading is a failure must not rank as "0 ms".
const mixed = emptyNodeTable()
noteNodeDelay(mixed, 'dead', 0, now - 30 * 60_000)
noteNodeDelay(mixed, 'alive', 221, now)
assert.deepEqual(routeCandidates(mixed, { now }).map(r => r.name), ['direct', 'alive', 'dead'],
  'an unmeasured node sorts last, never first')

// Everything cooling is an empty list — the caller decides what to retry.
const dead = emptyNodeTable()
noteNodeDelay(dead, 'a', 100, now)
noteNode429(dead, DIRECT_ROUTE, now - HOUR)
noteNode429(dead, 'a', now - HOUR)
assert.deepEqual(routeCandidates(dead, { now }), [], 'nothing is offered when the whole pool is cooling')

// --- the file survives a round trip and a corrupt read ---------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-nodes-'))
try {
  saveNodeTable(dir, pool)
  const loaded = loadNodeTable(dir)
  assert.deepEqual(loaded.nodes, pool.nodes)
  const stat = fs.statSync(path.join(dir, 'egress', 'nodes.json'))
  assert.equal(stat.mode & 0o777, 0o600, "the book is private: it names the operator's nodes")
  fs.writeFileSync(path.join(dir, 'egress', 'nodes.json'), '{not json')
  assert.deepEqual(loadNodeTable(dir).nodes, {}, 'a corrupt book reads as empty instead of throwing')
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log('outlet nodes: one pool (direct at 0 ms), 429 cools five hours, failures cool ten minutes')
