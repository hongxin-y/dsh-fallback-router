# dsh-llm-router

[English](README.md) | [中文](README.zh-CN.md)

Model routing and failure fallback for dsh (DeepSeek Harness). It merges `dsh-llm-fallbacks` and `dsh-llm-response-guard`: both "re-run this step on another route" and "this step's output is broken" are driven from one **model-configuration** surface.

The difference in one line: you used to maintain four things separately (fallback chain, time slots, provider retry, residue detection); now you maintain one list of **model profiles** and everything else is compiled from it.

## 0. Install

```sh
dsh plugin --profile desktop add github:hongxin-y/dsh-llm-router
```

Pin a commit (`#<sha>`) if you want the code that runs to stop changing. pnpm ≥ 10 does not run a git dependency's build script by default, so the first `add` may stop with `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`; run `pnpm approve-builds` inside the profile directory (`$DSH_HOME/profiles/desktop`), or add the package to that profile's `pnpm-workspace.yaml` allow list (`allowBuilds`, or `onlyBuiltDependencies` on older pnpm), then run the `add` again. Details, verification and uninstall → [docs/install.md](docs/install.md).

The package is not on the npm registry under this name — `dsh-llm-router` there belongs to an unrelated project. Install from the GitHub source above.

## 1. The core idea: model profiles

One profile = one real route + its own time windows, fallback policy, and failure rules.

```yaml
fallbacks:                  # the settings namespace stays `fallbacks` for compatibility
  models:
    - id: flex-flash
      name: DeepInfra Flex Flash
      kind: route           # route (single model) | combo (free combination)
      provider: deepinfra-flex
      model: deepseek-ai/DeepSeek-V4.1-Flash-1017
      windows: []           # empty = all day
      fallback: official    # official | loop | none
      officialModel: deepseek-official/deepseek-flash
      reasoningEffort: ''   # empty = follow the system default
      extraRoutes:          # tried in order after the head, before the official tail
        - route: ruinique/gpt-6.1-sol
          reasoningEffort: high   # empty = follow the system default
      rules:
        codes: [AUTH, QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, PI_AI_ERROR]
        regex: ['Upstream rejected the request']
        structural: true
        markers: [DSML, 'antml:', function_calls, tool_calls, tool_use, invoke, parameter, antml_function_calls]
```

### Fallback policy (one button per profile)

| Mode | Compiled chain | Meaning |
|---|---|---|
| `official` | `[this model, officialModel]` | fall back to the official model (default `deepseek-official/deepseek-flash`) |
| `loop` | `[this model, every other model once]` | ring fallback: walk the declared list once, so the last route still has somewhere to go |
| `none` | `[this model]` | no fallback; failure surfaces |

### Time windows

`windows` rows compile into time-slot rows whose chain is that profile's fallback chain. Two spellings:

- `{preset: liang-peak}` — a frozen preset (`liang-peak`, `liang-valley`, `glm-peak`, `glm-valley`), defined in code and expanded at compile time so it can never drift;
- `{start, end, days}` — hand-written, `HH:mm`, midnight-crossing allowed, `days` 0–6.

The first matching window wins; outside every window the first profile with `windows: []` applies.

### Free combinations (combo)

A `kind: combo` row owns no route. Its windows name an existing profile with `use`:

```yaml
    - id: peak-valley
      name: Peak / valley
      kind: combo
      windows:
        - { preset: liang-peak,   use: flex-flash }    # peak → flex-flash's whole chain
        - { preset: liang-valley, use: deepseek-auto } # valley → deepseek-auto's whole chain
```

- `use` may only point at a **single-model** row, so a reference cycle cannot be built;
- the referenced chain applies as-is (its own fallback and extra hops included); the combo adds nothing on top;
- a combo never becomes `rootChain`; a combo with "show in the model picker" ticked appears there as a fixed chain flattened from its windows in order (de-duplicated), while its real routing still follows the time windows;
- a window without `use`, or pointing at an unknown id, is ignored (with a warning in `/fallbacks` and the log).

### Failure rules

Three checks run in parallel; any hit means failure:

- **Codes** — `codes`, defaulting to every code the harness and pi-ai report today (including `PI_AI_ERROR`, which is where `Upstream rejected the request` lands).
- **Regex** — `regex`, matched against the failure message, to catch upstream prose.
- **Structural** — `structural` + `markers`: the assistant message ends inside a tool-call marker (`</|DSML|invoke>`, `</invoke>`, a lone `</parameter>` …) while the message carries no tool call and the request did declare tools. This is the response-guard check, rewritten as a structural test: the marker must sit at the **end of the answer**; a mention in mid-sentence does not count.

A structural hit takes a different recovery path: `model.select()` to the next hop plus a `steer()` telling the model its tool call was cut off and must be re-issued — instead of replaying the whole turn.

## 2. Per-provider retry

```yaml
  providers:
    - provider: deepinfra-flex
      enabled: true
      maxRetries: 3        # failures allowed inside the window
      windowMs: 300000     # 5-minute sliding window
      initialDelayMs: 800
      maxDelayMs: 15000
      jitterRatio: 0.1
```

