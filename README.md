# 🎙️ MiGPT-X

[![构建并推送镜像](https://github.com/Zayo-x/MiGPT-X/actions/workflows/docker.yml/badge.svg)](https://github.com/Zayo-x/MiGPT-X/actions/workflows/docker.yml)
[![镜像](https://img.shields.io/badge/ghcr.io-migpt--x-blue)](https://github.com/Zayo-x/MiGPT-X/pkgs/container/migpt-x)

> 把小爱音箱接上大模型，给它一个自己的人格，还能连续对话
> 全功能的 Web 控制台，所有配置可以在线更改

```
引擎    MiGPT-X 自研（在 MiGPT 思路上重写并大幅扩展）
版本    MiGPT-X v1.0.0
部署    Ubuntu 24.04.5 · systemd 或 Docker 两种方式
音箱    小爱音箱 Play（LX05）· 固件 1.82.10
模型    DeepSeek（cn:deepseek-v4.1-flash）
音色    小米 MiMo-V2.5-TTS / 微软 edge-tts（面板可切换）
控制台  http://<本机局域网IP>:36593
```

**一句指令部署：**

```bash
docker run -d --name migpt-x -p 36593:36593 -v migpt-data:/data \
  --restart unless-stopped ghcr.io/zayo-x/migpt-x:latest
```

---

## 📖 目录

- [它解决什么问题](#-它解决什么问题)
- [整体架构](#-整体架构)
- [核心特性](#-核心特性)
- [Docker 部署（一句指令）](#-docker-部署一句指令)
- [目录结构](#-目录结构)
- [配置说明](#-配置说明)
- [控制台使用](#-控制台使用)
- [连续对话模式](#-连续对话模式)
- [运维手册](#-运维手册)
- [常见问题排查](#-常见问题排查)
- [与上游的差异](#-与上游的差异)
- [已知问题](#-已知问题)

---

## 🎯 它解决什么问题

原版 MiGPT 能把小爱接上大模型，但有几个硬伤：

| 痛点 | MiGPT-X 的做法 |
|---|---|
| 每说一句都要喊「小爱同学」 | **连续对话模式**：说一次「开始聊天」，之后随便说 |
| 首次回答要等 20+ 秒（TTS 现场生成） | **缓存固定话术**：确认语预生成，1 秒内响应 |
| 回答完了音箱就"聋"了 | **自动补唤醒**：播完算时长，自动发唤醒指令 |
| 原版音色很机械 | **音色复刻**：用参考音频克隆音色，还能调语速 |
| 配置要改文件 + 重启 | **Web 控制台**：在线编辑、校验、备份、一键回滚 |
| 不知道自己音箱该用什么指令 | **21 款机型适配表**：点「应用」自动填指令 |
| 中文里"含关键词"太容易误触发 | **匹配方式开关**：「以触发词开头」/「含触发词」二选一 |

---

## 🏗️ 整体架构

```
                    ┌──────────────────────────────┐
   客厅说话    ────► │      小爱音箱 LX05           │
                    │      did = 123456789         │
                    └──────────────┬───────────────┘
                                   │ 小米云端（MiNA / MIoT）
                    ┌──────────────▼───────────────┐
                    │  ① migpt-next   主引擎        │
                    │                              │
                    │  轮询消息 ──► 触发词判定       │
                    │      │                       │
                    │      ├──► DeepSeek 生成回复    │
                    │      ├──► MiMo 生成语音        │
                    │      ├──► 播放 + 等播完        │
                    │      └──► 补唤醒 [5,3]        │
                    └───┬──────────────────────┬───┘
                        │                      │
          ┌─────────────▼──────────┐  ┌────────▼─────────────┐
          │ ② migpt-panel  :36593  │  │ ③ migpt-tts  :36594  │
          │                        │  │                      │
          │  状态 / 日志 / 在线配置  │  │  MiMo 音色复刻        │
          │  校验 / 备份 / 回滚     │  │  长度守卫 + 自动回退   │
          └────────────┬───────────┘  └──────────────────────┘
                       │
                  你的浏览器
```

### 三个常驻服务

| 服务 | 端口 | 作用 | 主要代码 |
|---|---|---|---|
| `migpt-next` | — | 主引擎：轮询消息、调 AI、驱动音箱 | `config.js`（343 行） |
| `migpt-panel` | 36593 | Web 控制台 + 配置编辑 + 备份回滚 | `server.mjs`（370 行）、`index.html`（884 行） |
| `migpt-tts` | 36594 | MiMo TTS 微服务（音色复刻） | `tts_server.py` |

> `migpt-tts` 是 **TTS 微服务**，同时提供两套引擎：
> 小米 MiMo-V2.5-TTS（复刻 / 文字描述）与微软 edge-tts（免费免 Key）。
> 用哪套由 `editable.json` 的 `tts.engine` 决定，面板可一键切换。

---

## ✨ 核心特性

### 🗣️ 连续对话模式

说一次唤醒词进入，之后**不用再喊「小爱同学」**：

```
你：小爱同学，开始聊天
🔊 哟西，聊天的干活，放马过来的！        ← 预生成音频，1 秒内响应
（等它播完约 1 秒）
你：今天天气怎么样                        ← 不用喊唤醒词
🤖 （AI 回答，大佐腔）
👂 自动补唤醒 → 音箱继续听
你：那明天呢
🤖 ...
你：小爱同学，结束聊天
🔊 哟西，聊天结束的干活，解散！
```

**实现要点**：上游 MiGPT-Next **完全没有** 保持唤醒状态的代码。
我们从原版 MiGPT（idootop/mi-gpt）扒出 `keepAlive` 机制移植过来：

```
播报 → ffprobe 算出音频时长 → 等它播完 → MIoT doAction(5, 3) 补唤醒
```

`[5, 3]` 是 LX05 的官方 `wakeUpCommand`（见机型适配表）。

### 🎭 自定义人格

面板「对话行为 → 人设」直接编辑系统提示词，当前是 482 字的**大佐腔**：

> 说中文的抗日剧日军大佐，语气傲慢、自信、爱用「哟西」

配合 `disableThinking: true` 关闭推理模型的思考过程，首字延迟明显下降。

### 🎙️ 语音合成（双引擎，面板一键切换）

面板「播报音色 → TTS 引擎」三选一：

| 引擎 | 延迟 | 费用 | 特点 |
|---|---|---|---|
| **小米 MiMo 复刻** `clone` | 3~25 秒（波动大） | 需 MiMo Key | 用参考音频克隆音色，**最像原声** |
| **小米 MiMo 文字描述** `mimo` | 约 1.3 秒 | 需 MiMo Key | 用风格指令造音色，快 |
| **微软 edge-tts** `edge` | **约 1.3~1.9 秒** | **免费免 Key** | 音色多（含方言），稳定 |

- 参考音频（clone 用）：`/root/tts-samples/vc2.mp3`（实测 7 秒最佳）
- 语速：`speed: 1.5`。小米引擎用 ffmpeg `atempo` 变速，
  微软引擎换算成 edge 自带的 `rate` 百分比（1.5 → `+50%`），**两者音调都不变**
- 微软音色：面板下拉可选 8 个中文音色
  （晓晓/晓伊/云希/云健/云扬/云夏 + 东北话晓北/陕西话晓妮）
- **长度守卫**（小米引擎）：复刻偶尔会失控（实测 18 字生成 48 秒音频），
  超限自动重试，两次不合格回退到风格引擎 `voicedesign`
- **固定话术缓存**：确认语、占位语预生成成 `fixed-*.mp3`，跳过实时生成

> 微软引擎失败时**不会**静默换成小米音色 —— 直接报错让 `config.js`
> 回退到音箱内置语音（你选微软是有原因的）。小米复刻失败才会回退到风格引擎。

### 🔤 触发词 + 匹配方式

面板「对话行为 → 触发词」，一栏一个，两种匹配方式可切换：

| 模式 | 行为 | 适合 |
|---|---|---|
| **以触发词开头** | `msg.startsWith(kw)` | 精确，少误触发。原版 MiGPT 行为 |
| **含触发词** | `msg.includes(kw)` | 灵敏。「嗯，你是谁」也能触发 |

> ⚠️ 中文里「我」「怎么」这类词出现频率极高，用「含触发词」几乎每句都会被塞给 AI。
> 触发词包含这类高频词时，建议用「以触发词开头」。

### 🏠 保留小爱原生能力

设备指令自动让给小爱处理，不抢活：

```
`打开` `关闭` `暂停` `继续` `下一首` `音量` `静音` `播放` …
```

每条消息先判断：小爱能答 → 交给小爱；答不上来 → AI 接管。
（可在面板关闭 `keepNativeAnswer` 强制 AI 接管）

---

## 🐳 Docker 部署（一句指令）

不想装 Node、不想配 systemd、不想自己编译 —— 一条命令跑起来：

```bash
docker run -d --name migpt-x \
  -p 36593:36593 \
  -v migpt-data:/data \
  --restart unless-stopped \
  ghcr.io/zayo-x/migpt-x:latest
```

然后浏览器打开 `http://<这台机器的局域网IP>:36593`。

### 首次使用

镜像里**不含任何密钥**，全部配置从挂载卷读取。第一次启动会自动生成一份模板，
打开面板按提示填，保存即生效：

| 填什么 | 在哪个标签页 | 说明 |
|---|---|---|
| 设备 ID / userId / passToken | 🔊 音箱连接 | 用 passToken 最省事，不会触发异地登录风控 |
| API 地址 / Key / 模型 | 🧠 AI 模型 | 任意 OpenAI 兼容接口 |
| 音频地址前缀 | 🎙️ 播报音色 | **必须改成这台机器的局域网 IP**，见下 |
| 触发词 / 人设 | 💬 对话行为 | 按喜好调 |

### ⚠️ 最容易踩的坑：音箱拉不到音频

音箱是**自己去下载**播报音频的，不是服务器推过去的。所以「播报音色 → 音频地址前缀」
必须填成**音箱能访问到的地址**：

```
✅ http://192.168.1.50:36593     这台机器的局域网 IP
❌ http://127.0.0.1:36593        音箱访问的是它自己
❌ http://localhost:36593        同上
```

端口映射（上面那条命令）和 `--network host` 都行，只要那个地址从音箱所在网络能通。

### 数据在哪

所有会变的东西都在 `/data` 卷里，删容器、换镜像都不丢：

```
/data
├── editable.json     配置（带密钥，所以绝不进镜像）
├── .mi.json          小米登录缓存
├── backups/          面板每次保存配置的自动快照
├── tts/              生成的播报音频
├── engine.log        引擎日志（面板读它显示实时对话）
└── control/          面板给守护进程发的重启/停止请求
```

备份就是把这个卷拷走：

```bash
docker run --rm -v migpt-data:/data -v "$PWD:/backup" alpine \
  tar czf /backup/migpt-x-backup.tar.gz -C /data .
```

### 用 docker compose

```bash
git clone https://github.com/Zayo-X/MiGPT-X.git
cd MiGPT-X
docker compose up -d
```

### 从源码构建（国内网络）

```bash
docker build -t migpt-x \
  --build-arg NPM_REGISTRY=https://registry.npmmirror.com \
  --build-arg PIP_INDEX=https://mirrors.aliyun.com/pypi/simple/ \
  --build-arg APT_MIRROR=mirrors.aliyun.com \
  .
```

| 参数 | 官方源 | 国内镜像 |
|---|---|---|
| `NPM_REGISTRY` | `https://registry.npmjs.org/` | `https://registry.npmmirror.com` |
| `PIP_INDEX` | `https://pypi.org/simple/` | `https://mirrors.aliyun.com/pypi/simple/` |
| `APT_MIRROR` | 留空（Debian 默认） | `mirrors.aliyun.com` |

> 构建需要 2~3 GB 磁盘。首次要拉基础镜像和依赖，之后有层缓存会快很多。
> Dockerfile 里刻意**没有**写 `# syntax=docker/dockerfile:1` —— 那行会让 BuildKit
> 去拉 `docker/dockerfile` 镜像，而它在 Docker 官方命名空间下、国内加速镜像不代理，
> 会卡在几十 KB/s。本文件没用到任何需要该指令的语法。

### 两个已知的坑

**① 如果你 fork 了自己构建，GHCR 的包可能是私有的**

本仓库的 `ghcr.io/zayo-x/migpt-x` 已验证可匿名拉取。但换到你自己的仓库后，
第一次推送出来的包**有可能**是私有的，那样别人 `docker pull` 会 403。这时去
仓库页面右侧 `Packages` → 进入 `migpt-x` → `Package settings` →
`Change visibility` → 改成 **Public** 即可。

验证方法（能拿到标签列表就是公开的）：

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:<用户名>/migpt-x:pull&service=ghcr.io" | jq -r .token)
curl -s -H "Authorization: Bearer $TOKEN" https://ghcr.io/v2/<用户名>/migpt-x/tags/list
```

**② 仓库里的 `.npmrc` 内容是 `22.14.0`**

那是历史遗留（不是合法的 npm 配置项）。构建时 pnpm 会忽略它，不影响使用。

### 容器里的进程模型

宿主机部署用三个 systemd 服务；容器里没有 systemd，改由入口脚本统一拉起：

```
entrypoint.sh ─┬─ python3 tts_server.py     TTS 微服务（36594，仅容器内）
               ├─ node supervisor.mjs        引擎守护进程 + 日志落盘
               └─ node server.mjs            控制台面板（36593）
```

面板会自己识别环境（`MIGPT_MODE=local`），把「状态查询 / 实时日志 / 重启按钮」
从 `systemctl` + `journalctl` 切换成「读日志文件 + 写请求文件」，界面完全一样。

引擎崩了守护进程自动拉起，连续快速失败会退避重试（3/6/12/24/48/60 秒），
所以配置没填好时不会把日志刷爆。

---

## 📁 目录结构

```
/root/migpt-next-2/                  ← 引擎
├── config.js                        ★ 343 行，所有核心逻辑
├── editable.json                    ★ 唯一配置源（面板读写这个）
├── editable.json.bak                ← 各类备份
├── start.mjs                        ← 启动入口
├── .mi.json                         ← 小米登录会话缓存（含 token，注意保密）
├── packages/                        ← MiGPT-Next 上游代码
│   ├── next/   引擎主体
│   ├── engine/ 基类（含 onMessage 调度）
│   ├── miot/   小米 IoT API 封装
│   ├── chat/   对话上下文
│   └── ...
├── backups/                         ← 配置自动备份（保留 20 份）
└── docs/                            ← 上游文档

/root/migpt-panel/                   ← 控制台
├── server.mjs                       ★ 370 行，HTTP 服务 + 白名单校验
├── index.html                       ★ 884 行，单文件控制台（零外部依赖）
├── tts_server.py                    ← MiMo TTS 微服务（:36594）
├── cmd.json                         ← 面板 → 引擎的命令通道
├── chat-mode                        ← 存在=连续对话开启中
├── no-restart                       ← 存在=安全模式（不自动重启引擎）
└── tts/                             ← 生成/缓存的音频
    ├── fixed-chatmode-on.mp3        ← 「开始聊天」确认语（预生成）
    ├── fixed-chatmode-off.mp3       ← 「结束聊天」确认语
    └── fixed-placeholder.mp3        ← 占位语「哟西」

/root/tts-venv/bin/edge-tts          ← ⚠️ 名字是遗留的，其实是转发到 TTS 微服务的 bash 脚本
/root/tts-samples/vc2.mp3            ← 音色复刻参考音频
```

---

## ⚙️ 配置说明

**唯一配置源是 `/root/migpt-next-2/editable.json`** —— 面板直接读写它，改完自动备份。

### 音箱连接 `speaker`

| 字段 | 说明 | 当前值 |
|---|---|---|
| `did` | 设备编号。**可填设备名称 / MAC / 数字 ID** | `123456789`（示例） |
| `userId` | 小米 ID（纯数字，**不是手机号或邮箱**） | `1234567890`（示例） |
| `passToken` | 登录凭证（约 370 字符）。比密码登录更安全 | `V1:pwROA…` |
| `heartbeat` | 消息轮询间隔（毫秒） | `500` |

> **设备 ID 获取方式**：直接填音箱名称（如「小爱音箱Play」）也行 ——
> 引擎匹配时用的是 `[deviceID, miotDID, name, alias, mac].includes(did)`。
> 想看数字 ID 就打开「调试日志」重启引擎，启动日志会打印设备列表。

### AI 模型 `openai`

| 字段 | 当前值 |
|---|---|
| `baseURL` | `https://api.xuan-luo.top/v1` |
| `model` | `cn:deepseek-v4.1-flash` |
| `disableThinking` | `true`（推理模型必开，否则 `content` 为空） |
| `timeout` | `60000` |

### 对话行为

| 字段 | 当前值 | 说明 |
|---|---|---|
| `callAIKeywords` | 9 个触发词 | 一栏一个 |
| `kwMatch` | `start` | `start`=以触发词开头 / `contain`=含触发词 |
| `placeholder` | `"哟西"` | 调 AI 前先播，抢占语音通道 |
| `persona` | 482 字 | 系统提示词 |
| `keepNativeAnswer` | `false` | 是否保留小爱原生回答 |
| `historyMaxLength` | `10` | 带多少条上下文 |
| `maxReplyLength` | `100` | 回复字数上限 |

### 播报音色 `tts`

| 字段 | 当前值 | 说明 |
|---|---|---|
| `engine` | `clone` | `clone`=复刻音色 / `mimo`=文字描述音色 |
| `cloneRef` | `/root/tts-samples/vc2.mp3` | 参考音频 |
| `cloneTimeout` | `25` | 超过就回退到描述音色 |
| `speed` | `1.5` | 语速倍率 |
| `baseUrl` | `http://192.168.1.50:36593` | 音箱从这里拉音频，**必须是音箱能访问到的地址** |
| `fallbackToBuiltin` | `true` | 生成失败时用音箱内置语音，保证不变哑巴 |

### 高级（机型相关）

| 字段 | LX05 值 | 说明 |
|---|---|---|
| `ttsAction` | `[5, 1]` | 「播放文本」指令 siid/aiid |
| `wakeUpAction` | `[5, 3]` | 补唤醒指令（原版叫 `wakeUpCommand`） |

> 不知道填什么？面板「音箱连接」页有 **21 款机型适配表**，找到自己的型号点「应用」自动填。

---

## 🖥️ 控制台使用

访问 **http://192.168.1.50:36593**（局域网内，已配 ufw 白名单）

### 六个标签页

```
🔊 音箱连接   21 款机型适配列表（默认展开）+ 设备 ID / userId / passToken
             每个字段都写了「获取方式」
🤖 AI 模型    API 地址、Key、模型名、关闭思考模式、走代理
💬 对话行为   触发词（一栏一个 + 匹配方式开关）、占位语、人设、开关项
🎙️ 播报音色   TTS 模式、参考音频、语速、超时、风格指令
⚙️ 其它       历史条数、回复上限、调试日志
🔧 高级       TTS 指令 siid/aiid、唤醒指令 siid/aiid
```

### 顶部操作栏

| 按钮 | 作用 |
|---|---|
| 状态徽章 | 引擎运行状态（绿=在线，带呼吸灯） |
| 模式条 | 显示连续对话是否开启 + 一键开关 |
| 👂 唤醒音箱 | 手动补发唤醒指令（不用喊小爱同学让音箱进入聆听） |
| 🔇 静音音箱 | 打断当前播放 |
| 重启 / 启动 / 停止 | 控制引擎服务 |

### 底部实时日志

彩色分类，一眼看出发生了什么：

```
🔥 听到       你说了什么
🔊 已播报     AI 回复 + TTS 播放
🔈 原生应答   小爱自己回答的
⚠️ 警告       异常但可降级
✅ 系统       启动、保存成功
```

### 保存的安全机制

```
点保存
  ├─ 白名单校验：字段类型、范围逐项检查（不合规直接拒绝，不动配置）
  ├─ 自动备份：写入 /root/migpt-next-2/backups/配置-时间戳.json
  ├─ 写入 editable.json
  ├─ 重启引擎
  └─ 启动失败？ → 自动回滚配置 + 进入安全模式（写 no-restart 文件）
```

**回滚**：面板「回滚」按钮恢复上一个备份。

---

## 🔄 连续对话模式

### 开启

```
你：小爱同学，开始聊天
🔊 哟西，聊天的干活，放马过来的！
```

**关键：等这句播完（约 1 秒）再说下一句** —— 补唤醒指令在播完后才发。

### 使用

- 之后**不用喊唤醒词**，直接说话
- 每次 AI 回答完，引擎会自动补唤醒，音箱继续听
- **设备指令仍然走小爱原生**（开灯、放歌、调音量）
- 如果静默超过 3~10 秒，音箱可能自动退出聆听 → 再喊一次「小爱同学」即可

### 关闭

```
你：小爱同学，结束聊天
🔊 哟西，聊天结束的干活，解散！
```

> 退出时**还是需要喊唤醒词的**，因为要先把音箱叫醒才能听到这句话。

### 界面开关

面板顶部模式条也能直接切换，同时会同步写 `chat-mode` 文件。

---

## 🔧 运维手册

### 服务管理

```bash
systemctl status  migpt-next  migpt-panel  migpt-tts
systemctl restart migpt-next
systemctl is-active migpt-next
```

### 看日志

```bash
journalctl -u migpt-next -f              # 实时
journalctl -u migpt-next --since "10 min ago"
journalctl -u migpt-next | grep -E "唤醒|保存|报错"
```

### ⚠️ 铁律：只能有一个引擎在跑

小米会风控并发登录（返回 `70016`）。检查：

```bash
ps -ef | grep "[s]tart.mjs" | grep -v "bash -c" | wc -l    # 必须是 1
```

**绝对不要**用 `import('./config.js')` 之类的方式验证语法 —— 导入即登录，会触发第二个会话。
验证语法请用 `node --check`（ESM 文件要加 `--input-type=module`）或观察 systemd 实际启动结果。

### 备份与恢复

```bash
# 配置备份（面板每次保存自动生成）
ls -lt /root/migpt-next-2/backups/ | head

# 手动备份
cp /root/migpt-next-2/editable.json /root/migpt-next-2/editable.json.$(date +%s)

# 代码备份（开发时留下的）
ls /root/migpt-next-2/config.js.bak-*
```

### Node 版本（重要）

```
/root/.nvm/versions/node/v24.14.1/bin/node   ← 引擎/面板用这个（nvm）
/usr/bin/node (v18.19.1)                     ← 青龙面板在用，⚠️ 千万别全局升级
```

运行本地命令记得先：

```bash
export PATH=/root/.nvm/versions/node/v24.14.1/bin:$PATH
```

### ⚠️ 提交代码前必看（密钥防护）

仓库 `origin` 指向了上游仓库 ✗ ——
而 **`editable.json` 里含 3 个真实密钥**：

```
openai.apiKey        大模型中转站密钥
tts.mimoApiKey       小米 MiMo 密钥
speaker.passToken    小米账号登录凭证（有效期很长，泄漏等于账号被接管）
```

`.gitignore` 已挡住下列路径（**不要**用 `git add -f` 强加）：

```
editable.json        editable.json.*        backups/
*.bak                *.bak-*                *.pre-*.bak
```

提交前自检：

```bash
cd /root/migpt-next-2

# ① 未跟踪列表里不该出现 editable.json / *.bak / backups
git status --porcelain | grep '^??'

# ② 全历史搜索 passToken 特征串（应为空）
PT=$(node -e "console.log(require('./editable.json').speaker.passToken.slice(0,30))")
git log --all -p -S"$PT" --oneline
```

> 截至 v1.0.0，git 历史中**从未**出现过这些密钥（已全量核查 ✅），
> 但 `backups/` 目录里 20 个配置快照**全都含 passToken** —— 所以它必须保持被忽略。

### 安全模式

引擎启动失败时，面板会自动写入 `/root/migpt-panel/no-restart`，
此时不再自动重启（避免无限崩溃循环），面板顶部会显示黄色警告条。
修好配置后删掉该文件即可恢复。

---

## 🔍 常见问题排查

### 「⚠️ 唤醒指令异常: Cannot read properties of undefined (reading 'doAction')」

**已修复**。原因是唤醒指令跑在了 `MiService.init()` 完成之前 ——
面板每次保存都会重启引擎，重启后约 5 秒内点「唤醒音箱」就会踩到。

现在 `wakeUp()` 会先等引擎就绪（最多 20 秒）：

```
⏳ 引擎正在登录小米服务，等它就绪…
👂 已补唤醒指令，现在可直接说话（不用喊小爱同学）
```

### 进入聊天模式后说话没反应

1. **先等确认语播完** —— 补唤醒在播完后才发，大概 1 秒
2. 静默太久音箱退出了聆听 → 重新喊「小爱同学」
3. 语音识别可能把「开始聊天」识别成别的 → 看面板日志里 `🔥 听到` 是什么

### AI 不回复 / `content` 为空

推理模型必须关掉思考过程：

```json
"openai": { "disableThinking": true }
```

### 首次回答特别慢（20~30 秒）

MiMo 音色复刻延迟波动很大（实测 2~25 秒）。缓解手段：

1. **固定话术已缓存**（`fixed-*.mp3`）—— 确认语、占位语是秒回的
2. 调小 `tts.cloneTimeout`（比如 10 秒）→ 超时自动回退到文字描述音色（快得多）
3. 改用 `engine: "mimo"`（文字描述音色，约 1.5 秒）

### 音箱不播报 / 提示 `player_play_url 未成功`

- 检查 `tts.baseUrl` 是否是**音箱能访问到的地址**（不是 `127.0.0.1`）
- 检查 `migpt-tts` 服务是否在跑：`systemctl is-active migpt-tts`
- 测试网络：从音箱所在网段访问 `http://192.168.1.50:36593/tts/`

### 小米风控 `70016`

**不要**创建额外的登录会话。确保只有一个引擎进程，且不要反复重启。

### 改动没生效

- 面板改完必须点**保存**（会重启引擎）
- 浏览器按 **Ctrl + F5** 强制刷新（面板 HTML 有缓存）

---

## 🆚 与上游的差异

| 能力 | 原版 MiGPT | MiGPT-Next | **MiGPT-X** |
|---|---|---|---|
| 接入大模型 | ✅ | ✅ | ✅ |
| 保留小爱原生回答 | ✅ | ✅ | ✅ |
| 连续对话（keepAlive） | ✅ | ❌ **完全没有** | ✅ **移植自原版** |
| 播放完成检测 | 流式回调 | — | ffprobe 算音频时长 |
| 音色复刻 | ❌ | ❌ | ✅ MiMo voiceclone |
| Web 控制台 | ❌ | ❌ | ✅ 单文件零依赖 |
| 在线配置编辑 | ❌ | ❌ | ✅ 校验+备份+回滚+安全模式 |
| 独立聊天模式 | ✅ wakeUp | ❌ | ✅ 独立文件状态机 |
| 固定话术缓存 | ❌ | ❌ | ✅ 消除首响延迟 |
| 机型适配表 | 文档 | 文档 | ✅ 面板内一键应用 |
| 触发词匹配方式 | 硬编码 startsWith | 硬编码 startsWith | ✅ 面板开关 |

---

## ⚠️ 已知问题

| 问题 | 影响 | 状态 |
|---|---|---|
| ~~`migpt-tts` 服务描述写着「edge-tts 常驻」~~ | ~~只是描述过时~~ | ✅ 已修正为「双引擎」 |
| `/root/tts-venv/bin/edge-tts` 文件名是遗留的 | 实为转发到 TTS 微服务的 bash 脚本（`config.js` 硬编码了该路径） | 保留 |
| 目录名仍是 `/root/migpt-next-2` | 项目已叫 MiGPT-X | 待改 |
| 仓库里散落 11 个 `config.js.bak-*`、7 个面板备份 | 占空间、看着乱 | 待清 |
| 磁盘使用率 86%（94G/116G） | 约 2G 的 torch/demucs 是没用的 | 待清 |
| **`pip install -U edge-tts` 会覆盖包装脚本** | ⚠️ pip 会重装同名的 console script，把 `/root/tts-venv/bin/edge-tts`（我们的转发脚本）冲掉，导致播报静默失效。升级后必须把脚本写回来，并用 `wc -c` 确认大于 200 字节 | **注意** |
| MiMo 复刻延迟 3~12 秒，偶发飙到 70 秒以上 | 首次回答慢，极端情况下外接 TTS 被判超时、回退内置电子音 | 已把包装脚本超时从 70s 提到 150s、面板等待提到 150s；正常 3~12 秒由缓存兜住 |

---

## 📜 致谢

- [idootop/mi-gpt](https://github.com/idootop/mi-gpt) —— 原版 MiGPT，本项目参考了它的 keepAlive 机制
- [idootop/migpt-next](https://github.com/idootop/migpt-next) —— MiGPT-Next，本项目在其思路上重写
- [home.miot-spec.com](https://home.miot-spec.com) —— MIoT 指令查询
- 小米 MiMo 开放平台 —— TTS 音色复刻

---

<p align="center">
  <b>MiGPT-X v1.0.0</b><br>
  <sub>作者 <a href="https://github.com/Zayo-x">Zayo-x</a> · MIT License</sub><br>
  <sub>控制台 <a href="http://192.168.1.50:36593">http://192.168.1.50:36593</a></sub>
</p>
