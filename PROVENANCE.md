# 素材来源与许可范围（PROVENANCE）

本仓库的**代码**按 MIT 许可（见 [`LICENSE`](LICENSE)）。`assets/` 下的**音频素材不在 MIT 覆盖范围内**，按下面的说明「原样提供」。

## 一、许可范围

| 范围 | 许可 |
|---|---|
| `lib/`、`test/`、`cordis.patch.yml`、`package.json`、文档 | **MIT**（见 [`LICENSE`](LICENSE)） |
| `assets/**`（音效） | **不适用 MIT**：按 **as-is** 随插件分发，仅用于运行本插件；**不授予再许可，也不声明为原创作品**。 |

这么划分的原因：代码可以明确授权，而音频素材的权利状态无法由本仓库百分之百举证。与其给一个站不住的授权，不如如实标注范围，并承诺收到权利主张就处理（见第三节）。

## 二、素材来源

| 文件 | 来源 / 说明 |
|---|---|
| `assets/say1.ogg` | 提示音。取自第三方 Minecraft 音效镜像站（<https://o.xbottle.top/mcsounds/>），音色为游戏《Minecraft》中的**蠹虫（Silverfish）**音效。 |

**关于版权**：该音效的权利归 **Mojang Studios / Microsoft** 所有。Minecraft 官方 [Usage Guidelines](https://mojang.com/zh-hans/usage-guidelines) 将游戏内的 "sounds and other audio" 明确列为 Mojang 的 assets，EULA 亦含 *Prohibition on Distribution and Commercial Use* 条款（"未经我们许可，不要分发或商业使用我们制作的任何东西"）。

因此本仓库对其**不主张任何权利，也不代表已获授权** —— 它只是随插件「原样」提供以便开箱可用。若你打算再分发或商用，**请自行取得授权，或替换成你有权使用的音频**（见第三节末）。

## 三、权利主张 / Takedown

如果你认为 `assets/` 中的素材侵犯了你的权利，请在本仓库开一条 issue，说明**文件名**与**依据**，我们会在核实后**立即替换或移除**，不附加其它条件。也欢迎直接提供可自由再分发的替代素材。

## 四、想换成自己的音效

插件自带替换入口，**不用改代码**：

- **在 DSH 设置里**：设置 → 等待提醒 → 「音效」一行选一个本地文件即可，改完立刻生效；
- **或直接替换文件**：把 `assets/say1.ogg` 换掉（支持 mp3 / ogg / opus / wav / m4a / aac / flac / webm；按文件头识别，改扩展名没用）。

适合作为替代的**可自由再分发**音源：自制录音、CC0 音效库（如 freesound.org 的 CC0 条目）、或自己合成。
