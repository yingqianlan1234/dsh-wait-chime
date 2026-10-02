# dsh-wait-chime

**助手停下来等你的时候，提醒你一声。**

一个 DSH（DeepSeek Harness）插件：当助手**向你提问**、或**需要你额外授权**时播放提示音，并把这声提醒的音量与开关放进 DSH 的**设置面板**。这样你切到别的窗口、或者在忙别的事，也不会让对话一直干等着。

|触发|依据的会话事件|说明|
|-|-|-|
|助手向你提问（`ask\\\_user\\\_question`）|`tool/call` 的工具名|响一声|
|需要额外权限（审批请求）|`approval/asked`|响一声|

## 特性

* **两类触发**，信号取自 DSH 的会话事件流
* **设置面板原生分区**：在 DSH 设置里多出一项「等待提醒」，含开关、连续响度滑块、试听按钮
* **连续响度**：`0.5× \\\~ 6×`（≈ −6dB \~ +15.6dB），用 Web Audio 的 `GainNode` 实现；`<audio>` 叠放作为兜底
* **改完即时生效**，不用重启（宿主热读取配置）
* **只读优先、无凭据**：所有 HTTP 路由都不含任何密钥；写配置只有一条，且拒绝跨站请求
* **自带诊断**：`events.json` 能看到实际见过的会话事件类型；`client-report.json` 能定位设置面板为什么没出现

## 目录结构

```
dsh-wait-chime/
├── package.json          # 插件元信息（dsh.bundle.patch / dsh.client）
├── cordis.patch.yml      # 把本插件插入 profile 的 loader 栈
├── lib/
│   ├── index.js          # 宿主侧：会话事件识别 + HTTP 路由
│   └── client.js         # 页面侧：轮询 + 播放 + 设置面板分区
├── assets/
│   └── say1.ogg          # 提示音（Ogg Vorbis）
├── test/
│   └── smoke.mjs         # 冒烟测试（假宿主，覆盖事件识别与路由）
└── LICENSE
```

## 安装（DSH 桌面端）

### 方式一：插件页安装（推荐）

1. DSH 桌面端 → **插件页 → 添加插件**；
2. 输入框里填 **GitHub 仓库地址**：`https://github.com/yingqianlan1234/dsh-wait-chime`
   （如果已经把仓库下载到本地，也可以直接填**本地目录路径**，例如 `D:\plugins\dsh-wait-chime` —— 这种填法完全不走网络）
3. 点**安装**，然后**重启 DSH 桌面端**；
4. 在页面里点一下（任意位置）。Chromium 的自动播放策略要求先有一次用户手势，插件会趁那一下静默解锁音频；不点的话第一次提醒可能没声。

> 输入框接受「npm 包名 / GitHub 仓库地址 / 本地目录路径」三者之一。填 GitHub 地址时需要能访问 github.com；面板上的「安装源：中国大陆镜像源」只作用于 **npm 包名**那种填法。
>
> 插件安装后**暂不支持自动更新**（这是插件页自己的提示）：升级需要先卸载再装新版。

### 方式二：手动安装（插件页不可用，或你要改代码调试时）

> 桌面端读取的是 `desktop` profile。以下路径以 `%USERPROFILE%\\\\.dsh` 为例。

**0. 获取代码**（三种任选其一）

- **下载 ZIP**（最省事）：仓库页右上 **Code ▾ → Download ZIP**，解压到任意目录；
- **git clone**：
  ```bash
  git clone https://github.com/yingqianlan1234/dsh-wait-chime.git
  ```

**1. 放置插件目录**（任意位置都可以，下例假设放在 `D:\\\\plugins\\\\dsh-wait-chime`）

**2. 链接进 profile 的 `node\\\_modules`**

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\\\\.dsh\\\\profiles\\\\desktop\\\\node\\\_modules\\\\dsh-wait-chime" `
  -Target "D:\\\\plugins\\\\dsh-wait-chime"
