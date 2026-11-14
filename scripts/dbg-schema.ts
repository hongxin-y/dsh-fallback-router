import { Config } from '../src/schema.ts'
import { withCompiledRouter } from '../src/index.ts'
import { defaultFallbacksConfig } from '../src/config.ts'

const resolved = Config({}) as unknown as Record<string, unknown>
console.log('typeof', typeof resolved)
console.log('json', JSON.stringify(resolved))
console.log('proto', Object.getPrototypeOf(resolved)?.constructor?.name)
const keys = Object.keys(resolved)
console.log('keys', keys.join(','))
if (keys.length === 1 && keys[0] === 'get') {
  console.log('get()', JSON.stringify((resolved as { get: () => unknown }).get()))
}
const compiled = withCompiledRouter({ ...defaultFallbacksConfig } as never) as unknown as Record<string, unknown>
console.log('compiled retry', JSON.stringify(compiled.retry))
console.log('compiled providers', JSON.stringify(compiled.providers))
console.log('compiled models', JSON.stringify(compiled.models))
console.log('compiled rootChain', JSON.stringify(compiled.rootChain))
