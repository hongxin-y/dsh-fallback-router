/**
 * Shared integration-test harness (plan Task 4). The drivers here are
 * extracted from Task 3's `tests/runtime.spec.ts` (real cordis waterfall
 * dispatch + fake agent/session) and extended with a mini agent-loop driver
 * that replays the loop's `buildRequest 閳?stream 閳?request-error 閳?retry?`
 * semantics (mirrored from `packages/core/agent-loop/src/agent.ts`: build the
 * request through the `agent/request` waterfall, report the failure through
 * `agent/request-error` with the serving provider, re-enter `buildRequest` on
 * `{ kind: 'retry' }`, otherwise throw `new LlmError(failure.message,
 * failure.code, failure)` 閳?spec 鎼?).
 *
 * The Task 4 spec files (`tests/plugin.spec.ts`, `tests/coexist-llm-retry
 * .spec.ts`, `tests/always-mode.spec.ts`) drive the real plugin `apply()`
 * against this harness.
 *
 * @module tests/support/harness
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import { ProviderRequestId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { RetryId } from '@deepseek-ai/dsh-llm-retry'
import type {
  LlmCallConfig, LlmFailure, ReasoningEffortId, ResolvedNormalRetryPolicy, ResolvedRetryPolicy,
} from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { defaultFallbacksConfig, type FallbacksConfig } from '../../src/config.ts'
import { FALLBACKS_CHAIN_MODEL, FALLBACKS_PROVIDER, clearForcedRoute, forcedRouteOf, pinForcedRoute } from '../../src/virtual-adapter.ts'
import { namedFallbackId } from '../../src/config.ts'

/** A pair served through the router delegate (concrete selection, virtual route). */
function isVirtualRoute(provider: string, model: string): boolean {
  return provider === FALLBACKS_PROVIDER
    || model === FALLBACKS_CHAIN_MODEL
    || namedFallbackId(provider) !== undefined
}

/**
 * Config helper: spec defaults + overrides (the plugin re-resolves through
 * the schema). There is NO `enabled` baseline any more (plan
 * fallbacks-web-ux-alignment T2 閳?the config-level switch is removed; the
 * runtime gates read content presence via `isFallbackActive`), so every
 * cfg() call is active exactly when its overrides configure content.
 */
export function cfg(overrides: Partial<FallbacksConfig> = {}): FallbacksConfig {
  // Default to `presets: 'none'` (fallbacks-preset-roles QC fix wave, qc1
  // S-2): the bundled preset self-declaration would otherwise materialize 7
  // preset rows on every legacy apply() that uses cfg(), isolating those
  // suites from preset behavior they do not test. Tests that need the
  // bundled behavior expand the default config explicitly
  // (`{ ...defaultFallbacksConfig, presets: 'bundled' }`).
  return { ...defaultFallbacksConfig, presets: 'none', ...overrides }
}

/** Fake agent + session; `setRoute` simulates the loop logging a new request header after a switch. */
export interface AgentHarness {
  agent: Agent
  setRoute(provider: string, model: string): void
}

/**
 * Make a fake agent. `header` mirrors the native `SessionHeader` fields the
 * dispatch-time runtime reads (plan fallbacks-role-automatch Task 4):
 * `session.header.origin` (the origin gate 閳?`'subagent'` only) and
 * `session.header.agentPreset` (the explicit-role carrier). Additive 閳?the
 * default `{}` behaves exactly like the previous `undefined` header for every
 * existing reader (`?.header?.origin ?? 'root'` 閳?`'root'`).
 */
