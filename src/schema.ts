/**
 * The `fallbacks` settings schema (schemastery), mirroring
 * {@link FallbacksConfig}.
 *
 * Host-only module: `Config` is the schemastery schema the settings section
 * validates/composes against, and `@deepseek-ai/schemastery` is an
 * `@deepseek-ai/*` RUNTIME value import — it must never enter the client
 * bundle, because the web loader module table cannot answer that require
 * (build-time externals drift, 20260815: the client bundle previously
 * externalized `@deepseek-ai/schemastery` and the web settings card failed
 * to load). The client half consumes `FallbacksConfig` and the other
 * config types from `./config.ts` type-only, so the schema stays here, out
 * of the client module graph.
 *
 * Object fields are optional by default in schemastery; `.default()` fills
 * the spec defaults, `.required()` keeps mandatory fields. Unknown keys are
 * RETAINED by the composition (verified plan Task 1 Step 1) — that is what
 * lets `detectLegacyKeys` flag two-block-era leftovers (`chains` /
 * `roles.default`) on the composed object at startup (warn + gateway
 * `legacyKeys`, see `src/index.ts` apply()).
 *
 * Current host contract: the whole schema is marked `volatile` (the host
 * retired `installSection` — the Loader entry Config IS the settings
 * section now, and `SettingsForms.update` only accepts volatile paths, so
 * the marker is what keeps the gateway/card write path legal). One marker
 * on the ROOT object makes every field live-editable and hands `apply` a
 * single identity-stable config reference the Loader commits saves into
 * (no remount per save). The marker rides the generic `.extra()` writer —
 * the exact bytes `.volatile()` writes in newer schemastery — because the
 * dev-time schemastery resolved from the lockfile can predate that sugar;
 * the `Meta` augmentation below declares the field the peer range admits
 * at its upper end.
 *
 * @module dsh-fallback-router/schema
 */

import z from '@deepseek-ai/schemastery'
import type { FallbacksConfig } from './config.ts'

declare module '@deepseek-ai/schemastery' {
  namespace Schemastery {
    interface Meta {
      /** Live-editable marker read by the Loader / `SettingsForms`. */
      volatile?: boolean;
    }
  }
}

