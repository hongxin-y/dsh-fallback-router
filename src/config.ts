/**
 * The `fallbacks` settings namespace: config types + defaults (the
 * schemastery `Config` schema lives in `./schema.ts`, host-only — this
 * module must stay free of `@deepseek-ai/*` value imports so the client
 * bundle never reaches schemastery).
 *
 * Two-block config model (plan fallbacks-role-config-model): block 1
 * `rootChain` — the root agent's single fallback chain (empty = no
 * degradation) — plus block 2 declared role entities: `roles.list`
 * (id/persona/prompt?/permissions?/chain?/fallback) and
 * `roles.rules` enum references into the declared ids (or the built-in
 * `'inherit'` role). The legacy `chains` / `roles.default` keys are gone
 * from the schema and type (zero residual, migration table excepted); the
 * runtime consumes the new shape directly and flags surviving legacy keys
 * at startup via `detectLegacyKeys` (see `src/index.ts` apply()).
 *
 * Spec §4 is authoritative for field names and default values — notably
 * `triggerCodes` defaults to dsh's stable failure codes `['AUTH', 'QUOTA',
 * 'RATE_LIMIT']` (there is no `QUOTA_EXCEEDED` code in dsh), and an
 * unconfigured install (empty `rootChain`, no time slots, empty roles) is a
 * no-op pass-through exactly like an uninstalled plugin (AC-8 —
 * {@link isFallbackActive}). There is NO config-level `enabled` switch
 * (plan fallbacks-web-ux-alignment T2): the Plugins-page row toggle is the
 * master switch (row disable = fiber destroy), and the runtime gates re-key
 * to content presence. A stored profile still carrying the removed
 * `enabled:` key loads cleanly — the gateway tolerates and strips it (the
 * advisor LEGACY_KEYS mechanism), it is never read and never re-persisted.
 *
 * This module is pure logic: it must not import any `@deepseek-ai/*` package
 * (types included) — `FallbacksConfig` is the plugin's own type. Task 3
 * registers the schemastery schema (see `./schema.ts`) with
 * `installSettingsSection` under the `fallbacks` settings namespace.
 *
 * @module dsh-fallback-router/config
 */

import { parseSelector } from './selectors.ts'
import { PRESETS, isAllDayConforming } from './time-slots.ts'
import type { SlotRowConfig } from './time-slots.ts'
import { ESCALATION_CAP_MS } from './recovery.ts'
import { validateModels } from './models.ts'
import type { ModelProfile, ProviderRetry } from './models.ts'

/** How an expired cooldown recovers the route (plan fallbacks-half-open-recovery Task 1). */
export type RecoveryPolicy = 'timer' | 'half-open'
/** How a cooled-down model comes back (spec §4). */
export type RevertPolicy = 'cooldown-expiry' | 'never'

/** A single role rule: match on provider/model patterns (spec §3). */
export interface FallbacksRoleRule {
  /**
   * Legacy persisted wire field (PR #62 feedback): rules are subagent-only,
   * so this constraint is IGNORED at match time — root requests never
   * match rules. Kept in the type/schema so pre-feedback `settings.yaml`
   * files that carry `origin` still parse, validate, and save unchanged.
   */
  origin?: 'root' | 'subagent'
  provider?: string
  model?: string
  role: string
}

/**
 * Chain-append strategy of a declared role entity: `inherit-root` (the
 * default) runs the role's own chain and then appends `rootChain`;
 * `none` uses only the role's own chain.
 */
export type FallbackStrategy = 'inherit-root' | 'none'

/**
 * A declared role entity (plan fallbacks-role-config-model Task 1).
 *
 * `prompt` / `permissions` are schema-reserved for the next iteration
 * (fallbacks-explicit-role-tool) — no consumer this round, and writing them
 * does NOT change this round's degradation behavior.
 */
export interface FallbacksRole {
  id: string
  /** Personality hint (人格提示) — free text, never validated. */
  persona: string
  /** Reserved for next iteration — no consumer this round. */
  prompt?: string
  /** Reserved for next iteration — no consumer this round. */
  permissions?: { allow?: string[]; deny?: string[] }
  chain?: string[]
  fallback?: FallbackStrategy
}

/** Role grouping for fallback chains: declared entities + enum references. */
export interface FallbacksRoles {
  list: FallbacksRole[]
  rules: FallbacksRoleRule[]
}