export function makeAgent(
  id: string,
  options: {
    provider?: string
    model?: string
    /**
     * The session's SERVED route reported through `requestHeader().config`
     * (the real host folds the served pair into the header after every
     * request). Pass a virtual pair (`FallbacksChain-model-1/Chain`) to model
     * a session whose dispatch goes through the delegate 閳?the only kind a
     * failure switch can redirect.
     */
    served?: { provider: string; model: string }
    /**
     * The concrete route the router is CURRENTLY serving this session, modelled
     * as a sticky pin (what a previous failure switch leaves behind).
     *
     * A fresh router-served session has no pin, so the plugin reads its current
     * route as the effective chain head. Tests that need "the chain head already
     * failed and this is where we are now" pass this instead of relying on the
     * head.
     */
    serving?: { provider: string; model: string }
  } = {},
  header: { origin?: 'root' | 'subagent'; agentPreset?: string } = {},
): AgentHarness {
  // Default: a session whose dispatch goes through the virtual delegate. That
  // is the only kind the host lets a failure switch redirect (`prepareRequest`
  // freezes the step selection), so a test that names a concrete route is
  // modelled as "picked model, served through the router" unless it passes an
  // explicit `served` pair.
  const defaultServed = options.provider === undefined
    ? {}
    : { provider: FALLBACKS_PROVIDER, model: FALLBACKS_CHAIN_MODEL }
  const route: { provider?: string; model?: string } = { ...(options.served ?? defaultServed) }
  if (options.serving !== undefined) {
    pinForcedRoute(id, {
      provider: options.serving.provider,
      model: options.serving.model,
      effort: '',
    })
  }
  const events: Array<{ type: string; data: Record<string, unknown> }> = []
  const agent = {
    id,
    options,
    status: 'idle' as const,
    session: {
      id,
      snapshotEvents: () => events,
      header,
      // Mirrors the real `Session.seq` (the next event's sequence number 閳?
      // always the log length): the P5 `session/event` driver stamps emitted
      // events with it.
      get seq() {
        return events.length
      },
      append(type: string, data: Record<string, unknown>) {
        events.push({ type, data })
        return { seq: events.length, type, data }
      },
      requestHeader: () => (route.provider === undefined ? undefined : { config: route }),
    },
  }
  return {
    agent: agent as unknown as Agent,
    /**
     * Model the loop recording the route an agent now runs on.
     *
     * A router-served session keeps its header on the virtual pair: the host
     * freezes the step selection and logs THAT, never the concrete head the
     * delegate dispatched to (`servedRouteOf` reads the pin instead). A
     * concrete session follows the recorded pair.
     */
    setRoute(provider: string, model: string): void {
      const header = agent.session.requestHeader()
      if (header === undefined || header.config.provider !== FALLBACKS_PROVIDER) {
        route.provider = provider
        route.model = model
      } else if (provider !== FALLBACKS_PROVIDER && model !== FALLBACKS_CHAIN_MODEL) {
        // A router-served session never logs the concrete hop: the switch rides
        // the forced dispatch route (`agent/request` applies the pending switch
        // 閳?`forceRoute`). Recording a CONCRETE pair as the pin is what makes
        // "this session now runs on X" observable to the next decision. A
        // virtual pair means the delegate still owns the hop, so the existing
        // pin (or the chain head when there is none) stays in charge.
        pinForcedRoute(id, { provider, model, effort: '' })
      }
      options.provider = provider
      options.model = model
    },
  }
}

/** Ordered `fallbacks/switch` events on an agent's session. */
export function switchEvents(agent: Agent): SessionEvent<'fallbacks/switch'>[] {
  return agent.session.snapshotEvents().filter((event) => event.type === 'fallbacks/switch') as SessionEvent<'fallbacks/switch'>[]
}

/** Ordered `llm/retry` events on an agent's session (the llm-retry stub's durable records). */
export function llmRetryEvents(agent: Agent): SessionEvent<'llm/retry'>[] {
  return agent.session.snapshotEvents().filter((event) => event.type === 'llm/retry') as SessionEvent<'llm/retry'>[]
}

/**
 * Append one durable `llm/retry` event in the **real** llm-retry event shape
 * (llm-retry `src/types.ts`: `retryId` / `turn` / `step` / `provider` /
 * `mode` / `policyKey` / `retry` / [`maxRetries` for normal] / `delayMs` /
 * `failure`). Task 4 uses the full shape so the always-cap counting is
 * exercised against the real bundle's event shape (T3 fix review 閳跨媴绗? 閳?the
 * `mode` discriminator must survive the real payload).
 */
