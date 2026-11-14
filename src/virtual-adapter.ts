/**
 * Virtual `FallbacksChain/Auto` LLM adapter (plan fallbacks-virtual-chain
 * Task 1, technical pins P1–P3; PR #62 feedback round): a mount-only
 * catalog row that makes the configured effective chain selectable as the
 * session **primary** in the host model picker, without patching dsh or
 * dsh-TUI (web and TUI share the adapter catalog).
 *
 * Wiring (P2): `installFallbacksAdapter` installs ONE conditional
 * `ctx.inject(['llm'])` child — absent `llm` service (test harness) is a
 * clean no-op, and fiber unload ⇒ the child's disposer unregisters the
 * route. Registration is an idempotent transition-reconcile on COMMITTED
 * config snapshots: register when nothing is configured → something is
 * (`isFallbackActive` — content presence, plan fallbacks-web-ux-alignment
 * T2), unregister on the reverse, driven by the settings `onChange` hook
 * (the returned reconcile thunk, wired by `apply()`) plus child activation.
 * The row is visible whenever something is configured — a non-conforming
 * all-day chain does NOT hide it (PR #62 feedback); conformance still gates
 * a successful delegate (`effectiveHeadOf` below refuses a non-conforming
 * all-day). The registration gate is `isFallbackActive` content presence
 * (`rootChain` / `timeSlots` / declared roles): a slot-row edit that flips
 * that gate (e.g. removing the only slot while `rootChain` and roles are
 * empty) intentionally churns registration — the content-presence contract
 * (plan fallbacks-web-ux-alignment T2), not churn to design away; do NOT
 * re-narrow the condition to ignore `timeSlots`. Conformance-only chain
 * edits still never churn (conformance gates the delegate, not the row).
 *
 * Adapter behavior (P1/P3): `listModels` advertises exactly the one virtual
 * row; `stream()` is a THIN single-hop delegate to the effective chain head
 * through the host LLM runtime — no chain walk, no cooldown/caps/revert
 * bookkeeping, no state writes (a failure inside the delegate surfaces at
 * `agent/request-error`, where the existing engine walks from there).
 * `resolveModel` proxies the current effective head's metadata when
 * resolvable (modalities/context-window/reasoning follow the head) with a
 * permissive default otherwise — never throws. `providerRetryPolicy` and
 * `imageRequestPricing` mirror the same head for the host-captured retry
 * policy and the token meter — also never throwing.
 *
 * @module dsh-llm-router/virtual-adapter
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  LlmAdapter,
  LlmError,
  type GenerateOptions,
  type LlmImageRequestPricing,
  type LlmModelInfo,
  type LlmResolvedModelInfo,
  type LlmRuntime,
  type ResolvedRetryPolicy,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  isFallbackActive,
  namedFallbackChain,
  namedFallbackProvider,
  namedFallbackId,
  NAMED_FALLBACK_MODEL,
  type FallbacksConfig,
} from './config.ts'
import { parseSelector, type Selector } from './selectors.ts'
import { pinnedEffort, profileChainAt } from './models.ts'
import { isAllDayActive, resolveEffectiveChain, resolveSlotState } from './time-slots.ts'

/** Provider route of the virtual adapter (exact string, spec lock). */
export const FALLBACKS_PROVIDER = 'FallbacksChain'
/**
 * Provider label the model picker renders (the route id above stays
 * `FallbacksChain` — sessions already pinned to it must keep resolving).
 */
export const FALLBACKS_PROVIDER_DISPLAY = '模型路由'
/**
 * Model id of the virtual catalog row (exact string, spec lock). "Auto" is
 * the hardcoded picker id (not i18n — user decision 2026-08-18). The
 * catalog `name` the host picker renders is dynamic — see
 * {@link pickerDisplayName} (`Auto: <model>[<slot>]`).
 */
export const FALLBACKS_CHAIN_MODEL = 'Auto'