/** A fixed, user-selectable fallback chain exposed as its own picker route. */
export interface NamedFallbackChain {
  /** Stable route id; lowercase letters, digits, and hyphens only. */
  id: string
  /** Human-readable model-picker label. */
  name: string
  /** Ordered provider/model selectors tried after a failure. */
  chain: string[]
}

/**
 * The full `fallbacks` settings shape (two-block config model, verbatim
 * field names).
 */
export interface FallbacksConfig {
  /**
   * The authored model profiles — THE primary config surface of this plugin
   * (see `src/models.ts`). When non-empty they COMPILE down to `rootChain` +
   * `timeSlots` at normalization time; the compiled fields are then derived
   * state, never authored.
   */
  models: ModelProfile[]
  /** Per-provider retry rows (对每个 provider 单独开启重试). */
  providers: ProviderRetry[]
  triggerCodes: string[]
  rootChain: string[]
  roles: FallbacksRoles
  /** Fixed named chains exposed as independent model-picker routes. */
  namedChains?: NamedFallbackChain[]
  cooldownMs: number
  revertPolicy: RevertPolicy
  maxSwitchesPerStep: number
  alwaysModeRetryCap: number
  /**
   * Preset-role injection switch: `'bundled'` declares the 5 preset roles
   * (spec §9.2) as seed rows on apply; `'none'` disables declaration.
   * Optional on purpose — a required field would break library consumers
   * that construct `FallbacksConfig` literals with the existing 8 keys
   * (additive, non-breaking). The value domain is guarded by the schema
   * (`Config` in `src/schema.ts`), NOT by `validateFallbacksConfig`, and
   * every resolved config carries a value via the schema default.
   */
  presets?: 'bundled' | 'none'
  /**
   * Dispatch-time LLM role auto-match switch (plan fallbacks-role-automatch
   * Task 1): when `true` (default), a subagent-origin request with no
   * explicit/rules-resolved role may have the best-fit declared role picked
   * by the LLM; `false` reproduces today's behavior exactly. Optional on
   * purpose, mirroring `presets` — a required field would break library
   * consumers that construct `FallbacksConfig` literals with the existing
   * keys (additive, non-breaking). The value domain is guarded by the
   * schema (`z.boolean().default(true)` in `src/schema.ts`), and the
   * runtime reads it defensively as `config.roleAutoMatch ?? true` (safe
   * for direct constructors that omit it).
   */
  roleAutoMatch?: boolean
  /**
   * Extra time-slot rows (plan fallbacks-timeslots Task 1, P5): the FIRST
   * matching row's chain becomes the effective root chain at request time;
   * `rootChain` (the all-day chain) is always the last row.
   * Optional on purpose, mirroring `presets` — additive, non-breaking for
   * library consumers. Malformed rows warn once and are skipped by the
   * resolver; the gateway rejects them on save (Task 3).
   */
  timeSlots?: SlotRowConfig[]
  /**
   * Config-level timezone for slot matching (default `Asia/Shanghai`,
   * UTC+8). Not per-slot.
   */
  tz?: string
  /**
   * Cooldown-expiry recovery mode (plan fallbacks-half-open-recovery Task
   * 1): `'timer'` restores the preferred candidate when the cooldown
   * expires (today's behavior); `'half-open'` leaves the route half-open
   * for one logged probe instead. Optional on purpose, mirroring
   * `presets` — a required field would break library consumers that
   * construct `FallbacksConfig` literals with the existing keys
   * (additive, non-breaking). The value domain is guarded by the schema
   * (`Config` in `src/schema.ts`), NOT by `validateFallbacksConfig`, and
   * every resolved config carries a value via the schema default.
   */
  recovery?: RecoveryPolicy
}

/**
 * Spec §4 defaults — `Config({})` must equal this (no-op install).
 * There is no `enabled` default (the key is removed — the Plugins-page row
 * toggle is the master switch): an unconfigured install (empty rootChain,
 * no time slots, empty roles) behaves exactly like an uninstalled plugin
 * (AC-3 / no-op invariant, {@link isFallbackActive}).
 */
export const defaultFallbacksConfig: FallbacksConfig = {
  models: [],
  providers: [],
  triggerCodes: ['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER'],
  rootChain: [],
  roles: { list: [], rules: [] },
  namedChains: [],
  cooldownMs: 300_000,
  revertPolicy: 'cooldown-expiry',
  maxSwitchesPerStep: 8,
  alwaysModeRetryCap: 5,
  presets: 'bundled',
  roleAutoMatch: true,
  timeSlots: [],
  tz: 'Asia/Shanghai',
  recovery: 'timer',
}

