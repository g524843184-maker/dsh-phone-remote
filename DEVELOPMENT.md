# 开发说明（DEVELOPMENT）

这份文档写给想改代码的人。想直接用请看 [README](README.md)。

---

## 一、它解决什么问题

手机打字慢、切窗口烦、提醒看不到。所以把手机变成 Mac 的**外接终端**：

```
说（语音输入）→ 看（1:1 屏幕镜像）→ 摸（触控板手势）
                        ↓
             听（语音回读，按来源决定从哪台设备出声）
                        ↓
             切（大聪明 / 小聪明 / 大管家，一键激活 + 全屏）
```

技术选型只有一个原则：**零第三方依赖**。整个服务只用 Node 内置模块 + macOS 自带命令，
没有 npm 安装步骤，没有编译步骤，掉进坑里也好查。

---

## 二、为什么是「插件 + 它拉起的服务」

这是本项目最容易让人困惑的一点。

DSH 的 web 服务只监听 `127.0.0.1`，而手机必须从**局域网**访问 → 纯插件形态不可行。
把 DSH 改成监听 `0.0.0.0` 又等于把整个 GUI 暴露到局域网，不能这么干。

所以插件做的事是：**启动时 `spawn` 同包内的 `server/server.cjs`，绑定 `0.0.0.0:8787`**。

```
DSH 主进程
  └─ 插件 apply()  ──spawn──▶  server.cjs (:8787)  ◀──HTTP── 手机浏览器
        ↑                          ↑
   继承 DSH 的 TCC 权限        同样继承（responsible process 是 DSH.app）
```

关键点：**macOS 的 TCC 授权单位是「负责任进程」= 那个 .app**。
子进程的负责进程是 DeepSeek Harness，所以它自动获得 DSH 已授权的
「辅助功能」和「屏幕录制」，不需要再单独授权一个应用。

生命周期：`ctx.effect(() => () => child.kill())`，插件卸载/DSH 退出时收掉。
服务意外退出会 2 秒后重启。

> 包是 ESM（`"type": "module"`），但服务本体是 CommonJS，所以文件名必须是 `.cjs`，
> 否则 `require is not defined`。

---

## 三、代码地图

```
lib/index.js          host 入口：spawn 服务、转发日志、生命周期、退出清理
server/server.cjs     全部后端（~1100 行，单文件，分区清楚）
server/index.html     全部前端（~860 行，单文件，内联样式与脚本）
```

### server.cjs 分区（按出现顺序）

| 区 | 内容 |
|---|---|
| 配置 | 端口、白名单 `KEYS` / `APPS` / `SWITCH`、token |
| 输入注入 | `typeText`（剪贴板+⌘V）、`buildKeyScript`、`osa`、`launchApp` |
| 屏幕 | `captureScreen`/`doCapture`（**串行链**）、`decodePngGray`、`sampleBrightness` |
| 模式识别 | `detectSurface`（判 DSH 当前是经典界面还是大管家界面） |
| 指针 | `mouseArgv`、`mouse`（cliclick） |
| 语音 | 转写监听 → 过滤 → 分段合成 → 路由 → 待播队列 |
| 切换 | `frontApp`、`waitFront`、`switchTo` |
| 路由 | 23 个 HTTP 端点 |

### 前端手势判定链

| 手指数 | 判定 | 动作 |
|---|---|---|
| 1 | 轻点（≤420ms、位移<12） | 单击（180ms 内连点=双击） |
| 1 | 长按 >520ms 后移动 | `dd` 起拖 → `dm` 跟手 → `du` 收尾 |
| 1 | 移动 | 相对移动（节流 30ms，加速度 0.55~3×） |
| 2 | 竖向平移 | 每 60px 一页滚动 |
| 2 | 轻点（<260ms） | 右键 |
| 2 | 间距变化 >34px | `⌘+` / `⌘-` |
| 3/4 | 位移 >22px（当场触发） | 主方向 `Ctrl+↑↓←→` |

---

## 四、四个核心机制

### ① 语音路由：机制判定，不是模型判定

每轮对话结束（转写里出现 `turn/end`），读**系统剪贴板**，与这一轮的 `user/message`
空白归一后比较：

```
exact  完全一致            → 手机（排队，等手机来取）
prefix 剪贴板是消息开头     → 手机（粘完又在 Mac 上补了）
inside 夹在中间且 ≥8 字     → 手机（输入框原有草稿）
其它                      → Mac（afplay 本地播）
```

为什么能这么判：**只有手机那条路会经过「写剪贴板 + ⌘V」**，Mac 键盘敲出来的内容与剪贴板无因果关系。

短文本（<2 字）不判手机 —— "好""嗯"太容易误中。**宁可漏判，不要错判**：
漏判只是声音走 Mac，错判会把声音送到错的设备。

自检/回归：`POST /say/testroute {userText, clipText?}` 返回 `{exact, prefix, inside, decision}`。