Strictly per-provider opt-in: a provider absent from `providers` is never retried — it falls back immediately. The window is sliding: retrying stops once failures inside `windowMs` exceed `maxRetries`.

> **Retry ownership**: the plugin consumes `agent/request-error` itself, so the built-in `@deepseek-ai/dsh-llm-retry` has to be switched off. Otherwise it burns its own five default attempts (`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`) before this plugin's per-provider rule is ever consulted:
>
> ```yaml
> - id: llm-retry
>   name: "@deepseek-ai/dsh-llm-retry"
>   disabled: true
> ```

## 3. Compilation (why the old fields no longer need editing)

When `models` is non-empty the plugin compiles the list — on every config read — into the three fields the engine already consumes:

- `rootChain` — the fallback chain of the first **single-model** profile without windows (combos never qualify; with none present the first single-model profile is used, and failing that the official flash route);
- `timeSlots` — one row per window (a preset window compiles to `kind: preset`, a custom one to `kind: custom`); a window carrying `use` gets the referenced profile's whole compiled chain instead;
- `namedChains` — one entry per profile with "show in the model picker" ticked (a single model uses its own compiled chain, a combo uses its window chains flattened in order and de-duplicated), named after the profile.

So while profiles exist, hand-written `rootChain` / `timeSlots` / `namedChains` are derived, read-only results; editing them has no effect. With `models` empty the plugin reverts to the old behaviour: the three fields are used verbatim, so an existing `llm-fallbacks` config carries over unchanged.

## 4. UI

Settings → Plugins → **模型配置 (Model profiles)** — the whole panel is this one thing:

- one card per profile: pick the 配置类型 (single model / free combination) first, then the name; a single model gets Provider + model + 推理等级 fields, the three-way fallback switch (official / loop / none) and extra fallback routes (`extraRoutes`, each row Provider + model + 推理等级, as many rows as needed); both kinds get "show in the model picker" (`expose`);
- 推理等级 (`reasoningEffort`) left empty follows the system default (the host fills in whatever the model advertises); the options are the levels that model advertises in the runtime catalog, and changing the model or provider clears it (effort ids are model-specific, a stale one is rejected by the host). An extra fallback route pins its own level the same way, and that level applies only when that hop is the one actually serving the request;
- **every Provider and model field is a dropdown** fed by the running host's provider/model catalog (`llm/listConfigurableProviders` + `session/modelCatalog`). A value the catalog does not advertise is kept as an extra option, so a hand-written route is never silently replaced; with no catalog at all the field degrades to free text;
- time-window rows: pick a preset (Liang peak / Liang valley / GLM peak / GLM valley) or "custom" and fill in the clock fields and weekdays; the trailing 使用配置 dropdown decides which existing profile serves that window (required on a combo, "本模型" by default on a single model);
- failure rules: code checkboxes, an extra-code input, regex lines, the structural toggle and markers;
- a "Provider retry" section at the bottom for the per-provider rows;
- the legacy "main agent / subagent roles / advanced" panels are gone entirely; provider credentials (api-key, baseURL) stay in the provider's own config and are not editable here.

## 5. Fallback features kept

Profiles are the only authoring surface; the engine is untouched (it simply has no UI any more):

- cooldown (`cooldownMs`) and `revertPolicy` (`cooldown-expiry` / manual), `recovery: timer|half-open`;
- `namedChains` (compiled from `expose`, shown as `FallbacksChain / <name>`), `maxSwitchesPerStep`, `alwaysModeRetryCap`;
- role-based subagents (`roles.list` / `roles.rules`, five preset roles, `**Execute as**: <id>`, persona and badge);
- context-window-aware fallback (`CONTEXT_WINDOW_EXCEEDED`);
- the dsh-tui surface (`/fallbacks` diagnostics, `/settings` section).

## 6. Verifying

After saving, run `/fallbacks` for the session diagnostic (source, resolved role, chains, recent switches, cooldown). Expected:

- the effective chain matches the configured profile's fallback chain;
- after one upstream failure the log shows `llm-router: retrying <provider> (n/max) in <ms> after <code>`, then `llm-router: retry budget for <provider> is spent` once the window is exhausted, followed by the switch.

## 7. Migrating from the old plugins

1. Disable `llm-fallbacks` and `llm-response-guard` (their hooks overlap; running all three double-switches and double-retries).
2. Split the old `rootChain` into `models`: one profile per candidate, the last one `fallback: none`.
3. Express an old `namedChains` entry as a profile: its first route becomes the profile, tick "show in the model picker", and put the remaining hops into "extra fallback routes".
4. A route repeated inside an old chain (say a provider listed three times) becomes that provider's "Provider retry" row instead of duplicate entries.
5. Copy the old `llm-response-guard` `markers` into the relevant profile's `rules.markers`; `degrade: true` becomes `structural: true`.
6. Rewrite the old `retry` block as `providers` rows.

## License

MIT — see [LICENSE](LICENSE).
