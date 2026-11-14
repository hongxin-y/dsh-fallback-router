/**
 * The model-profile layer: this plugin's PRIMARY authoring unit.
 *
 * dsh-llm-router was authored around one global `rootChain` plus a set of
 * time-slot rows. The router inverts that: the user declares **model
 * profiles**, and every routing decision derives from them. One profile
 * carries its own
 *
 *   - route (`provider` / `model`),
 *   - time windows (时间区间) — when this profile is the active one,
 *   - fallback policy (兜底配置): `official` (one official DeepSeek model),
 *     `loop` (the next profiles in declaration order, wrapping around so the
 *     last failure returns to the first) or `none`,
 *   - failure rules (失效判定): error codes, regular expressions over the
 *     failure message, and the structural "the stream died inside markup"
 *     detector carried over from dsh-llm-response-guard.
 *
 * The legacy engine (chain walking, cooldown, suppression, the virtual
 * `FallbacksChain/Auto` adapter, the picker rows, subagent roles) is kept
 * verbatim and keeps reading `rootChain` / `timeSlots`. {@link compileRouter}
 * is the ONLY bridge: it compiles the profiles down to those two fields at
 * config-normalization time, so every existing consumer keeps working while
 * the authored shape is profile-centric.
 *
 * This module is pure logic: it must not import any `@deepseek-ai/*` package
 * (types included) — the client bundle imports it for the card's own
 * validation and must never reach schemastery.
 *
 * @module dsh-llm-router/models
 */

import { OFFICIAL_FLASH, PRESET_IDS, resolveSlotState } from './time-slots.ts'
import type { PresetId, SlotRowConfig, SlotWindow } from './time-slots.ts'
import type { FallbacksConfig, NamedFallbackChain } from './config.ts'

/** How a failing profile degrades (兜底配置). */
export type FallbackMode = 'official' | 'loop' | 'none'

/** Every legal {@link FallbackMode}, in UI order. */
export const FALLBACK_MODES: readonly FallbackMode[] = Object.freeze(['official', 'loop', 'none'])

/**
 * The failure codes a fresh profile reacts to — every code the harness (and
 * the pi-ai provider) can report today, including the catch-all
 * `PI_AI_ERROR` that `Upstream rejected the request` lands on.
 */
export const DEFAULT_RULES_CODES: readonly string[] = Object.freeze([
  'AUTH',
  'QUOTA',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'INVALID_REQUEST',
  'PI_AI_ERROR',
  'EMPTY_RESPONSE',
  'CONTEXT_WINDOW_EXCEEDED',
])

/**
 * Protocol markers whose appearance at the END of an answer means the stream
 * died inside a tool call. Carried over from dsh-llm-response-guard, where
 * this list was tuned against 32k historical assistant messages with zero
 * false positives.
 */
export const DEFAULT_MARKERS: readonly string[] = Object.freeze([
  'DSML',
  'antml:',
  'function_calls',
  'tool_calls',
  'tool_use',
  'invoke',
  'parameter',
  'antml_function_calls',
])

/** Per-profile failure detection (失效判定). */
export interface FailureRules {
  /** Failure codes that degrade this profile; an EMPTY list means every code. */
  codes: string[]
  /** Case-insensitive regular expressions matched against the failure message. */
  regex: string[]
  /** Structural detection: a text-only answer that stops inside tool markup. */
  structural: boolean
  /** Markers the structural detector looks for. */
  markers: string[]
}

/**
 * What a profile is made of.
 *
 * - `route` — one `provider/model`, optionally with 时间区间, 兜底 and 规则.
 * - `combo` — 自由组合: no route of its own; every 时间区间 names another
 *   profile through {@link SlotWindow.use}, so one config can hand 梁高峰 to
 *   profile A and 梁低谷 to profile B without duplicating their settings.
 */
export type ModelProfileKind = 'route' | 'combo'

/** Every valid {@link ModelProfileKind}. */
export const MODEL_PROFILE_KINDS: readonly ModelProfileKind[] = Object.freeze(['route', 'combo'])

/**
 * One 追加兜底路由 hop: a `provider/model` plus the 推理等级 it pins. An empty
 * effort follows the model default, exactly like the profile's own route.
 */
export interface ExtraRoute {
  /** `provider/model`. */
  route: string
  /** 推理等级 (`''` = follow the model's default). */
  reasoningEffort: string
}

