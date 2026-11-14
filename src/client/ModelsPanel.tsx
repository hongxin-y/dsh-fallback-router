/**
 * 模型配置 (model profiles) panel — the ONLY authoring surface of
 * dsh-fallback-router.
 *
 * Every row is a MODEL CONFIGURATION. Two shapes exist:
 *
 * - 单一模型 (`kind: 'route'`) — a `provider/model` route with its own time
 *   windows (时间区间, either a frozen preset like 梁高峰/梁低谷 or a
 *   hand-written window), its own fallback policy (官方兜底 / 循环兜底 /
 *   不兜底), the extra hops it may try (追加兜底路由) and its own failure
 *   rules (错误码 + 正则 + 结构判定).
 * - 自由组合 (`kind: 'combo'`) — no route of its own; every 时间区间 names an
 *   existing configuration (`使用配置`), so 梁高峰 can run config A while
 *   梁低谷 runs config B without duplicating either one's settings.
 *
 * Every provider/model field is a dropdown fed by the host catalog
 * (`llm/listConfigurableProviders` + `session/modelCatalog`); a value the
 * catalog does not know is kept as an extra option so a hand-written route is
 * never silently replaced, and an empty catalog degrades to a text input.
 *
 * The host compiles this list down to `rootChain` / `timeSlots` /
 * `namedChains` (`withCompiledRouter`), so the chain-walking engine keeps
 * working unchanged.
 *
 * The panel owns its own draft and its own Save: it writes ONLY `models` and
 * `providers`. Everything the legacy card used to expose (the global chain,
 * the time-slot table, the subagent roles, the advanced scalars) is
 * deliberately NOT editable here — it is either compiled from these rows or
 * left at whatever the config already carries.
 *
 * @module dsh-fallback-router/client/ModelsPanel
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { FallbacksConfig } from '../config.ts'
import {
  DEFAULT_MARKERS,
  DEFAULT_PROVIDER_RETRY,
  DEFAULT_RULES_CODES,
  normalizeModelProfiles,
  normalizeProviders,
  normalizeRoutes,
  type FallbackMode,
  type ModelProfile,
  type ModelProfileKind,
  type ProviderRetry,
} from '../models.ts'
import { PRESET_IDS, type PresetId } from '../time-slots.ts'
import css from './FallbacksCard.module.css'
import panel from './ModelsPanel.module.css'

/** One model the host can dispatch to, as a dropdown shows it. */
export interface ModelsCatalogModel {
  id: string
  name: string
  /** 推理等级 the model advertises (empty when it has none). */
  efforts?: { id: string; name: string }[]
  /** The level the model picks when the request names none. */
  defaultEffort?: string
}

/** One provider and its models, as the dropdowns show them. */
export interface ModelsCatalogProvider {
  id: string
  name: string
  models: ModelsCatalogModel[]
}

/** The dropdown source, as the card passes it in. */
export type ModelsCatalog = readonly ModelsCatalogProvider[]

/** Labels for the two configuration shapes. */
const KIND_LABELS: readonly { kind: ModelProfileKind; label: string; hint: string }[] = [
  { kind: 'route', label: '单一模型', hint: '配置一个 provider/模型，自己带时间区间、兜底与判定规则' },
  { kind: 'combo', label: '自由组合', hint: '不绑定模型：每个时间区间指定使用哪一个已有配置' },
]

/** Labels for the three fallback policies (兜底配置按钮). */
const MODE_LABELS: readonly { mode: FallbackMode; label: string; hint: string }[] = [
  { mode: 'official', label: '官方兜底', hint: '失败后切到官方 DeepSeek 模型' },
  { mode: 'loop', label: '循环兜底', hint: '按顺序切到下一个模型配置，最后一个失效后回到第一个' },
  { mode: 'none', label: '不兜底', hint: '失败就停下，只保留重试' },
]

/** Chinese labels of the four frozen preset windows (梁文峰 / 梁文谷 …). */
const PRESET_LABELS: Record<PresetId, string> = {
  'liang-peak': '梁文峰',
  'liang-valley': '梁文谷',
  'glm-peak': 'GLM峰',
  'glm-valley': 'GLM谷',
}

/** One preset option row of the window editor. */
const PRESET_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: '自定义时间段' },
  ...PRESET_IDS.map(id => ({ value: id, label: PRESET_LABELS[id] })),
]