export function appendLlmRetry(
  agent: Agent,
  data: {
    turn: number
    step: number
    provider: string
    mode: 'normal' | 'always'
    retry?: number
    policyKey?: string
    maxRetries?: number
    delayMs?: number
    failure?: LlmFailure
  },
): void {
  const { turn, step, provider, mode } = data
  const retry = data.retry ?? 1
  const policyKey = data.policyKey ?? (mode === 'always'
    ? '["always",500,10000,0]'
    : '["normal",2,["RATE_LIMIT"],500,10000,0]')
  const delayMs = data.delayMs ?? 500
  const failure = data.failure ?? { message: 'busy', code: mode === 'normal' ? 'RATE_LIMIT' : 'SERVER' }
  // Real shape (llm-retry `src/types.ts`): `retryId` is a branded `RetryId`,
  // `maxRetries` is REQUIRED on the normal variant (and must stay absent on
  // the always variant 閳?excess-property check). Branching on the literal
  // `mode` lets the object literal satisfy the discriminated union.
  if (mode === 'normal') {
    agent.session.append('llm/retry', {
      retryId: RetryId(`llm-retry:${provider}:${turn}:${step}:${retry}`),
      turn,
      step,
      provider,
      mode,
      policyKey,
      retry,
      maxRetries: data.maxRetries ?? 2,
      delayMs,
      failure,
    })
  } else {
    agent.session.append('llm/retry', {
      retryId: RetryId(`llm-retry:${provider}:${turn}:${step}:${retry}`),
      turn,
      step,
      provider,
      mode,
      policyKey,
      retry,
      delayMs,
      failure,
    })
  }
}

/**
 * Emit one `assistant/message` `session/event` through the SAME context the
 * plugin listens on (plan fallbacks-half-open-recovery P5 driver): the
 * post-commit append firehose the P3 success-observation listener consumes.
 * The message is a real `createAssistantMessage` (dsh-llm) carrying the
 * producing route's `provider`/`model` provenance 閳?the actual producing
 * route, so a probe served through the virtual FallbacksChain/Auto adapter
 * matches its real head's key.
 */
export function emitAssistantMessage(
  ctx: Context,
  agent: Agent,
  data: {
    provider: string
    model: string
    turn?: number
    step?: number
    interrupted?: true
  },
): void {
  const { provider, model } = data
  const message = createAssistantMessage({
    content: [{ type: 'text', text: 'ok' }],
    source: { provider, model },
  })
  ctx.emit('session/event', agent.session, {
    type: 'assistant/message',
    seq: agent.session.seq,
    time: Date.now(),
    data: {
      turn: data.turn ?? 1,
      step: data.step ?? 1,
      message,
      ...(data.interrupted === undefined ? {} : { interrupted: data.interrupted }),
    },
  })
}

/** Drive one `agent/request-error` waterfall (the loop's dispatch, spec 鎼? table). */
export function dispatchRequestError(
  ctx: Context,
  agent: Agent,
  overrides: {
    turn?: number
    step?: number
    provider?: string
    failure?: LlmFailure
    retryPolicy?: ResolvedRetryPolicy
  } = {},
): Promise<RequestErrorAction> {
  return ctx.waterfall('agent/request-error', {
    agent,
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    // The loop reports the provider the REQUEST was built for 閳?for a session
    // served through the virtual delegate that is `FallbacksChain`, never the
    // concrete route the delegate happens to dispatch to.
    provider: overrides.provider ?? (agent.session.requestHeader()?.config.provider ?? 'mock'),
    failure: overrides.failure ?? { message: 'boom', code: 'AUTH' },
    retryPolicy: overrides.retryPolicy,
    signal: new AbortController().signal,
  }, () => Promise.resolve(undefined))
}

/**
 * Drive one `agent/request` waterfall (the loop's buildRequest, spec 鎼? table).
 *
 * M-02: mirrors the real agent loop, which folds (logs) the request header
 * with the served route after buildRequest 閳?the effective config returned by
 * the waterfall is written back into the fake session's route, so
 * `currentModel` reads the actually-served provider/model on the next
 * `agent/request-error` without the test author hand-syncing `setRoute`.
 * `setRoute` degrades to an explicit override for tests that route manually.
 */
