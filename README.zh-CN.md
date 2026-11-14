# dsh-fallback-router

[English](README.md) | [中文](README.zh-CN.md)

dsh（DeepSeek Harness）的**模型路由与故障兜底**插件。它是 `dsh-llm-fallbacks` 与 `dsh-llm-response-guard` 的合并版：把「换一条路由重跑」和「这一步的输出坏了」两类故障，收进同一套以**模型配置**为中心的面板里。

一句话区别：以前你要分别维护「降级链」「分时槽」「provider 重试」「残片判定」四处配置；现在你只维护一张**模型配置**列表，其余全部由它编译出来。

## 〇、安装

```sh
dsh plugin --profile desktop add github:hongxin-y/dsh-fallback-router
```

想锁定代码版本就带上提交号（`#<sha>`）。pnpm ≥ 10 默认不执行 git 依赖的构建脚本，第一次 `add` 可能停在 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`：在 profile 目录（`$DSH_HOME/profiles/desktop`）里跑一次 `pnpm approve-builds`，或把该包写进该 profile 的 `pnpm-workspace.yaml` 允许列表（pnpm 11 用 `allowBuilds`，pnpm 10 用 `onlyBuiltDependencies`），再执行一次。详细步骤、验证与卸载 → [docs/install.md](docs/install.md)。

本包也已发布到 npm 注册表，装它不需要现场构建：

```sh
dsh plugin --profile desktop add dsh-fallback-router
```

## 一、核心概念：模型配置

每一条「模型配置」= 一个可被路由到的真实模型 + 它自己的时间区间、兜底策略、失效判定规则。

```yaml
fallbacks:                  # 设置命名空间沿用 fallbacks，兼容旧配置
  models:
    - id: flex-flash
      name: DeepInfra Flex Flash
      kind: route           # route（单一模型）| combo（自由组合）
      provider: deepinfra-flex
      model: deepseek-ai/DeepSeek-V4.1-Flash-1017
      windows: []           # 空 = 全时段
      fallback: official    # official | loop | none
      officialModel: deepseek-official/deepseek-flash
      reasoningEffort: ''   # 留空 = 跟随系统；否则填该模型广告的等级 id
      extraRoutes:          # 追加兜底路由：主路由之后、官方兜底之前，按顺序尝试
        - route: ruinique/gpt-6.1-sol
          reasoningEffort: high   # 留空 = 跟随系统
      rules:
        codes: [AUTH, QUOTA, RATE_LIMIT, SERVER, TIMEOUT, TRANSPORT, PI_AI_ERROR]
        regex: ['Upstream rejected the request']
        structural: true
        markers: [DSML, 'antml:', function_calls, tool_calls, tool_use, invoke, parameter, antml_function_calls]
```

两条形状：

- **单一模型**（`kind: route`，默认）—— 绑定一个 `provider/model`，自带时间区间、兜底策略、追加路由与失效判定。
- **自由组合**（`kind: combo`）—— 不绑定模型，每个时间区间用 `use: <另一个模型的 id>` 指定「这一段用哪个已有配置」。例如梁高峰用 `flex-flash`、梁低谷用 `deepseek-auto`，两边的兜底与判定规则各自沿用，不用复制一遍。

### 兜底策略（每个模型配置一个按钮）

| 模式 | 编译出的链 | 含义 |
|---|---|---|
| `official` | `[本模型, officialModel]` | 挂了就切官方模型（默认 `deepseek-official/deepseek-flash`） |
| `loop` | `[本模型, 其余模型各一次]` | 循环兜底：按声明顺序绕一圈，最后一条失效也还能试到别的 |
| `none` | `[本模型]` | 不兜底，挂了就报错 |

### 时间区间

`windows` 里的每一行在编译时变成一条分时槽，链内容就是该模型的兜底链。两种写法：

- `{preset: liang-peak}` —— 冻结预设（`liang-peak` 梁高峰 / `liang-valley` 梁低谷 / `glm-peak` / `glm-valley`），定义在代码里，编译期展开，不会随时间漂移；
- `{start, end, days}` —— 自定义，`HH:mm`，可跨午夜，`days` 是 0–6。

第一个命中的窗口胜出；没有窗口命中的时刻回落到第一条 `windows: []` 的模型。

### 自由组合（combo）

`kind: combo` 的行不绑定 `provider/model`，它只在窗口上写 `use`：

```yaml
    - id: peak-valley
      name: 峰谷组合
      kind: combo
      windows:
        - { preset: liang-peak,   use: flex-flash }    # 梁高峰 → 用 flex-flash 的整条链
        - { preset: liang-valley, use: deepseek-auto } # 梁低谷 → 用 deepseek-auto 的整条链