```

**3. 登记到 profile 的 `package.json`**

`%USERPROFILE%\\\\.dsh\\\\profiles\\\\desktop\\\\package.json` 里加两处：

```json
{
  "dependencies": {
    "dsh-wait-chime": "link:D:/plugins/dsh-wait-chime"
  },
  "dsh": {
    "profile": {
      "bundles": \\\[
        "dsh-wait-chime"
      ]
    }
  }
}
```

**4. 重启 DSH 桌面端**（`bundles` 变了，热重载覆盖不到）

**5. 在页面里点一下**（任意位置）。Chromium 的自动播放策略要求先有一次用户手势，插件会趁那一下静默解锁音频；不点的话第一次提醒可能没声。

### ⚠️ 改 `package.json` 时务必避开 BOM

不要用 **Windows PowerShell 5.1** 的 `Set-Content -Encoding utf8` 改 profile 的 `package.json`：它会写入 **UTF-8 BOM**，而 DSH 启动时用 Node 的 `JSON.parse` 读这个文件——**Node 不接受 BOM**，结果是**桌面端直接起不来**（`SyntaxError: Unexpected token ''`，Host 启动期致命错误）。

用编辑器改，或者：

```powershell
\\\[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))
```

改完务必这样验证（用与 DSH 相同的解析器，且**不要**预先剥掉 BOM，否则测不出来）：

```powershell
node -e "JSON.parse(require('fs').readFileSync(process.argv\\\[1],'utf8'))" "$env:USERPROFILE\\\\.dsh\\\\profiles\\\\desktop\\\\package.json"
```

## 工作原理

```
宿主 (lib/index.js)
  root.on('session/event')            ← DSH 会话事件流
    ├─ tool/call + name=ask\\\_user\\\_question  ┐
    └─ approval/asked                      ┴→ state.seq++ → 落盘 $DSH\\\_HOME/.dshw-wait.json

页面 (lib/client.js)
  每秒 fetch /dsh-wait-chime/pending.json
    └─ seq 变大 → play(gain)
         ├─ 优先 Web Audio：AudioContext + GainNode(gain)   ← 连续增益
         └─ 兜底：同时播 N 份 <audio>（整数台阶）
```

去重：页面把「已播过的 seq」记在 `localStorage`，宿主侧 `seq` 持久化，刷新页面不会把旧提醒再响一遍；若状态文件丢失导致 `seq` 归零，前端会自动对齐游标（否则会永久静音）。

## 设置面板

DSH 设置里会出现一项 **「等待提醒」**（导航里的一级分区）：

|控件|作用|
|-|-|
|提醒音 开关|相当于配置里的 `enabled`|
|响度滑块|`gain`，`0.5 \\\~ 6`（步进 0.1），右侧显示倍率与 dB|
|音效文件|选本地音频替换提示音（按文件头识别格式），旁边有「恢复默认」|
|试听|按当前档位立刻响一次|

实现走 DSH 的客户端插槽 API：

```js
exports.inject = \\\['slots']
ctx.slots.inject('settings.section', () =>
  ctx.slots.register(
    { name: 'settings.section', id: 'dsh-wait-chime', order: 620, label: '等待提醒' },
    () => React.createElement(WaitChimeSection),
  ))