const configSchema = z.object({
  // ── the authored model layer (dsh-fallback-router) ───────────────────────────
  // Every row is a MODEL CONFIGURATION: a route, the time windows it is active
  // in, how it falls back (official model / loop over the other rows / none)
  // and which failures it reacts to. `rootChain` / `timeSlots` below are
  // COMPILED from this list at read time (`withCompiledRouter`), never
  // authored, and stay in the schema so a legacy chain config still parses.
  models: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        // 配置类型: `route` serves provider/model, `combo` (自由组合) only
        // relays each 时间区间 to another profile through `use`.
        kind: z.union([z.const('route'), z.const('combo')]).default('route'),
        provider: z.string(),
        model: z.string(),
        windows: z
          .array(
            z.object({
              // A preset window stores no clock fields: `preset` names a
              // frozen window (`liang-peak` …) that is expanded at compile
              // time, so 梁高峰/梁低谷 can be picked exactly like the legacy
              // card did. Empty `preset` = the custom start/end/days below.
              preset: z.string().default(''),
              start: z.string().default(''),
              end: z.string().default(''),
              days: z.array(z.number()).default([]),
              // 使用配置: serve this window with another profile's chain.
              use: z.string().default(''),
            }),
          )
          .default([]),
        fallback: z.union([z.const('official'), z.const('loop'), z.const('none')]).default('official'),
        officialModel: z.string().default('deepseek-official/deepseek-flash'),
        // 追加兜底路由: extra `provider/model` hops between this route and the
        // official tail (the legacy multi-hop named chains).
        extraRoutes: z.array(z.union([
          z.string(),
          z.object({
            route: z.string().default(''),
            reasoningEffort: z.string().default(''),
          }),
        ])).default([]),
        // 在模型选择器里显示: register this profile as a `FallbacksChain/<name>`
        // picker row (replaces the legacy `namedChains` authoring surface).
        expose: z.boolean().default(false),
        // 推理等级: the reasoning effort this route always asks for (`''` = the
        // model's own default). The host rejects an id the model does not list.
        reasoningEffort: z.string().default(''),
        rules: z
          .object({
            codes: z.array(z.string()),
            regex: z.array(z.string()),
            structural: z.boolean(),
            markers: z.array(z.string()),
          })
          .default({ codes: [], regex: [], structural: true, markers: [] }),
      }),
    )
    .default([]),
  // Per-provider retry rows (retry settings live on the provider, exactly like
  // the model layer lives on the model). There is deliberately no shared
  // `retry` object: schemastery materialises an unset `z.object` as `{}`, and
  // that empty row would have to be told apart from "the user configured a
  // default" on every read. Programmatic callers may still pass `retry` (see
  // `retryFor`), it simply is not part of the authored schema.
  providers: z
    .array(
      z.object({
        provider: z.string(),
        enabled: z.boolean(),
        maxRetries: z.number(),
        windowMs: z.number(),
        initialDelayMs: z.number(),
        maxDelayMs: z.number(),
        jitterRatio: z.number(),
      }),
    )
    .default([]),
  // No `enabled` key (plan fallbacks-web-ux-alignment T2): the Plugins-page
  // row toggle is the master switch; the runtime gates read content presence
  // (`isFallbackActive`). A stored `enabled:` line is schema-unknown, so
  // schemastery retains it on the composed object — inert (nothing reads it)
  // and stripped from every gateway snapshot/write (LEGACY_KEYS in
  // `src/gateway.ts`), never re-persisted.
  triggerCodes: z.array(z.string()).default(['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER']),
  rootChain: z.array(z.string()).default([]),
  namedChains: z
    .array(z.object({
      id: z.string(),
      name: z.string(),
      chain: z.array(z.string()),
    }))
    .default([]),
  roles: z
    .object({
      list: z
        .array(
          z.object({
            id: z.string().required(),
            persona: z.string().default(''),
            prompt: z.string(),
            permissions: z.object({
              allow: z.array(z.string()),
              deny: z.array(z.string()),
            }),
            chain: z.array(z.string()),
            fallback: z.union([z.const('inherit-root'), z.const('none')]).default('inherit-root'),
          }),
        )
        .default([]),
      rules: z
        .array(
          z.object({
            // Legacy wire field (PR #62 feedback): accepted so pre-feedback
            // configs parse/save unchanged; ignored at match time — rules
            // are subagent-only.
            origin: z.union([z.const('root'), z.const('subagent')]),
            provider: z.string(),
            model: z.string(),
            role: z.string().required(),
          }),
        )
        .default([]),
    })
    .default({ list: [], rules: [] }),
  cooldownMs: z.number().default(300_000),
  revertPolicy: z.union([z.const('cooldown-expiry'), z.const('never')]).default('cooldown-expiry'),
  maxSwitchesPerStep: z.number().default(8),
  alwaysModeRetryCap: z.number().default(5),
  // 9th field (spec §9.4): union-of-const + default, same shape as
  // `revertPolicy` above — illegal values fail at schema resolve, and the
  // default guarantees every resolved config carries `presets`.
  presets: z.union([z.const('bundled'), z.const('none')]).default('bundled'),
  // 10th field (plan fallbacks-role-automatch Task 1): dispatch-time LLM
  // role auto-match switch, default ON. Boolean with a schema default — the
  // same additive shape as the other optional fields — so `Config({})`
  // carries `roleAutoMatch: true` and every resolved config has a value.
  roleAutoMatch: z.boolean().default(true),
  // 11th/12th fields (plan fallbacks-timeslots Task 1, P5): extra time-slot
  // rows (the all-day chain keeps `rootChain`'s name) and the
  // config-level timezone. The row shape is deliberately PERMISSIVE (plain
  // strings, no const unions) — malformed rows (bad kind/preset/window)
  // must WARN at load and be skipped by the resolver, never fail schema
  // resolve (P6 warn-not-crash); the gateway rejects them on save
  // (Task 3). Absent `days`/`chain` compose to [] — the resolver reads
  // []/absent `days` as "all days" and an empty `chain` as malformed.
  timeSlots: z
    .array(
      z.object({
        kind: z.string(),
        preset: z.string(),
        start: z.string(),
        end: z.string(),
        days: z.array(z.number()),
        chain: z.array(z.string()),
      }),
    )
    .default([]),
  tz: z.string().default('Asia/Shanghai'),
  // 13th field (plan fallbacks-half-open-recovery Task 1): cooldown-expiry
  // recovery mode — `'timer'` restores the preferred candidate on expiry
  // (today's behavior, byte-identical); `'half-open'` leaves the route
  // half-open for one logged probe instead. Union-of-const + default, the
  // same shape as `revertPolicy`/`presets` — illegal values fail at schema
  // resolve, and the default guarantees every resolved config carries
  // `recovery`.
  recovery: z.union([z.const('timer'), z.const('half-open')]).default('timer'),
})
// Root volatile marker (see the module docblock). `extra` CLONES the schema
// and marks the clone — exactly what schemastery's `.volatile()` does
// (`return this.extra('volatile', true)`) — so the marked clone is the export.
export const Config = configSchema.extra('volatile', true) as unknown as z<FallbacksConfig>