/** The eight markers the structural detector ships with (可编辑). */
const MARKER_HINT = DEFAULT_MARKERS.join(' ')

const WEEKDAYS: readonly string[] = ['日', '一', '二', '三', '四', '五', '六']

/** One time window row of a model profile, as edited (strings for inputs). */
interface WindowRow {
  /** Frozen preset id, or '' for a hand-written window. */
  preset: string
  start: string
  end: string
  days: number[]
  /** 使用配置: another profile's id, or '' for this profile's own route. */
  use: string
}

/** One provider/model route, as edited (two inputs, never one text blob). */
interface RouteRow {
  provider: string
  model: string
  /** 推理等级 pinned for this hop ('' = 跟随系统). */
  reasoningEffort: string
}

/** One model profile, as edited (inputs hold strings). */
interface ModelRow {
  id: string
  name: string
  kind: ModelProfileKind
  provider: string
  model: string
  fallback: FallbackMode
  officialProvider: string
  officialModel: string
  windows: WindowRow[]
  extraRoutes: RouteRow[]
  expose: boolean
  /** 推理等级: the effort this route pins, or '' for the model default. */
  reasoningEffort: string
  codes: string[]
  customCode: string
  regex: string
  structural: boolean
  markers: string
}

function splitRoute(route: string): RouteRow {
  const text = route.trim()
  const at = text.indexOf('/')
  if (at < 0) return { provider: text, model: '', reasoningEffort: '' }
  return { provider: text.slice(0, at).trim(), model: text.slice(at + 1).trim(), reasoningEffort: '' }
}

function joinRoute(row: RouteRow): string {
  const provider = row.provider.trim()
  const model = row.model.trim()
  if (provider === '' || model === '') return ''
  return `${provider}/${model}`
}

function rowsOf(models: readonly ModelProfile[]): ModelRow[] {
  return models.map(model => ({
    id: model.id,
    name: model.name,
    kind: model.kind === 'combo' ? 'combo' : 'route',
    provider: model.provider,
    model: model.model,
    fallback: model.fallback,
    officialProvider: splitRoute(model.officialModel).provider,
    officialModel: splitRoute(model.officialModel).model,
    windows: model.windows.map(window => ({
      preset: window.preset ?? '',
      start: window.start,
      end: window.end,
      days: [...(window.days ?? [])],
      use: window.use ?? '',
    })),
    // The host may hand back either shape (a plain `provider/model` string from
    // an older config, or the `{ route, reasoningEffort }` row): normalize first
    // so a legacy row renders instead of crashing the whole panel.
    extraRoutes: normalizeRoutes(model.extraRoutes).map(hop => ({
      ...splitRoute(hop.route),
      reasoningEffort: hop.reasoningEffort,
    })),
    expose: model.expose === true,
    reasoningEffort: model.reasoningEffort ?? '',
    codes: [...model.rules.codes],
    customCode: '',
    regex: model.rules.regex.join('\n'),
    structural: model.rules.structural,
    markers: model.rules.markers.join(' '),
  }))
}

function splitLines(raw: string): string[] {
  return raw.split(/[\n,]+/).map(line => line.trim()).filter(line => line !== '')
}

function profilesOf(rows: readonly ModelRow[]): ModelProfile[] {
  const draft = rows.map((row, index) => {
    const combo = row.kind === 'combo'
    return {
      id: row.id.trim() === '' ? `model-${index + 1}` : row.id.trim(),
      name: row.name.trim() === ''
        ? (combo ? `组合 ${index + 1}` : row.model.trim() === '' ? `模型 ${index + 1}` : row.model.trim())
        : row.name.trim(),
      kind: row.kind,
      // A combo owns no route; normalizing it with halves would otherwise drop
      // the row entirely (an empty route is invalid for a single model).
      provider: combo ? '' : row.provider.trim(),
      model: combo ? '' : row.model.trim(),
      windows: row.windows.map(window => {
        const use = combo || window.use !== '' ? { use: window.use } : {}
        return window.preset === ''
          ? { start: window.start, end: window.end, days: [...window.days], ...use }
          : { preset: window.preset, start: '', end: '', days: [], ...use }
      }),
      fallback: row.fallback,
      officialModel: joinRoute({ provider: row.officialProvider, model: row.officialModel, reasoningEffort: '' }),
      extraRoutes: row.extraRoutes
        .map(hop => ({ route: joinRoute(hop), reasoningEffort: hop.reasoningEffort.trim() }))
        .filter(hop => hop.route !== ''),
      expose: row.expose,
      reasoningEffort: combo ? '' : row.reasoningEffort.trim(),
      rules: {
        codes: [...row.codes, ...splitLines(row.customCode)],
        regex: row.regex.split('\n').map(line => line.trim()).filter(line => line !== ''),
        structural: row.structural,
        markers: row.markers.split(/[\s,]+/).map(marker => marker.trim()).filter(marker => marker !== ''),
      },
    }
  })
  return normalizeModelProfiles(draft)
}

