// Build a static preview of the models panel from the SHIPPED bundle: the
// hashed CSS text and the hashed class map are extracted out of
// dist/client/index.js, so what the browser renders here is the exact CSS the
// plugin injects. Used to eyeball the layout without a logged-in GUI.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'

const BUNDLE = 'dist/client/index.js'
const OUT = '.build/preview-panel.html'
const source = readFileSync(BUNDLE, 'utf8')

/** All `var X_module_css_default = { "local": "hashed", ... }` maps. */
function classMaps() {
  const maps = {}
  const re = /var (\w+)_module_css_default = \{([^}]*)\};/g
  let hit
  while ((hit = re.exec(source)) !== null) {
    const [, moduleName, body] = hit
    const map = {}
    for (const pair of body.matchAll(/"([^"]+)":\s*"([^"]+)"/g)) map[pair[1]] = pair[2]
    maps[moduleName] = map
  }
  return maps
}

/** Every `const css$N = "<escaped css>";` literal, unescaped. */
function cssText() {
  const out = []
  const re = /const css\$\d+ = ("(?:[^"\\]|\\.)*");/g
  let hit
  while ((hit = re.exec(source)) !== null) out.push(JSON.parse(hit[1]))
  return out.join('\n')
}

const maps = classMaps()
const panel = maps.ModelsPanel
const card = maps.FallbacksCard
if (panel === undefined || card === undefined) {
  throw new Error(`missing class maps: ${Object.keys(maps).join(', ')}`)
}

// The panel imports the card module for the shared chrome (h2, save/discard,
// hint, input, textarea, checkbox); everything else is its own module.
const cls = name => {
  const value = panel[name] ?? card[name]
  if (value === undefined) throw new Error(`no class ${name}`)
  return value
}
const c = (...names) => names.map(cls).join(' ')

const CODES = ['AUTH', 'QUOTA', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'PI_AI_ERROR', 'INVALID_REQUEST', 'EMPTY_RESPONSE', 'UNKNOWN']
const DAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const chips = items => `<div class="${cls('chips')}">${items.join('')}</div>`
const chip = (label, checked, type = 'checkbox') =>
  `<label class="${cls('chip')}"><input type="${type}"${checked ? ' checked' : ''}><span>${label}</span></label>`

function extraRouteRow(provider, model, effort = '') {
  return `<div class="${cls('row')}">
    <label class="${c('rowField', 'grow')}"><span class="${cls('cellLabel')}">Provider</span>${select(provider, PROVIDERS, '选择 Provider')}</label>
    <label class="${c('rowField', 'grow')}"><span class="${cls('cellLabel')}">模型</span>${select(model, MODELS, '选择模型')}</label>
    <label class="${c('rowField', 'grow')}"><span class="${cls('cellLabel')}">推理等级</span>${select(effort, ['', 'low', 'high', 'max'], '跟随系统')}</label>
    <button class="${cls('iconBtn')}">✕</button>
  </div>`
}

function retryRow(provider, retries, windowMs) {
  return `<div class="${cls('row')}">
    <label class="${c('rowField', 'grow')}"><span class="${cls('cellLabel')}">Provider</span>${select(provider, PROVIDERS, '选择 Provider')}</label>
    <label class="${cls('chipRow')}"><input type="checkbox" checked><span>启用</span></label>
    <label class="${c('rowField', 'w110')}"><span class="${cls('cellLabel')}">重试次数</span><input class="${cls('input')}" type="number" value="${retries}"></label>
    <label class="${c('rowField', 'w130')}"><span class="${cls('cellLabel')}">窗口(ms)</span><input class="${cls('input')}" type="number" value="${windowMs}"></label>
    <button class="${cls('iconBtn')}">✕</button>
  </div>`
}

// Exactly the providers a real profile shows on the Models page (configured
// only): the signed-in account, the official route, and the declared ones.
const PROVIDERS = ['deepseek-account', 'deepseek-official', 'deepinfra-flex', 'ruinique', 'ikun']
const MODELS = ['deepseek-ai/DeepSeek-V4.1-Flash-1017', 'DeepSeek-V4.1-Flash-1017', 'deepseek-flash', 'gpt-6-luna', 'gpt-6.1-sol']
const EFFORTS = ['low', 'medium', 'high']

const select = (value, options, placeholder) =>
  `<select class="${cls('input')}"><option value="">${placeholder}</option>${options
    .filter(option => option !== '')
    .map(option => `<option${option === value ? ' selected' : ''}>${option}</option>`)
    .join('')}</select>`

const kindRow = current => chips([
  chip('单一模型', current === 'route', 'radio'),
  chip('自由组合', current === 'combo', 'radio'),
])