```

拿不到 `slots` 时只跳过面板，提醒功能不受影响（注册失败仅告警）。

### 替换提示音

面板里「音效」那一行选个本地文件即可，改完立刻生效（会自动试听一次）。**支持的文件类型**：

|类型|扩展名|说明|
|-|-|-|
|MP3|`.mp3`|最常见，推荐|
|Ogg Vorbis / Opus|`.ogg` `.opus`|Chromium 原生支持|
|WAV|`.wav`|未压缩，体积偏大|
|AAC / M4A|`.m4a` `.aac`|手机录音常见|
|FLAC|`.flac`|无损，体积大|
|WebM 音频|`.webm`|少见但可用|

* **上限 4 MB**，建议 **≤ 2 MB、1\~3 秒**的短音效（太长会拖慢对话节奏）
* 格式**按文件头识别**，改扩展名骗不过去；不是音频文件会被直接拒绝并提示
* 自定义音效存到 `%USERPROFILE%\\.dsh\\dsh-wait-chime\\chime.<ext>`，**不写进插件目录**——升级插件不会覆盖它，也不会弄脏 git 工作区
* 点「恢复默认」会删掉自定义文件，回到内置的 `assets/say1.ogg`

## 配置

文件：`%USERPROFILE%\\\\.dsh\\\\.dshw-wait.json`（首次触发提醒后自动生成）

```json
{
  "seq": 4,
  "enabled": true,
  "volume": 1,
  "boost": 2.5
}
```

|字段|含义|
|-|-|
|`enabled`|`false` = 静音（前端只对齐游标，不发声）|
|`boost`|响度倍数，`0.2 \\\~ 6`（`gain = volume × boost`）|
|`volume`|`0 \\\~ 1`，保留用于兼容；在设置面板里调过响度后会归一为 `1`|
|`chime`|自定义音效的元信息（`ext`/`mime`/`size`/`name`/`at`）；`null` = 用内置默认|
|`seq`|插件自己维护的提醒序号，别手动改|

**改完最多 1 秒生效，不用重启。** 如果手改这个文件，注意同样别存成带 BOM 的 UTF-8（插件用 `JSON.parse` 读它，带 BOM 会静默沿用旧值）。

## HTTP 接口

|方法|路径|说明|
|-|-|-|
|`GET`|`/dsh-wait-chime/pending.json`|`{seq, kind, detail, ts, enabled, volume, boost, gain, chime, accept, maxBytes}`|
|`POST`|`/dsh-wait-chime/config.json`|写配置，body 如 `{"gain": 2.5}` / `{"enabled": false}`|
|`GET`|`/dsh-wait-chime/chime.ogg`|提示音字节（有自定义就下发自定义，否则内置；`Content-Type` 随实际格式）|
|`POST`|`/dsh-wait-chime/chime-upload`|替换音效：body 是音频原始字节，`X-Chime-Name` 头给显示名（≤ 4 MB，按文件头识别）|
|`POST`|`/dsh-wait-chime/chime-reset`|恢复内置默认音效|
|`GET`/`POST`|`/dsh-wait-chime/client-report.json`|页面侧自报诊断（slots/react 是否可用、面板是否渲染）|
|`GET`|`/dsh-wait-chime/events.json`|见过的会话事件类型与次数、页面轮询计数|

所有路由拒绝 `Sec-Fetch-Site: cross-site`；全部不含凭据。默认监听 DSH 自己的 HTTP 端口（桌面端为 `127.0.0.1:19387`）。

## 开发

```bash
npm test          # = node test/smoke.mjs
```

冒烟测试用假宿主覆盖：事件识别（提问 / 审批 / 冷却 / `decided` 不重复）、配置读取与热更新、写路由、音频路由、跨站拒绝、诊断计数、状态落盘。

改了 `lib/` 下的代码后，**必须重启 DSH 桌面端**才会加载新的宿主/客户端代码（配置改动则不用）。

## 排错

|现象|先查|
|-|-|
|设置里没有「等待提醒」|`GET /dsh-wait-chime/client-report.json`：看 `slotsFound` / `hasReact` / `panelRendered`|
|完全不响|控制台有没有 `\\\[dsh-wait-chime] 等待提醒已启动`；`pending.json` 的 `seq` 会不会涨|
|第一次没声|自动播放策略：在页面里点一下解锁|
|提问不响|`events.json` 里有没有 `tool/call`；`pending.json` 的 `kind` 是不是 `question`|
|审批不响|`events.json` 里有没有 `approval/asked`（只有 `approval/decided` 说明没抓到询问那一刻）|
|声音太轻 / 太吵|设置面板拖响度滑块，或改 `.dshw-wait.json` 的 `boost`（1 秒生效）|
|桌面端起不来|profile 的 `package.json` 是不是被写进了 BOM（见上文）|

## 卸载

从 `%USERPROFILE%\\\\.dsh\\\\profiles\\\\desktop\\\\package.json` 的 `dsh.profile.bundles` 里删掉 `"dsh-wait-chime"` 一行，重启即可（`dependencies` 那行留着无副作用）。彻底清理再删除 `node\\\_modules\\\\dsh-wait-chime` 这个 junction 和插件目录。

## 素材

`assets/say1.ogg` 取自第三方 Minecraft 音效镜像站，音色是《Minecraft》里的**蠹虫（Silverfish）音效，其权利归 Mojang Studios / Microsoft 所有。它不在 MIT 覆盖范围内**，本仓库不主张任何权利、也不代表已获授权——随插件「原样」提供，只为开箱可用。

逐项来源、许可范围的划分与 takedown 方式见 [**PROVENANCE.md**](PROVENANCE.md)。想换成自己的音效：在设置面板的「音效」一行选文件即可，或直接替换 `assets/say1.ogg`（支持 mp3 / ogg / opus / wav / m4a / aac / flac / webm）。

## License

MIT（见 [LICENSE](LICENSE)）。素材另有说明，见上。

