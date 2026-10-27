/**
 * Perception event priority filtering.
 *
 * Miloco's perception suggestions carry an urgency (`high` / `medium` /
 * `low`; upstream drops `ignore` before dispatch). The DSH plugin allows the
 * owner to set a minimum level: events below it never become a DSH turn.
 *
 * Rules, tasks, onboarding and normal conversation events do not carry an
 * urgency; they always pass. This filter only applies when an urgency can be
 * determined, either from a structured field or from the `事件优先级：...`
 * line in Miloco's event text.
 *
 * @module dsh-miloco-bridge/perception
 */

/** Allowed minimum levels. `all` disables filtering. */
export const PERCEPTION_LEVELS = ['all', 'low', 'medium', 'high']

/** Numeric ranking; larger = more urgent. */
export const PERCEPTION_RANK = {
  low: 1,
  medium: 2,
  high: 3,
}

/**
 * Normalise a configured minimum level.
 * @param {unknown} value - Raw config value.
 * @returns {'all'|'low'|'medium'|'high'} A valid level.
 */
export function normalizePerceptionLevel(value) {
  const text = String(value ?? '').trim().toLowerCase()
  return PERCEPTION_LEVELS.includes(text) ? text : 'all'
}

/**
 * Pick the most urgent value from a list of matches.
 * @param {string[]} values - Raw urgency strings.
 * @returns {'high'|'medium'|'low'|'ignore'|''} The highest urgency, or empty.
 */
function highestUrgency(values) {
  let best = ''
  let bestRank = 0
  let sawIgnore = false
  for (const raw of values) {
    const value = String(raw ?? '').trim().toLowerCase()
    if (value === 'ignore') {
      sawIgnore = true
      continue
    }
    const rank = PERCEPTION_RANK[value] ?? 0
    if (rank > bestRank) {
      best = value
      bestRank = rank
    }
  }
  return best || (sawIgnore ? 'ignore' : '')
}

/**
 * Read the urgency of an inbound push.
 *
 * Structured fields win. Otherwise parse every `事件优先级：...` line in the
 * message and take the highest one, so a batch containing high + low is
 * treated as high.
 *
 * @param {any} payload - Webhook payload.
 * @returns {'high'|'medium'|'low'|'ignore'|''} The urgency, or empty when the
 * event is not a perception event.
 */
export function parseUrgency(payload) {
  const candidates = [
    payload?.urgency,
    payload?.priority,
    payload?.perception?.urgency,
    payload?.event?.urgency,
  ]
  const direct = candidates.find(value => typeof value === 'string' && value.trim() !== '')
  if (direct) {
    const value = direct.trim().toLowerCase()
    if (value === 'ignore' || value in PERCEPTION_RANK) return value
  }

  const text = typeof payload?.message === 'string' ? payload.message : ''
  if (!text) return ''
  const values = []
  const re = /(?:事件优先级|urgency)\s*[：:=]\s*(high|medium|low|ignore)/gi
  for (const match of text.matchAll(re)) values.push(match[1])
  return highestUrgency(values)
}

/**
 * Decide whether an event is at or above the configured minimum.
 * @param {'high'|'medium'|'low'|'ignore'|''} urgency - Parsed urgency.
 * @param {string} minLevel - Configured minimum level.
 * @returns {boolean} Whether the event may be delivered.
 */
export function perceptionAllowed(urgency, minLevel) {
  if (!urgency) return true
  if (urgency === 'ignore') return false
  const min = PERCEPTION_RANK[normalizePerceptionLevel(minLevel)] ?? 0
  return (PERCEPTION_RANK[urgency] ?? 0) >= min
}