/**
 * Model the user re-picking a concrete model in the picker: the host logs that
 * selection, and the dispatch-time forced route an earlier switch pinned no
 * longer describes the session, so it is dropped too.
 */
export function selectConcrete(agent: Agent, route: { provider: string; model: string }): void {
  clearForcedRoute((agent.session as { id?: string }).id ?? agent.id)
  const header = agent.session.requestHeader()
  if (header !== undefined) {
    header.config.provider = route.provider
    header.config.model = route.model
  }
}

export async function dispatchRequestProposal(
  ctx: Context,
  agent: Agent,
  seed: LlmCallConfig,
  overrides: { turn?: number; step?: number } = {},
): Promise<LlmCallConfig> {
  const config = await ctx.waterfall('agent/request', {
    agent,
    turn: overrides.turn ?? 1,
    step: overrides.step ?? 1,
    signal: new AbortController().signal,
  }, () => Promise.resolve(seed))
  const header = agent.session.requestHeader()
  if (header !== undefined) {
    // The real loop logs the FROZEN step selection, never the proposal: a
    // router-served session keeps its virtual pair even when the plugin (or a
    // caller) proposes a concrete route 閳?the redirect happens inside the
    // adapter. A virtual proposal IS a selection change (e.g. picking a named
    // chain), so it is logged like the host would.
    if (isVirtualRoute(config.provider, config.model) || !isVirtualRoute(header.config.provider, header.config.model)) {
      header.config.provider = config.provider
      header.config.model = config.model
    }
  }
  return config
}

/**
 * The route the delegate actually dispatches for this agent right now: the
 * session's forced route (set by a committed switch) wins over the config the
 * loop proposed. This is what a caller of `dispatchRequest` used to observe
 * directly, back when the plugin rewrote the proposed config itself 閳?the host
 * now freezes that config, so the redirect happens inside the adapter instead.
 */
export function servedRouteOf(agent: Agent, config: LlmCallConfig): LlmCallConfig {
  const pin = forcedRouteOf(agent.session?.id)
  if (pin === undefined) return config
  return {
    ...config,
    provider: pin.provider,
    model: pin.model,
    ...(pin.effort === '' ? {} : { reasoningEffort: pin.effort as LlmCallConfig['reasoningEffort'] }),
  }
}

/**
 * Drive one `agent/request` waterfall and report the route that would be
 * dispatched 閳?the served route (see `servedRouteOf`), which equals the
 * proposed config when no switch is in flight.
 */
export async function dispatchRequest(
  ctx: Context,
  agent: Agent,
  seed: LlmCallConfig,
  overrides: { turn?: number; step?: number } = {},
): Promise<LlmCallConfig> {
  return servedRouteOf(agent, await dispatchRequestProposal(ctx, agent, seed, overrides))
}

/**
 * Provider retry policy with `mode: 'normal'` (llm-retry semantics; default retryable codes per spec 鎼? note).
 * The overrides type is the distributive partial over both resolved variants
 * (`ResolvedRetryPolicy` is a concrete union, so a plain `Omit` would only
 * expose the common keys).
 */
export function normalPolicy(overrides: Partial<Omit<ResolvedNormalRetryPolicy, 'mode'>> = {}): ResolvedRetryPolicy {
  return {
    mode: 'normal',
    maxRetries: 2,
    retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT'],
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0,
    ...overrides,
  }
}

/** Provider retry policy with `mode: 'always'` (unbounded retries 閳?the cap mechanism's subject). */
export function alwaysPolicy(overrides: Partial<Omit<ResolvedRetryPolicy, 'mode'>> = {}): ResolvedRetryPolicy {
  return {
    mode: 'always',
    initialDelayMs: 500,
    maxDelayMs: 10_000,
    jitterRatio: 0,
    ...overrides,
  }
}

