/**
 * What a thread is *for*, when where it runs is not enough to tell you.
 *
 * Most zones are a repo, and a repo is a good enough answer: the threads standing on it all
 * touch the same code. A workspace folder is not. Sessions started from `~/PycharmProjects`
 * all report that one directory as their project, so they land on one enormous plot holding
 * PR reviews, ticket triage, incident digs and one-off scripts side by side — a pile you
 * cannot read anything off.
 *
 * So a crowded zone splits by what its threads are doing instead. The signal has to come
 * from the thread itself, and the only field that carries intent is the title: a thread
 * launched from a skill names the skill in it, and the rest describe themselves in fairly
 * consistent words.
 */

/**
 * Under this many threads a project stays one zone — the split is for piles, not repos. Only
 * the default: the colony reads the `splitAt` setting, and 0 there turns splitting off.
 */
export const SPLIT_AT = 12

/**
 * A skill or slash command in the title. Claude Code opens a skill thread with the skill's
 * own preamble, which starts by naming its directory, so the path is the reliable half;
 * a bare `/name` at the very start covers the ones typed by hand.
 */
const SKILL_PATH = /skills\/([a-z0-9][a-z0-9._-]*)/i
const SLASH_COMMAND = /^\s*\/([a-z0-9][a-z0-9-]*)\b/i

/**
 * Keyword buckets, first match wins. The order is the point: "Review and merge CF-2237"
 * is a review before it is a ticket, and "Fix comparison-bot crashloop using Loki logs" is
 * an incident before it is a fix — the more specific reading comes first, exactly like
 * `statusFor`.
 */
const BUCKETS = [
  { key: 'reviews', label: 'reviews', test: /pull request|\bpr\b|\bmr\b|code review|\breview\b/i },
  { key: 'incidents', label: 'incidents', test: /sentry|crashloop|traceback|stack trace|exception|\bloki\b|\btrace\b|incident|outage/i },
  { key: 'tickets', label: 'tickets', test: /\b(cs|cf|bug|eb|ef|com|bc|dev|ai)-\d+\b|jira|ticket|backlog|triage/i },
  { key: 'infra', label: 'infra', test: /kubernetes|\bk8s\b|kubectl|cluster|namespace|\bpod\b|helm|deploy|bamboo|\bci\b|pipeline|rollout/i },
  { key: 'fixes', label: 'fixes', test: /\bfix(ed|es|ing)?\b|\bbug\b|broken|failure|regression|debug/i },
  { key: 'reports', label: 'reports', test: /report|analytics|baseline|audit|\bstats\b|summar(y|ise|ize)/i },
  { key: 'builds', label: 'builds', test: /implement|\badd\b|\bcreate\b|build|migrat|refactor|optimi[sz]e|\bfeature\b/i },
]

/**
 * Which kind of work a thread is. Returns a stable key for grouping and a short label for
 * the plate over the zone — the key is what the layout remembers, so it must not drift
 * with wording.
 */
export function taskTypeOf(thread) {
  const title = thread.title || ''
  const skill = title.match(SKILL_PATH) || title.match(SLASH_COMMAND)
  if (skill) {
    const name = skill[1].toLowerCase()
    // Labelled with its leading slash, so a zone of `/fix` threads never reads as the
    // `fixes` keyword bucket sitting a few tiles away.
    return { key: `skill:${name}`, label: `/${name}` }
  }
  const text = `${title} ${thread.preview || ''}`
  for (const bucket of BUCKETS) {
    if (bucket.test.test(text)) return { key: bucket.key, label: bucket.label }
  }
  return { key: 'misc', label: 'misc' }
}

/**
 * Group threads into zones: one per project, except that a project over `splitAt` threads
 * becomes one zone per task type. `splitAt` of 0 means never split — every repo is one zone,
 * however many threads are standing on it.
 *
 * The decision is made on the project's *whole* size rather than on each type's, so a zone
 * does not merge back into its parent the moment one of its types thins out — the map is
 * only worth learning if it holds still.
 *
 * @returns Map of zone key → { key, project, label, threads }, biggest first.
 */
export function zonesFor(threads, splitAt = SPLIT_AT) {
  const byProject = new Map()
  for (const thread of threads) {
    const key = thread.project || 'unknown'
    if (!byProject.has(key)) byProject.set(key, [])
    byProject.get(key).push(thread)
  }

  // A subagent belongs wherever its parent stands, whatever its own prompt happens to say.
  // Read on its own, "Adversarially verify this finding" is a review and its parent is a
  // migration — and splitting a fan-out away from the thread that spawned it loses the one
  // thing worth seeing about it, which is the crowd on that thread's site.
  const parentOf = new Map(threads.filter((t) => t.subagent && t.parentId).map((t) => [t.id, t.parentId]))

  const zones = new Map()
  for (const [project, list] of byProject) {
    if (!splitAt || list.length <= splitAt) {
      zones.set(project, { key: project, project, label: project, threads: list })
      continue
    }
    const typeById = new Map()
    for (const thread of list) typeById.set(thread.id, taskTypeOf(thread))
    for (const thread of list) {
      const parent = parentOf.get(thread.id)
      const type = (parent && typeById.get(parent)) || typeById.get(thread.id)
      // The separator never appears in a folder name or a skill name, so an unsplit
      // project can never collide with a split one's zone.
      const key = `${project}›${type.key}`
      if (!zones.has(key)) {
        zones.set(key, { key, project, label: `${project} › ${type.label}`, threads: [] })
      }
      zones.get(key).threads.push(thread)
    }
  }

  return new Map(
    [...zones.entries()].sort((a, b) => {
      if (b[1].threads.length !== a[1].threads.length) return b[1].threads.length - a[1].threads.length
      return a[0].localeCompare(b[0])
    })
  )
}