/**
 * Reserved role id: legal as a rule target (`roles.rules[].role`) and as
 * the no-rule-match fallback, but FORBIDDEN in `roles.list[].id`.
 */
export const INHERIT_ROLE_ID = 'inherit'

/**
 * The no-op gate (AC-8), re-keyed from the removed `enabled` switch to
 * CONTENT PRESENCE (plan fallbacks-web-ux-alignment T2): the plugin
 * intervenes exactly when something is configured — a non-empty `rootChain`
 * (the all-day chain), at least one time-slot row, or at least one declared
 * role. An inactive config is a pass-through exactly like an uninstalled
 * plugin; the Plugins-page row toggle remains the master switch (row
 * disable = fiber destroy). ONE helper for every runtime gate — the former
 * `config.enabled` sites (request waterfalls, picker-row registration, TUI
 * summary, General-row badge) all read through this.
 */
export function isFallbackActive(config: FallbacksConfig): boolean {
  return (config.models?.length ?? 0) > 0
    || config.rootChain.length > 0
    || (config.timeSlots?.length ?? 0) > 0
    || config.roles.list.length > 0
    || (config.namedChains?.length ?? 0) > 0
}

/** Role id format (aligned with yet-another-subagent `isValidProfileId`). */
export const ROLE_ID_PATTERN = /^[a-z0-9-]{1,32}$/

/** Provider prefix for fixed named-chain picker routes. */
export const NAMED_FALLBACK_PROVIDER_PREFIX = 'FallbacksChain-'
/** The sole model id exposed by each fixed named-chain provider route. */
export const NAMED_FALLBACK_MODEL = 'Chain'

/** Convert a validated named-chain id into its virtual provider route. */
export function namedFallbackProvider(id: string): string | undefined {
  const normalized = id.trim()
  if (!ROLE_ID_PATTERN.test(normalized) || normalized === 'auto') return undefined
  return `${NAMED_FALLBACK_PROVIDER_PREFIX}${normalized}`
}

/** Recover a validated named-chain id from a virtual provider route. */
export function namedFallbackId(provider: string): string | undefined {
  if (!provider.startsWith(NAMED_FALLBACK_PROVIDER_PREFIX)) return undefined
  const id = provider.slice(NAMED_FALLBACK_PROVIDER_PREFIX.length)
  if (!ROLE_ID_PATTERN.test(id) || id === 'auto') return undefined
  return id
}

/** Find a named chain addressed by one of its virtual provider routes. */
export function namedFallbackChain(config: FallbacksConfig, provider: string): NamedFallbackChain | undefined {
  const id = namedFallbackId(provider)
  return id === undefined ? undefined : config.namedChains?.find(chain => chain.id.trim() === id)
}

/**
 * Minimal logger surface {@link validateFallbacksConfig} warns through —
 * keeps this module free of `@deepseek-ai/*` imports (a cordis Logger is
 * structurally compatible).
 */
export interface FallbacksConfigLogger {
  warn(message: string): void
}

/**
 * Validate a fallbacks config (pure, warn-only — never throws, never
 * mutates): role id format/uniqueness/reserved word, rule role references
 * (declared ids + the built-in `'inherit'`), the `fallback` enum,
 * `rootChain`/role-chain selector legality, and the role model-config
 * requirement (a declared role with a missing/empty chain warns — a role
 * without a model config is meaningless, plan fallbacks-feedback-round
 * T2). `persona` is free text and is deliberately not
 * validated. Each violation emits one `llm-router: ...` warn and "does
 * not take effect" — the config stays usable (spec §4 / AC-4
 * warn-not-crash semantics).
 */
