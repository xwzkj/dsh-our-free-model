/**
 * The outlet's node book: what each node measured, and when it last said 429.
 *
 * mihomo's own url-test is stateless — it re-ranks every few minutes and forgets
 * everything in between. That is the wrong memory for this job: a node that
 * answered 429 an hour ago is still spent, and re-choosing it costs a turn. So
 * the choice is made here, from a table the plugin owns, and the group is pinned
 * with `PUT /proxies/ofm-outlet`.
 *
 * Two clocks, deliberately different:
 *
 * - **delay** is a routing hint, refreshed hourly. Stale latency is still a
 *   usable hint, so an old reading never excludes a node.
 * - **429** is a quota verdict about an exit address, and a provider's pool
 *   refills on its own schedule. Five hours is the configured assumption: past
 *   that, the node is a candidate again.
 *
 * A transport failure is neither: the node may be down, or the path to it may be
 * having a bad minute, so it cools for ten minutes instead of five hours.
 *
 * @module src/outlet-nodes.js
 */

import fs from 'node:fs'
import path from 'node:path'

export const NODE_TABLE_FILE = 'nodes.json'

/**
 * The direct path is a pool member like any other, with a latency of zero.
 *
 * That is the whole rule: on a turn, take the lowest-latency path whose 429 is
 * older than the cooldown. Direct costs nothing extra, so it always wins while
 * it is healthy — and the moment it is refused, it sits out five hours like any
 * node and the fastest node takes its place.
 */
export const DIRECT_ROUTE = 'direct'

/** Five hours: how long a 429 keeps a node out of the running. */
export const DEFAULT_COOLDOWN_HOURS = 5
/** Ten minutes: how long a connect failure keeps a node out of the running. */
export const DEFAULT_FAIL_MINUTES = 10

const jsonFile = dataDir => path.join(dataDir, 'egress', NODE_TABLE_FILE)

/** A fresh, empty book. */
export function emptyNodeTable() {
  return { version: 1, updatedAt: 0, nodes: {} }
}

/**
 * Read the book, tolerating every kind of damage.
 *
 * A corrupt or missing file is not an error worth failing a turn over — it just
 * means every node is unmeasured, which `rankNodes` already handles (unknown
 * delays sort last, nothing is excluded). The file is 0600 and holds no secrets,
 * only node names and timings.
 */
export function loadNodeTable(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(jsonFile(dataDir), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.nodes !== 'object' || parsed.nodes === null) return emptyNodeTable()
    return { version: 1, updatedAt: Number(parsed.updatedAt) || 0, nodes: parsed.nodes }
  } catch {
    return emptyNodeTable()
  }
}

