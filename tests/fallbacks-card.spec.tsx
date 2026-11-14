// @vitest-environment jsdom
/**
 * The llm-router plugin card, post-merge shape.
 *
 * The card is a thin shell around the 模型配置 panel: the legacy fallbacks
 * surface (默认降级链 / 分时槽 / 子代理角色 / 高级选项) is deliberately gone, and
 * these specs pin exactly that — the panel is the ONLY authoring surface, and
 * a save writes `models` + `providers` through the settings gateway.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { bindSnapshotSelector } from '../src/client/use-snapshot.ts'
import { FallbacksCard } from '../src/client/FallbacksCard.tsx'
import type { FallbacksCardProps } from '../src/client/FallbacksCard.tsx'
import { ModelsPanel } from '../src/client/ModelsPanel.tsx'
import type { ModelsCatalog } from '../src/client/ModelsPanel.tsx'
import { FallbacksSettingsController } from '../src/client/fallbacks-store.ts'
import type { FallbacksRemote, FallbacksSettingsState } from '../src/client/fallbacks-store.ts'
import type { ClientConnectionRpc } from '@deepseek-ai/dsh-client-connection/client'
import { defaultFallbacksConfig } from '../src/config.ts'
import type { FallbacksConfig } from '../src/config.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: FallbacksCardProps['t'] = key => en[key as keyof typeof en]

function okResult<T>(value: T): { ok: true; value: T } {
  return { ok: true, value }
}

/** One gateway call recorded by the scripted channel. */
interface RecordedCall {
  method: string
  payload: unknown
}

/** The scripted settings wire: one config, one writable flag, recorded calls. */
interface Scripted {
  api: FallbacksRemote
  rpc: ClientConnectionRpc
  calls: RecordedCall[]
  current: FallbacksConfig
}

function scriptedWire(config: FallbacksConfig, writable = true): Scripted {
  const calls: RecordedCall[] = []
  const wire: Scripted = {
    current: config,
    calls,
    api: {
      settings: {
        describe: async () => okResult({ writable, namespaces: [] }),
      },
    } as unknown as FallbacksRemote,
    rpc: {
      call: async (_ns: string, method: string, payload: unknown) => {
        calls.push({ method, payload })
        if (method === 'fallbacks/set') {
          const patch = (payload as { args?: { patch?: FallbacksConfig } }).args?.patch
          if (patch !== undefined) wire.current = patch
        }
        return okResult({ config: wire.current, present: true, legacyKeys: [], seeds: [] })
      },
    } as unknown as ClientConnectionRpc,
  }
  return wire
}

function cardProps(
  controller: FallbacksSettingsController,
  useSnapshot: ReturnType<typeof bindSnapshotSelector<FallbacksSettingsState>>,
): FallbacksCardProps {
  return {
    controller,
    useSnapshot,
    t,
    view: 'page',
    useSessions: undefined as never,
    useWorkspaces: undefined as never,
  }
}

async function mountCard(config: FallbacksConfig, writable = true): Promise<{
  controller: FallbacksSettingsController
  wire: Scripted
  container: HTMLElement
}> {
  const wire = scriptedWire(config, writable)
  const controller = new FallbacksSettingsController(wire.api, wire.rpc)
  await controller.load()
  const view = render(<FallbacksCard {...cardProps(controller, bindSnapshotSelector(controller.store))} />)
  return { controller, wire, container: view.container }
}

const BASE: FallbacksConfig = { ...defaultFallbacksConfig }

const WITH_MODELS: FallbacksConfig = {
  ...defaultFallbacksConfig,
  models: [
    {
      id: 'flex-flash',
      name: 'Flex Flash',
      provider: 'deepinfra-flex',
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      windows: [],
      fallback: 'official',
      officialModel: 'deepseek-official/deepseek-flash',
      extraRoutes: [],
      expose: false,
      rules: { codes: ['AUTH'], regex: [], structural: true, markers: ['DSML'] },
    },
  ],
  providers: [
    {
      provider: 'deepinfra-flex',
      enabled: true,
      maxRetries: 3,
      windowMs: 300_000,
      initialDelayMs: 800,
      maxDelayMs: 15_000,
      jitterRatio: 0.1,
    },
  ],
}