/**
 * `LlmError` code: the effective chain is empty — the virtual route has no
 * head to delegate to (P1 guard).
 */
export const EMPTY_EFFECTIVE_CHAIN_CODE = 'EMPTY_EFFECTIVE_CHAIN'
/**
 * `LlmError` code: the effective chain head is not a dispatchable real pair
 * (non-conforming all-day, wildcard selector, malformed selector, or a
 * self-route back to `FallbacksChain/*` — the P1 recursion guard).
 */
export const UNDISPATCHABLE_HEAD_CODE = 'UNDISPATCHABLE_EFFECTIVE_HEAD'
/** `LlmError` code (defensive): the `llm` runtime disappeared mid-flight. */
export const LLM_UNAVAILABLE_CODE = 'LLM_UNAVAILABLE'

/** One dispatchable exact head: `provider/model`. Wildcards are never seeds (P3). */
export interface EffectiveHead {
  provider: string
  model: string
}

/**
 * The FIRST DISPATCHABLE exact head of a chain — the single definition of
 * "effective head" (F-001) shared by the virtual adapter's delegate paths and
 * the routing engine's served-route anchor (`anchorServedRoute` in
 * `src/index.ts`). Walks the SAME chain `resolveEffectiveChain` produces,
 * skipping entries that can never
 * be dispatched: malformed selectors (config-warning path), `provider/*`
 * `provider/*` wildcards (no real pair), and self-routes back to
 * `FallbacksChain/*` (the P1 recursion guard). `undefined` when the chain
 * is empty or no entry is dispatchable.
 */
export function firstDispatchableExactHead(chain: readonly string[]): EffectiveHead | undefined {
  for (const entry of chain) {
    let selector: Selector
    try {
      selector = parseSelector(entry)
    } catch {
      continue // malformed chain entries (hand-written YAML) are never dispatch targets
    }
    if (selector.model === undefined) continue // wildcard: no real pair to delegate
    if (selector.provider === FALLBACKS_PROVIDER || namedFallbackId(selector.provider) !== undefined) continue // virtual-route recursion guard
    return { provider: selector.provider, model: selector.model }
  }
  return undefined
}

/**
 * The effective chain head at `now` (P1): the first DISPATCHABLE exact head
 * of the SAME `resolveEffectiveChain` the routing engine uses — thin
 * config+clock entry into the shared {@link firstDispatchableExactHead} (no
 * divergent skip/walk rules). `undefined` when the chain is empty or no
 * entry is dispatchable (wildcard, self-route to `FallbacksChain/*`,
 * malformed selector).
 *
 * Conformance gate (PR #62 feedback): the all-day `rootChain` must be
 * conforming (exactly one official model — Flash or Pro)
 * for a successful delegate —
 * a legacy multi-model (or empty) all-day chain earns no primary
 * semantics even though the picker row is visible. `resolveModel` then
 * falls back to the permissive default and `stream()` throws
 * {@link UNDISPATCHABLE_HEAD_CODE}.
 */
export function effectiveHeadOf(config: FallbacksConfig, now: Date): EffectiveHead | undefined {
  if (!isAllDayActive(config)) return undefined
  const chain = resolveEffectiveChain(config, now, config.tz ?? 'Asia/Shanghai')
  return firstDispatchableExactHead(chain)
}

/**
 * One concrete route the virtual delegate must dispatch to, pinned to the
 * session it was decided for.
 *
 * The host freezes a step's model selection BEFORE `agent/request` runs and
 * rejects any waterfall answer that changes `provider`/`model`
 * (`agent/request proposed "X" after step preparation fixed "Y"; use
 * agent.model.select() before step preparation`). A failure switch must
 * therefore happen INSIDE the delegate — the request keeps naming
 * `FallbacksChain-*`, the adapter dispatches to the pinned head — instead of
 * rewriting the request config.
 */