function routeWindow(presetLabel, start, end, useLabel, useValue) {
  return `<div class="${cls('rowMid')}">
    <span class="${c('rowField', 'w180')}"><select class="${cls('input')}"><option>${presetLabel}</option><option>梁低谷</option><option>GLM 高峰</option><option>GLM 低谷</option><option>自定义时间段</option></select></span>
    <span class="${c('rowField', 'w90')}"><input class="${cls('input')}" value="${start}"></span>
    <span class="${cls('arrow')}">→</span>
    <span class="${c('rowField', 'w90')}"><input class="${cls('input')}" value="${end}"></span>
    <span class="${cls('days')}">${DAYS.map((d, i) => `<label class="${cls('day')}"><input type="checkbox"${i > 0 && i < 6 ? ' checked' : ''}><span>${d}</span></label>`).join('')}</span>
    <span class="${c('rowField', 'w180')}">${select(useValue, ['gpt-auto'], useLabel)}</span>
    <button class="${cls('iconBtn')}">✕</button>
  </div>`
}

function comboWindow(presetLabel, useValue, placeholder = '选择配置') {
  return `<div class="${cls('rowMid')}">
    <span class="${c('rowField', 'w180')}"><select class="${cls('input')}"><option>${presetLabel}</option><option>梁高峰</option><option>梁低谷</option><option>自定义时间段</option></select></span>
    <span class="${cls('hint')}">${presetLabel}（预设时间段）</span>
    <span class="${c('rowField', 'w180')}">${select(useValue, ['flex-flash', 'gpt-auto'], placeholder)}</span>
    <button class="${cls('iconBtn')}">✕</button>
  </div>`
}

function rulesGroup() {
  return `<div class="${cls('group')}">
    <span class="${cls('groupTitle')}">失效判定</span>
    <span class="${cls('hint')}">勾选的错误码触发兜底；正则匹配错误信息；结构判定捕捉「工具调用被截断」。</span>
    ${chips(CODES.map(code => chip(code, code !== 'UNKNOWN')))}
    <input class="${cls('input')}" placeholder="追加错误码，空格分隔">
    <textarea class="${cls('input')} ${cls('inputTextarea')}" rows="2" placeholder="正则，每行一条"></textarea>
    ${chip('结构判定（工具调用残片）', true)}
    <input class="${cls('input')}" value="DSML antml: function_calls tool_calls tool_use invoke parameter">
  </div>`
}

function modelCard(name, provider, model, exposed) {
  return `<div class="${cls('card')}">
    <div class="${cls('cardHead')}">
      <span class="${cls('cardTitle')}">${name} · ${provider}/${model}${exposed ? ' · 选择器可见' : ''}</span>
      <button class="${cls('iconBtn')}">✕</button>
    </div>
    ${kindRow('route')}
    <div class="${cls('grid')}">
      <label class="${cls('cell')}"><span class="${cls('cellLabel')}">名称</span><input class="${cls('input')}" value="${name}"></label>
      <label class="${cls('cell')}"><span class="${cls('cellLabel')}">Provider</span>${select(provider, PROVIDERS, '选择 Provider')}</label>
      <label class="${cls('cell')}"><span class="${cls('cellLabel')}">模型</span>${select(model, MODELS, '选择模型')}</label>
      <label class="${cls('cell')}"><span class="${cls('cellLabel')}">推理等级</span>${select('', EFFORTS, '跟随模型默认')}</label>
    </div>
    <div class="${cls('group')}">
      <span class="${cls('groupTitle')}">兜底配置</span>
      ${chips([
        chip('官方兜底', true, 'radio'),
        chip('循环兜底', false, 'radio'),
        chip('不兜底', false, 'radio'),
      ])}
      <div class="${cls('grid')}">
        <label class="${cls('cell')}"><span class="${cls('cellLabel')}">官方兜底 Provider</span>${select('deepseek-official', PROVIDERS, '选择 Provider')}</label>
        <label class="${cls('cell')}"><span class="${cls('cellLabel')}">官方兜底模型</span>${select('deepseek-flash', MODELS, '选择模型')}</label>
      </div>
      <span class="${cls('hint')}">失败后切到官方 DeepSeek 模型</span>
      <span class="${cls('groupTitle')}">追加兜底路由</span>
      <span class="${cls('hint')}">按顺序在主路由之后、官方兜底之前尝试。</span>
      ${extraRouteRow('ruinique', 'gpt-6.1-sol')}
      ${extraRouteRow('deepinfra-flex', 'DeepSeek-V4.1-Flash-1017')}
      <button class="${cls('addBtn')}">+ 追加兜底路由</button>
    </div>
    <div class="${cls('group')}">
      ${chip('在模型选择器里显示', exposed)}
    </div>
    <div class="${cls('group')}">
      <span class="${cls('groupTitle')}">时间区间</span>
      <span class="${cls('hint')}">留空表示全天可用；命中任一行时这个模型生效。</span>
      ${routeWindow('自定义时间段', '09:00', '12:00', '本模型', '')}
      ${comboWindow('梁低谷', '', '本模型')}
      <button class="${cls('addBtn')}">+ 时间区间</button>
    </div>
    ${rulesGroup()}
  </div>`
}