function retryRowsOf(providers: readonly ProviderRetry[]): ProviderRetry[] {
  return normalizeProviders(providers)
}

function newModelRow(rows: readonly ModelRow[]): ModelRow {
  const used = new Set(rows.map(row => row.id.trim()))
  let serial = 1
  while (used.has(`model-${serial}`)) serial += 1
  return {
    id: `model-${serial}`,
    name: '',
    kind: 'route',
    provider: '',
    model: '',
    fallback: 'official',
    officialProvider: 'deepseek-official',
    officialModel: 'deepseek-flash',
    windows: [],
    extraRoutes: [],
    expose: false,
    reasoningEffort: '',
    codes: [...DEFAULT_RULES_CODES],
    customCode: '',
    regex: '',
    structural: true,
    markers: DEFAULT_MARKERS.join(' '),
  }
}

function newRetryRow(provider: string): ProviderRetry {
  return { provider, ...DEFAULT_PROVIDER_RETRY }
}

function toggleCode(codes: readonly string[], code: string): string[] {
  return codes.includes(code) ? codes.filter(entry => entry !== code) : [...codes, code]
}

function toggleDay(days: readonly number[], day: number): number[] {
  return days.includes(day) ? days.filter(entry => entry !== day) : [...days, day].sort((a, b) => a - b)
}

/** Props: the live config, the catalog behind the dropdowns, and the write path. */
export interface ModelsPanelProps {
  config: FallbacksConfig
  writable: boolean
  saving: boolean
  onSave: (next: FallbacksConfig) => void
  /** Provider/model catalog for the dropdowns; omit to fall back to text inputs. */
  catalog?: ModelsCatalog
}

/** Provider ids the dropdown offers (catalog only; the current value is added by the picker). */
function providerChoices(catalog: ModelsCatalog | undefined): string[] {
  const out = new Set<string>()
  for (const provider of catalog ?? []) out.add(provider.id)
  return [...out].sort((left, right) => left.localeCompare(right))
}

/** Model ids one provider advertises (catalog only; the picker adds the current value). */
function modelChoices(catalog: ModelsCatalog | undefined, provider: string): string[] {
  const out = new Set<string>()
  const entry = (catalog ?? []).find(candidate => candidate.id === provider.trim())
  for (const model of entry?.models ?? []) out.add(model.id)
  return [...out].sort((left, right) => left.localeCompare(right))
}

/**
 * 推理等级 ids the chosen model advertises (catalog only; the picker adds the
 * current value). An unknown provider/model simply has no levels, and the field
 * degrades to free text so a hand-written effort is never lost.
 */
function effortChoices(catalog: ModelsCatalog | undefined, provider: string, model: string): string[] {
  const entry = (catalog ?? []).find(candidate => candidate.id === provider.trim())
  const target = (entry?.models ?? []).find(candidate => candidate.id === model.trim())
  return (target?.efforts ?? []).map(effort => effort.id)
}

/** One dropdown-or-input field. */
interface PickerProps {
  ariaLabel: string
  value: string
  options: readonly string[]
  placeholder: string
  disabled: boolean
  onChange: (next: string) => void
}

/**
 * A catalog-backed field: the catalog drives the options, a value the catalog
 * does not know stays selectable (a hand-written route is never silently
 * replaced), and an empty catalog degrades to free text so a host without a
 * catalog is still editable.
 */