export interface ForcedRoute {
  provider: string
  model: string
  /** 推理等级 pinned for this exact hop (`''` = follow the model default). */
  effort: string
  /**
   * `true` = the pin covers exactly one request (role injection: the head seeds
   * the session's first call, later calls go back to the chain). Absent = the
   * pin holds until it is replaced or cleared (failure switches).
   */
  once?: boolean
}

const FORCED_ROUTES = new Map<string, ForcedRoute>()

/** Per-session count of `agent/request` dispatches (one-shot pin bookkeeping). */
const REQUEST_SEQ = new Map<string, number>()

/** Pin which concrete route a session's virtual delegate dispatches to. */
export function pinForcedRoute(sessionId: string, route: ForcedRoute): void {
  FORCED_ROUTES.set(sessionId, route)
}

/**
 * Pin a route for the NEXT request only (role injection). Expired by
 * {@link beginRequest} once a later request starts.
 */
export function pinOnceForcedRoute(sessionId: string, route: ForcedRoute): void {
  FORCED_ROUTES.set(sessionId, { ...route, once: true })
}

/**
 * Start one `agent/request` for a session: drops a one-shot pin left by an
 * earlier request, then advances the request counter. Returns the pinned route
 * that this request will be served by.
 */
export function beginRequest(sessionId: string | undefined): ForcedRoute | undefined {
  if (sessionId === undefined) return undefined
  const seq = (REQUEST_SEQ.get(sessionId) ?? 0) + 1
  REQUEST_SEQ.set(sessionId, seq)
  const pinned = FORCED_ROUTES.get(sessionId)
  if (pinned !== undefined && pinned.once === true && seq > 1) {
    FORCED_ROUTES.delete(sessionId)
    return undefined
  }
  return pinned
}

/** Read the pinned route of one session (`undefined` = serve the chain head). */
export function forcedRouteOf(sessionId: string | undefined): ForcedRoute | undefined {
  return sessionId === undefined ? undefined : FORCED_ROUTES.get(sessionId)
}

/** Drop one session's pinned route (revert / disposal). */
export function clearForcedRoute(sessionId: string): void {
  FORCED_ROUTES.delete(sessionId)
  REQUEST_SEQ.delete(sessionId)
}

/** Drop every pinned route (plugin dispose — no residual state). */
export function clearAllForcedRoutes(): void {
  FORCED_ROUTES.clear()
  REQUEST_SEQ.clear()
}

/**
 * Turn a pinned route into a dispatchable {@link EffectiveHead}: only the
 * exact form `provider/model` with a real provider qualifies, and a virtual
 * provider is refused ({@link firstDispatchableExactHead}'s recursion guard).
 */
export function forcedHeadOf(route: ForcedRoute | undefined): EffectiveHead | undefined {
  if (route === undefined) return undefined
  return firstDispatchableExactHead([`${route.provider}/${route.model}`])
}

/**
 * The concrete head the delegate dispatches for `provider` right now, ignoring
 * any session pin — i.e. what a virtual-route request really hits. Shared with
 * the test harness so specs can observe the served route the way the adapter
 * would compute it.
 * @param config - live router config.
 * @param provider - the request's provider (virtual `FallbacksChain` or a named route).
 * @param now - clock sample for time-slot resolution.
 */
export function servedHeadFor(
  config: FallbacksConfig,
  provider: string,
  now: Date = new Date(),
): EffectiveHead | undefined {
  const named = namedFallbackChain(config, provider)
  if (named === undefined) return effectiveHeadOf(config, now)
  const id = namedFallbackId(provider)
  const at = id === undefined ? [] : profileChainAt(config, id, now, config.tz ?? 'Asia/Shanghai')
  return firstDispatchableExactHead(at.length > 0 ? at : named.chain)
}