function comboCard(name) {
  return `<div class="${cls('card')}">
    <div class="${cls('cardHead')}">
      <span class="${cls('cardTitle')}">${name} · 自由组合（2 个区间） · 选择器可见</span>
      <button class="${cls('iconBtn')}">✕</button>
    </div>
    ${kindRow('combo')}
    <div class="${cls('grid')}">
      <label class="${cls('cell')}"><span class="${cls('cellLabel')}">名称</span><input class="${cls('input')}" value="${name}"></label>
    </div>
    <div class="${cls('group')}">
      ${chip('在模型选择器里显示', true)}
      <span class="${cls('hint')}">组合在模型选择器里显示为它各区间链按顺序拼接的固定降级链；实际分时仍按时间区间生效。</span>
    </div>
    <div class="${cls('group')}">
      <span class="${cls('groupTitle')}">时间区间</span>
      <span class="${cls('hint')}">留空表示全天可用；命中任一行时这个模型生效。</span>
      ${comboWindow('梁高峰', 'flex-flash')}
      ${comboWindow('梁低谷', 'gpt-auto')}
      <button class="${cls('addBtn')}">+ 时间区间</button>
    </div>
    ${rulesGroup()}
  </div>`
}

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>ModelsPanel preview</title>
<style>
  :root {
    --dsw-alias-bg-module-platform: #1f2023;
    --dsw-alias-bg-layer-3: #2a2b2f;
    --dsw-alias-label-primary: #e8e8ea;
    --dsw-alias-label-secondary: #a3a5ab;
    --dsw-alias-label-tertiary: #7c7e85;
    --dsw-alias-border-l2: #3a3c42;
    --dsw-alias-border-l3: #4a4d54;
    --dsw-alias-border-l4: #45474e;
    --dsw-alias-state-business-primary: #4d7cfe;
    --dsw-alias-state-error-primary: #e5484d;
    --dsw-radius-md: 8px;
  }
  body { margin: 0; padding: 16px; background: #131316; color: var(--dsw-alias-label-primary);
         font-family: system-ui, "Microsoft YaHei", sans-serif; }
  input, select, textarea, button { font-family: inherit; }
  ${cssText()}
</style></head>
<body>
<div class="${cls('panel')}">
  <h2 class="${cls('sectionHeading')}" id="models">
    <span class="${cls('sectionHeadingText')}">模型配置</span>
    <span class="${cls('sectionActions')}">
      <button class="${cls('discard')}">撤销</button>
      <button class="${cls('save')}">保存</button>
    </span>
  </h2>
  <span class="${cls('hint')}">每个「模型配置」是一个可路由的模型：它自己的时间区间、兜底方式与失效判定。「自由组合」不绑定模型，每个时间区间指定用哪个已有配置。</span>
  <div class="${cls('cards')}">
    ${modelCard('flex-flash', 'deepinfra-flex', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', true)}
    ${modelCard('gpt-auto', 'ruinique', 'gpt-6-luna', true)}
    ${comboCard('峰谷组合')}
  </div>
  <button class="${cls('addBtn')}">+ 新增模型配置</button>
  <div class="${cls('group')}">
    <span class="${cls('groupTitle')}">Provider 重试</span>
    <span class="${cls('hint')}">每个 provider 单独开启：窗口内失败次数未超过上限时先重试，超过后按上面的兜底配置切换。</span>
    ${retryRow('deepinfra-flex', 3, 300000)}
    ${retryRow('ruinique', 3, 300000)}
    <button class="${cls('addBtn')}">+ 新增 provider</button>
  </div>
</div>
</body></html>`

mkdirSync('.build', { recursive: true })
writeFileSync(OUT, html, 'utf8')

// Narrow-container check: the retry section on its own, same CSS.
const onlyRetry = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>retry preview</title>
<style>
  :root {
    --dsw-alias-bg-module-platform: #1f2023;
    --dsw-alias-bg-layer-3: #2a2b2f;
    --dsw-alias-label-primary: #e8e8ea;
    --dsw-alias-label-secondary: #a3a5ab;
    --dsw-alias-label-tertiary: #7c7e85;
    --dsw-alias-border-l2: #3a3c42;
    --dsw-alias-border-l3: #4a4d54;
    --dsw-alias-border-l4: #45474e;
    --dsw-alias-state-business-primary: #4d7cfe;
    --dsw-radius-md: 8px;
  }
  body { margin: 0; padding: 16px; background: #131316; color: var(--dsw-alias-label-primary);
         font-family: system-ui, "Microsoft YaHei", sans-serif; }
  input, select, textarea, button { font-family: inherit; }
  ${cssText()}
</style></head>
<body>
<div class="${cls('group')}">
  <span class="${cls('groupTitle')}">Provider 重试</span>
  <span class="${cls('hint')}">每个 provider 单独开启：窗口内失败次数未超过上限时先重试，超过后按上面的兜底配置切换。</span>
  ${retryRow('deepinfra-flex', 3, 300000)}
  ${retryRow('ruinique', 3, 300000)}
  <button class="${cls('addBtn')}">+ 新增 provider</button>
</div>
</body></html>`
writeFileSync('.build/preview-retry.html', onlyRetry, 'utf8')

console.log('wrote', OUT, html.length, 'bytes')
console.log('panel classes:', Object.keys(panel).length, 'card classes:', Object.keys(card).length)
