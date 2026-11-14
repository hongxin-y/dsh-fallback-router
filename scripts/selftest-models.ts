/**
 * Self-test for the model-configuration layer of dsh-fallback-router.
 *
 * Runs OUTSIDE the host: it exercises the pure compilation / rule / detection
 * helpers plus the config bridge (`withCompiledRouter`) that turns authored
 * model profiles into the chain + slot rows the routing engine already reads.
 *
 * Usage: node_modules\.bin\tsx.cmd scripts\selftest-models.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  DEFAULT_MARKERS,
  DEFAULT_RULES_CODES,
  compileModelChain,
  compileRouter,
  defaultRules,
  degenerateReason,
  failureMatches,
  matchesRules,
  normalizeModelProfiles,
  normalizeProviders,
  normalizeRoutes,
  pinnedEffort,
  profileChainAt,
  pruneFailures,
  retryDelay,
  retryFor,
  validateModels,
  waitFor,
  type ModelProfile,
  type ProviderRetry,
} from '../src/models.ts'
import { defaultFallbacksConfig, type FallbacksConfig } from '../src/config.ts'
import { resolveEffectiveChain, resolveSlotState } from '../src/time-slots.ts'

let pass = 0
let fail = 0
const failures: string[] = []

function check(name: string, run: () => void): void {
  try {
    run()
    pass += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    fail += 1
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name} :: ${message}`)
    console.log(`FAIL ${name} :: ${message}`)
  }
}

async function checkAsync(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run()
    pass += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    fail += 1
    const message = error instanceof Error ? error.message : String(error)
    failures.push(`${name} :: ${message}`)
    console.log(`FAIL ${name} :: ${message}`)
  }
}

function profile(over: Partial<ModelProfile> = {}): ModelProfile {
  return {
    id: 'a',
    name: 'A',
    kind: 'route',
    provider: 'deepinfra-flex',
    model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    windows: [],
    fallback: 'official',
    officialModel: 'deepseek-official/deepseek-flash',
    extraRoutes: [],
    expose: false,
    reasoningEffort: '',
    rules: { codes: [...DEFAULT_RULES_CODES], regex: [], structural: true, markers: [...DEFAULT_MARKERS] },
    ...over,
  }
}

function configWith(models: ModelProfile[], over: Partial<FallbacksConfig> = {}): FallbacksConfig {
  return { ...defaultFallbacksConfig, models, ...over } as FallbacksConfig
}

// ---------------------------------------------------------------- compile ----

check('official fallback appends the official model', () => {
  const chain = compileModelChain(configWith([profile()]), 0)
  assert.deepEqual(chain, ['deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017', 'deepseek-official/deepseek-flash'])
})

check('none fallback keeps only the head', () => {
  const chain = compileModelChain(configWith([profile({ fallback: 'none' })]), 0)
  assert.deepEqual(chain, ['deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017'])
})

check('loop fallback rings through the other profiles and stops at the last', () => {
  const models = [
    profile({ id: 'a', name: 'A', fallback: 'loop' }),
    profile({ id: 'b', name: 'B', provider: 'deepseek-official', model: 'deepseek-flash', fallback: 'loop' }),
    profile({ id: 'c', name: 'C', provider: 'ruinique', model: 'gpt-6-luna', fallback: 'loop' }),
  ]
  // From b the ring visits c, a — and stops there: re-visiting the head would
  // only retry a route this same step already tried.
  const chain = compileModelChain(configWith(models), 1)
  assert.deepEqual(chain, [
    'deepseek-official/deepseek-flash',
    'ruinique/gpt-6-luna',
    'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017',
  ])
})

check('compileRouter turns each window into one custom slot row', () => {
  const models = [
    profile({ id: 'day', name: '白天', windows: [{ start: '09:00', end: '12:00', days: [1, 2] }] }),
    profile({ id: 'night', name: '夜间', provider: 'deepseek-official', model: 'deepseek-flash', windows: [{ start: '22:00', end: '02:00' }] }),
  ]
  const compiled = compileRouter(configWith(models))
  assert.equal(compiled.timeSlots.length, 2)
  assert.equal(compiled.timeSlots[0]?.kind, 'custom')
  assert.equal(compiled.timeSlots[0]?.name, 'day')
  assert.deepEqual(compiled.timeSlots[0]?.days, [1, 2])
  assert.deepEqual(compiled.timeSlots[0]?.chain, [
    'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'deepseek-official/deepseek-flash',
  ])
  // No all-day profile -> the first model is the root chain.
  assert.deepEqual(compiled.rootChain, [
    'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'deepseek-official/deepseek-flash',
  ])
})

check('compileRouter prefers the first window-less profile as the root chain', () => {
  const models = [
    profile({ id: 'always', name: '常驻', provider: 'ruinique', model: 'gpt-6-luna', fallback: 'none' }),
    profile({ id: 'day', name: '白天', windows: [{ start: '09:00', end: '12:00' }] }),
  ]
  const compiled = compileRouter(configWith(models))
  assert.deepEqual(compiled.rootChain, ['ruinique/gpt-6-luna'])
})

check('compileRouter is a no-op without model profiles', () => {
  const base = configWith([], { rootChain: ['deepinfra-flex/x', 'deepseek-official/deepseek-flash'] })
  const compiled = compileRouter(base)
  assert.deepEqual(compiled.rootChain, base.rootChain)
  assert.deepEqual(compiled.timeSlots, base.timeSlots)
})

check('the compiled slot row wins through resolveSlotState', () => {
  const models = [
    profile({ id: 'day', name: '白天', windows: [{ start: '09:00', end: '12:00' }] }),
    profile({ id: 'night', name: '夜间', provider: 'deepseek-official', model: 'deepseek-flash', windows: [{ start: '22:00', end: '02:00' }] }),
  ]
  const compiled = configWith(models, compileRouter(configWith(models)))
  const morning = resolveEffectiveChain(compiled, new Date('2026-11-08T10:00:00+08:00'), 'Asia/Shanghai')
  assert.equal(morning[0], 'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017')
  const night = resolveEffectiveChain(compiled, new Date('2026-11-08T23:30:00+08:00'), 'Asia/Shanghai')
  assert.equal(night[0], 'deepseek-official/deepseek-flash')
  const state = resolveSlotState(compiled, new Date('2026-11-08T23:30:00+08:00'), 'Asia/Shanghai')
  assert.equal(state.winner === 'all-day' ? '' : state.winner.name, 'night')
})

check('a preset window compiles into a preset row and still resolves', () => {
  const models = [profile({ id: 'peak', name: '高峰', windows: [{ preset: 'liang-peak', start: '', end: '', days: [] }] })]
  const compiled = compileRouter(configWith(models))
  assert.equal(compiled.timeSlots.length, 1)
  const row = compiled.timeSlots[0]
  assert.equal(row?.kind, 'preset')
  assert.equal(row?.preset, 'liang-peak')
  assert.equal(row?.name, 'peak')
  // A preset row carries no clock fields of its own — the preset owns them.
  assert.equal(row?.start, undefined)
  assert.equal(row?.end, undefined)
  assert.equal(row?.days, undefined)
  // Monday 10:00 in Shanghai falls inside the Liang peak window.
  const state = resolveSlotState(
    configWith(models, compiled),
    new Date('2026-11-09T10:00:00+08:00'),
    'Asia/Shanghai',
  )
  assert.equal(state.winner === 'all-day' ? '' : state.winner.name, 'peak')
})

check('extra routes sit between the head and the official fallback', () => {
  const models = [
    profile({
      id: 'a',
      fallback: 'official',
      extraRoutes: [
        { route: 'ruinique/gpt-6.1-sol', reasoningEffort: '' },
        { route: 'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017', reasoningEffort: '' },
      ],
    }),
  ]
  const chain = compileModelChain(configWith(models), 0)
  assert.deepEqual(chain, [
    'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'ruinique/gpt-6.1-sol',
    'deepseek-official/deepseek-flash',
  ])
})

check('extra routes work with the loop fallback without duplicates', () => {
  const models = [
    profile({ id: 'a', fallback: 'loop', extraRoutes: [{ route: 'ruinique/gpt-6.1-sol', reasoningEffort: '' }] }),
    profile({ id: 'b', provider: 'deepseek-official', model: 'deepseek-flash', fallback: 'loop' }),
  ]
  const chain = compileModelChain(configWith(models), 0)
  assert.deepEqual(chain, [
    'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'ruinique/gpt-6.1-sol',
    'deepseek-official/deepseek-flash',
  ])
})

check('expose compiles the profile into a named picker chain', () => {
  const models = [
    profile({ id: 'deepseek-auto', name: 'deepseek自动降级链', expose: true }),
    profile({ id: 'hidden', name: '隐藏', provider: 'ruinique', model: 'gpt-6-luna', expose: false }),
  ]
  const compiled = compileRouter(configWith(models))
  assert.deepEqual(compiled.namedChains, [
    {
      id: 'deepseek-auto',
      name: 'deepseek自动降级链',
      chain: ['deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017', 'deepseek-official/deepseek-flash'],
    },
  ])
})

// --------------------------------------------------------------- combos ----

check('a combo window compiles to the chain of the configuration it points at', () => {
  const models = [
    profile({ id: 'flex', name: 'Flex', windows: [] }),
    profile({
      id: 'peak-valley',
      name: '峰谷组合',
      kind: 'combo',
      provider: '',
      model: '',
      windows: [{ preset: 'liang-peak', start: '', end: '', days: [], use: 'flex' }],
    }),
  ]
  const compiled = compileRouter(configWith(models))
  assert.equal(compiled.timeSlots.length, 1)
  const row = compiled.timeSlots[0]!
  assert.equal(row.kind, 'preset')
  assert.equal(row.name, 'peak-valley')
  assert.deepEqual(row.chain, ['deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017', 'deepseek-official/deepseek-flash'])
})

check('a combo with two windows switches between two existing configurations', () => {
  const models = [
    profile({ id: 'peak', name: 'Peak', provider: 'deepinfra-flex', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' }),
    profile({ id: 'valley', name: 'Valley', provider: 'deepseek-official', model: 'deepseek-flash', fallback: 'none' }),
    profile({
      id: 'split',
      name: '峰谷',
      kind: 'combo',
      provider: '',
      model: '',
      windows: [
        { preset: 'liang-peak', start: '', end: '', days: [], use: 'peak' },
        { preset: 'liang-valley', start: '', end: '', days: [], use: 'valley' },
      ],
    }),
  ]
  const compiled = compileRouter(configWith(models))
  assert.equal(compiled.timeSlots.length, 2)
  assert.deepEqual(compiled.timeSlots[0]!.chain[0], 'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017')
  assert.deepEqual(compiled.timeSlots[1]!.chain, ['deepseek-official/deepseek-flash'])
})

check('a combo window without a target compiles to nothing', () => {
  const models = [
    profile({
      id: 'orphan',
      name: '孤立组合',
      kind: 'combo',
      provider: '',
      model: '',
      windows: [{ preset: 'liang-peak', start: '', end: '', days: [], use: '' }],
    }),
  ]
  assert.equal(compileRouter(configWith(models)).timeSlots.length, 0)
})

check('an exposed combo keeps switching by its own windows at request time', () => {
  const models = [
    profile({ id: 'peak', name: 'Peak', provider: 'deepinfra-flex', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', fallback: 'none' }),
    profile({ id: 'valley', name: 'Valley', provider: 'deepseek-official', model: 'deepseek-flash', fallback: 'none' }),
    profile({
      id: 'split',
      name: '峰谷',
      kind: 'combo',
      provider: '',
      model: '',
      expose: true,
      windows: [
        { preset: 'liang-peak', start: '', end: '', days: [], use: 'peak' },
        { preset: 'liang-valley', start: '', end: '', days: [], use: 'valley' },
      ],
    }),
  ]
  const compiled = compileRouter(configWith(models))
  const config = { ...configWith(models), ...compiled }
  // 10:00 is inside 梁文峰, 23:00 is outside it — the same picker entry must
  // answer with a different chain instead of one frozen flattened chain.
  assert.deepEqual(
    profileChainAt(config, 'split', new Date('2026-11-09T10:00:00+08:00'), 'Asia/Shanghai'),
    ['deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017'],
  )
  assert.deepEqual(
    profileChainAt(config, 'split', new Date('2026-11-09T23:00:00+08:00'), 'Asia/Shanghai'),
    ['deepseek-official/deepseek-flash'],
  )
  // The flattened picker chain is still what the row advertises up front.
  assert.deepEqual(compiled.namedChains[0]!.chain, [
    'deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017',
    'deepseek-official/deepseek-flash',
  ])
})

check('a profile without windows answers with its own chain at any time', () => {
  const models = [
    profile({ id: 'always', name: 'Always', provider: 'deepinfra-flex', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', fallback: 'official' }),
  ]
  const compiled = compileRouter(configWith(models))
  const config = { ...configWith(models), ...compiled }
  assert.deepEqual(
    profileChainAt(config, 'always', new Date('2026-11-09T03:00:00+08:00'), 'Asia/Shanghai'),
    ['deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017', 'deepseek-official/deepseek-flash'],
  )
  assert.deepEqual(profileChainAt(config, 'ghost', new Date(), 'Asia/Shanghai'), [])
})

check('a combo never becomes the root chain but can be a picker entry', () => {
  const models = [
    profile({
      id: 'only-combo',
      name: '只有组合',
      kind: 'combo',
      provider: '',
      model: '',
      expose: true,
      windows: [{ preset: 'liang-peak', start: '', end: '', days: [], use: 'ghost' }],
    }),
  ]
  const compiled = compileRouter(configWith(models))
  // `ghost` does not exist, so the combo flattens to nothing: a dead entry is
  // dropped instead of shipping an empty picker chain.
  assert.deepEqual(compiled.namedChains, [])
  assert.deepEqual(compiled.rootChain, ['deepseek-official/deepseek-flash'])
})

check('an exposed combo becomes a picker chain flattened from its windows', () => {
  const models = [
    profile({ id: 'peak', name: 'Peak', provider: 'deepinfra-flex', model: 'flex', fallback: 'official' }),
    profile({ id: 'valley', name: 'Valley', provider: 'ruinique', model: 'gpt-6-luna', fallback: 'none' }),
    profile({
      id: 'mix',
      name: '峰谷组合',
      kind: 'combo',
      provider: '',
      model: '',
      expose: true,
      windows: [
        { preset: 'liang-peak', start: '', end: '', days: [], use: 'peak' },
        { preset: 'liang-valley', start: '', end: '', days: [], use: 'valley' },
        { preset: 'glm-peak', start: '', end: '', days: [], use: 'peak' },
      ],
    }),
  ]
  const compiled = compileRouter(configWith(models))
  assert.deepEqual(compiled.namedChains, [
    { id: 'mix', name: '峰谷组合', chain: ['deepinfra-flex/flex', 'deepseek-official/deepseek-flash', 'ruinique/gpt-6-luna'] },
  ])
})

check('a single-model window may borrow another configuration', () => {
  const models = [
    profile({ id: 'borrower', name: '借用', windows: [{ preset: 'liang-peak', start: '', end: '', days: [], use: 'donor' }] }),
    profile({ id: 'donor', name: 'Donor', provider: 'ruinique', model: 'gpt-6-luna', fallback: 'none' }),
  ]
  const compiled = compileRouter(configWith(models))
  assert.deepEqual(compiled.timeSlots[0]!.chain, ['ruinique/gpt-6-luna'])
})

// ------------------------------------------------------------------ rules ----

check('an empty code list matches every failure', () => {
  assert.equal(matchesRules({ codes: [], regex: [], structural: false, markers: [] }, { code: 'WHATEVER' }), true)
})

check('a listed code matches, an unlisted one does not', () => {
  const rules = { codes: ['SERVER', 'TIMEOUT'], regex: [], structural: false, markers: [] }
  assert.equal(matchesRules(rules, { code: 'SERVER' }), true)
  assert.equal(matchesRules(rules, { code: 'PI_AI_ERROR' }), false)
})

check('a regex matches the failure message', () => {
  const rules = { codes: ['AUTH'], regex: ['upstream rejected', '\\b50\\d\\b'], structural: false, markers: [] }
  assert.equal(matchesRules(rules, { code: 'PI_AI_ERROR', message: 'Upstream rejected the request' }), true)
  assert.equal(matchesRules(rules, { code: 'PI_AI_ERROR', message: 'something else' }), false)
})

check('an invalid regex is ignored instead of throwing', () => {
  const rules = { codes: [], regex: ['(unclosed'], structural: false, markers: [] }
  assert.doesNotThrow(() => matchesRules(rules, { code: 'SERVER' }))
})

check('failureMatches scopes rules to the failing provider', () => {
  const models = [
    profile({ id: 'a', provider: 'deepinfra-flex', rules: { codes: ['SERVER'], regex: [], structural: false, markers: [] } }),
    profile({ id: 'b', provider: 'ruinique', rules: { codes: ['AUTH'], regex: [], structural: false, markers: [] } }),
  ]
  const config = configWith(models)
  assert.equal(failureMatches(config, 'deepinfra-flex', { code: 'SERVER' }), true)
  assert.equal(failureMatches(config, 'ruinique', { code: 'SERVER' }), false)
  // A provider nobody authored falls back to the classic triggerCodes gate.
  assert.equal(failureMatches(config, 'unknown-provider', { code: 'SERVER' }), true)
  assert.equal(failureMatches(config, 'unknown-provider', { code: 'NOPE' }), false)
})

check('failureMatches falls back to triggerCodes without profiles', () => {
  const config = configWith([], { triggerCodes: ['SERVER'] })
  assert.equal(failureMatches(config, 'any', { code: 'SERVER' }), true)
  assert.equal(failureMatches(config, 'any', { code: 'AUTH' }), false)
})

check('a picker-selected model retries by the default rules its provider opted into', () => {
  const models = [profile({ id: 'a', provider: 'deepinfra-flex', rules: { codes: ['SERVER'], regex: [], structural: false, markers: [] } })]
  const retryRow = (provider: string): ProviderRetry => ({
    provider, enabled: true, maxRetries: 3, windowMs: 300_000,
    initialDelayMs: 800, maxDelayMs: 15_000, jitterRatio: 0.1,
  })
  // ruinique routes to no profile — it is only reachable by selecting one of
  // its models in the picker — but the user switched its retry row on.
  const config = configWith(models, { providers: [retryRow('ruinique')] })
  assert.equal(failureMatches(config, 'ruinique', { code: 'PI_AI_ERROR' }), true)
  assert.equal(failureMatches(config, 'ruinique', { code: 'TIMEOUT' }), true)
  // Without that row the legacy triggerCodes gate is still what applies.
  assert.equal(failureMatches(config, 'ikun-gateway', { code: 'PI_AI_ERROR' }), false)
  assert.equal(failureMatches(config, 'ikun-gateway', { code: 'SERVER' }), true)
  // A switched-off row does not opt the provider in.
  const off = configWith(models, { providers: [{ ...retryRow('ruinique'), enabled: false }] })
  assert.equal(failureMatches(off, 'ruinique', { code: 'PI_AI_ERROR' }), false)
})

// --------------------------------------------------------------- structure ----

const TOOLS = ['read', 'write']

check('a truncated tool-call tail is degenerate', () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: 'let me check\n</|DSML|invoke></|DSML|calls>' }] }
  assert.equal(degenerateReason(message, TOOLS, { ...defaultRules(), structural: true }), 'marker:DSML')
})

check('an answer with a tool call is never degenerate', () => {
  const message = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'ok\n</|DSML|invoke>' },
      { type: 'tool-call', name: 'read', input: {} },
    ],
  }
  assert.equal(degenerateReason(message, TOOLS, { ...defaultRules(), structural: true }), undefined)
})

check('plain prose is not degenerate', () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: '工具调用会被截断，例如 </|DSML|invoke> 这样的残片。' }] }
  assert.equal(degenerateReason(message, TOOLS, { ...defaultRules(), structural: true }), undefined)
})

check('structural detection is skipped when the model exposes no tools', () => {
  const message = { role: 'assistant', content: [{ type: 'text', text: '</|DSML|invoke>' }] }
  assert.equal(degenerateReason(message, [], { ...defaultRules(), structural: true }), undefined)
})

// ----------------------------------------------------------------- retry ----

function retryRow(over: Partial<ProviderRetry> = {}): ProviderRetry {
  return { provider: 'deepinfra-flex', enabled: true, maxRetries: 3, windowMs: 300000, initialDelayMs: 800, maxDelayMs: 15000, jitterRatio: 0, ...over }
}

check('pruneFailures drops timestamps outside the window', () => {
  const list = [1000, 2000, 9000]
  assert.equal(pruneFailures(list, 10000, 5000), 1)
  assert.deepEqual(list, [9000])
})

check('retryDelay grows exponentially and respects the ceiling', () => {
  const policy = retryRow()
  assert.equal(retryDelay(policy, 1), 800)
  assert.equal(retryDelay(policy, 2), 1600)
  assert.equal(retryDelay(policy, 3), 3200)
  assert.equal(retryDelay(policy, 40), 15000)
})

check('jitter keeps the delay inside the policy ceiling', () => {
  const policy = retryRow({ jitterRatio: 0.5 })
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const delay = retryDelay(policy, attempt)
    assert.ok(delay >= 0 && delay <= policy.maxDelayMs, `delay ${String(delay)} out of range`)
  }
})

check('retryFor only honours the exact provider row (retry is opt-in per provider)', () => {
  const config = configWith([], { providers: [retryRow({ provider: 'ruinique', maxRetries: 1 })] })
  assert.equal(retryFor(config, 'ruinique')?.maxRetries, 1)
  assert.equal(retryFor(config, 'other'), undefined)
})

check('retryFor returns nothing when no row is configured', () => {
  assert.equal(retryFor(configWith([], { providers: [] }), 'deepinfra-flex'), undefined)
})

check('retryFor returns nothing for a row that is switched off', () => {
  const config = configWith([], { providers: [retryRow({ provider: 'ruinique', enabled: false })] })
  assert.equal(retryFor(config, 'ruinique'), undefined)
})

await checkAsync('waitFor resolves false when the signal aborts', async () => {
  const controller = new AbortController()
  const pending = waitFor(50, controller.signal)
  controller.abort()
  assert.equal(await pending, false)
})

// ------------------------------------------------------------ validation ----

check('validateModels warns about an incomplete route and a bad id', () => {
  const warnings: string[] = []
  const logger = { warn: (message: string) => { warnings.push(message) }, info: () => {} }
  validateModels(configWith([profile({ id: 'Bad Id', provider: '' })]), logger)
  assert.ok(warnings.some(line => line.includes('id')), warnings.join(' | '))
  assert.ok(warnings.some(line => line.includes('incomplete route')), warnings.join(' | '))
})

check('normalizeModelProfiles fills defaults for a sparse row', () => {
  const rows = normalizeModelProfiles([{ id: 'x', provider: 'p', model: 'm' }])
  assert.equal(rows.length, 1)
  assert.equal(rows[0]?.fallback, 'official')
  assert.equal(rows[0]?.officialModel, 'deepseek-official/deepseek-flash')
  assert.equal(rows[0]?.rules.structural, true)
  assert.deepEqual(rows[0]?.windows, [])
})

check('normalizeProviders drops rows without a provider', () => {
  assert.equal(normalizeProviders([{ provider: '  ' }, { provider: 'p' }]).length, 1)
})

// ------------------------------------------------------------ 推理等级 ----

check('pinnedEffort returns the level the matching route pins', () => {
  const config = configWith([
    profile({ id: 'flash', reasoningEffort: 'high' }),
    profile({ id: 'other', provider: 'ruinique', model: 'gpt-6-luna', reasoningEffort: 'low' }),
  ])
  assert.equal(pinnedEffort(config, 'deepinfra-flex', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'), 'high')
  assert.equal(pinnedEffort(config, 'ruinique', 'gpt-6-luna'), 'low')
})

check('pinnedEffort returns nothing for an unpinned or unknown route', () => {
  const config = configWith([profile({ id: 'flash', reasoningEffort: '' })])
  assert.equal(pinnedEffort(config, 'deepinfra-flex', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'), '')
  assert.equal(pinnedEffort(config, 'nobody', 'nothing'), '')
})

check('a combo never pins an effort, and normalization keeps route levels only', () => {
  const rows = normalizeModelProfiles([
    { id: 'mix', kind: 'combo', reasoningEffort: 'high' },
    { id: 'flash', provider: 'deepinfra-flex', model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', reasoningEffort: ' low ' },
  ])
  assert.equal(rows[0]?.reasoningEffort, '')
  assert.equal(rows[1]?.reasoningEffort, 'low')
  assert.equal(pinnedEffort(configWith(rows), 'deepinfra-flex', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'), 'low')
})

check('normalizeRoutes accepts both the string and the row shape', () => {
  const rows = normalizeRoutes([
    'ruinique/gpt-6.1-sol',
    { route: 'deepinfra-flex/flex', reasoningEffort: ' high ' },
    { route: '' },
    'ruinique/gpt-6.1-sol',
  ])
  assert.deepEqual(rows, [
    { route: 'ruinique/gpt-6.1-sol', reasoningEffort: '' },
    { route: 'deepinfra-flex/flex', reasoningEffort: 'high' },
  ])
})

check('an extra route pins its own effort when it becomes the head', () => {
  const config = configWith([
    profile({ id: 'a', extraRoutes: [{ route: 'ruinique/gpt-6.1-sol', reasoningEffort: 'high' }] }),
  ])
  assert.equal(pinnedEffort(config, 'ruinique', 'gpt-6.1-sol'), 'high')
  // The profile's own route still wins over any hop that repeats it.
  assert.equal(pinnedEffort(config, 'deepinfra-flex', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'), '')
})

check('an extra route with no level follows the system default', () => {
  const config = configWith([
    profile({ id: 'a', extraRoutes: [{ route: 'ruinique/gpt-6.1-sol', reasoningEffort: '' }] }),
  ])
  assert.equal(pinnedEffort(config, 'ruinique', 'gpt-6.1-sol'), '')
})

// --------------------------------------------------------------- shipping ----

check('the shipped package identity is dsh-fallback-router', () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { name?: string }
  assert.equal(pkg.name, 'dsh-fallback-router')
})

console.log(`\nPASS=${String(pass)} FAIL=${String(fail)}`)
if (fail > 0) {
  console.log(failures.join('\n'))
  process.exitCode = 1
}