/**
 * Host picker label: `自动：<displayName>［<slot>］`.
 * Display name first so the trigger stays readable and platforms stay
 * distinguishable (catalog `name`, not the model id). Bare `Auto` when
 * there is no dispatchable head. Slot label from {@link resolveSlotState},
 * with the all-day winner spelled out instead of its sentinel id.
 * @param modelDisplayName - catalog/resolved name; falls back to the id.
 */
export function pickerDisplayName(
  config: FallbacksConfig,
  now: Date = new Date(),
  modelDisplayName?: string,
): string {
  const head = effectiveHeadOf(config, now)
  if (head === undefined) return FALLBACKS_CHAIN_MODEL
  const slot = resolveSlotState(config, now, config.tz ?? 'Asia/Shanghai')
  const model = modelDisplayName !== undefined && modelDisplayName !== '' ? modelDisplayName : head.model
  const slotLabel = slot.winner === 'all-day' ? '全天' : slot.label
  return `自动：${model}［${slotLabel}］`
}

/** Catalog `name` for a head pair; id if the provider is not listed. */
async function resolveHeadDisplayName(llm: LlmRuntime | undefined, head: EffectiveHead): Promise<string> {
  if (llm === undefined) return head.model
  try {
    const listed = await llm.listModels(head.provider)
    const row = listed.find(model => model.id === head.model)
    if (row !== undefined && row.name !== '') return row.name
  } catch {
    // Provider not registered or list failed — try resolveModelInfo.
  }
  try {
    const info = await llm.resolveModelInfo(head.provider, head.model)
    if (info.name !== '') return info.name
  } catch {
    // Unresolvable — caller keeps the id.
  }
  return head.model
}

/** One history message of a delegated request. */
type DelegatedMessage = GenerateOptions['messages'][number]

/**
 * The `provider/model` an adapter-private replay envelope names for itself, when
 * it names them in a readable shape.
 *
 * `ReplayEnvelope.response` is an untyped, adapter-private payload
 * (`@deepseek-ai/dsh-llm` `types.d.ts`), so this probe is deliberately
 * structural and total: anything it cannot read yields `undefined` and the
 * caller leaves the message untouched — never guessed, never thrown. A pair
 * naming the virtual route itself is refused, because re-stamping onto
 * `FallbacksChain` would be a self-route.
 */
function envelopeProvenance(replayState: unknown): EffectiveHead | undefined {
  if (typeof replayState !== 'object' || replayState === null) return undefined
  const response: unknown = (replayState as { response?: unknown }).response
  if (typeof response !== 'object' || response === null) return undefined
  const { provider, model } = response as { provider?: unknown; model?: unknown }
  if (typeof provider !== 'string' || provider === '' || provider === FALLBACKS_PROVIDER || namedFallbackId(provider) !== undefined) return undefined
  if (typeof model !== 'string' || model === '') return undefined
  return { provider, model }
}

/**
 * Restore the provenance of history messages the durable record attributes to
 * the virtual route (R-004).
 *
 * The loop stamps every durable assistant message with the route of the REQUEST
 * that produced it — `FallbacksChain/Auto` here — while the replay envelope
 * inside it was produced by the head adapter that actually answered
 * (`@deepseek-ai/dsh-agent-loop` builds the durable source from
 * `request.provider`). The runtime's ownership gate exposes an envelope to a
 * target adapter only while that adapter instance owns the message's recorded
 * provider (`LlmRuntime.forAdapter`), so the delegate's second pass —
 * `llm.stream({ … provider: head })` — hands the head a message whose envelope
 * has been dropped, and pi-ai-backed thinking signatures silently degrade on the
 * root virtual route.
 *
 * Re-stamping the pair the envelope itself names puts the message back under the
 * adapter that produced it, so the gate keeps it. Reading the pair from the
 * envelope — never from the effective head — also keeps a rotation faithful: an
 * envelope produced by a previous head is not handed to another provider's
 * adapter. Only `source` changes; the durable record the loop writes is
 * untouched. Two readers see the delegated `source`: the runtime's ownership gate
 * (`forAdapter`), and — for a pi-ai-backed head — that adapter's own replay
 * validator, which throws `INVALID_REPLAY_STATE` unless
 * `response.provider`/`response.model` equal the message source. Re-stamping to
 * the pair the envelope names is therefore what makes the envelope *acceptable*,
 * not merely retained; re-stamping to the effective head instead would feed the
 * validator a mismatched pair on any rotation.
 *
 * @param messages - the delegated request's history, exactly as received.
 * @returns `messages` itself when nothing qualifies, so the untouched path
 *   allocates nothing and behaves precisely as before.
 */