### ② 分段流式合成

220 字一段，第一段合成完就入队；手机播完 `POST /say/ack` 推进下一段。
本地 TTS（GENIE）单段合成要十几秒，不分段的话首声要等很久。

### ③ 全屏固定坐标 + 模式识别

DSH 是 Electron，侧边栏**不在辅助功能树里**，只能按坐标点。而窗口位置一变坐标就废了，
所以先 `AXFullScreen = true`，等 0.9 秒动画，再判断当前界面，再点。

界面判断用截图取色：经典界面左上有大号白色 wordmark（亮度 88 / 高亮占比 0.20），
大管家界面同区域是深色（30 / 0.016），阈值取 0.08。为此写了个 60 行的无依赖 PNG 解码器
（`zlib.inflateSync` + 5 种滤镜还原）。

### ④ 虚拟光标必须对齐真实指针

前端那个白圈如果从屏幕中心起算，和 Mac 上的真实指针会有固定偏移 → 点击全落空。
所以每次触摸开始先 `GET /mouse/pos`（`cliclick p:.`）把本地光标对齐。

---

## 五、踩过的坑（改之前务必看）

| 坑 | 现象 | 结论 |
|---|---|---|
| `cliclick m:+=80` | 报 `Invalid X axis coordinate`，而前端不检查错误 | 相对移动是 `m:+80,+40`。真实指针一步没动，只有本地假光标在动 |
| 拖拽中途用 `m:` | 窗口不跟手，松手才跳 | 必须 `dm:x,y`（continue drag） |
| `pkill afplay` 与 `afplay` 同发 | 日志有 afplay 却没声音 | pkill 要串行，回调里再起 |
| `screencapture` 加锁丢弃 | 轮询时偶发 503 | 改成 Promise 串行链 |
| 转写文件在项目间跳 | 双音轨 + 路由误判 | 钉住一个文件 + seq 按文件记账 |
| 已念 seq 只在内存 | 每次重启重念一遍 | 落盘 `.voice-state.json` |
| 轻点判定 260ms | 正常按压 250~400ms 全被判掉 | 放宽到 420ms，长按 520ms |
| 放大面板嵌在镜像层里 | 永远看不见 | 被 `overflow:hidden` 裁掉，挪到舞台层 |
| `pkill`/`pgrep` 在受限沙箱 | 看不到 afplay 进程 | 用退出码与耗时验证 |
| 手机视口 812 / 物理 874 | 底部贴不到边 | 只能贴 812 |
| DSH 客户端插件 | 挂载成功、轮询正常，按钮不渲染 | 桌面按钮改用独立小窗 |

---

## 六、本地调试

```sh
# 直接跑服务（不经插件），改完即生效
cd server && PORT=8787 HOST=0.0.0.0 node server.cjs

# 自检：权限、语音、各项能力
curl "http://127.0.0.1:8787/selfcheck?t=$(cat ~/.dsh/phone-remote.token)"

# 语音路由回归
curl -X POST "http://127.0.0.1:8787/say/testroute?t=$TOKEN" \
     -H 'content-type: application/json' \
     -d '{"userText":"我们试试","clipText":"我们试试"}'
```

改 `index.html` 后必须**重启服务**（页面在启动时读进内存），但浏览器端 `cache-control: no-store`，
刷新即得新版。

### 权限排查

| 现象 | 缺什么 |
|---|---|
| 镜像全黑/只有壁纸 | 屏幕录制 |
| 点击、⌘C 全无效 | 辅助功能 |

TCC 授权给的是 **DeepSeek Harness.app**（不是 node、不是终端）。
勾完要重启 DSH 才对已运行进程生效。

---

## 七、想加功能的话

- **新按键**：`KEYS` 白名单加一项 → `/key` 直接用（前端只传 key 名，命令永不下发）
- **新应用**：`APPS` 白名单加一项 → `/launch`
- **新手势**：`index.html` 的 touchstart/move/end 三条链，`mode` 变量控制状态机
- **新语音来源**：`pollTranscript` 只认 DSH 的 `session.v4.jsonl.zstd`，换来源改 `zstdCat` + 解析

安全底线：注入类接口一律 `?t=` 校验（`timingSafeEqual`）；白名单用 `Object.hasOwn`；
用户输入永不拼进 shell 脚本。

---

## 八、已知限制

| 限制 | 说明 |
|---|---|
| 仅 macOS | 依赖 `osascript` / `screencapture` / `sips` / `cliclick` |
| 滚动是翻页 | 合成滚轮事件被 macOS 丢弃，降级用 `PageUp/PageDown` |
| 大管家切换靠坐标 | Electron 侧边栏不在辅助功能树里；DSH 布局大改就要重新校准 |
| 语音依赖本地 TTS | 没有 `127.0.0.1:9899` 时代理不存在，只是不念，其它正常 |
| DSH 关掉 = 遥控器不可用 | 服务是插件拉起的子进程 |