/**
 * Runtime double for the declared `LlmError` surface (the real
 * `@deepseek-ai/dsh-llm`, resolved from the npm registry as a peer dep),
 * mirroring the real class (`packages/llm/llm/src/index.ts`):
 * `(message, code, options?)` with a frozen serializable `failure`. The loop
 * constructs the terminal error as `new LlmError(failure.message,
 * failure.code, failure)` (spec 鎼?) 閳?the failure object doubles as the
 * options bag.
 */
export class LlmError extends Error {
  readonly code: string
  readonly failure: LlmFailure

  constructor(
    message: string,
    code: string,
    options: { status?: number; providerRetryAfterMs?: number; requestId?: string } = {},
  ) {
    super(message)
    this.name = 'LlmError'
    this.code = code
    this.failure = Object.freeze({
      message,
      code,
      ...(options.status === undefined ? {} : { status: options.status }),
      ...(options.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: options.providerRetryAfterMs }),
      // The real `LlmFailure.requestId` is a branded `ProviderRequestId`
      // (dsh-llm brand.ts); the double converts the plain-string test input.
      ...(options.requestId === undefined ? {} : { requestId: ProviderRequestId(options.requestId) }),
    })
  }
}

/** One scripted step attempt: `undefined` = the attempt succeeded. */
export type StepAttempt = LlmFailure | undefined

export interface StepResult {
  outcome: 'success' | 'error'
  /** Terminal `LlmError` when the step ended in error 閳?original code/message preserved (spec 鎼?). */
  error?: LlmError
  /** Routes dispatched per attempt (the served route 閳?a committed switch shows up here). */
  requests: LlmCallConfig[]
  /** Configs the `agent/request` waterfall proposed per attempt (the host-frozen selection). */
  proposals: LlmCallConfig[]
}

export interface RunStepOptions {
  /** Retry policy reported in every `agent/request-error` payload (the serving provider's policy). */
  retryPolicy?: ResolvedRetryPolicy
  /** Base config builder for each attempt; defaults to the current route. */
  seed?: (route: { provider: string; model: string }) => LlmCallConfig
}

/**
 * Mini agent-loop driver (mirrors `agent-loop/src/agent.ts` step()): build the
 * request through `agent/request` (a pending switch applies here), report the
 * scripted failure through `agent/request-error`, re-enter the build on
 * `{ kind: 'retry' }`, and end the step with the original failure's `LlmError`
 * on passthrough. The request header is logged (via `setRoute`) before each
 * failure dispatch, as the real loop does.
 */
export async function runAgentStep(
  ctx: Context,
  handle: AgentHarness,
  script: readonly StepAttempt[],
  options: RunStepOptions = {},
): Promise<StepResult> {
  const { agent, setRoute } = handle
  const header = agent.session.requestHeader()?.config as { provider: string; model: string } | undefined
  const route: { provider: string; model: string } = header ?? {
    provider: agent.options.provider ?? 'mock',
    model: agent.options.model ?? '',
  }
  const requests: LlmCallConfig[] = []
  const proposals: LlmCallConfig[] = []
  for (const failure of script) {
    const proposed = await dispatchRequestProposal(ctx, agent, options.seed ? options.seed(route) : { ...route })
    const served = servedRouteOf(agent, proposed)
    proposals.push(proposed)
    requests.push(served)
    // The loop logs the request header (the config it built) before dispatch.
    setRoute(proposed.provider, proposed.model)
    if (failure === undefined) return { outcome: 'success', requests, proposals }
    const action = await dispatchRequestError(ctx, agent, {
      provider: proposed.provider,
      failure,
      retryPolicy: options.retryPolicy,
    })
    if (action?.kind !== 'retry') {
      return { outcome: 'error', error: new LlmError(failure.message, failure.code, failure), requests, proposals }
    }
  }
  // Script exhausted with a trailing failure and no passthrough: the step ends
  // with that failure's original error.
  const last = script.at(-1)
  if (last !== undefined) {
    return { outcome: 'error', error: new LlmError(last.message, last.code, last), requests, proposals }
  }
  return { outcome: 'success', requests, proposals }
}