function restoreEnvelopeProvenance(messages: DelegatedMessage[]): DelegatedMessage[] {
  let changed = false
  const restored = messages.map((message): DelegatedMessage => {
    const source = message.source
    // `source` is optional on the request-message union (an identity-free
    // one-shot user input carries `source?: never`), and only an assistant
    // message's `model` source names a provider/model pair to re-stamp.
    if (message.role !== 'assistant' || source?.kind !== 'model') return message
    if (!((source.provider === FALLBACKS_PROVIDER && source.model === FALLBACKS_CHAIN_MODEL)
      || (namedFallbackId(source.provider) !== undefined && source.model === NAMED_FALLBACK_MODEL))) return message
    const provenance = envelopeProvenance(source.replayState)
    if (provenance === undefined) return message
    changed = true
    return { ...message, source: { ...source, ...provenance } }
  })
  return changed ? restored : messages
}

/**
 * The virtual adapter (P1/P3). `stream()` is a thin head-delegate, never a
 * second routing engine: no chain walk, cooldown, caps, revert bookkeeping,
 * or state writes live here — those stay in the `agent/request` /
 * `agent/request-error` listeners. Exported so the defensive guard paths
 * the registration lifecycle cannot reach (a registered route whose `llm`
 * vanished mid-teardown) stay unit-testable by direct construction.
 */
export class FallbacksChainAdapter extends LlmAdapter {
  constructor(
    private readonly readConfig: () => FallbacksConfig,
    private readonly getLlm: () => LlmRuntime | undefined,
  ) {
    super()
  }

  /** Minimal honest descriptor — each virtual provider route keeps its id. */
  override providerInfo(provider: string) {
    return { id: provider, name: FALLBACKS_PROVIDER_DISPLAY }
  }

  /**
   * The chain a named virtual provider serves RIGHT NOW.
   *
   * A picker entry marked 选择器可见 is one authored profile, and a profile
   * keeps its own time windows — selecting it must not freeze the route it
   * happened to have when the row was compiled. `profileChainAt` resolves the
   * profile's windows through the same slot machinery the root route uses and
   * falls back to the profile's all-day chain; `named.chain` is only the last
   * resort for a named chain that is not backed by a profile (a hand-authored
   * legacy `namedChains` row).
   */
  private namedChainAt(config: FallbacksConfig, provider: string, now: Date): string[] | undefined {
    const named = namedFallbackChain(config, provider)
    if (named === undefined) return undefined
    const id = namedFallbackId(provider)
    const at = id === undefined ? [] : profileChainAt(config, id, now, config.tz ?? 'Asia/Shanghai')
    return at.length > 0 ? at : named.chain
  }

  /** Resolve the fixed chain head addressed by a named virtual provider. */
  private headForProvider(provider: string, config: FallbacksConfig, now: Date): EffectiveHead | undefined {
    return servedHeadFor(config, provider, now)
  }