describe('llm-router card scope', () => {
  it('renders the model panel and nothing else', async () => {
    await mountCard(BASE)
    expect(screen.getByRole('heading', { name: '模型配置' })).toBeTruthy()
    // The legacy sections are gone from the card entirely.
    expect(screen.queryByRole('heading', { name: '主代理' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '子代理角色' })).toBeNull()
    expect(screen.queryByRole('heading', { name: '高级选项' })).toBeNull()
    expect(screen.queryByText('默认降级链')).toBeNull()
    expect(screen.queryByText('分时槽设置')).toBeNull()
  })

  it('renders one editor card per configured model', async () => {
    await mountCard(WITH_MODELS)
    expect(screen.getByText('Flex Flash · deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017')).toBeTruthy()
    expect(screen.getAllByLabelText('删除这个模型配置')).toHaveLength(1)
  })

  it('does not surface provider credentials', async () => {
    await mountCard(WITH_MODELS)
    expect(screen.queryByLabelText(/api.?key/i)).toBeNull()
    expect(screen.queryByText(/api.?key/i)).toBeNull()
  })
})

describe('llm-router card saves', () => {
  it('writes a newly added model configuration through fallbacks/set', async () => {
    const { wire } = await mountCard(BASE)
    fireEvent.click(screen.getByRole('button', { name: '+ 新增模型配置' }))
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'deepinfra-flex' } })
    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(wire.calls.some(call => call.method === 'fallbacks/set')).toBe(true)
    })
    const patch = wire.current
    expect(patch.models).toHaveLength(1)
    expect(patch.models?.[0]?.provider).toBe('deepinfra-flex')
    expect(patch.models?.[0]?.model).toBe('deepseek-ai/DeepSeek-V4.1-Flash-1017')
  })

  it('saves a preset window as a preset row, not as clock fields', async () => {
    const { wire } = await mountCard(WITH_MODELS)
    fireEvent.click(screen.getByRole('button', { name: '+ 时间区间' }))
    fireEvent.change(screen.getByLabelText('时间段预设'), { target: { value: 'liang-peak' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(wire.calls.some(call => call.method === 'fallbacks/set')).toBe(true)
    })
    expect(wire.current.models?.[0]?.windows).toEqual([
      { preset: 'liang-peak', start: '', end: '', days: [] },
    ])
  })

  it('edits the official fallback as provider + model, not as one string', async () => {
    const { wire } = await mountCard(WITH_MODELS)
    fireEvent.change(screen.getByLabelText('官方兜底 Provider'), {
      target: { value: 'deepseek-official' },
    })
    fireEvent.change(screen.getByLabelText('官方兜底模型'), { target: { value: 'deepseek-pro' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(wire.calls.some(call => call.method === 'fallbacks/set')).toBe(true)
    })
    expect(wire.current.models?.[0]?.officialModel).toBe('deepseek-official/deepseek-pro')
  })

  it('saves the picker exposure flag and the extra routes', async () => {
    const { wire } = await mountCard(WITH_MODELS)
    fireEvent.click(screen.getByLabelText('在模型选择器里显示'))
    fireEvent.click(screen.getByRole('button', { name: '+ 追加兜底路由' }))
    fireEvent.click(screen.getByRole('button', { name: '+ 追加兜底路由' }))
    const providers = screen.getAllByLabelText('追加路由 Provider')
    const models = screen.getAllByLabelText('追加路由模型')
    fireEvent.change(providers[0]!, { target: { value: 'ruinique' } })
    fireEvent.change(models[0]!, { target: { value: 'gpt-6.1-sol' } })
    fireEvent.change(providers[1]!, { target: { value: 'deepinfra-flex' } })
    fireEvent.change(models[1]!, { target: { value: 'DeepSeek-V4.1-Flash-1017' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(wire.calls.some(call => call.method === 'fallbacks/set')).toBe(true)
    })
    expect(wire.current.models?.[0]?.expose).toBe(true)
    expect(wire.current.models?.[0]?.extraRoutes).toEqual([
      { route: 'ruinique/gpt-6.1-sol', reasoningEffort: '' },
      { route: 'deepinfra-flex/DeepSeek-V4.1-Flash-1017', reasoningEffort: '' },
    ])
  })

  it('keeps every legacy field the panel does not own', async () => {
    const { wire } = await mountCard(WITH_MODELS)
    fireEvent.change(screen.getByLabelText('模型'), {
      target: { value: 'deepseek-ai/DeepSeek-V4.1-Flash-1018' },
    })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(wire.calls.some(call => call.method === 'fallbacks/set')).toBe(true)
    })
    expect(wire.current.cooldownMs).toBe(defaultFallbacksConfig.cooldownMs)
    expect(wire.current.roles.list).toEqual(defaultFallbacksConfig.roles.list)
    expect(wire.current.triggerCodes).toEqual(defaultFallbacksConfig.triggerCodes)
  })

  it('disables the write path when the host is read-only', async () => {
    const { wire } = await mountCard(WITH_MODELS, false)
    const save = screen.getByRole('button', { name: '保存' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect((screen.getByLabelText('在模型选择器里显示') as HTMLInputElement).disabled).toBe(true)
    expect(wire.calls.some(call => call.method === 'fallbacks/set')).toBe(false)
  })
})

const ROUTE_ROW = WITH_MODELS.models![0]!

/** A 自由组合 row: no route of its own, one window pointing at `flex-flash`. */
const COMBO_CONFIG: FallbacksConfig = {
  ...defaultFallbacksConfig,
  models: [
    ROUTE_ROW,
    {
      id: 'peak-valley',
      name: '峰谷组合',
      kind: 'combo',
      provider: '',
      model: '',
      windows: [{ preset: 'liang-peak', start: '', end: '', days: [], use: '' }],
      fallback: 'official',
      officialModel: 'deepseek-official/deepseek-flash',
      extraRoutes: [],
      expose: false,
      rules: { codes: [], regex: [], structural: false, markers: [] },
    },
  ],
  providers: [],
}

describe('llm-router combos', () => {
  it('renders a combo as windows that point at existing configurations', async () => {
    await mountCard(COMBO_CONFIG)
    expect(screen.getByText(/峰谷组合 · 自由组合（0 个区间）/)).toBeTruthy()
    // Only the single-model row keeps a fallback policy block.
    expect(screen.getAllByLabelText('官方兜底 Provider')).toHaveLength(1)
    expect(screen.getAllByLabelText('Provider')).toHaveLength(1)
    const use = screen.getByLabelText('使用配置') as HTMLSelectElement
    expect(use.tagName).toBe('SELECT')
    expect([...use.options].map(option => option.value)).toEqual(['', 'flex-flash'])
  })

  it('saves the 使用配置 of a combo window', async () => {
    const { wire } = await mountCard(COMBO_CONFIG)
    fireEvent.change(screen.getByLabelText('使用配置'), { target: { value: 'flex-flash' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(wire.calls.some(call => call.method === 'fallbacks/set')).toBe(true)
    })
    expect(wire.current.models?.[1]?.kind).toBe('combo')
    expect(wire.current.models?.[1]?.windows).toEqual([
      { preset: 'liang-peak', start: '', end: '', days: [], use: 'flex-flash' },
    ])
  })

  it('renders a legacy extra route that the host still hands back as a string', () => {
    const config = {
      ...WITH_MODELS,
      models: [{
        ...ROUTE_ROW,
        // What `Config(patch).get()` really returns for an older config: the
        // plain string form, not the `{ route, reasoningEffort }` row.
        extraRoutes: ['ikun-gateway/deepseek-v4.1-flash'],
      }],
    } as unknown as FallbacksConfig
    render(<ModelsPanel config={config} writable saving={false} onSave={() => {}} />)
    expect(screen.getByText('Flex Flash · deepinfra-flex/deepseek-ai/DeepSeek-V4.1-Flash-1017')).toBeTruthy()
    expect((screen.getByLabelText('追加路由 Provider') as HTMLInputElement).value).toBe('ikun-gateway')
    expect((screen.getByLabelText('追加路由模型') as HTMLInputElement).value).toBe('deepseek-v4.1-flash')
    expect((screen.getByLabelText('追加路由推理等级') as HTMLInputElement).value).toBe('')
  })

  it('pins a reasoning level on an extra route, or leaves it on 跟随系统', () => {
    render(<ModelsPanel config={WITH_MODELS} catalog={EFFORT_CATALOG} writable saving={false} onSave={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: '+ 追加兜底路由' }))
    const provider = screen.getByLabelText('追加路由 Provider') as HTMLSelectElement
    fireEvent.change(provider, { target: { value: 'deepinfra-flex' } })
    fireEvent.change(screen.getByLabelText('追加路由模型'), {
      target: { value: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' },
    })
    const effort = () => screen.getByLabelText('追加路由推理等级') as HTMLSelectElement
    expect(effort().tagName).toBe('SELECT')
    // 跟随系统 is the empty first option.
    expect([...effort().options].map(option => option.value)).toEqual(['', 'low', 'high'])
    expect(effort().value).toBe('')
    fireEvent.change(effort(), { target: { value: 'high' } })
    expect(effort().value).toBe('high')
    // Changing the route drops the level: effort ids are model-specific.
    fireEvent.change(screen.getByLabelText('追加路由模型'), { target: { value: 'other-model' } })
    expect(effort().value).toBe('')
  })

  it('lets a combo be shown in the model picker', async () => {
    const { wire } = await mountCard(COMBO_CONFIG)
    // Both the single-model row and the combo carry the picker switch.
    const switches = screen.getAllByLabelText('在模型选择器里显示')
    expect(switches).toHaveLength(2)
    fireEvent.click(switches[1]!)
    expect(screen.getByText(/峰谷组合 · 自由组合（0 个区间） · 选择器可见/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => {
      expect(wire.calls.some(call => call.method === 'fallbacks/set')).toBe(true)
    })
    expect(wire.current.models?.[1]?.expose).toBe(true)
  })

  it('offers 本模型 on a single-model window', async () => {
    await mountCard(WITH_MODELS)
    fireEvent.click(screen.getByRole('button', { name: '+ 时间区间' }))
    const use = screen.getByLabelText('使用配置') as HTMLSelectElement
    expect(use.value).toBe('')
    // Only 本模型: the lone route has no OTHER configuration to point at.
    expect([...use.options].map(option => option.value)).toEqual([''])
    expect(screen.getByText('本模型')).toBeTruthy()
  })
})

const CATALOG: ModelsCatalog = [
  { id: 'deepinfra-flex', name: 'deepinfra-flex', models: [{ id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', name: 'Flash' }] },
  { id: 'deepseek-official', name: 'deepseek-official', models: [{ id: 'deepseek-flash', name: 'Flash' }] },
]

/** The same catalog, with the reasoning levels the runtime advertises. */
const EFFORT_CATALOG: ModelsCatalog = [
  {
    id: 'deepinfra-flex',
    name: 'deepinfra-flex',
    models: [{
      id: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
      name: 'Flash',
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }],
      defaultEffort: 'high',
    }],
  },
]

describe('llm-router dropdowns', () => {
  it('feeds the provider and model fields from the catalog', () => {
    render(<ModelsPanel config={WITH_MODELS} catalog={CATALOG} writable saving={false} onSave={() => {}} />)
    const provider = screen.getAllByLabelText('Provider')[0] as HTMLSelectElement
    expect(provider.tagName).toBe('SELECT')
    expect([...provider.options].map(option => option.value)).toEqual([
      '',
      'deepinfra-flex',
      'deepseek-official',
    ])
    const model = screen.getByLabelText('模型') as HTMLSelectElement
    expect(model.tagName).toBe('SELECT')
    expect([...model.options].map(option => option.value)).toContain('deepseek-ai/DeepSeek-V4.1-Flash-1017')
  })

  it('keeps a value the catalog does not advertise', () => {
    const config: FallbacksConfig = {
      ...WITH_MODELS,
      models: [{ ...ROUTE_ROW, provider: 'legacy-p', model: 'legacy-m' }],
    }
    render(<ModelsPanel config={config} catalog={CATALOG} writable saving={false} onSave={() => {}} />)
    const provider = screen.getAllByLabelText('Provider')[0] as HTMLSelectElement
    expect([...provider.options].map(option => option.value)).toContain('legacy-p')
    expect(provider.value).toBe('legacy-p')
  })

  it('degrades to free text when the host has no catalog', () => {
    render(<ModelsPanel config={WITH_MODELS} writable saving={false} onSave={() => {}} />)
    expect((screen.getAllByLabelText('Provider')[0] as HTMLElement).tagName).toBe('INPUT')
    expect((screen.getByLabelText('模型') as HTMLElement).tagName).toBe('INPUT')
  })

  it('offers the model reasoning levels and saves the chosen one', () => {
    const saves: FallbacksConfig[] = []
    render(
      <ModelsPanel
        config={WITH_MODELS}
        catalog={EFFORT_CATALOG}
        writable
        saving={false}
        onSave={next => { saves.push(next) }}
      />,
    )
    const effort = screen.getByLabelText('推理等级') as HTMLSelectElement
    expect(effort.tagName).toBe('SELECT')
    expect([...effort.options].map(option => option.value)).toEqual(['', 'low', 'high'])
    fireEvent.change(effort, { target: { value: 'low' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    expect(saves).toHaveLength(1)
    expect(saves[0]?.models?.[0]?.reasoningEffort).toBe('low')
  })

  it('clears a pinned level when the model changes', () => {
    render(<ModelsPanel config={WITH_MODELS} catalog={EFFORT_CATALOG} writable saving={false} onSave={() => {}} />)
    const effort = () => screen.getByLabelText('推理等级') as HTMLSelectElement
    fireEvent.change(effort(), { target: { value: 'high' } })
    expect(effort().value).toBe('high')
    fireEvent.change(screen.getByLabelText('模型'), { target: { value: 'other-model' } })
    expect(effort().value).toBe('')
  })
})