/** One authored model profile. */
export interface ModelProfile {
  /** Stable id (`/^[a-z0-9-]{1,32}$/`); also the compiled slot row's name. */
  id: string
  /** Human-readable label for the card and the status strip. */
  name: string
  /** 配置类型: `route` serves a provider/model, `combo` only relays windows. */
  kind: ModelProfileKind
  provider: string
  model: string
  /** Time windows in which this profile is the active one (empty = all day). */
  windows: SlotWindow[]
  /** 兜底配置: what happens when this profile fails. */
  fallback: FallbackMode
  /** Target of `fallback: 'official'` (`provider/model`). */
  officialModel: string
  /**
   * 追加兜底路由: extra hops tried after the profile's own route and before the
   * official tail, in declaration order. This is how a hand-written multi-hop
   * chain (the legacy `namedChains` rows) is expressed in the model layer
   * without inventing a second chain syntax.
   */
  extraRoutes: ExtraRoute[]
  /**
   * 在模型选择器里显示: expose this profile as a selectable
   * `FallbacksChain/<name>` row, so picking it in the model picker routes
   * through this profile's compiled chain. Replaces the legacy `namedChains`
   * rows, which were chains you could only reach through the picker.
   */
  expose: boolean
  /**
   * 推理等级: the reasoning effort this profile pins for its own route
   * (`''` = follow the model's default). The host validates the value against
   * the model's advertised efforts, so the panel only offers real ones.
   */
  reasoningEffort: string
  rules: FailureRules
}

/** Per-provider retry policy (对每个 provider 单独开启重试). */
export interface ProviderRetry {
  /** Provider id this row applies to. */
  provider: string
  enabled: boolean
  /** Attempts inside one {@link windowMs} window before giving up. */
  maxRetries: number
  windowMs: number
  initialDelayMs: number
  maxDelayMs: number
  /** Symmetric jitter ratio applied to every backoff step (0 = none). */
  jitterRatio: number
}

/** Defaults of a freshly added provider retry row. */
export const DEFAULT_PROVIDER_RETRY = Object.freeze({
  enabled: true,
  maxRetries: 3,
  windowMs: 300_000,
  initialDelayMs: 800,
  maxDelayMs: 15_000,
  jitterRatio: 0.1,
})

/** Defaults of a freshly added model profile. */
export function defaultRules(): FailureRules {
  return {
    codes: [...DEFAULT_RULES_CODES],
    regex: [],
    structural: true,
    markers: [...DEFAULT_MARKERS],
  }
}

/** Profile id format (same alphabet as role ids). */
export const MODEL_ID_PATTERN = /^[a-z0-9-]{1,32}$/

