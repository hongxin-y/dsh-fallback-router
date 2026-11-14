import { readFileSync, writeFileSync } from 'node:fs'

const OUT = 'D:/Repos/dsh-llm-router/.build/validate-profile.txt'
const out = []
const log = (line) => { out.push(line); writeFileSync(OUT, out.join('\n'), 'utf8') }

const YAML = await import('yaml')
const yaml = YAML.default ?? YAML
const api = await import('file:///D:/Repos/dsh-llm-router/dist/index.js')

const text = readFileSync('C:/Users/18918/.dsh/profiles/desktop/cordis.patch.yml', 'utf8')
const entries = yaml.parse(text)
const entry = entries.find((item) => item.id === 'llm-router')
log(`entry found: ${entry !== undefined} disabled=${entry?.disabled}`)

const config = api.Config(entry.config)
const plain = typeof config?.get === 'function' ? config.get() : config
log(`raw models=${plain.models.length} providers=${plain.providers.length} timeSlots=${plain.timeSlots?.length ?? 'none'}`)

const warnings = []
const logger = { warn: (...args) => warnings.push(args.join(' ')), info: () => {}, debug: () => {} }
api.validateFallbacksConfig(plain, logger)
log(`validate warnings: ${warnings.length}`)
for (const warning of warnings) log(`  ! ${warning}`)

const compiled = api.withCompiledRouter(plain)
log(`compiled rootChain=${JSON.stringify(compiled.rootChain)}`)
log(`compiled slots=${compiled.timeSlots.length}`)
for (const slot of compiled.timeSlots) log(`  slot ${slot.name}: ${slot.start}-${slot.end} chain=${JSON.stringify(slot.chain)}`)
log(`compiled triggerCodes=${JSON.stringify(compiled.triggerCodes)}`)
log(`roles=${compiled.roles.list.length} namedChains=${compiled.namedChains?.length ?? 0} presets=${compiled.presets}`)
log(`retryFor(deepinfra-flex)=${JSON.stringify(api.retryFor(compiled, 'deepinfra-flex') ?? null)}`)
log(`retryFor(deepseek-official)=${JSON.stringify(api.retryFor(compiled, 'deepseek-official') ?? null)}`)
log(`isFallbackActive=${api.validateFallbacksConfig !== undefined}`)
log('DONE')