  /** Advisory catalog: Auto plus one fixed row per named route. */
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const config = this.readConfig()
    const now = new Date()
    const named = namedFallbackChain(config, provider)
    if (provider !== FALLBACKS_PROVIDER) {
      if (named === undefined) return []
      const head = firstDispatchableExactHead(this.namedChainAt(config, provider, now) ?? [])
      const display = head === undefined ? undefined : await resolveHeadDisplayName(this.getLlm(), head)
      return [{ provider, id: NAMED_FALLBACK_MODEL, name: named.name || named.id, ...(display === undefined ? {} : { description: display }) }]
    }
    // Once the user has marked at least one 模型配置 选择器可见, that row IS the
    // entry they expect to see: keeping the built-in `Auto` row next to it reads
    // as the same configuration listed twice (both render under the same
    // provider display name). The provider stays registered — sessions already
    // pinned to `FallbacksChain/Auto` keep resolving — it is only hidden from
    // the picker catalog.
    if ((config.models ?? []).some((profile) => profile.expose)) return []
    const head = effectiveHeadOf(config, now)
    const display = head === undefined ? undefined : await resolveHeadDisplayName(this.getLlm(), head)
    return [{
      provider,
      id: FALLBACKS_CHAIN_MODEL,
      name: pickerDisplayName(config, now, display),
    }]
  }

  /**
   * Proxy the current effective head's model metadata when resolvable (P3):
   * modalities/context-window/reasoning follow the head — the truthful
   * answer for the CURRENT head. Permissive default otherwise; never throws.
   */
  override async resolveModel(
    provider: string,
    model: string,
    signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    if (provider !== FALLBACKS_PROVIDER && (model !== NAMED_FALLBACK_MODEL || namedFallbackChain(this.readConfig(), provider) === undefined)) {
      return { provider, id: model, name: model }
    }
    const config = this.readConfig()
    const head = this.headForProvider(provider, config, new Date())
    const llm = this.getLlm()
    if (head !== undefined && llm !== undefined) {
      try {
        const info = await llm.resolveModelInfo(head.provider, head.model, signal)
        return {
          provider,
          id: model,
          name: info.name,
          ...(info.description === undefined ? {} : { description: info.description }),
          ...(info.inputModalities === undefined ? {} : { inputModalities: info.inputModalities }),
          ...(info.context === undefined ? {} : { context: info.context }),
          ...(info.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: info.defaultMaxTokens }),
          ...(info.reasoning === undefined ? {} : { reasoning: info.reasoning }),
        }
      } catch {
        // Head metadata unresolvable (e.g. the head's provider is not
        // registered) — fall through to the permissive default (P3).
      }
    }
    return { provider, id: model, name: model }
  }

  /**
   * Route-accurate retry attribution: the virtual row declares no policy of
   * its own — the virtual `provider` argument is intentionally ignored. The
   * host captures `adapter.providerRetryPolicy(provider) ??
   * resolveRetryPolicy(void 0, …)` ONCE, when a route is registered, so
   * answering here with the SAME policy the concrete head route declared
   * (e.g. a user's `llm-deepseek.retryPolicy`, including `mode: 'always'`)
   * keeps retries behaving exactly as they do on the head `stream()`
   * dispatches. Never throws: an unresolvable head, a vanished `llm`, or an
   * unregistered head provider degrades to `undefined` — the host's own
   * default. That last arm matters: the runtime's lookup THROWS `NO_ADAPTER`
   * for an unknown provider, and this call happens inside the plugin's
   * `registerAdapter`, so an escaping throw would take the whole virtual
   * route down instead of just degrading its policy.
   */
  override providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined {
    try {
      const config = this.readConfig()
      if (provider !== FALLBACKS_PROVIDER && namedFallbackChain(config, provider) === undefined) return undefined
      const head = this.headForProvider(provider, config, new Date())
      // Defensive recursion guard (mirroring imageRequestPricing):
      // `effectiveHeadOf` already refuses self-routes, so a
      // `FallbacksChain/*` head is impossible — assert it anyway so a future
      // resolution change can never re-enter the virtual adapter's own
      // registration.
      if (head === undefined || head.provider === FALLBACKS_PROVIDER) return undefined
      return this.getLlm()?.providerRetryPolicy(head.provider)
    } catch {
      return undefined // unknown provider route → the host's own default
    }
  }

  /**
   * Route-accurate image pricing: the virtual row has no
   * pricing of its own — the virtual `provider`/`model` arguments are
   * intentionally ignored. Resolves the SAME effective head `stream()`
   * dispatches and delegates through the runtime lookup, so the token
   * meter gets exactly the answer the concrete route's adapter would give
   * (including `undefined`). Never throws: an unresolvable head, a
   * vanished `llm`, or a throwing delegate degrades to `undefined` — the
   * token meter's neutral estimate.
   */
  override imageRequestPricing(provider: string, model: string): LlmImageRequestPricing | undefined {
    try {
      const config = this.readConfig()
      if (provider !== FALLBACKS_PROVIDER && (model !== NAMED_FALLBACK_MODEL || namedFallbackChain(config, provider) === undefined)) return undefined
      const head = this.headForProvider(provider, config, new Date())
      // Defensive recursion guard: `effectiveHeadOf` already refuses
      // self-routes, so a `FallbacksChain/*` head is impossible — assert
      // it anyway so a future resolution change can never recurse image
      // pricing into the virtual adapter itself.
      if (head === undefined || head.provider === FALLBACKS_PROVIDER) return undefined
      return this.getLlm()?.imageRequestPricing(head.provider, head.model)
    } catch {
      return undefined // thrown delegate → the meter's neutral estimate
    }
  }

  /**
   * Thin head-delegate (P1): resolve the effective chain head and dispatch
   * that REAL pair through the host LLM runtime. Throws an explicit
   * `LlmError` only when there is no real pair to delegate to: an empty
   * effective chain, an undispatchable head (wildcard / malformed /
   * self-route — the recursion guard), or a vanished `llm` runtime. The
   * runtime normalizes the throw into a terminal error finish chunk, so the
   * documented listener-order degradation stays graceful instead of a hard
   * outage.
   */
  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const config = this.readConfig()
    const now = new Date()
    const named = namedFallbackChain(config, options.provider)
    if (options.provider !== FALLBACKS_PROVIDER && (options.model !== NAMED_FALLBACK_MODEL || named === undefined)) {
      throw new LlmError('llm-router: unknown named fallback route', UNDISPATCHABLE_HEAD_CODE)
    }
    // A failure switch decided in `agent/request-error` pins the hop for THIS
    // session: the host already froze the step's selection (and rejects any
    // request-config rewrite), so the switch is honoured here, at dispatch.
    // A session-pinned route serves its first retry even when the chain
    // itself is momentarily undispatchable (e.g. every sibling cooled).
    const pinnedRoute = forcedRouteOf((options as { sessionId?: string }).sessionId)
    const pinnedHead = forcedHeadOf(pinnedRoute)
    const chain = named === undefined
      ? resolveEffectiveChain(config, now, config.tz ?? 'Asia/Shanghai')
      : (this.namedChainAt(config, options.provider, now) ?? [])
    if (chain.length === 0 && pinnedHead === undefined) {
      throw new LlmError(
        'llm-router: the effective chain is empty — the virtual FallbacksChain route has no head to delegate to',
        EMPTY_EFFECTIVE_CHAIN_CODE,
      )
    }
    const head = pinnedHead ?? this.headForProvider(options.provider, config, now)
    if (head === undefined) {
      throw new LlmError(
        'llm-router: the effective chain head cannot be dispatched (non-conforming all-day, wildcard, malformed, or self-route) — refusing to delegate',
        UNDISPATCHABLE_HEAD_CODE,
      )
    }
    const llm = this.getLlm()
    if (llm === undefined) {
      // The route is registered on a live `llm` service; absence means the
      // fiber is tearing down. Defensive — never silently drop the call.
      throw new LlmError(
        'llm-router: the llm runtime is unavailable — cannot delegate the FallbacksChain call',
        LLM_UNAVAILABLE_CODE,
      )
    }
    // 推理等级: a profile that pins an effort for this exact head route wins
    // over the head's own default; an unpinned route keeps whatever the caller
    // asked for (`prepareCall` already filled in the model default). A pinned
    // hop carries its own truthful level — the caller's effort was chosen for
    // the route that just failed, not for this one.
    const pinned = pinnedRoute !== undefined && pinnedHead !== undefined
      ? pinnedRoute.effort
      : pinnedEffort(config, head.provider, head.model)
    return llm.stream({
      ...options,
      provider: head.provider,
      model: head.model,
      ...(pinned === '' ? {} : { reasoningEffort: pinned as GenerateOptions['reasoningEffort'] }),
      // R-004: the head must still receive its own replay envelope.
      messages: restoreEnvelopeProvenance(options.messages),
    })
  }
}

