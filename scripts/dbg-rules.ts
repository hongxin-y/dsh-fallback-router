import { failureMatches, matchesRules, DEFAULT_MARKERS } from '../src/models.ts'
import { defaultFallbacksConfig } from '../src/config.ts'

const a = {
  id: 'a', name: 'A', provider: 'deepinfra-flex', model: 'm1', windows: [],
  fallback: 'official' as const, officialModel: 'deepseek-official/deepseek-flash',
  rules: { codes: ['SERVER'], regex: [], structural: false, markers: [...DEFAULT_MARKERS] },
}
const b = {
  id: 'b', name: 'B', provider: 'ruinique', model: 'm2', windows: [],
  fallback: 'official' as const, officialModel: 'deepseek-official/deepseek-flash',
  rules: { codes: ['AUTH'], regex: [], structural: false, markers: [...DEFAULT_MARKERS] },
}
const config = { ...defaultFallbacksConfig, models: [a, b] } as typeof defaultFallbacksConfig
console.log('a.rules.codes', JSON.stringify(a.rules.codes))
console.log('b.rules.codes', JSON.stringify(b.rules.codes))
console.log('matches b SERVER', matchesRules(b.rules, { code: 'SERVER' }))
console.log('matches a SERVER', matchesRules(a.rules, { code: 'SERVER' }))
console.log('failureMatches ruinique SERVER', failureMatches(config as never, 'ruinique', { code: 'SERVER' }))
console.log('failureMatches deepinfra SERVER', failureMatches(config as never, 'deepinfra-flex', { code: 'SERVER' }))
console.log('triggerCodes', JSON.stringify(config.triggerCodes))
