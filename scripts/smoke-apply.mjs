import { readFileSync, writeFileSync } from 'node:fs'

const OUT = 'D:/Repos/dsh-llm-router/.build/smoke-apply.txt'
const out = []
const log = (line) => {
  out.push(line)
  writeFileSync(OUT, out.join('\n'), 'utf8')
}

const profile = 'C:/Users/18918/.dsh/profiles/desktop'
const yamlPath = 'D:/deepseek-harness/resources/app.asar/dsh/node_modules/yaml/dist/index.js'
const pkgPath = 'D:/Repos/dsh-llm-router/dist/index.js'

const YAML = await import('file:///' + yamlPath)
const yaml = YAML.default ?? YAML

const api = await import('file:///' + pkgPath)
log(`module: name=${api.name} provide=${JSON.stringify(api.provide ?? [])}`)
log(`exports: ${Object.keys(api).sort().join(',')}`)

const patch = yaml.parse(readFileSync(`${profile}/cordis.patch.yml`, 'utf8'))
const entries = Array.isArray(patch) ? patch : patch.plugins ?? []
log(`entries: ${entries.length}`)
const fb = entries.find((entry) => entry.id === 'llm-fallbacks')
if (fb === undefined) {
  log('MISSING llm-fallbacks entry')
} else {
  const config = api.Config(fb.config ?? {})
  const plain = typeof config?.get === 'function' ? config.get() : config
  log(`legacy config accepted: keys=${Object.keys(plain).join(',')}`)
  const compiled = api.withCompiledRouter(plain)
  log(`legacy compiled: rootChain=${JSON.stringify(compiled.rootChain)} slots=${compiled.timeSlots.length}`)
}

const sample = api.Config({
  models: [
    {
      id: 'fast',
      name: 'Fast',
      provider: 'deepinfra-flex',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      windows: [{ start: '09:00', end: '12:00', days: [1, 2, 3, 4, 5] }],
      fallback: 'loop',
      officialModel: 'deepseek-official/deepseek-flash',
      rules: { codes: ['PI_AI_ERROR', 'SERVER'], regex: ['Upstream rejected'], structural: true, markers: ['DSML'] },
    },
    {
      id: 'official',
      name: 'Official',
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      windows: [],
      fallback: 'none',
      officialModel: 'deepseek-official/deepseek-flash',
      rules: { codes: [], regex: [], structural: false, markers: [] },
    },
  ],
  providers: [{ provider: 'deepinfra-flex', enabled: true, maxRetries: 3, windowMs: 300000, initialDelayMs: 800, maxDelayMs: 15000, jitterRatio: 0.1 }],
})
const samplePlain = typeof sample?.get === 'function' ? sample.get() : sample
log(`models parsed: ${samplePlain.models.length} providers=${samplePlain.providers.length} retryKey=${'retry' in samplePlain}`)
const compiledSample = api.withCompiledRouter(samplePlain)
log(`models compiled: rootChain=${JSON.stringify(compiledSample.rootChain)}`)
log(`models slots=${compiledSample.timeSlots.length} first=${JSON.stringify(compiledSample.timeSlots[0] ?? null)}`)
log(`triggerCodes=${JSON.stringify(compiledSample.triggerCodes)}`)
log(`retryFor(deepinfra-flex)=${JSON.stringify(api.retryFor(compiledSample, 'deepinfra-flex') ?? null)}`)
log(`retryFor(deepseek-official)=${JSON.stringify(api.retryFor(compiledSample, 'deepseek-official') ?? null)}`)
log('DONE')