```

规则：

- `use` 只能指向另一个 **单一模型** 行，所以引用天然无环；
- 被引用的那条链原样生效（含它自己的兜底与追加路由），组合行自己不再追加兜底；
- 组合行不参与 `rootChain`；勾了「在模型选择器里显示」的组合会以「各区间链按顺序拼接、去重」的固定链出现在选择器里（实际分时仍按时间区间生效）；
- 窗口没有 `use`、或指向不存在的 id 时，该窗口被忽略（`/fallbacks` 与日志里有告警）。

### 失效判定规则

三条并行，任一命中即视为失效：

- **错误码** —— `codes`，默认带上 harness 与 pi-ai 目前会报的全部码（含 `PI_AI_ERROR`，`Upstream rejected the request` 就落在它上面）。
- **正则** —— `regex`，对失败消息做匹配，用来抓上游原文里的特征句。
- **结构判定** —— `structural` + `markers`：assistant 消息末尾停在工具调用标记中间（`</|DSML|invoke>`、`</invoke>`、孤立 `</parameter>` 等），且整条消息里没有 tool-call、但本次请求确实带了 tools。这是 `llm-response-guard` 的判定，已改成结构判定而非文本拟合：要求标记出现在**答案结尾**，句中引用不算命中。

命中结构残片时走的是另一条恢复路径：`model.select()` 换到兜底链下一跳 + `steer()` 一条「你上次的工具调用被截断了，重新发一次」的提示，而不是重跑整轮。

## 二、每个 provider 单独的重试

```yaml
  providers:
    - provider: deepinfra-flex
      enabled: true
      maxRetries: 3        # 窗口内允许的失败次数
      windowMs: 300000     # 滑动窗口 5 分钟
      initialDelayMs: 800
      maxDelayMs: 15000
      jitterRatio: 0.1