function Picker({ ariaLabel, value, options, placeholder, disabled, onChange }: PickerProps): ReactNode {
  if (options.length === 0) {
    return (
      <input
        className={css.input}
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        disabled={disabled}
        onChange={event => { onChange(event.target.value) }}
      />
    )
  }
  // The current value may predate the catalog (hand-written route, provider that
  // stopped advertising a model): keep it selectable instead of silently
  // snapping the field to the first catalog entry.
  const merged = value !== '' && !options.includes(value) ? [value, ...options] : options
  return (
    <select
      className={css.input}
      value={value}
      aria-label={ariaLabel}
      disabled={disabled}
      onChange={event => { onChange(event.target.value) }}
    >
      <option value="">{placeholder}</option>
      {merged.map(option => (
        <option key={option} value={option}>{option}</option>
      ))}
    </select>
  )
}

export function ModelsPanel({ config, writable, saving, onSave, catalog }: ModelsPanelProps): ReactNode {
  const [rows, setRows] = useState<ModelRow[]>(() => rowsOf(config.models ?? []))
  const [providers, setProviders] = useState<ProviderRetry[]>(() => retryRowsOf(config.providers ?? []))
  const [seeded, setSeeded] = useState<string>(() => JSON.stringify([config.models, config.providers]))

  // Re-seed when the SERVER truth changes (a landed save, a settings push from
  // another window). Local edits are identified by the same JSON key, so a
  // re-render of identical content never clobbers a staged draft.
  const serverKey = JSON.stringify([config.models, config.providers])
  useEffect(() => {
    if (serverKey === seeded) return
    setRows(rowsOf(config.models ?? []))
    setProviders(retryRowsOf(config.providers ?? []))
    setSeeded(serverKey)
  }, [serverKey, seeded, config.models, config.providers])

  const draft = useMemo(() => profilesOf(rows), [rows])
  // Compare NORMALIZED forms on both sides: the wire may omit defaults the
  // draft always carries (`kind`, a window's `use`), which would otherwise
  // read as a permanent edit.
  const savedModels = useMemo(() => normalizeModelProfiles(config.models ?? []), [config.models])
  const savedProviders = useMemo(() => retryRowsOf(config.providers ?? []), [config.providers])
  const dirty = JSON.stringify(draft) !== JSON.stringify(savedModels)
    || JSON.stringify(providers) !== JSON.stringify(savedProviders)

  const update = (index: number, patch: Partial<ModelRow>): void => {
    setRows(current => current.map((row, at) => (at === index ? { ...row, ...patch } : row)))
  }

  /**
   * The configurations one window may point at (使用配置): every OTHER
   * single-model row. A combo can only relay to a real route, so combos are
   * never offered — that also rules out a reference cycle by construction.
   */
  const useChoicesFor = (selfIndex: number): readonly { id: string; label: string }[] =>
    rows
      .map((row, at) => ({ row, at }))
      .filter(({ row, at }) => at !== selfIndex && row.kind === 'route' && row.id.trim() !== '')
      .map(({ row }) => ({ id: row.id.trim(), label: row.name.trim() === '' ? row.id.trim() : row.name.trim() }))

  const save = (): void => {
    onSave({ ...config, models: draft, providers })
    setSeeded(JSON.stringify([draft, providers]))
  }

  return (
    <div className={panel.panel}>
      <h2 className={css.sectionHeading} id="models" aria-label="模型配置">
        <span className={css.sectionHeadingText}>模型配置</span>
        <span className={css.sectionActions}>
          <button
            type="button"
            className={css.discard}
            disabled={!dirty || saving}
            onClick={() => {
              setRows(rowsOf(config.models ?? []))
              setProviders(retryRowsOf(config.providers ?? []))
              setSeeded(serverKey)
            }}
          >
            撤销
          </button>
          <button type="button" className={css.save} disabled={!writable || saving || !dirty} onClick={save}>
            {saving ? '保存中…' : '保存'}
          </button>
        </span>
      </h2>
      <span className={css.hint}>
        每个「模型配置」是一个可路由的模型：它自己的时间区间、兜底方式与失效判定。按顺序构成降级链。
      </span>

      <div className={panel.cards}>
        {rows.map((row, index) => (
          <div key={index} className={panel.card}>
            <div className={panel.cardHead}>
              <span className={panel.cardTitle}>
                {row.name.trim() === '' ? (row.kind === 'combo' ? `组合 ${index + 1}` : `模型 ${index + 1}`) : row.name}
                {row.kind === 'combo'
                  ? ` · 自由组合（${row.windows.filter(window => window.use !== '').length} 个区间）`
                  : row.provider.trim() === '' || row.model.trim() === ''
                    ? '（未填写路由）'
                    : ` · ${row.provider}/${row.model}`}
                {row.expose ? ' · 选择器可见' : ''}
              </span>
              <button
                type="button"
                className={panel.iconBtn}
                aria-label="删除这个模型配置"
                disabled={!writable}
                onClick={() => { setRows(current => current.filter((_, at) => at !== index)) }}
              >
                ✕
              </button>
            </div>

            {/* 配置类型 — 单一模型 or 自由组合 (每个时间区间用另一个配置). */}
            <div className={panel.chips} role="group" aria-label="配置类型">
              {KIND_LABELS.map(entry => (
                <label key={entry.kind} className={panel.chip} title={entry.hint}>
                  <input
                    type="radio"
                    className={css.checkbox}
                    name={`model-kind-${String(index)}`}
                    checked={row.kind === entry.kind}
                    disabled={!writable}
                    onChange={() => { update(index, { kind: entry.kind }) }}
                  />
                  <span>{entry.label}</span>
                </label>
              ))}
            </div>

            {row.kind === 'route' ? (
              <div className={panel.grid}>
                <label className={panel.cell}>
                  <span className={panel.cellLabel}>名称</span>
                  <input
                    className={css.input}
                    value={row.name}
                    placeholder={`模型 ${index + 1}`}
                    onChange={event => { update(index, { name: event.target.value }) }}
                  />
                </label>
                <label className={panel.cell}>
                  <span className={panel.cellLabel}>Provider</span>
                  <Picker
                    ariaLabel="Provider"
                    value={row.provider}
                    options={providerChoices(catalog)}
                    placeholder="选择 Provider"
                    disabled={!writable}
                    onChange={next => { update(index, { provider: next, reasoningEffort: '' }) }}
                  />
                </label>
                <label className={panel.cell}>
                  <span className={panel.cellLabel}>模型</span>
                  <Picker
                    ariaLabel="模型"
                    value={row.model}
                    options={modelChoices(catalog, row.provider)}
                    placeholder="选择模型"
                    disabled={!writable}
                    onChange={next => {
                      // Effort ids are model-specific: a stale one would be
                      // rejected by the host, so changing the route clears it.
                      update(index, { model: next, reasoningEffort: '' })
                    }}
                  />
                </label>
                <label className={panel.cell}>
                  <span className={panel.cellLabel}>推理等级</span>
                  <Picker
                    ariaLabel="推理等级"
                    value={row.reasoningEffort}
                    options={effortChoices(catalog, row.provider, row.model)}
                    placeholder="跟随模型默认"
                    disabled={!writable}
                    onChange={next => { update(index, { reasoningEffort: next }) }}
                  />
                </label>
              </div>
            ) : (
              <div className={panel.grid}>
                <label className={panel.cell}>
                  <span className={panel.cellLabel}>名称</span>
                  <input
                    className={css.input}
                    value={row.name}
                    placeholder={`组合 ${index + 1}`}
                    onChange={event => { update(index, { name: event.target.value }) }}
                  />
                </label>
              </div>
            )}

            {/* 兜底配置按钮 — one per single-model configuration. */}
            {row.kind === 'route' && (
            <div className={panel.group} role="group" aria-label="兜底配置">
              <span className={panel.groupTitle}>兜底配置</span>
              <div className={panel.chips}>
                {MODE_LABELS.map(entry => (
                  <label key={entry.mode} className={panel.chip} title={entry.hint}>
                    <input
                      type="radio"
                      className={css.checkbox}
                      name={`fallback-mode-${String(index)}`}
                      checked={row.fallback === entry.mode}
                      disabled={!writable}
                      onChange={() => { update(index, { fallback: entry.mode }) }}
                    />
                    <span>{entry.label}</span>
                  </label>
                ))}
              </div>
              {row.fallback === 'official' && (
                <div className={panel.grid}>
                  <label className={panel.cell}>
                    <span className={panel.cellLabel}>官方兜底 Provider</span>
                    <Picker
                      ariaLabel="官方兜底 Provider"
                      value={row.officialProvider}
                      options={providerChoices(catalog)}
                      placeholder="deepseek-official"
                      disabled={!writable}
                      onChange={next => { update(index, { officialProvider: next }) }}
                    />
                  </label>
                  <label className={panel.cell}>
                    <span className={panel.cellLabel}>官方兜底模型</span>
                    <Picker
                      ariaLabel="官方兜底模型"
                      value={row.officialModel}
                      options={modelChoices(catalog, row.officialProvider)}
                      placeholder="deepseek-flash"
                      disabled={!writable}
                      onChange={next => { update(index, { officialModel: next }) }}
                    />
                  </label>
                </div>
              )}
              <span className={css.hint}>
                {MODE_LABELS.find(entry => entry.mode === row.fallback)?.hint ?? ''}
              </span>
              <span className={panel.groupTitle}>追加兜底路由</span>
              <span className={css.hint}>按顺序在主路由之后、官方兜底之前尝试。</span>
              {row.extraRoutes.map((route, at) => (
                <div key={at} className={panel.row}>
                  <label className={`${panel.rowField} ${panel.grow}`}>
                    <span className={panel.cellLabel}>Provider</span>
                    <Picker
                      ariaLabel="追加路由 Provider"
                      value={route.provider}
                      options={providerChoices(catalog)}
                      placeholder="选择 Provider"
                      disabled={!writable}
                      onChange={next => {
                        // The effort id belongs to the model, so a new route
                        // drops the old one instead of pinning a stale level.
                        const extraRoutes = row.extraRoutes.map((item, position) =>
                          position === at ? { ...item, provider: next, model: '', reasoningEffort: '' } : item)
                        update(index, { extraRoutes })
                      }}
                    />
                  </label>
                  <label className={`${panel.rowField} ${panel.grow}`}>
                    <span className={panel.cellLabel}>模型</span>
                    <Picker
                      ariaLabel="追加路由模型"
                      value={route.model}
                      options={modelChoices(catalog, route.provider)}
                      placeholder="选择模型"
                      disabled={!writable}
                      onChange={next => {
                        const extraRoutes = row.extraRoutes.map((item, position) =>
                          position === at ? { ...item, model: next, reasoningEffort: '' } : item)
                        update(index, { extraRoutes })
                      }}
                    />
                  </label>
                  <label className={`${panel.rowField} ${panel.grow}`}>
                    <span className={panel.cellLabel}>推理等级</span>
                    <Picker
                      ariaLabel="追加路由推理等级"
                      value={route.reasoningEffort}
                      options={effortChoices(catalog, route.provider, route.model)}
                      placeholder="跟随系统"
                      disabled={!writable}
                      onChange={next => {
                        const extraRoutes = row.extraRoutes.map((item, position) =>
                          position === at ? { ...item, reasoningEffort: next } : item)
                        update(index, { extraRoutes })
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className={panel.iconBtn}
                    aria-label="删除这条追加路由"
                    disabled={!writable}
                    onClick={() => {
                      update(index, { extraRoutes: row.extraRoutes.filter((_, position) => position !== at) })
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={panel.addBtn}
                disabled={!writable}
                onClick={() => {
                  update(index, {
                    extraRoutes: [...row.extraRoutes, { provider: '', model: '', reasoningEffort: '' }],
                  })
                }}
              >
                + 追加兜底路由
              </button>
            </div>
            )}

            {/* 选择器可见 — a combo can be pinned into the picker too. */}
            <div className={panel.group} role="group" aria-label="选择器可见">
              <label className={panel.chip} title="勾选后这个模型配置会出现在模型选择器里（FallbacksChain 下）">
                <input
                  type="checkbox"
                  className={css.checkbox}
                  checked={row.expose}
                  disabled={!writable}
                  onChange={() => { update(index, { expose: !row.expose }) }}
                />
                <span>在模型选择器里显示</span>
              </label>
              {row.kind === 'combo' && (
                <span className={css.hint}>
                  组合在模型选择器里显示为它各区间链按顺序拼接的固定降级链；实际分时仍按时间区间生效。
                </span>
              )}
            </div>

            {/* 时间区间 — belongs to THIS model configuration. */}
            <div className={panel.group} role="group" aria-label="时间区间">
              <span className={panel.groupTitle}>时间区间</span>
              <span className={css.hint}>留空表示全天可用；命中任一行时这个模型生效。</span>
              {row.kind === 'combo' && useChoicesFor(index).length === 0 && (
                <span className={css.hint}>
                  先创建至少一个「单一模型」配置，组合才有可选的配置。
                </span>
              )}
              {row.windows.map((window, at) => (
                <div key={at} className={panel.rowMid}>
                  <span className={`${panel.rowField} ${panel.w180}`}>
                    <select
                      className={css.input}
                      value={window.preset}
                      aria-label="时间段预设"
                      disabled={!writable}
                      onChange={event => {
                        const preset = event.target.value
                        const windows = row.windows.map((item, position) =>
                          position === at ? { ...item, preset } : item)
                        update(index, { windows })
                      }}
                    >
                      {PRESET_OPTIONS.map(option => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </select>
                  </span>
                  {window.preset === '' ? (
                    <>
                      <span className={`${panel.rowField} ${panel.w90}`}>
                        <input
                          className={css.input}
                          value={window.start}
                          placeholder="09:00"
                          aria-label="开始时间"
                          onChange={event => {
                            const windows = row.windows.map((item, position) =>
                              position === at ? { ...item, start: event.target.value } : item)
                            update(index, { windows })
                          }}
                        />
                      </span>
                      <span className={panel.arrow}>→</span>
                      <span className={`${panel.rowField} ${panel.w90}`}>
                        <input
                          className={css.input}
                          value={window.end}
                          placeholder="12:00"
                          aria-label="结束时间"
                          onChange={event => {
                            const windows = row.windows.map((item, position) =>
                              position === at ? { ...item, end: event.target.value } : item)
                            update(index, { windows })
                          }}
                        />
                      </span>
                      <span className={panel.days}>
                        {WEEKDAYS.map((label, day) => (
                          <label key={day} className={panel.day}>
                            <input
                              type="checkbox"
                              className={css.checkbox}
                              checked={window.days.includes(day)}
                              disabled={!writable}
                              onChange={() => {
                                const windows = row.windows.map((item, position) =>
                                  position === at ? { ...item, days: toggleDay(item.days, day) } : item)
                                update(index, { windows })
                              }}
                            />
                            <span>{label}</span>
                          </label>
                        ))}
                      </span>
                    </>
                  ) : (
                    <span className={css.hint}>
                      {PRESET_LABELS[window.preset as PresetId] ?? window.preset}（预设时间段）
                    </span>
                  )}
                  {/* 使用配置 — which existing configuration serves this window. */}
                  <span className={`${panel.rowField} ${panel.w180}`}>
                    <select
                      className={css.input}
                      value={window.use}
                      aria-label="使用配置"
                      disabled={!writable}
                      onChange={event => {
                        const use = event.target.value
                        const windows = row.windows.map((item, position) =>
                          position === at ? { ...item, use } : item)
                        update(index, { windows })
                      }}
                    >
                      <option value="">{row.kind === 'route' ? '本模型' : '选择配置'}</option>
                      {useChoicesFor(index).map(choice => (
                        <option key={choice.id} value={choice.id}>{choice.label}</option>
                      ))}
                    </select>
                  </span>
                  <button
                    type="button"
                    className={panel.iconBtn}
                    aria-label="删除这个时间区间"
                    disabled={!writable}
                    onClick={() => { update(index, { windows: row.windows.filter((_, position) => position !== at) }) }}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                type="button"
                className={panel.addBtn}
                disabled={!writable}
                onClick={() => {
                  update(index, {
                    windows: [...row.windows, { preset: '', start: '09:00', end: '12:00', days: [], use: '' }],
                  })
                }}
              >
                + 时间区间
              </button>
            </div>

            {/* 失效判定 — codes (defaults on) + regex + structural residue. */}
            <div className={panel.group} role="group" aria-label="失效判定">
              <span className={panel.groupTitle}>失效判定</span>
              <span className={css.hint}>勾选的错误码触发兜底；正则匹配错误信息；结构判定捕捉「工具调用被截断」。</span>
              <div className={panel.chips}>
                {DEFAULT_RULES_CODES.map(code => (
                  <label key={code} className={panel.chip}>
                    <input
                      type="checkbox"
                      className={css.checkbox}
                      checked={row.codes.includes(code)}
                      disabled={!writable}
                      onChange={() => { update(index, { codes: toggleCode(row.codes, code) }) }}
                    />
                    <span>{code}</span>
                  </label>
                ))}
              </div>
              <input
                className={css.input}
                value={row.customCode}
                placeholder="追加错误码，空格分隔"
                aria-label="追加错误码"
                onChange={event => { update(index, { customCode: event.target.value }) }}
              />
              <textarea
                className={`${css.input} ${css.inputTextarea}`}
                value={row.regex}
                placeholder={'正则，每行一条，例如：\\b50\\d\\b|upstream rejected'}
                aria-label="正则规则"
                rows={2}
                onChange={event => { update(index, { regex: event.target.value }) }}
              />
              <label className={panel.chip}>
                <input
                  type="checkbox"
                  className={css.checkbox}
                  checked={row.structural}
                  disabled={!writable}
                  onChange={() => { update(index, { structural: !row.structural }) }}
                />
                <span>结构判定（工具调用残片）</span>
              </label>
              {row.structural && (
                <input
                  className={css.input}
                  value={row.markers}
                  placeholder={MARKER_HINT}
                  aria-label="结构判定标记"
                  onChange={event => { update(index, { markers: event.target.value }) }}
                />
              )}
            </div>
          </div>
        ))}
      </div>

      <button
        type="button"
        className={panel.addBtn}
        disabled={!writable}
        onClick={() => { setRows(current => [...current, newModelRow(current)]) }}
      >
        + 新增模型配置
      </button>

      {/* Per-provider retry (对每个 provider 单独开启重试). */}
      <div className={panel.group} role="group" aria-label="Provider 重试">
        <span className={panel.groupTitle}>Provider 重试</span>
        <span className={css.hint}>
          每个 provider 单独开启：窗口内失败次数未超过上限时先重试，超过后按上面的兜底配置切换。
        </span>
        {providers.map((row, index) => (
          <div key={index} className={panel.row}>
            <label className={`${panel.rowField} ${panel.grow}`}>
              <span className={panel.cellLabel}>Provider</span>
              <Picker
                ariaLabel="Provider"
                value={row.provider}
                options={providerChoices(catalog)}
                placeholder="选择 Provider"
                disabled={!writable}
                onChange={next => {
                  setProviders(current => current.map((item, at) =>
                    at === index ? { ...item, provider: next } : item))
                }}
              />
            </label>
            <label className={panel.chipRow}>
              <input
                type="checkbox"
                className={css.checkbox}
                checked={row.enabled}
                disabled={!writable}
                onChange={() => {
                  setProviders(current => current.map((item, at) =>
                    at === index ? { ...item, enabled: !item.enabled } : item))
                }}
              />
              <span>启用</span>
            </label>
            <label className={`${panel.rowField} ${panel.w110}`}>
              <span className={panel.cellLabel}>重试次数</span>
              <input
                className={css.input}
                type="number"
                min={0}
                max={100}
                value={row.maxRetries}
                onChange={event => {
                  const value = Number(event.target.value)
                  setProviders(current => current.map((item, at) =>
                    at === index ? { ...item, maxRetries: Number.isFinite(value) ? value : item.maxRetries } : item))
                }}
              />
            </label>
            <label className={`${panel.rowField} ${panel.w130}`}>
              <span className={panel.cellLabel}>窗口(ms)</span>
              <input
                className={css.input}
                type="number"
                min={1000}
                step={1000}
                value={row.windowMs}
                onChange={event => {
                  const value = Number(event.target.value)
                  setProviders(current => current.map((item, at) =>
                    at === index ? { ...item, windowMs: Number.isFinite(value) ? value : item.windowMs } : item))
                }}
              />
            </label>
            <button
              type="button"
              className={panel.iconBtn}
              aria-label="删除这个 provider 重试配置"
              disabled={!writable}
              onClick={() => { setProviders(current => current.filter((_, at) => at !== index)) }}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          type="button"
          className={panel.addBtn}
          disabled={!writable}
          onClick={() => { setProviders(current => [...current, newRetryRow('')]) }}
        >
          + 新增 provider
        </button>
      </div>
    </div>
  )
}
