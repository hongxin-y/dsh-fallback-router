# 产物库（Artifacts）

本仓库遵循 `D:\Repos\AGENTS.md` 的产物库约定：**凡 `.gitignore` 会忽略的路径，字节都放在产物库，仓库内只留 junction 指回去。**

## 映射表

| 仓库路径（junction） | 产物库实体路径 | 用途 | 能否重建 |
| --- | --- | --- | --- |
| `D:\Repos\dsh-llm-router\.build\` | `D:\Repos\Artifacts\dsh-llm-router\.build\` | `tsc` 中间产物（`.build/host` 是 tsdown 的输入）、临时调试脚本、探针输出 | 能（`pnpm build`） |
| `D:\Repos\dsh-llm-router\dist\` | `D:\Repos\Artifacts\dsh-llm-router\dist\` | 发布产物：宿主 `index.js` + web client bundle | 能（`pnpm build`） |
| `D:\Repos\dsh-llm-router\node_modules\` | `D:\Repos\Artifacts\dsh-llm-router\node_modules\` | pnpm 依赖树 | 能（`pnpm install --frozen-lockfile`） |

清单机读版：`D:\Repos\Artifacts\dsh-llm-router\MANIFEST.csv`。

## 常用命令

```powershell
# 确认三个目录仍是 junction（LinkType 应为 Junction）
Get-Item -Force D:\Repos\dsh-llm-router\.build, D:\Repos\dsh-llm-router\dist, D:\Repos\dsh-llm-router\node_modules |
  Select-Object FullName, LinkType, Target

# 确认没有漏在外面的 ignored 实体文件（只应剩三个以 / 结尾的挂接目录）
git -C D:\Repos\dsh-llm-router status --ignored --porcelain | Select-String '^!!'

# 构建（产物直接落在产物库，经 junction 可见）
pnpm build
```

## 危险操作

- **`git clean -xfd`**：会顺着 junction 删除产物库里的真实文件。需要清理时先 `cmd /c rmdir` 摘掉 junction，再在产物库里操作。
- **`Remove-Item -Recurse` 指向 junction**：同样会穿透。删链接用 `cmd /c rmdir D:\Repos\dsh-llm-router\dist`。
- **`robocopy`**：必须带 `/XJ`，否则会复制链接目标内容。
- **永远不要**在 `D:\Repos\Artifacts` 里 `git init`。

## 新克隆后的顺序

```powershell
git clone https://github.com/hongxin-y/dsh-fallback-router.git D:\Repos\dsh-llm-router
cd D:\Repos\dsh-llm-router
pnpm install          # 会重建 node_modules（实体目录，不是 junction）
pnpm build            # 重建 .build 与 dist
```

新克隆的仓库里没有 junction，`node_modules` / `dist` / `.build` 都是普通目录；只有在这台机器上按 AGENTS.md 迁移过的副本才用产物库。若要在本机恢复产物库布局，按上文映射表 `Move-Item` 后 `New-Item -ItemType Junction`。