```

语义是**严格逐 provider opt-in**：没写进 `providers` 的 provider 一次都不重试，失败直接走兜底链。窗口是滑动窗口——`windowMs` 内失败次数超过 `maxRetries` 才放弃重试。

> **重试归属**：插件自己消费 `agent/request-error`，所以要把内置的 `@deepseek-ai/dsh-llm-retry` 关掉，否则它会先用自己的 5 次默认策略（`EMPTY_RESPONSE`/`RATE_LIMIT`/`SERVER`/`TIMEOUT`/`TRANSPORT`）把失败吃掉，本插件的 per-provider 规则永远轮不到：
>
> ```yaml
> - id: llm-retry
>   name: "@deepseek-ai/dsh-llm-retry"
>   disabled: true
> ```

## 三、编译关系（为什么旧字段不用再改）

`models` 非空时，插件在每次读配置时把模型列表编译成引擎原本读的三个字段：

- `rootChain` —— 第一条无窗口的**单一模型**的兜底链（组合行不参与；没有这样的行时取第一条单一模型，再没有就退回官方 flash）；
- `timeSlots` —— 每个窗口一条行（预设窗口编译成 `kind: preset`，自定义窗口编译成 `kind: custom`）；带 `use` 的窗口，链换成被引用模型编译出的整条链；
- `namedChains` —— 每个勾了「在模型选择器里显示」的模型配置一条（单一模型用自己编译的链，组合用它各区间链按顺序拼接去重后的链），名字即配置名。

因此有模型配置时，手写的 `rootChain` / `timeSlots` / `namedChains` 都是只读的派生结果，改它们不会生效。`models` 为空时，插件完全退回旧行为：手写的三个字段原样使用，`llm-fallbacks` 的老配置文件可以直接搬过来。

## 四、界面

设置 → 插件配置 → **模型配置**，整个面板只有这一件事：

- 每个模型一张卡片：先选「配置类型」（单一模型 / 自由组合），再填名称；单一模型有 Provider + 模型 + 推理等级三格、兜底三选一（官方兜底 / 循环兜底 / 不兜底）、追加兜底路由（`extraRoutes`，每行 Provider + 模型 + 推理等级，可加多行）；两种类型都有「在模型选择器里显示」（`expose`）。
- 推理等级（`reasoningEffort`）留空表示跟随系统（由内核按该模型声明的默认等级决定）；下拉选项来自该模型在运行时目录里声明的等级，换模型或换 Provider 会自动清空（等级 id 是模型专属的，留着会被内核拒绝）。追加兜底路由的等级同理：它只在该跳真正成为当前请求路由时生效，不会沿用主路由的等级。
- **所有 Provider 与模型都是下拉**，选项来自当前运行环境的 provider / 模型目录（`llm/listConfigurableProviders` + `session/modelCatalog`）。目录里没有的值仍会保留成一个额外选项，手写的路由不会被静默替换；宿主完全拿不到目录时退化成文本框。
- 时间区间行：可下拉选预设（梁高峰 / 梁低谷 / GLM 高峰 / GLM 低谷），也可以选「自定义时间段」后填起止与星期；末尾的「使用配置」下拉决定这一段用哪个已有配置（组合行必选，单一模型行默认「本模型」）。
- 失效判定：错误码复选 + 追加自定义码 + 正则 + 结构判定 + markers。
- 底部「Provider 重试」段：逐行开关 + 窗口参数。
- 旧插件带进来的「主代理 / 子代理角色 / 高级」面板已整块移除；provider 的 api-key、baseURL 等仍由模型 provider 自己的配置管理，这里不可编辑。

## 五、保留的 fallback 能力

模型配置是唯一创作面，引擎能力原样保留（只是不再有编辑界面）：

- 冷却（`cooldownMs`）与 `revertPolicy`（`cooldown-expiry` / 手动）、`recovery: timer|half-open`；
- `namedChains`（由 `expose` 编译生成，模型选择器里显示为 `FallbacksChain / <名字>`）、`maxSwitchesPerStep`、`alwaysModeRetryCap`；
- 角色化 subagent（`roles.list` / `roles.rules`、五个内置预设角色、`**Execute as**: <id>` 声明、persona 与徽章）；
- 上下文窗口感知降级（`CONTEXT_WINDOW_EXCEEDED`）；
- dsh-tui 操作面（`/fallbacks` 诊断、`/settings` 分区）。

## 六、验证

保存后输入 `/fallbacks` 看会话诊断（来源、解析角色、链、最近切换、冷却）。期望看到：

- 生效链与你配置的模型兜底链一致；
- 触发一次上游失败后，日志出现 `llm-router: retrying <provider> (n/max) in <ms> after <code>`，窗口用尽后是 `llm-router: retry budget for <provider> is spent`，随后发生切换。

## 七、从旧插件迁移

1. 停用 `llm-fallbacks` 与 `llm-response-guard`（两者与本插件的钩子重叠，同时启用会重复切换/重复重试）。
2. 把旧 `llm-fallbacks` 的 `rootChain` 拆成 `models`：每个候选一条，最后一条 `fallback: none`。
3. 旧的 `namedChains` 用模型配置表达：那条链的首个路由建成一个模型，勾上「在模型选择器里显示」；链中间的跳数填进它的「追加兜底路由」。
4. 旧链里同一个路由重复出现（例如某个 provider 连写三次）用该 provider 的「Provider 重试」行表达，而不是重复写路由。
5. 旧 `llm-response-guard` 的 `markers` 抄进对应模型的 `rules.markers`，`degrade: true` 对应 `structural: true`。
6. 旧 `retry` 配置改写成 `providers` 行。

## 许可

MIT，见 [LICENSE](LICENSE)。