/** Write the book atomically: a reader never sees half a table. */
export function saveNodeTable(dataDir, table) {
  const target = jsonFile(dataDir)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(table, null, 2)}\n`, { mode: 0o600 })
  fs.renameSync(temporary, target)
}

function slot(table, name) {
  const key = String(name)
  const existing = table.nodes[key]
  if (existing !== undefined && typeof existing === 'object') return existing
  const created = { delayMs: 0, delayAt: 0, last429At: 0, lastFailAt: 0, fails: 0 }
  table.nodes[key] = created
  return created
}

/** Record a measurement. `delayMs <= 0` means the node did not answer at all. */
export function noteNodeDelay(table, name, delayMs, now = Date.now()) {
  const entry = slot(table, name)
  if (Number.isFinite(delayMs) && delayMs > 0) {
    entry.delayMs = Math.trunc(delayMs)
    entry.delayAt = now
    entry.fails = 0
    return entry
  }
  entry.delayMs = 0
  entry.delayAt = now
  entry.lastFailAt = now
  entry.fails = (Number(entry.fails) || 0) + 1
  return entry
}

/** The node carried a turn: clear the failure counter, leave the 429 stamp alone. */
export function noteNodeSuccess(table, name, now = Date.now()) {
  const entry = slot(table, name)
  entry.okAt = now
  entry.fails = 0
  return entry
}

/** The node's exit address is out of quota. This is the five-hour stamp. */
export function noteNode429(table, name, now = Date.now()) {
  const entry = slot(table, name)
  entry.last429At = now
  return entry
}

/**
 * Candidate node names, best first.
 *
 * Order: measured latency ascending, then unmeasured nodes. Excluded: a 429
 * inside the cooldown window, a failure inside the short window, and anything
 * named in `exclude` (the nodes this turn already tried).
 *
 * When every node is excluded the caller gets an empty list and decides — this
 * function does not quietly resurrect a spent node, because "pick the least bad
 * one" is a policy the caller may want to apply only once.
 */
export function rankNodes(table, {
  now = Date.now(),
  cooldownHours = DEFAULT_COOLDOWN_HOURS,
  failMinutes = DEFAULT_FAIL_MINUTES,
  exclude = [],
} = {}) {
  const cooldownMs = Math.max(0, cooldownHours) * 3_600_000
  const failMs = Math.max(0, failMinutes) * 60_000
  const skip = new Set(exclude.map(String))
  const ranked = []
  for (const [name, raw] of Object.entries(table.nodes ?? {})) {
    // `rankNodes` answers "which *nodes*", so the direct entry — which shares the
    // table so the five-hour rule applies to it too — is not one of them.
    if (skip.has(name) || name === DIRECT_ROUTE) continue
    const entry = raw ?? {}
    const last429At = Number(entry.last429At) || 0
    if (cooldownMs === 0 ? last429At > 0 : last429At > 0 && now - last429At < cooldownMs) continue
    const lastFailAt = Number(entry.lastFailAt) || 0
    if (failMs === 0 ? lastFailAt > 0 : lastFailAt > 0 && now - lastFailAt < failMs) continue
    const delayMs = Number(entry.delayMs) || 0
    ranked.push({ name, delayMs })
  }
  ranked.sort((a, b) => {
    // A measured node always outranks an unmeasured one, however slow: an
    // unmeasured node is one we know nothing about, not one we know is fast.
    if (a.delayMs > 0 && b.delayMs === 0) return -1
    if (a.delayMs === 0 && b.delayMs > 0) return 1
    if (a.delayMs !== b.delayMs) return a.delayMs - b.delayMs
    return a.name.localeCompare(b.name)
  })
  return ranked.map(item => item.name)
}

/**
 * Every path a turn may take, best first — direct included, at latency 0.
 *
 * This is the rule the operator asked for, spelled out: one pool, one ordering
 * (latency), one exclusion (a 429 inside the cooldown window). `direct` carries
 * no latency reading of its own and is never given one; only its 429 stamp
 * matters, because a refused direct connection is exactly what the pool is for.
 *
 * A failed *connection* cools a node for the short window; it never cools
 * `direct`, because a reset on the way out says nothing about our own address.
 */
export function routeCandidates(table, {
  now = Date.now(),
  cooldownHours = DEFAULT_COOLDOWN_HOURS,
  failMinutes = DEFAULT_FAIL_MINUTES,
  exclude = [],
} = {}) {
  const cooldownMs = Math.max(0, cooldownHours) * 3_600_000
  const failMs = Math.max(0, failMinutes) * 60_000
  const skip = new Set(exclude.map(String))
  const routes = []
  if (!skip.has(DIRECT_ROUTE)) {
    const direct = table.nodes?.[DIRECT_ROUTE] ?? {}
    const last429At = Number(direct.last429At) || 0
    if (!(cooldownMs === 0 ? last429At > 0 : last429At > 0 && now - last429At < cooldownMs)) {
      routes.push({ name: DIRECT_ROUTE, delayMs: 0, direct: true })
    }
  }
  for (const [name, raw] of Object.entries(table.nodes ?? {})) {
    if (name === DIRECT_ROUTE || skip.has(name)) continue
    const entry = raw ?? {}
    const last429At = Number(entry.last429At) || 0
    if (cooldownMs === 0 ? last429At > 0 : last429At > 0 && now - last429At < cooldownMs) continue
    const lastFailAt = Number(entry.lastFailAt) || 0
    if (failMs === 0 ? lastFailAt > 0 : lastFailAt > 0 && now - lastFailAt < failMs) continue
    routes.push({ name, delayMs: Number(entry.delayMs) || 0, direct: false })
  }
  routes.sort((a, b) => {
    if (a.delayMs !== b.delayMs) return a.delayMs - b.delayMs
    // Equal latency: direct first, it is the cheapest to use. Node names break
    // the remaining ties so the order is stable between turns.
    if (a.direct !== b.direct) return a.direct ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return routes
}

/**
 * The node whose 429 is oldest, for the case where every node is cooling.
 *
 * Retrying the one that has been cooling longest is the only guess left that is
 * better than giving up: its window is closest to expiring, and a wrong guess
 * costs one refused request. Returns `null` for an empty book.
 */
export function oldestLimitedNode(table, { exclude = [] } = {}) {
  const skip = new Set(exclude.map(String))
  let best = null
  let bestAt = Infinity
  for (const [name, raw] of Object.entries(table.nodes ?? {})) {
    if (skip.has(name)) continue
    const at = Number(raw?.last429At) || 0
    if (at < bestAt) { best = name; bestAt = at }
  }
  return best
}

/** Everything the settings page could show about one node, without the secrets. */
export function describeNode(entry, now = Date.now()) {
  const last429At = Number(entry?.last429At) || 0
  return {
    delayMs: Number(entry?.delayMs) || 0,
    delayAt: Number(entry?.delayAt) || 0,
    last429At,
    limitedForMs: last429At > 0 ? Math.max(0, last429At + DEFAULT_COOLDOWN_HOURS * 3_600_000 - now) : 0,
  }
}