/** `provider/model` selector of one profile (empty for a combo). */
export function routeOf(profile: ModelProfile): string {
  const provider = profile.provider.trim()
  const model = profile.model.trim()
  return provider === '' || model === '' ? '' : `${provider}/${model}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function count(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : fallback
}

function ratio(value: unknown, fallback: number): number {
  return count(value, fallback, 0, 1)
}

function normalizeWindow(raw: unknown): SlotWindow | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const preset = text(record.preset)
  if (preset !== '' && (PRESET_IDS as readonly string[]).includes(preset)) {
    // A preset window stores no clock fields: the frozen definition is the
    // single source of truth, so a preset row can never drift.
    const presetUse = text(record.use)
    return presetUse === ''
      ? { preset: preset as PresetId, start: '', end: '', days: [] }
      : { preset: preset as PresetId, start: '', end: '', days: [], use: presetUse }
  }
  const start = text(record.start)
  const end = text(record.end)
  if (!/^\d{1,2}:\d{2}$/.test(start) || !/^\d{1,2}:\d{2}$/.test(end)) return undefined
  const days = Array.isArray(record.days)
    ? record.days.filter((day): day is number => typeof day === 'number' && Number.isInteger(day) && day >= 0 && day <= 6)
    : []
  const use = text(record.use)
  return use === '' ? { start, end, days } : { start, end, days, use }
}

/** Normalize authored windows; malformed entries are dropped, never thrown. */
export function normalizeWindows(raw: unknown): SlotWindow[] {
  if (!Array.isArray(raw)) return []
  const out: SlotWindow[] = []
  for (const item of raw) {
    const window = normalizeWindow(item)
    if (window !== undefined) out.push(window)
  }
  return out
}

/**
 * Normalize an authored 追加兜底路由 list (blank rows dropped, duplicates
 * collapsed). Both shapes are accepted: the legacy plain `provider/model`
 * string, and the current `{ route, reasoningEffort }` row that also pins a
 * 推理等级.
 */
export function normalizeRoutes(raw: unknown): ExtraRoute[] {
  if (!Array.isArray(raw)) return []
  const out: ExtraRoute[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const record = item !== null && typeof item === 'object' ? item as Record<string, unknown> : undefined
    const route = record === undefined ? text(item) : text(record.route)
    if (route === '' || seen.has(route)) continue
    seen.add(route)
    out.push({ route, reasoningEffort: record === undefined ? '' : text(record.reasoningEffort) })
  }
  return out
}

/** Normalize authored failure rules (defaults fill every missing field). */
export function normalizeRules(raw: unknown): FailureRules {
  const base = defaultRules()
  if (raw === null || typeof raw !== 'object') return base
  const record = raw as Record<string, unknown>
  const codes = Array.isArray(record.codes)
    ? record.codes.filter((code): code is string => typeof code === 'string' && code.trim() !== '').map((code) => code.trim())
    : base.codes
  const regex = Array.isArray(record.regex)
    ? record.regex.filter((source): source is string => typeof source === 'string' && source.trim() !== '').map((source) => source.trim())
    : base.regex
  const markers = Array.isArray(record.markers)
    ? record.markers.filter((marker): marker is string => typeof marker === 'string' && marker.trim() !== '').map((marker) => marker.trim())
    : base.markers
  return {
    codes,
    regex,
    structural: bool(record.structural, base.structural),
    markers: markers.length > 0 ? markers : base.markers,
  }
}

/** Normalize one authored fallback mode. */
export function normalizeMode(raw: unknown): FallbackMode {
  const value = text(raw)
  return value === 'official' || value === 'loop' || value === 'none' ? value : 'official'
}

/** Normalize one authored profile kind (anything unknown is a plain route). */
export function normalizeKind(raw: unknown): ModelProfileKind {
  return text(raw) === 'combo' ? 'combo' : 'route'
}

/** Normalize the authored profile list (invalid rows are skipped). */
export function normalizeModelProfiles(raw: unknown): ModelProfile[] {
  if (!Array.isArray(raw)) return []
  const out: ModelProfile[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (item === null || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const kind = normalizeKind(record.kind)
    // A combo owns no route: it only relays its windows to other profiles, so
    // an empty provider/model is its normal shape rather than a broken row.
    const provider = kind === 'combo' ? '' : text(record.provider)
    const model = kind === 'combo' ? '' : text(record.model)
    if (kind === 'route' && (provider === '' || model === '')) continue
    const requested = text(record.id)
    let id = MODEL_ID_PATTERN.test(requested) && !seen.has(requested) ? requested : ''
    if (id === '') {
      let index = out.length + 1
      while (seen.has(`model-${index}`)) index += 1
      id = `model-${index}`
    }
    seen.add(id)
    out.push({
      id,
      name: text(record.name) || (kind === 'combo' ? id : `${provider}/${model}`),
      kind,
      provider,
      model,
      windows: normalizeWindows(record.windows),
      fallback: normalizeMode(record.fallback),
      officialModel: text(record.officialModel) || OFFICIAL_FLASH,
      extraRoutes: normalizeRoutes(record.extraRoutes),
      expose: bool(record.expose, false),
      reasoningEffort: kind === 'combo' ? '' : text(record.reasoningEffort),
      rules: normalizeRules(record.rules),
    })
  }
  return out
}

/** Normalize one authored provider retry row. */
export function normalizeProviderRetry(raw: unknown): ProviderRetry | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const record = raw as Record<string, unknown>
  const provider = text(record.provider)
  if (provider === '') return undefined
  return {
    provider,
    enabled: bool(record.enabled, DEFAULT_PROVIDER_RETRY.enabled),
    maxRetries: Math.trunc(count(record.maxRetries, DEFAULT_PROVIDER_RETRY.maxRetries, 0, 100)),
    windowMs: count(record.windowMs, DEFAULT_PROVIDER_RETRY.windowMs, 1_000, 86_400_000),
    initialDelayMs: count(record.initialDelayMs, DEFAULT_PROVIDER_RETRY.initialDelayMs, 1, 600_000),
    maxDelayMs: count(record.maxDelayMs, DEFAULT_PROVIDER_RETRY.maxDelayMs, 1, 600_000),
    jitterRatio: ratio(record.jitterRatio, DEFAULT_PROVIDER_RETRY.jitterRatio),
  }
}

/** Normalize the authored per-provider retry list. */
export function normalizeProviders(raw: unknown): ProviderRetry[] {
  if (!Array.isArray(raw)) return []
  const out: ProviderRetry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const row = normalizeProviderRetry(item)
    if (row === undefined || seen.has(row.provider)) continue
    seen.add(row.provider)
    out.push(row)
  }
  return out
}

/**
 * The ordered chain a profile degrades through, head first.
 *
 * `official` walks one official model; `loop` walks every OTHER profile in
 * declaration order and wraps around, so the last failure returns to the
 * first profile (循环兜底); `none` keeps the single route.
 */
export function compileModelChain(config: FallbacksConfig, index: number): string[] {
  const models = config.models ?? []
  const profile = models[index]
  if (profile === undefined) return []
  // A combo has no chain of its own: it is a schedule of other profiles'
  // chains, resolved per window by compileRouter.
  if (profile.kind === 'combo') return []
  const head = routeOf(profile)
  const chain: string[] = [head]
  const push = (route: string | undefined): void => {
    const value = (route ?? '').trim()
    if (value === '' || chain.includes(value)) return
    chain.push(value)
  }
  // 追加兜底路由 ride directly behind the head, whatever the mode: they are
  // the user's explicit hops (the legacy named-chain shape).
  for (const hop of profile.extraRoutes ?? []) push(hop.route)
  if (profile.fallback === 'none') return chain
  if (profile.fallback === 'official') {
    push(profile.officialModel)
    return chain
  }
  for (let step = 1; step < models.length; step += 1) {
    const next = models[(index + step) % models.length]
    if (next === undefined) continue
    push(routeOf(next))
  }
  return chain
}

/**
 * The chain a `use` reference resolves to, or `[]` when the reference is
 * missing or points at another combo (combos cannot nest — one level of
 * indirection keeps the compiled row a plain chain).
 */
function chainOfReference(config: FallbacksConfig, use: string): string[] {
  const models = config.models ?? []
  const index = models.findIndex((profile) => profile.id === use)
  if (index < 0) return []
  const target = models[index]
  if (target === undefined || target.kind === 'combo') return []
  return compileModelChain(config, index)
}

/**
 * The picker chain of a combo: every window's chain concatenated in authored
 * order and de-duplicated. A combo routes by time window at request time; this
 * flattened chain is what makes it selectable in the model picker at all, and
 * it starts at the first window's head.
 */
function comboChain(config: FallbacksConfig, index: number): string[] {
  const profile = (config.models ?? [])[index]
  if (profile === undefined) return []
  const chain: string[] = []
  const push = (route: string): void => {
    if (route !== '' && !chain.includes(route)) chain.push(route)
  }
  for (const window of profile.windows) {
    const use = window.use ?? ''
    if (use === '') continue
    for (const route of chainOfReference(config, use)) push(route)
  }
  return chain
}

/**
 * The chain a profile serves AT `now` — the request-time answer a picker entry
 * marked 选择器可见 must give.
 *
 * A profile's windows are authored as its own schedule, so selecting that
 * profile in the model picker has to keep switching by time instead of
 * collapsing to one fixed chain. The compiled rows for this profile are
 * resolved through the same {@link resolveSlotState} the root route uses; when
 * no window matches (or the profile has none) the profile's own chain is the
 * all-day answer.
 *
 * @param config - the COMPILED config (`timeSlots` carries this profile's rows).
 * @param profileId - the profile id (also the named picker chain id).
 * @param now - the instant to resolve.
 * @param tz - the wall-clock zone the windows are authored in.
 * @returns the ordered chain, or `[]` when the profile does not exist.
 */
export function profileChainAt(config: FallbacksConfig, profileId: string, now: Date, tz: string): string[] {
  const models = config.models ?? []
  const index = models.findIndex((profile) => profile.id === profileId)
  if (index < 0) return []
  const profile = models[index]
  if (profile === undefined) return []
  const own = profile.kind === 'combo' ? comboChain(config, index) : compileModelChain(config, index)
  const rows = (config.timeSlots ?? []).filter((row) => row.name === profile.id)
  if (rows.length === 0) return own
  const allDay = own.length > 0 ? own : [OFFICIAL_FLASH]
  const state = resolveSlotState({ ...config, timeSlots: rows, rootChain: allDay }, now, tz)
  return state.winner === 'all-day' ? own : state.winner.chain
}

/**
 * Compile the profile list down to the fields the legacy engine reads: the
 * all-day `rootChain`, one time-slot row per authored window, and the picker
 * chains (`namedChains`) of every profile marked `expose`.
 *
 * A window that carries {@link SlotWindow.use} compiles to the referenced
 * profile's chain, which is what makes a combo profile (自由组合) work: one
 * config, many windows, each window served by a different existing profile.
 *
 * With no profiles the authored `rootChain`/`timeSlots`/`namedChains` are
 * returned untouched (a hand-written legacy config keeps working).
 */
export function compileRouter(config: FallbacksConfig): {
  rootChain: string[]
  timeSlots: SlotRowConfig[]
  namedChains: NamedFallbackChain[]
} {
  const models = config.models ?? []
  if (models.length === 0) {
    return {
      rootChain: config.rootChain ?? [],
      timeSlots: config.timeSlots ?? [],
      namedChains: config.namedChains ?? [],
    }
  }
  const rows: SlotRowConfig[] = []
  for (const [index, profile] of models.entries()) {
    for (const window of profile.windows) {
      const chain =
        window.use === undefined || window.use === ''
          ? compileModelChain(config, index)
          : chainOfReference(config, window.use)
      // A row with no chain would be a window that serves nothing; skipping it
      // keeps the engine from switching to an empty route.
      if (chain.length === 0) continue
      rows.push(
        window.preset === undefined
          ? {
              kind: 'custom',
              start: window.start,
              end: window.end,
              days: [...(window.days ?? [])],
              name: profile.id,
              chain,
            }
          : { kind: 'preset', preset: window.preset, name: profile.id, chain },
      )
    }
  }
  const namedChains: NamedFallbackChain[] = []
  for (const [index, profile] of models.entries()) {
    if (!profile.expose) continue
    const chain = profile.kind === 'combo' ? comboChain(config, index) : compileModelChain(config, index)
    // An exposed profile with nothing to route to would be a dead picker entry.
    if (chain.length === 0) continue
    namedChains.push({ id: profile.id, name: profile.name, chain })
  }
  // The all-day route must be a real route: a combo can only ever answer
  // inside its windows, so it never becomes the rootChain.
  const allDay = models.findIndex((profile) => profile.kind === 'route' && profile.windows.length === 0)
  const fallback = models.findIndex((profile) => profile.kind === 'route')
  const rootChain =
    allDay >= 0
      ? compileModelChain(config, allDay)
      : fallback >= 0
        ? compileModelChain(config, fallback)
        : [OFFICIAL_FLASH]
  return { rootChain, timeSlots: rows, namedChains }
}

/** The profile that owns one exact route, if any. */
export function profileForRoute(
  config: FallbacksConfig,
  provider: string,
  model: string,
): ModelProfile | undefined {
  return (config.models ?? []).find((profile) => profile.provider === provider && profile.model === model)
}

/**
 * 推理等级 pinned for one exact route, or `''` when the route follows the
 * model default. A route can be shared by several profiles; the first pin
 * wins, which matches {@link profileForRoute}'s own first-match rule. Routes
 * that only appear as 追加兜底路由 are checked after the profile routes.
 */
export function pinnedEffort(config: FallbacksConfig, provider: string, model: string): string {
  const models = config.models ?? []
  for (const profile of models) {
    if (profile.kind !== 'route') continue
    if (profile.provider !== provider || profile.model !== model) continue
    if (profile.reasoningEffort !== '') return profile.reasoningEffort
  }
  // 追加兜底路由 pin their own 推理等级: a hop reached through the compiled
  // chain must run at the level the author picked for that hop, not at the
  // level of the profile that happens to be active.
  const route = `${provider}/${model}`
  for (const profile of models) {
    for (const hop of profile.extraRoutes ?? []) {
      if (hop.route !== route) continue
      if (hop.reasoningEffort !== '') return hop.reasoningEffort
    }
  }
  return ''
}

/**
 * The profile that is active at `now`: the first matching time window wins,
 * otherwise the first all-day profile, otherwise the first declared profile.
 */
export function activeProfile(config: FallbacksConfig, now: Date, tz: string): ModelProfile | undefined {
  const models = config.models ?? []
  if (models.length === 0) return undefined
  const state = resolveSlotState(config, now, tz)
  const winner = state.winner
  if (winner !== 'all-day') {
    const byId = models.find((profile) => profile.id === winner.name)
    if (byId !== undefined) return byId
  }
  return models.find((profile) => profile.windows.length === 0) ?? models[0]
}

/** One LLM failure, as the `agent/request-error` waterfall reports it. */
export interface FailureLike {
  code?: string
  message?: string
}

/**
 * Whether the authored rules want this failure handled.
 *
 * The failure payload names a PROVIDER but not a model, so every profile on
 * that provider votes: any matching profile rules wins. With no profiles (a
 * legacy chain-authored config) the classic `triggerCodes` gate applies.
 */
export function failureMatches(
  config: FallbacksConfig,
  provider: string,
  failure: FailureLike,
): boolean {
  // Defensive: an emitter that ships no failure object must not make the
  // retry/fallback handlers throw inside the `agent/request-error` waterfall.
  if (failure === undefined || failure === null) return false
  const models = config.models ?? []
  if (models.length === 0) return config.triggerCodes.includes(failure.code ?? '')
  const candidates = models.filter((profile) => profile.provider === provider)
  if (candidates.length === 0) {
    // No profile routes to this provider: the user picked one of its models
    // straight from the model picker. An explicit per-provider retry row still
    // opts that provider in, and the rules that then apply are the ones the
    // settings UI shows as its defaults — otherwise a directly selected model
    // would silently retry only the four legacy `triggerCodes`.
    if (retryFor(config, provider) !== undefined) return matchesRules(defaultRules(), failure)
    return config.triggerCodes.includes(failure.code ?? '')
  }
  return candidates.some((profile) => matchesRules(profile.rules, failure))
}

const REGEX_CACHE = new Map<string, RegExp | null>()

/** Compile (and cache) one authored rule pattern; `null` means invalid. */
export function rulePattern(source: string): RegExp | null {
  const cached = REGEX_CACHE.get(source)
  if (cached !== undefined) return cached
  let compiled: RegExp | null = null
  try {
    compiled = new RegExp(source, 'i')
  } catch {
    compiled = null
  }
  REGEX_CACHE.set(source, compiled)
  return compiled
}

/**
 * Whether one failure is a "this profile is broken" event under `rules`:
 * its code is listed (an EMPTY list matches every code) or one authored
 * regular expression matches the failure message.
 */
export function matchesRules(rules: FailureRules, failure: FailureLike): boolean {
  const code = failure.code ?? ''
  if (rules.codes.length === 0 || rules.codes.includes(code)) return true
  const message = failure.message ?? ''
  if (message === '') return false
  for (const source of rules.regex) {
    const compiled = rulePattern(source)
    if (compiled !== null && compiled.test(message)) return true
  }
  return false
}

/** Concatenated text blocks of one message; tool-call arguments are excluded. */
export function visibleText(message: { content?: unknown } | null | undefined): string {
  const parts: string[] = []
  const content = message?.content
  if (!Array.isArray(content)) return ''
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('')
}

/** Number of real tool-call blocks in one message. */
export function countToolCalls(message: { content?: unknown } | null | undefined): number {
  const content = message?.content
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const block of content) {
    if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'tool-call') total += 1
  }
  return total
}

/** Blocks beyond text and tool-call mean the message is not a plain answer. */
export function hasOtherBlocks(message: { content?: unknown } | null | undefined): boolean {
  const content = message?.content
  if (!Array.isArray(content)) return false
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const type = (block as { type?: unknown }).type
    if (type !== 'text' && type !== 'tool-call') return true
  }
  return false
}

/** Characters that may separate a marker from its markup delimiters. */
const DELIMITERS = '<>|/\\[\\](){}:;,.\\s"\'‘’“”'

/**
 * Whether `marker` sits in markup position, i.e. NOT as a quoted word in prose.
 *
 * The test is structural, with no size or prose heuristics: a run of tags at
 * the END of the answer carrying the name, a delimiter-wrapped protocol token
 * at the end, the opening half of a truncated token at the end, or the whole
 * trimmed text being the marker plus delimiters only. It is deliberately an
 * END-OF-ANSWER test — a broken stream stops emitting inside markup, so
 * anything after the markup means the markup was quoted or followed by real
 * work, not a silent tool-call loss.
 */
export function markerInMarkupPosition(text: string, marker: string): boolean {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // No `\b` on purpose: corrupted tails glue CJK replacement characters onto
  // the name ("</\u951d\u6dd2SML\u951d?invoke>") and `\b` does not treat CJK as
  // a word boundary.
  const carries = new RegExp(escaped, 'i')
  const trimmedTail = text.replace(/\s+$/, '')
  const trailingTags = /((?:\s*<\/?[^<>\n]{0,60}>)+)$/
  const ending = trailingTags.exec(trimmedTail)
  if (ending !== null && carries.test(ending[1] ?? '')) return true
  const tailLine = trimmedTail.slice(Math.max(0, trimmedTail.lastIndexOf('\n') + 1)).trim()
  const lineEnding = trailingTags.exec(tailLine)
  if (lineEnding !== null && carries.test(lineEnding[1] ?? '')) return true
  const tokenLike = new RegExp(`\\|\\s*${escaped}\\s*\\|[ \\t]*$`, 'm')
  if (tokenLike.test(text)) return true
  const trailingToken = new RegExp(`${escaped}\\s*\\|[ \\t]*$`, 'm')
  if (trailingToken.test(text)) return true
  const onlyMarker = new RegExp(`^[${DELIMITERS}]*${escaped}[${DELIMITERS}]*$`, 'i')
  return onlyMarker.test(text.trim())
}

/** Tool names declared in a canonical request header. */
export function headerToolNames(header: unknown): string[] {
  const tools = (header as { tools?: unknown } | null | undefined)?.tools
  if (!Array.isArray(tools)) return []
  const names: string[] = []
  for (const tool of tools) {
    const name = (tool as { name?: unknown } | null | undefined)?.name
    if (typeof name === 'string' && name !== '') names.push(name)
  }
  return names
}

/**
 * Decide whether one assistant message is a degenerate completion — the
 * kernel persisted a normal `stop`, but the text ends inside tool markup, so
 * a tool call was silently dropped.
 *
 * @returns `marker:<marker>` when degenerate, otherwise undefined.
 */
export function degenerateReason(
  message: unknown,
  tools: readonly string[],
  rules: FailureRules,
): string | undefined {
  if (message === null || typeof message !== 'object') return undefined
  const record = message as { role?: unknown; content?: unknown }
  if (record.role !== 'assistant') return undefined
  if (countToolCalls(record) > 0) return undefined
  if (hasOtherBlocks(record)) return undefined
  // Only a model that was TOLD it has tools can have dropped one.
  if (tools.length === 0) return undefined
  const body = visibleText(record)
  if (body.trim().length === 0) return undefined
  for (const marker of rules.markers) {
    if (markerInMarkupPosition(body, marker)) return `marker:${marker}`
  }
  return undefined
}

/**
 * The retry policy for one provider: an explicit `providers[]` row wins, and
 * no row at all means "no retry here" (the request-error waterfall then goes
 * straight to the fallback switch). Retry is strictly opt-in per provider —
 * a default would make every install retry before it ever falls back.
 */
export function retryFor(config: FallbacksConfig, provider: string): ProviderRetry | undefined {
  const rows = config.providers ?? []
  const exact = rows.find((row) => row.provider === provider)
  if (exact !== undefined) return exact.enabled ? exact : undefined
  return undefined
}

/** Minimal logger surface the validators warn through. */
export interface ModelConfigLogger {
  warn(message: string): void
}

/**
 * Validate the authored profile list (pure, warn-only — never throws, never
 * mutates). Each violation emits one `llm-router: ...` warn and the offending
 * row is ignored by the compiler.
 */
export function validateModels(config: FallbacksConfig, logger: ModelConfigLogger): void {
  const models = config.models ?? []
  const seen = new Set<string>()
  for (const [index, profile] of models.entries()) {
    if (!MODEL_ID_PATTERN.test(profile.id)) {
      logger.warn(`llm-router: invalid model id "${profile.id}" — must match /^[a-z0-9-]{1,32}$/`)
    }
    if (seen.has(profile.id)) {
      logger.warn(`llm-router: duplicate model id "${profile.id}" — profile ids must be unique`)
    }
    seen.add(profile.id)
    if (profile.kind === 'route' && (profile.provider.trim() === '' || profile.model.trim() === '')) {
      logger.warn(`llm-router: model "${profile.id}" has an incomplete route "${profile.provider}/${profile.model}" — it cannot serve a request until both halves are filled`)
    }
    if (profile.kind === 'combo' && profile.windows.length === 0) {
      logger.warn(`llm-router: combo "${profile.id}" has no 时间区间 — it can never serve anything`)
    }
    if (profile.expose && profile.kind === 'combo' && comboChain(config, index).length === 0) {
      logger.warn(`llm-router: combo "${profile.id}" is marked 在模型选择器里显示 but resolves to no chain — it is left out of the picker`)
    }
    for (const window of profile.windows) {
      const use = window.use ?? ''
      if (use === '') {
        if (profile.kind === 'combo') {
          logger.warn(`llm-router: combo "${profile.id}" has a window without 使用配置 — that window is ignored`)
        }
        continue
      }
      const target = models.find((candidate) => candidate.id === use)
      if (target === undefined) {
        logger.warn(`llm-router: model "${profile.id}" points a window at unknown profile "${use}" — that window is ignored`)
      } else if (target.kind === 'combo') {
        logger.warn(`llm-router: model "${profile.id}" points a window at combo "${use}" — combos cannot nest, that window is ignored`)
      }
    }
    if (!FALLBACK_MODES.includes(profile.fallback)) {
      logger.warn(`llm-router: model "${profile.id}" has invalid fallback "${String(profile.fallback)}" — expected official, loop or none`)
    }
    if (profile.fallback === 'official' && !profile.officialModel.includes('/')) {
      logger.warn(`llm-router: model "${profile.id}" official fallback "${profile.officialModel}" is not a provider/model selector`)
    }
    for (const source of profile.rules.regex) {
      if (rulePattern(source) === null) {
        logger.warn(`llm-router: model "${profile.id}" rule /${source}/ is not a valid regular expression — ignored`)
      }
    }
    for (const window of profile.windows) {
      if (!/^\d{1,2}:\d{2}$/.test(window.start) || !/^\d{1,2}:\d{2}$/.test(window.end)) {
        logger.warn(`llm-router: model "${profile.id}" has a malformed window ${window.start}-${window.end} — ignored`)
      }
    }
    if (index === 0 && models.length === 1 && profile.fallback === 'loop') {
      logger.warn('llm-router: model "{}" uses loop fallback but is the only profile — the loop has nowhere to go'.replace('{}', profile.id))
    }
  }
  const providers = config.providers ?? []
  const seenProviders = new Set<string>()
  for (const row of providers) {
    if (row.provider.trim() === '') {
      logger.warn('llm-router: a retry row has an empty provider — it matches no provider and is ignored')
    }
    if (seenProviders.has(row.provider)) {
      logger.warn(`llm-router: duplicate retry row for provider "${row.provider}" — the first row wins`)
    }
    seenProviders.add(row.provider)
    if (row.maxDelayMs < row.initialDelayMs) {
      logger.warn(`llm-router: retry row "${row.provider}" has maxDelayMs below initialDelayMs — the delay stays at initialDelayMs`)
    }
  }
}

/**
 * Drop failures that fell out of the trailing window, then report how many are
 * still inside it. Mutates `list` in place so the caller keeps one array.
 */
export function pruneFailures(list: number[], now: number, windowMs: number): number {
  const cutoff = now - windowMs
  let drop = 0
  while (drop < list.length && list[drop] <= cutoff) drop += 1
  if (drop > 0) list.splice(0, drop)
  return list.length
}

/** Bounded exponential backoff with symmetric jitter, mirroring llm-retry. */
export function retryDelay(policy: ProviderRetry, attempt: number): number {
  const exponent = Math.min(Math.max(attempt - 1, 0), 16)
  const exponential = Math.min(policy.initialDelayMs * 2 ** exponent, policy.maxDelayMs)
  const jitter = 1 - policy.jitterRatio + 2 * policy.jitterRatio * Math.random()
  return Math.min(Math.round(exponential * jitter), policy.maxDelayMs)
}

/** Cancellable wait; resolves false when the step was aborted mid-backoff. */
export function waitFor(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted === true) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve(false)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
