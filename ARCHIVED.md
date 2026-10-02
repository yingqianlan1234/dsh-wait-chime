# ⚠️ 本插件已退役（ARCHIVED）

**不要安装这个插件。** 它的功能已被 **`dsh-whale-widget`（小鲸鱼挂件）0.3.16+ 内置覆盖**。

本目录**刻意保留**，用途只有两个：

1. **作为 GitHub 仓库上传流程的实例**（完整的 commit 历史、`.gitignore`、`LICENSE`、`PROVENANCE.md` 都在）
2. **作为 DSH 插件的写法参考**（宿主侧事件识别 + 客户端插件 + 设置面板分区 + HTTP 路由，见下文）

---

## 一、为什么退役：功能完全重复

小鲸鱼 **0.3.16（2026-09-26 发布）** 就已内置提问/授权提醒音效，比本插件的初始提交**早了 6 天以上**。

| 时间 | 事件 |
|---|---|
| 2026-09-26 | 小鲸鱼 0.3.16 发布，**已内含**提问/授权音效 |
| 2026-10-02 14:07 | 小鲸鱼 0.3.18 发布 |
| **2026-10-02 16:49** | 本插件初始提交 `88c6871` |
| 2026-10-03 | 确认重复 → 卸载本插件，音频素材迁入小鲸鱼 |

**代码实证**（小鲸鱼 0.3.17 `lib/index.js`）：

| 行号 | 作用 |
|---|---|
| `:873`、`:937` | 监听 `ask_user_question` 的 `tool/call` → `kind: 'question'` |
| `:948`、`:949` | 监听 `approval/asked` → `kind: 'approval'` |
| `:3191` | 路由 `/dsh-whale/wait.json` |

与本插件的 `WAIT_TOOLS` / `WAIT_EVENTS`（`lib/index.js:52`、`:55`）**触发依据完全一致**。

### 教训
小鲸鱼是**当时已安装的插件** —— 排查"有没有现成方案"的第 0 步应当是**看一眼已装插件的能力清单**，成本为零。这次跳过该步，导致整轮开发净产出为零，中途还因手动覆盖包文件导致 DSH 桌面端无法启动。

**规则**：动手造之前先调研（顺序：已装插件 → 本机代码 → npm/GitHub → B站/搜索 → 都没有才自己写）。

---

## 二、参考价值（这是保留它的理由）

### 1. GitHub 仓库上传流程的完整实例
- 5 个 commit 的真实历史，含 README 迭代、元信息补全
- `package.json` 的 `repository` / `homepage` / `bugs` / `keywords` 写法（`package.json:25-40`）
- `files` 白名单机制（决定哪些文件进 npm 包，`package.json:13-21`）
- `.gitignore` / `.gitattributes` / `LICENSE`（MIT，署名用 GitHub ID）
- `PROVENANCE.md`：**素材权利边界**的写法 —— 代码走 MIT，音频明确排除在 MIT 外、按 as-is 提供并附 takedown 条款。这是处理"代码自有但素材来路不明"的合规范式。

### 2. DSH 插件写法参考（可直接抄的结构）

| 内容 | 位置 | 说明 |
|---|---|---|
| **bundle patch** | `cordis.patch.yml` | 把插件插入 profile 的 loader 栈；**回退 = 从 profile 的 `package.json` 的 `dsh.profile.bundles` 删掉本行** |
| **插件元信息声明** | `package.json:42-49` | `dsh.bundle.patch` 指向 patch 文件；`dsh.client.platform: "web"` 声明这是一个**有客户端部分**的插件 |
| **宿主侧入口** | `lib/index.js:48-60` | 导出 `name` / `inject` / `apply(root)` 三件套 |
| **会话事件识别** | `lib/index.js:52-55` | `ask_user_question` 是**挂起式**工具调用：模型发出后 DSH 追加 `tool/call`，需据此判定"助手在等你"。审批走 `approval/asked` 事件 |
| **HTTP 路由** | `lib/index.js:289` | 通过 `ctx.webServer`（或 `ctx.get('webServer')`）拿服务端，`DSH_HOME` 从环境变量读 |
| **生命周期清理** | `lib/index.js:499-500` | `ctx.effect(() => () => {...})` 注册卸载时的清理 |
| **客户端插件** | `lib/client.js` | 页面侧：轮询 + 播放 + **设置面板原生分区** |
| **自定义音频目录** | `lib/index.js:35-44` | 用户自定义音效落地在 `$DSH_HOME/dsh-wait-chime/`，含 MIME 表与大小上限（4MB） |
| **自带诊断** | `lib/index.js:45-46` | `.dshw-wait.json`（状态）、`.dshw-wait-events.json`（实际见过的会话事件类型）——排查"设置面板为什么没出现"靠它 |
| **冒烟测试** | `test/smoke.mjs` | 假宿主，覆盖事件识别与路由，不依赖真实 DSH |

**特别值得抄的两点：**
- `DSHW-wait-events.json` 这类**诊断文件**：记录"实际见过的会话事件类型"，是搞不清 DSH 事件流时的自证手段。
- **设置面板原生分区**：`client.js` 里在 DSH 设置页新增「等待提醒」分区，含开关、响度滑块、试听按钮，且**改完即时生效不用重启**（宿主热读配置）。

---

## 三、音频素材已迁出

`assets/say1.ogg`（Minecraft 蠹虫音效，7497 B）**已安装到小鲸鱼插件的自定义音效里**：

- 转码为真正的 WAV 后放在 `$DSH_HOME\whale-audio\say1.wav`（32864 B，PCM 16bit 单声道 44100Hz，0.372s）
- 注册于 `$DSH_HOME\whale-audio\audio.json`，在小鲸鱼面板里以片段 `frag:say1` 使用
- ⚠️ **小鲸鱼的 `fragmentMime()` 对自定义片段硬编码 `audio/wav`**，所以自定义音效**必须是真 WAV** —— 塞 Ogg 字节会静默无声

**本目录的 `assets/say1.ogg` 仅作原始素材留存**，权利状态见 [`PROVENANCE.md`](PROVENANCE.md)（归 Mojang/Microsoft，未获授权，仅个人本地使用）。

---

## 四、如需重新启用（不推荐）

功能上无意义（与小鲸鱼重复），仅在调试本目录代码时有意义：

1. 从 DSH 插件页安装本目录（填本地路径）
2. 若与已装的小鲸鱼**同时存在**，两者会**同时响** —— 需先在小鲸鱼面板关掉它的提问/授权音效
3. **卸载**：插件页卸载；或手动从 profile 的 `package.json` 删除 `dependencies` 与 `dsh.profile.bundles` 里的 `dsh-wait-chime` 两处，再 `pnpm install`
4. ⚠️ **绝不要手动覆盖 `node_modules` 里的包文件** —— 会让锁文件与实际不符，导致 DSH 无法启动