export function validateFallbacksConfig(config: FallbacksConfig, logger: FallbacksConfigLogger): void {
  // The profile layer validates itself (and is the primary surface): ids,
  // fallback modes, rule regular expressions, windows, retry rows.
  validateModels(config, logger)
  const declaredIds = new Set<string>()
  for (const role of config.roles.list) {
    // Client-canonical trim alignment (qc2 S-3): the UI rebuilds ids with
    // `row.id.trim()` (rowsToRoles) and validates the trimmed value, so the
    // host validator must too — a padded id in YAML resolves exactly like
    // the UI's canonical form (format/reserved/duplicate checks + the
    // declared-id set), never as a raw-string mismatch that would produce a
    // duplicate/undeclared warn against a trimmed sibling. Warn messages
    // still name the raw stored id so the user can locate it in the file.
    const id = role.id.trim()
    if (!ROLE_ID_PATTERN.test(id)) {
      logger.warn(`llm-router: invalid role id "${role.id}" — must match /^[a-z0-9-]{1,32}$/`)
    }
    if (id === INHERIT_ROLE_ID) {
      logger.warn(`llm-router: role id "${role.id}" is reserved — "inherit" cannot be declared in roles.list`)
    }
    if (declaredIds.has(id)) {
      logger.warn(`llm-router: duplicate role id "${role.id}" — role ids must be unique`)
    }
    declaredIds.add(id)
    for (const entry of role.chain ?? []) {
      try {
        parseSelector(entry)
      } catch (error) {
        logger.warn(
          `llm-router: ignoring invalid chain entry "${entry}" in role "${role.id}": ${(error as Error).message}`,
        )
      }
    }
    // A declared role with no model config is meaningless: the settings
    // card blocks saving one, and hand-written YAML gets this startup warn
    // (warn-only — never throws; the runtime still falls back to
    // rootChain defensively, plan fallbacks-feedback-round T2).
    if ((role.chain ?? []).length === 0) {
      logger.warn(
        `llm-router: role "${role.id}" has no model config — declare at least one chain entry, or use the built-in "inherit" rule target instead`,
      )
    }
    if (role.fallback !== undefined && role.fallback !== 'inherit-root' && role.fallback !== 'none') {
      logger.warn(
        `llm-router: role "${role.id}" has invalid fallback "${String(role.fallback)}" — expected "inherit-root" or "none"`,
      )
    }
  }
  // Named chains are additive fixed routes. Startup remains warn-only; the
  // gateway applies the same constraints strictly on save.
  if (Array.isArray(config.namedChains)) {
    const namedIds = new Set<string>()
    const namedLabels = new Set<string>()
    for (const [index, item] of config.namedChains.entries()) {
      if (item === null || typeof item !== 'object') {
        logger.warn(`llm-router: namedChains[${index}] is not an object — row ignored`)
        continue
      }
      const id = typeof item.id === 'string' ? item.id.trim() : ''
      const name = typeof item.name === 'string' ? item.name.trim() : ''
      if (!ROLE_ID_PATTERN.test(id) || id === 'auto') {
        logger.warn(`llm-router: invalid named chain id "${String(item.id)}" — use /^[a-z0-9-]{1,32}$/ and reserve "auto"`)
      }
      if (namedIds.has(id)) logger.warn(`llm-router: duplicate named chain id "${id}" — only the first route is usable`)
      namedIds.add(id)
      if (name === '') logger.warn(`llm-router: named chain "${id}" has an empty name — row ignored`)
      const labelKey = name.toLowerCase()
      if (namedLabels.has(labelKey)) logger.warn(`llm-router: duplicate named chain name "${name}" — picker labels should be unique`)
      namedLabels.add(labelKey)
      if (!Array.isArray(item.chain) || item.chain.length === 0) {
        logger.warn(`llm-router: named chain "${id}" has no model config — declare at least one chain entry`)
        continue
      }
      for (const entry of item.chain) {
        if (typeof entry !== 'string') {
          logger.warn(`llm-router: ignoring non-string selector in named chain "${id}"`)
          continue
        }
        try {
          parseSelector(entry)
        } catch (error) {
          logger.warn(`llm-router: ignoring invalid chain entry "${entry}" in named chain "${id}": ${(error as Error).message}`)
        }
      }
    }
  }
  // P6: `rootChain` is the all-day chain — its LAST entry (默认模型) must
  // be exactly one official model (Flash / Pro XOR; leading 默认降级链
  // entries allowed). A non-empty chain whose tail is not official (incl.
  // the retired `deepseek-v4-flash` and the never-served legacy
  // `deepseek-official/deepseek-pro`) earns ONE startup warn. The empty
  // default stays quiet. A config authored through model profiles skips this
  // warn: its all-day chain is COMPILED (a `loop` profile legitimately ends on
  // another profile, not on an official model).
  //
  // This is a DIAGNOSTIC only — `isAllDayActive` (the runtime gate) accepts any
  // chain for a profile-authored config, so the hand-authored layer is checked
  // here on its own terms.
  if (
    config.models.length === 0
    && config.rootChain.length > 0
    && !isAllDayConforming(config.rootChain)
  ) {
    logger.warn(
      'llm-router: rootChain must end with exactly one official model (deepseek-official/deepseek-flash or deepseek-official/deepseek-v4-pro) — the all-day route dead-ends wherever the chain tail points instead of landing on an official fallback',
    )
  }
  for (const entry of config.rootChain) {
    try {
      parseSelector(entry)
    } catch (error) {
      logger.warn(`llm-router: ignoring invalid rootChain entry "${entry}": ${(error as Error).message}`)
    }
  }
  const validTargets = new Set([...declaredIds, INHERIT_ROLE_ID])
  for (const rule of config.roles.rules) {
    // Same canonical trim as the declared side (rowsToRules trims rule
    // roles on the client) — a padded reference resolves against a padded
    // declaration exactly as the UI would.
    if (!validTargets.has(rule.role.trim())) {
      logger.warn(
        `llm-router: rule references undeclared role "${rule.role}" — expected one of roles.list ids or "inherit"`,
      )
    }
  }
  // P4 guards for time-slot rows (warn on load; the gateway rejects on
  // save): at most ONE row per preset id, known preset ids only, and preset
  // rows must not carry their own windows/day masks (windows are code
  // constants). The schema keeps the row shape permissive on purpose —
  // malformed rows must warn here, never fail composition (P6
  // warn-not-crash); the resolver skips them defensively at request time.
  if (Array.isArray(config.timeSlots)) {
    const seenSlotPresets = new Set<string>()
    for (const row of config.timeSlots) {
      if (row.kind !== 'preset') continue
      const preset = row.preset
      if (typeof preset !== 'string' || !Object.hasOwn(PRESETS, preset)) {
        logger.warn(`llm-router: unknown time-slot preset ${JSON.stringify(preset)} — row ignored`)
        continue
      }
      if (seenSlotPresets.has(preset)) {
        logger.warn(`llm-router: duplicate time-slot preset "${preset}" — only the first row takes effect`)
        continue
      }
      seenSlotPresets.add(preset)
      if (row.start !== undefined || row.end !== undefined || (row.days !== undefined && row.days.length > 0)) {
        logger.warn(
          `llm-router: preset "${preset}" carries its own window/day fields — preset windows are fixed code constants; the row is ignored`,
        )
      }
    }
  }
  // Review point 3 (PR #87): with `recovery: 'half-open'` and a cooldown at
  // or above the 1-hour escalation cap, `escalatedCooldownMs` degenerates to
  // `max(ms, min(cap, ms × 2^(n-1)))` = `ms` for every n — escalation is
  // silently inert (every suppression stays flat at cooldownMs). Same class
  // as the other inert-configuration warns: one startup warn, never throws.
  if ((config.recovery ?? 'timer') === 'half-open' && config.cooldownMs >= ESCALATION_CAP_MS) {
    logger.warn(
      `llm-router: recovery "half-open" escalation is inert — cooldownMs (${config.cooldownMs} ms) is at or above the 1-hour escalation cap (${ESCALATION_CAP_MS} ms), so every suppression stays flat at cooldownMs`,
    )
  }
}

