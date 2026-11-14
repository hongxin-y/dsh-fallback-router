import { readdirSync, existsSync } from 'node:fs'
const base = 'D:/deepseek-harness/resources/app.asar/dsh/node_modules/@deepseek-ai'
const out = []
out.push('base exists: ' + existsSync(base))
if (existsSync(base)) {
  const names = readdirSync(base)
  out.push('count: ' + names.length)
  out.push(names.filter(n => /agent-loop|dsh-llm|dsh-agent|dsh-session/.test(n)).join('\n'))
}
console.log(out.join('\n'))
