# omp-pet-shinosawa

给 omp 用的桌面宠物扩展：篠澤広（Shinosawa Hiro）会待在编辑器上方，跟随会话事件切换动画，并在需要时显示上下文用量 / 余额面板。

- 9 组动画，共 57 帧（PetX V1）
- 点击立绘或 `用量` 链接打开 usage 面板，10 秒后自动收起
- 支持位置、大小、动画手动控制
- 图片缓存为有界 LRU，长时间运行不会无限增长

## 安装

要求：omp，并且终端支持原生图片（Tern）或 SIXEL / Kitty。

作为插件安装（从 GitHub 拉取，落到 `~/.omp/plugins/node_modules/omp-pet-shinosawa`，不是本地链接）；`package.json` 已经声明了入口：

```json
{ "omp": { "extensions": ["./src/pet.ts"] } }
```

```bash
omp plugin install git@github.com:curealb/Tern-pets.git
```

本地开发时改用链接，改完源码重启 omp 即生效：

```bash
omp plugin link F:/code/tern-plugins/pets
```

之后重启 omp（新启用的插件需要重新启动才会加载）。卸载用 `omp plugin uninstall omp-pet-shinosawa`。

git 安装的是仓库的一个副本，不会跟随本地改动：更新先 push，再 `omp plugin upgrade omp-pet-shinosawa`。

不要同时在 `~/.omp/agent/config.yml` 的 `extensions:` 里再写同一个入口：插件入口会自动加载，重复配置没有意义。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/shinosawa` | 显示 / 隐藏宠物 |
| `/shinosawa show` | 显示 |
| `/shinosawa hide` | 隐藏 |
| `/shinosawa mood` | 列出全部动画名 |
| `/shinosawa mood <name>` | 强制某个动画，事件不再覆盖 |
| `/shinosawa mood auto` | 解除强制，回到自动 |
| `/shinosawa size <32..192>` | 设置渲染宽度（像素，默认 96） |
| `/shinosawa place <left\|center\|right\|wander>` | 位置；`wander` 会在原位附近短距离走动 |
| `/shinosawa usage` | 显示 usage 面板 10 秒 |
| `/shinosawa about` | 显示角色信息 |
| `/shinosawa --help`、`-h`、`help` | 打开用法面板（Esc / Enter / q 关闭） |

## 打开 usage

- **Tern 原生终端**：直接点立绘。点击动作挂在图片节点上，终端在动画帧切换的瞬间偶尔会丢点击；丢的时候再点一次，或用 `/shinosawa usage`。
- **普通终端**：宠物旁边的 `用量` 链接。需要终端链接可点击，通常要在配置里打开：

  ```yaml
  tui:
    mouse: true
  extensionRenderers:
    assistantText: true
  ```

- 原生 Tern 下不显示这个 `用量` 标签，避免和面板里的 `用量` 重复。

## usage 面板

面板出现在宠物旁边，持续 10 秒：

| 行 | 内容 |
| --- | --- |
| 用量 | 当前上下文 tokens / 窗口，百分比 badge，进度条 |
| 余额 | 提供方 usage 报表；DeepSeek 没有 usage provider 时读 `/user/balance` |
| 时段 | 仅 DeepSeek：峰时 / 谷时（半价）与距下一次切换的时间 |

细节：

- 面板先出现，余额在后台请求（8 秒超时）；请求失败时保留上一次的值或显示占位。
- 打开面板 250ms 后宠物跳一次 `jumping`，跳完恢复原来的动画。
- 面板打开时不会再显示额外的 `用量` 点击标签。

DeepSeek 峰时（UTC，周一至周五）：`01:00–04:00`、`06:00–10:00`。中国法定节假日未单独建模，只按星期近似。

## 动画

9 组动画，播放时按各自的帧间隔循环：

| 动画 | 帧数 × 间隔 | 触发 |
| --- | --- | --- |
| `idle` | 6 × 160ms | 默认；各种一次性动画结束后回归 |
| `waving` | 4 × 140ms | `session_start` 打招呼；闲置随机 |
| `jumping` | 5 × 140ms | 启动预热（挥手之后）；回合成功结束；打开 usage；闲置随机 |
| `review` | 6 × 150ms | 仅闲置随机 |
| `waiting` | 6 × 150ms | `turn_start` |
| `running` | 6 × 120ms | 任意工具开始执行 |
| `failed` | 8 × 140ms | 工具报错；回合以失败结束 |
| `runningLeft` / `runningRight` | 8 × 120ms | `place = wander` 时自动走动 |

补充：

- 非 wander 模式下，闲置每 12–36 秒从 `jumping` / `waving` / `review` 中随机播一个。
- wander 模式每 1.2–3.8 秒走一小段，单段最多 8 格，不会横穿整个屏幕。
- `mood <name>` 会设置 `forcedMood`，事件和闲置都不再改动画；`mood auto` 解除。
- 未知动画名会被忽略，`/shinosawa mood` 可以列出全部名字。

## 行为与默认值

- 默认位置：`left`，偏移 0 格。
- 默认大小：96px；高度按 192×208 的帧比例计算。
- 用量行是 Tern composer footer 里的一个灰色事实（与模型/路径/分支同一行），文案保持短：`🐾 Hiro · tokens/window tok (pct%) · 余额 … · 峰/谷`；模型名已经在 chip 上，不再重复。Tern 空间不足时会先丢优先级最低的事实（包括这一行）。
- 图片缓存：最近 24 个 `Image`，LRU 淘汰。图片接入当前 TUI 的 `imageBudget`；重绘复用稳定的 Kitty image/placement ID，换帧、隐藏和组件销毁时释放旧图像，避免残影叠加。
- 宠物只在主会话生效；子会话不会改动共享状态。

## 目录

```text
src/pet.ts                扩展入口与全部逻辑
shinosawa/pet.json        角色元数据
shinosawa/spritesheet.webp
shinosawa/frames/*.png    57 张预切帧（按动画名-帧号命名）
shinosawa/preview*.png
package.json
```

## 开发

omp 直接加载 `src/pet.ts`，没有构建步骤。改完重启 omp；Windows 上 `/reload` 不保证重新导入改过的模块代码。

协议回归测试使用真实的 OMP 18.20.0 TUI 组件，运行 `bun install` 后执行 `bun test`。覆盖重绘、移动、动画换帧、隐藏、跨 TUI 重建，以及 Kitty Placeholder 和关闭图片后的文本回退。

动画表在 `src/pet.ts` 的 `ATLAS` 里（行号 0–8 对应 spritesheet 的 9 行），新增帧需要同时放入 `shinosawa/frames/<name>-<n>.png` 并更新 `ATLAS` 的 `frames`。