/**
 * Install the virtual adapter registration lifecycle (P2).
 *
 * @param ctx - the plugin context.
 * @param readConfig - live config reader (the same `source()` the runtime
 *   reads, so reconcile always sees COMMITTED composed snapshots).
 * @returns the reconcile thunk — call it from the settings `onChange` hook
 *   (child activation runs one reconcile on its own).
 */
export function installFallbacksAdapter(ctx: Context, readConfig: () => FallbacksConfig): () => void {
  let llm: LlmRuntime | undefined
  type Registration = ReturnType<LlmRuntime['registerAdapter']>
  let disposeAdapter: Registration | undefined
  let registered = false
  let namedRoutesFingerprint = ''
  const logger = ctx.logger('llm-router')
  // The adapter reads the `llm` binding at CALL time (the inject child swaps
  // it as the service appears/disappears) and the config at call time.
  const adapter = new FallbacksChainAdapter(readConfig, () => llm)

  const reconcile = () => {
    const config = readConfig()
    // PR #62 feedback: the row is visible whenever something is configured
    // (`isFallbackActive` — content presence; the removed `enabled` switch is
    // re-keyed to it) — conformance of the all-day chain is NOT part of
    // registration (a legacy/empty chain still earns the row as long as
    // something is configured; the delegate refuses it via
    // `effectiveHeadOf`).
    const shouldRegister = isFallbackActive(config)
    const fingerprint = JSON.stringify(config.namedChains ?? [])
    const providerIds = [...new Set([
      FALLBACKS_PROVIDER,
      ...(config.namedChains ?? []).flatMap(chain => {
        const provider = namedFallbackProvider(chain.id)
        return provider === undefined ? [] : [provider]
      }),
    ])]
    if (shouldRegister && !registered) {
      if (llm === undefined) return
      try {
        disposeAdapter = llm.registerAdapter(providerIds, adapter)
        registered = true
        namedRoutesFingerprint = fingerprint
        logger.info('llm-router: virtual adapter routes registered — Auto and configured named chains are selectable in the model picker')
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'DUPLICATE_ADAPTER') throw error
        logger.debug('llm-router: virtual adapter route already registered — no routes on this fiber (multi-fiber dedupe)')
      }
    } else if (shouldRegister && registered && fingerprint !== namedRoutesFingerprint) {
      try {
        disposeAdapter?.replace(providerIds)
        namedRoutesFingerprint = fingerprint
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'DUPLICATE_ADAPTER') throw error
        logger.warn('llm-router: could not atomically update virtual routes because a provider id is already owned')
      }
    } else if (!shouldRegister && registered) {
      disposeAdapter?.()
      disposeAdapter = undefined
      registered = false
      logger.info('llm-router: virtual adapter unregistered — FallbacksChain/Auto hidden from the model picker')
    }
  }

  ctx.inject(['llm'], (llmCtx) => {
    llm = llmCtx.llm
    reconcile()
    return () => {
      // Fiber unload / `llm` service removal: withdraw the route.
      disposeAdapter?.()
      disposeAdapter = undefined
      registered = false
      llm = undefined
    }
  })

  return reconcile
}