/**
 * Detect legacy (two-block-era) leftovers in a config SOURCE — the composed
 * object `source()` returns, or a raw settings document. Recognizes the
 * removed `chains` key, the removed `roles.default` field, the removed
 * role-entity fields `roles.list[].label` / `roles.list[].description`
 * (renamed to `persona`), and `roles.rules[].role` values that reference no
 * declared `roles.list` id and are not the built-in `'inherit'`. Returns
 * descriptive key/role names; the gateway attaches them as `get().legacyKeys`
 * so the client can show a migration banner (spec §9 — the source is read
 * directly because schemastery retains unknown keys, verified plan Task 1
 * Step 1).
 */
export function detectLegacyKeys(source: Record<string, unknown>): string[] {
  const keys: string[] = []
  if (Object.hasOwn(source, 'chains')) keys.push('chains')
  const roles = source.roles
  if (isRecordLike(roles)) {
    if (Object.hasOwn(roles, 'default')) keys.push('roles.default')
    const declared = new Set<string>()
    if (Array.isArray(roles.list)) {
      for (const item of roles.list) {
        if (!isRecordLike(item)) continue
        if (typeof item.id === 'string') declared.add(item.id)
        if (Object.hasOwn(item, 'label')) keys.push('roles.list[].label')
        if (Object.hasOwn(item, 'description')) keys.push('roles.list[].description')
      }
    }
    if (Array.isArray(roles.rules)) {
      for (const rule of roles.rules) {
        if (
          isRecordLike(rule)
          && typeof rule.role === 'string'
          && rule.role !== INHERIT_ROLE_ID
          && !declared.has(rule.role)
        ) {
          keys.push(`roles.rules[].role: ${rule.role}`)
        }
      }
    }
  }
  return keys
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
