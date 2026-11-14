/**
 * The `llm-router` plugin card on the web Plugins page.
 *
 * SCOPE (deliberate, post-merge): the card renders ONE thing — the 模型配置
 * panel. The legacy fallbacks surface (the global 默认降级链 editor, the
 * time-slot table, the subagent role list, the advanced scalars) is not
 * editable here any more:
 *
 *   - `rootChain` / `timeSlots` / `namedChains` are COMPILED from the model
 *     rows by `withCompiledRouter`, so hand-editing them would be overwritten
 *     on the next read;
 *   - `roles` / `cooldownMs` / `revertPolicy` / `presets` / `tz` keep whatever
 *     the composed config already carries — a save writes only `models` and
 *     `providers`, so nothing is dropped;
 *   - provider API keys and other credentials belong to the provider plugins
 *     (`llm-pi-ai`, …) and are never surfaced (let alone made editable) here.
 *
 * The card is a thin shell around {@link ModelsPanel}: it loads the store on
 * mount, renders the channel/error notices, and hands the panel the write
 * gate. All authoring logic lives in the panel.
 */

import { useEffect, useMemo, type ReactNode } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import {
  FallbacksSettingsController,
  type FallbacksSettingsState,
} from './fallbacks-store.ts'
import css from './FallbacksCard.module.css'
import { ModelsPanel, type ModelsCatalog } from './ModelsPanel.tsx'

/** The card store (loaded on mount, refreshed on pushed invalidations). */
export interface FallbacksCardInjected {
  controller: FallbacksSettingsController
  /** Bare snapshot source the renderer binds as `useSnapshot`. */
  hooks: {
    snapshot: import('@deepseek-ai/dsh-client-store').SnapshotStore<FallbacksSettingsState>
  }
}

/** Props delivered by the slot outlet: runtime share + locale seat + inject face. */
export type FallbacksCardProps =
  PropsRuntime<'plugins.bundle.config'>
  & PropsLocale<'fallbacks'>
  & InjectFace<FallbacksCardInjected>

export function FallbacksCard({ controller, useSnapshot }: FallbacksCardProps): ReactNode {
  const state = useSnapshot(snapshot => snapshot)

  // The store starts 'idle' and pushed invalidations only refresh an already
  // loaded store, so the card must pull the descriptor itself on mount.
  // `controller` is the stable slot-injected singleton: this fires once.
  useEffect(() => {
    const snapshot = controller.store.getSnapshot()
    if (snapshot.status === 'idle') void controller.load()
    if (snapshot.catalogStatus === 'idle') void controller.loadCatalog()
  }, [controller])

  const saving = state.status === 'saving'

  // The provider/model pickers read the runtime catalog: provider ids come from
  // `llm/listConfigurableProviders` FILTERED to the ones this host actually has
  // configured (the Models page's own `configured` predicate), and each row
  // carries the models that provider's settings profile already declares. A
  // directory-only provider never shows up; the picker still renders a value
  // the catalog does not advertise.
  const catalog = useMemo<ModelsCatalog>(
    () => state.catalogProviders.map(entry => ({ id: entry.id, name: entry.id, models: entry.models })),
    [state.catalogProviders],
  )

  return (
    <div>
      {state.legacyKeys.length > 0 ? (
        <div className={css.legacyNotice} role="status">
          检测到旧版配置键：{state.legacyKeys.join('、')}。它们仍然生效，但不再有编辑界面。
        </div>
      ) : null}
      {state.error !== null ? (
        <div className={css.noticeRow} role="alert">
          <span className={css.error}>{state.error}</span>
          <button type="button" className={css.outlineButton} onClick={() => { void controller.load() }}>
            重试
          </button>
        </div>
      ) : null}
      {state.error === null && state.status === 'ready' && !state.present ? (
        // A get that resolved no config (channel down, plugin just reloaded)
        // leaves the panel on defaults — an empty 模型配置 list that looks
        // exactly like "my configuration vanished". Say so and offer the retry.
        <div className={css.noticeRow} role="status">
          <span className={css.hint}>配置通道未连通，下面显示的是默认值（不是你保存的配置）。</span>
          <button type="button" className={css.outlineButton} onClick={() => { void controller.load() }}>
            重新读取
          </button>
        </div>
      ) : null}
      <ModelsPanel
        config={state.config}
        catalog={catalog}
        writable={state.writable}
        saving={saving}
        onSave={next => { void controller.save(next) }}
      />
    </div>
  )
}
