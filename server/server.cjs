#!/usr/bin/env node
// phone-remote —— 把手机当 Mac(mini) 的无线键盘 + 快捷键遥控面板 + CLI 启动器
//
// 原理：手机浏览器打开本服务的网页，文本框用手机输入法(含语音)输入，
// 快捷键做成按钮。指令发到本服务后，在 *本机* 用 osascript 合成键盘事件，
// 打进当前最前的窗口。因为是本机注入、不是远程软件跨机转发，
// 中文和组合键都不受 UU 远程那类工具的 IME 转发限制。
//
// 安全：
//  - 仅 Tailscale/局域网可达 + token 校验（无 token 的请求一律 401）。
//  - 文本经临时文件中转、osascript 读文件写剪贴板再 Cmd+V；快捷键走白名单映射。
//    用户输入绝不拼进 osascript 脚本，杜绝命令注入。

const http = require("http");
const zlib = require("zlib");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || "127.0.0.1"; // 默认只听本机；要给手机用，显式传 HOST=0.0.0.0 或 Tailscale IP
const DIR = __dirname;
const CLIP_TMP = path.join(DIR, ".clip.tmp"); // 文本中转文件（覆盖写，已 gitignore）
const LAUNCH_TMP = path.join(DIR, ".launch.command"); // 一键打开的启动脚本（覆盖写，已 gitignore）

// ── 持久 token ──
// 优先用 ~/.dsh/phone-remote.token（**插件重装/升级后 token 不变**，手机主屏那个图标就不会失效）；
// 没有才退回本目录的 .token（独立运行时的老行为）。
const stableTokenFile = path.join(os.homedir(), ".dsh", "phone-remote.token");
const tokenFile = (() => {
  try { fs.mkdirSync(path.dirname(stableTokenFile), { recursive: true }); } catch {}
  return stableTokenFile;
})();
let TOKEN = "";
try {
  TOKEN = fs.readFileSync(tokenFile, "utf8").trim();
} catch {}
// 空的或过短的 .token 视同没有：否则空 token 会让 ?t= 直接通过校验
if (TOKEN.length < 16) {
  TOKEN = crypto.randomBytes(16).toString("hex");
  fs.writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  fs.chmodSync(tokenFile, 0o600); // 文件原本就在（空的）时 mode 不生效
}
const TOKEN_BUF = Buffer.from(TOKEN);
const tokenOk = (given) => {
  const buf = Buffer.from(String(given ?? ""));
  return buf.length === TOKEN_BUF.length && crypto.timingSafeEqual(buf, TOKEN_BUF);
};

const INDEX = fs.readFileSync(path.join(DIR, "index.html"));

// ── 快捷键白名单：前端传 action 名，后端查表，查不到即拒绝 ──
// 每项：{ code:<AppleScript key code> } 或 { char:"<单字符>" }，可选 mods:[修饰键]
const MODS = { cmd: "command down", ctrl: "control down", opt: "option down", shift: "shift down" };
const KEYS = {
  // 导航
  up: { code: 126 }, down: { code: 125 }, left: { code: 123 }, right: { code: 124 },
  home: { code: 115 }, end: { code: 119 }, pageup: { code: 116 }, pagedown: { code: 121 },
  // 编辑
  tab: { code: 48 }, enter: { code: 36 }, esc: { code: 53 },
  backspace: { code: 51 }, fdelete: { code: 117 }, space: { code: 49 },
  // 终端常用（Ctrl 组合）
  "ctrl-c": { char: "c", mods: ["ctrl"] }, "ctrl-d": { char: "d", mods: ["ctrl"] },
  "ctrl-r": { char: "r", mods: ["ctrl"] }, "ctrl-l": { char: "l", mods: ["ctrl"] },
  "ctrl-u": { char: "u", mods: ["ctrl"] }, "ctrl-a": { char: "a", mods: ["ctrl"] },
  "ctrl-e": { char: "e", mods: ["ctrl"] }, "ctrl-k": { char: "k", mods: ["ctrl"] },
  "ctrl-w": { char: "w", mods: ["ctrl"] }, "ctrl-z": { char: "z", mods: ["ctrl"] },
  // 系统 Cmd 组合
  "cmd-c": { char: "c", mods: ["cmd"] }, "cmd-v": { char: "v", mods: ["cmd"] },
  "cmd-x": { char: "x", mods: ["cmd"] }, "cmd-z": { char: "z", mods: ["cmd"] },
  "cmd-shift-z": { char: "z", mods: ["cmd", "shift"] }, "cmd-a": { char: "a", mods: ["cmd"] },
  "cmd-s": { char: "s", mods: ["cmd"] }, "cmd-f": { char: "f", mods: ["cmd"] },
  "cmd-w": { char: "w", mods: ["cmd"] }, "cmd-t": { char: "t", mods: ["cmd"] },
  // 触控区多指手势用（三指/四指 → 系统手势；双指捏合 → 缩放）
  "ctrl-up": { code: 126, mods: ["ctrl"] }, "ctrl-down": { code: 125, mods: ["ctrl"] },
  "ctrl-left": { code: 123, mods: ["ctrl"] }, "ctrl-right": { code: 124, mods: ["ctrl"] },
  "cmd-plus": { char: "+", mods: ["cmd"] }, "cmd-minus": { char: "-", mods: ["cmd"] },
  "cmd-tab": { code: 48, mods: ["cmd"] }, "cmd-left": { code: 123, mods: ["cmd"] },
  "cmd-right": { code: 124, mods: ["cmd"] }, "opt-left": { code: 123, mods: ["opt"] },
  "opt-right": { code: 124, mods: ["opt"] },
};

// ── 应用白名单：一键在新终端窗口里启动某个 CLI ──
// 同 KEYS 的思路：前端只传 key 名，命令字符串写死在这里，用户输入永远进不来。
// 想加工具就在这里补一行，再去 index.html 的「一键打开」区加个按钮。
const APPS = {
  cc: { label: "Claude Code", cmd: "claude" },
  codex: { label: "Codex", cmd: "codex" },
  kimi: { label: "Kimi", cmd: "$HOME/.kimi-code/bin/kimi" }, // 不在 PATH，得写全路径
};
// 新终端的工作目录。默认 home；想固定到某个项目就给服务设环境变量 LAUNCH_CWD。
const LAUNCH_CWD = process.env.LAUNCH_CWD || os.homedir();

function buildKeyScript(k) {
  const target = k.char !== undefined ? `keystroke "${k.char}"` : `key code ${k.code}`;
  const using = k.mods && k.mods.length
    ? ` using {${k.mods.map((m) => MODS[m]).join(", ")}}`
    : "";
  return `tell application "System Events" to ${target}${using}`;
}

// 执行 osascript。scriptLines: 字符串或数组（每项一个 -e）。
function osa(scriptLines) {
  const lines = Array.isArray(scriptLines) ? scriptLines : [scriptLines];
  const args = [];
  for (const l of lines) args.push("-e", l);
  return new Promise((resolve, reject) => {
    execFile("osascript", args, { timeout: 5000 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve();
    });
  });
}

// 文本注入：写临时文件 → osascript 读文件写剪贴板(AppKit) → Cmd+V。
// 为什么不用 pbcopy：后台/非 Aqua 会话里 pbcopy 命令常连不到 GUI pasteboard
//   （写入后 pbpaste 读回空，已实测），而 osascript 的 `the clipboard` 走 AppKit 正常。
// 为什么走文件而非 system attribute 传参：后者对中文报 -1700。
// 文本走文件、路径为固定常量，绝不拼进脚本，杜绝注入；read as «class utf8» 保证中文正确。
// simplified: 覆盖 mini 当前剪贴板；.clip.tmp 覆盖写不删（已 gitignore）。
function typeText(text) {
  fs.writeFileSync(CLIP_TMP, text, { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(CLIP_TMP, 0o600); // mode 只在新建时生效，旧文件补一次
  return osa([
    `set the clipboard to (read POSIX file "${CLIP_TMP}" as «class utf8»)`,
    'tell application "System Events" to keystroke "v" using command down',
  ]);
}

// shell 单引号转义：把值裹进单引号，内部的单引号按 '"'"' 的老办法拆开。
const shq = (v) => "'" + String(v).replace(/'/g, "'\\''") + "'";

// 一键启动：写一个 .command 脚本，交给 open 让 Terminal 跑起来。
// 为什么不用 `tell application "Terminal" to do script`：那条路走 Apple Events，
//   需要单独的「自动化」TCC 授权，而本服务由 launchd 后台拉起，授权弹窗未必有人看得见。
//   open 走 LaunchServices，不需要额外授权 —— 实测从非 GUI 会话也能开出窗口并执行脚本。
// 脚本内容全部来自 APPS 表和 LAUNCH_CWD 两个常量，没有一个字符来自请求体，无注入面。
// simplified: 用 exec，CLI 退出后窗口即完；要接着干就再点一次按钮。
//
// 窗口抢焦点这件事放在脚本里做，不在服务端做：本服务由 launchd 拉起、无 UI，
// 系统不让它把别的 app 提到前台（实测 open 出来的窗口停在后台）。而脚本是
// Terminal 自己的子进程，activate 由它发出就能生效，也不需要给本服务申请
// 「自动化」授权。失败就静默跳过——窗口照样开着，只是得手点一下。
function launchApp(key) {
  const app = APPS[key];
  const script = `#!/bin/zsh\ncd ${shq(LAUNCH_CWD)} || exit 1\nosascript -e 'tell application "Terminal" to activate' >/dev/null 2>&1\nexec ${app.cmd}\n`;
  fs.writeFileSync(LAUNCH_TMP, script, { mode: 0o700 });
  fs.chmodSync(LAUNCH_TMP, 0o700); // writeFileSync 的 mode 只在新建时生效，覆盖写要补一刀
  return new Promise((resolve, reject) => {
    execFile("open", ["-a", "Terminal", LAUNCH_TMP], { timeout: 5000 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve();
    });
  });
}

// ── 屏幕镜像：GET /screen ──────────────────────────────────────────────
// 只做一件事：把当前整块屏幕截成 JPEG 交出去。不裁窗口、不抽内容、不做智能取景
//   （需求铁律第 2 条：「越是挑选内容，工程改造越复杂」）。手机端的"对话区"从此
//   改成 1:1 镜像整个 Mac 显示区——触控板当鼠标用时才有得看。
// 为什么用 screencapture 轮询，而不是 ScreenCaptureKit / WebRTC：
//   实测全屏出图 0.107s、缩到 728px 宽 0.144s / 64KB，局域网 5~8fps 足够看清
//   「光标在哪、是不是还在转、有没有飘红」。少改造优先。
// 权限：TCC 判定的是**发起截图的进程**。生产环境里是 PhoneRemote.app，不是终端——
//   在终端里截得出来，不代表那个 .app 截得出来。这是 P1 的第一风险项。
const SHOT_TMP = path.join(os.tmpdir(), "phone-remote-shot.jpg");
const SCREEN_TMP = path.join(os.tmpdir(), "phone-remote-screen.jpg");
let shotCache = { at: 0, buf: null }; // 120ms 内的重复请求直接吃缓存，省一次 fork

// 串行化：同一时刻只跑一次 screencapture。
// 为什么不再用「忙就丢 503」：手机上页面 5fps 轮询 + 放大镜偶尔再来一发，
//   上一帧还没截完就撞上，前端会偶尔拿到 503 导致掉帧跳动。
// 串行链的代价只是"晚一点出帧"，换来的是永不 503。
let shotChain = Promise.resolve();

function captureScreen(opts) {
  const run = () => doCapture(opts);
  const p = shotChain.then(run, run);
  shotChain = p.then(() => {}, () => {});   // 吞掉错误，别让链条断
  return p;
}

function doCapture(opts) {
  const width = opts.width;
  const region = ["x", "y", "rw", "rh"].every((k) => Number.isFinite(opts[k]));
  if (!region && Date.now() - shotCache.at < 120 && shotCache.buf) return Promise.resolve(shotCache.buf);
  return new Promise((resolve, reject) => {
    const args = ["-x", "-t", "jpg", "-o"]; // -x 不播快门声
    if (region) args.push("-R", `${opts.x},${opts.y},${opts.rw},${opts.rh}`);
    args.push(SHOT_TMP);
    const fail = (e) => reject(e);
    execFile("screencapture", args, { timeout: 5000 }, (err, _out, stderr) => {
      if (err) return fail(new Error((stderr || err.message).trim() || "screencapture failed"));
      // 区域裁剪（放大镜）按原生分辨率原样返回；整屏才缩图
      const readBack = (p) => fs.readFile(p, (e, buf) => {
        if (e) return reject(e);
        if (!region) shotCache = { at: Date.now(), buf };
        resolve(buf);
      });
      if (region) return readBack(SHOT_TMP);
      execFile("sips", ["--resampleWidth", String(width), SHOT_TMP, "--out", SCREEN_TMP], { timeout: 5000 },
        (e2, _o2, st2) => {
          if (e2) return fail(new Error((st2 || e2.message).trim() || "sips failed"));
          readBack(SCREEN_TMP);
        });
    });
  });
}


// ── 极简 PNG 解码（只为判断一个小区域的亮度，不引依赖）───────────────
// screencapture 输出 8bit RGB/RGBA 非隔行 PNG，用 Node 自带 zlib 就能解。
function decodePngGray(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not png");
  let off = 8, w = 0, h = 0, bitDepth = 8, colorType = 6;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    off += 12 + len;
  }
  if (bitDepth !== 8) throw new Error("bitDepth " + bitDepth);
  const ch = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!ch) throw new Error("colorType " + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = line[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const p0 = a + b - c, pa = Math.abs(p0 - a), pb = Math.abs(p0 - b), pc = Math.abs(p0 - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[i] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { w, h, ch, data: out };
}

// 抓一小块并算亮度（0..255）。经典界面上方是大号白色 wordmark，管家界面那儿是深色。
function sampleBrightness(rect) {
  return new Promise((resolve) => {
    const f = path.join(os.tmpdir(), "pm-probe.png");
    execFile("screencapture", ["-x", "-t", "png", "-R", rect, f], { timeout: 4000 }, (e) => {
      if (e) return resolve(null);
      let img;
      try { img = decodePngGray(fs.readFileSync(f)); } catch (err) { return resolve(null); }
      let sum = 0, n = 0, bright = 0;
      for (let i = 0; i < img.w * img.h; i++) {
        const o = i * img.ch;
        const v = img.ch === 1 ? img.data[o] : (img.data[o] * 0.299 + img.data[o + 1] * 0.587 + img.data[o + 2] * 0.114);
        sum += v; n++; if (v > 150) bright++;
      }
      resolve({ mean: sum / n, bright: bright / n });
    });
  });
}

/* 判断 DSH 当前在经典界面还是管家界面。
   实测（全屏 1512×945）：经典模式左上 (25,88,210,24) 有大号白字 → 亮度 ~88、高亮占比 0.20；
   管家模式同一块是深色 → 均值 ~30、占比 0.016。阈值取中间即可。 */
async function detectSurface() {
  const st = await sampleBrightness("25,88,210,24");
  if (!st) return "unknown";
  return st.bright > 0.08 ? "agent" : "bot";
}

// ── agent 切换：POST /switch ───────────────────────────────────────────
// 三个键 = 把对应界面激活并切到前台全屏。命令写死在这里，请求体只带 key，进不来代码。
// 大聪明与管家都是同一个 DSH 应用（管家是 ds-bot 的面板），靠"当前面板"区分；
// 小聪明是 Hermes 的本地网页（127.0.0.1:9900）。
// 小聪明的桌面端（Electron），路径固定；万一被移走就用 open -a 兜底
const HERMES_APP = "/Users/jjjj/.hermes/hermes-agent/apps/desktop/release/mac-arm64/Hermes.app";
const SWITCH = {
  dsh:   { label: "大聪明", open: ["-a", "DeepSeek Harness"] },
  hermes:{ label: "小聪明", open: [HERMES_APP] },
  // 大管家 = DSH 里的 ds-bot 面板：激活 DSH 后点侧边栏那个「DS Bot」入口。
  // 它是 Electron 的 Web 内容，辅助功能树里读不到按钮，只能用坐标点；
  // 坐标按「窗口原点 + 固定偏移」算，偏移量实测于 1280×913 窗口：侧边栏第 1 个导航项。
  // 坐标点击已停用：布局一变化就会点偏（实测点到了「新会话」，在项目里凭空建了个对话）。
  // 大管家与大脑共用同一个窗口、靠 surface 区分，等 surface 桥接插件做好再真正切。
  // 全屏固定坐标（实测全屏 1512×945）：
  //   侧边栏「DS Bot」行 (120,210) → 进管家界面
  //   管家界面左下鲸鱼按钮 (42,954) → 弹出菜单；菜单里「切换经典 Agent 模式」在 (90,862)
  dsbot: { label: "大管家", open: ["-a", "DeepSeek Harness"], enter: { x: 120, y: 210 } },
};

// ── 用户配置（可选）────────────────────────────────────────────────
// 三个 agent 键默认指向**开发机上的三个应用**（见上面 SWITCH）。别人想用，不必改代码：
//   ~/.dsh/phone-remote.json
//   {
//     "switch": { "dsbot": { "label": "大管家", "open": ["-a", "DeepSeek Harness"],
//                            "enter": { "x": 120, "y": 210 } } },
//     "apps":   { "cc": { "label": "Claude Code", "cmd": "claude" } }
//   }
// 只写想覆盖的项，其余保持默认。
const CONFIG_FILE = path.join(os.homedir(), ".dsh", "phone-remote.json");
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  if (cfg && typeof cfg === "object") {
    if (cfg.switch && typeof cfg.switch === "object") Object.assign(SWITCH, cfg.switch);
    if (cfg.apps && typeof cfg.apps === "object") Object.assign(APPS, cfg.apps);
    console.log("[config] 已应用 " + CONFIG_FILE);
  }
} catch (e) {
  if (e && e.code !== "ENOENT") console.log("[config] 读取失败（忽略）：" + e.message);
}
// 原生全屏快捷键：比 AppleScript 的 zoomed 可靠（Electron 窗口不响应 set bounds 全屏）
const FULLSCREEN = { code: 3, char: "f", mods: ["ctrl", "cmd"] };

function frontApp() {
  return new Promise((resolve) => {
    execFile("osascript", ["-e",
      'tell application "System Events" to get name of first application process whose frontmost is true'],
      { timeout: 4000 }, (_e, out) => resolve(String(out || "").trim()));
  });
}

// 等到目标应用真的成为前台（Electron 被 open/activate 唤起需要时间，抢跑会把快捷键打到别的 app）
async function waitFront(want, timeoutMs = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if ((await frontApp()) === want) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function osaOnce(script) {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], { timeout: 8000 }, (_e, out) => resolve(String(out || "").trim()));
  });
}

async function switchTo(key) {
  const t = SWITCH[key];
  if (!t) throw new Error("unknown target: " + key);
  const want = key === "hermes" ? "Hermes" : "DeepSeek Harness";

  // 1) 拉起（已在跑就只是激活）
  await new Promise((resolve, reject) => {
    execFile("open", t.open, { timeout: 8000 }, (err, _o, se) => {
      if (err && key === "hermes") return execFile("open", ["http://127.0.0.1:9900"], () => resolve());
      if (err) return reject(new Error((se || err.message).trim()));
      resolve();
    });
  });

  // 2) 激活 + 等它真的到前台（最多 8 秒）
  await osaOnce('tell application "' + want + '" to activate');
  if (!(await waitFront(want))) {
    await osaOnce('tell application "' + want + '" to activate');
    await waitFront(want, 4000);
  }
  const front = await frontApp();
  console.log("[switch] " + key + " 前台=" + front);

  // 3) 全屏固定坐标 + 先判断当前模式，避免误点（经典界面左下角是账户菜单，含「退出登录」）
  const ensureFullscreen = async () => {
    const r = await osaOnce([
      'tell application "System Events" to tell process "DeepSeek Harness"',
      '  try',
      '    if (value of attribute "AXFullScreen" of front window) is false then set value of attribute "AXFullScreen" of front window to true',
      '    return "ok"',
      '  on error e',
      '    return "err:" & e',
      '  end try',
      'end tell',
    ].join("\n"));
    console.log("[switch] 全屏: " + r);
    await new Promise((res) => setTimeout(res, 900));   // 等动画
  };
  const clickAt = (x, y) => new Promise((res) => {
    console.log("[switch] 点击 " + x + "," + y);
    execFile("/opt/homebrew/bin/cliclick", ["c:" + x + "," + y], { timeout: 5000 }, () => res());
  });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  await ensureFullscreen();
  const mode = await detectSurface();
  console.log("[switch] 当前界面=" + mode);

  if (key === "dsbot") {
    if (mode !== "bot") { await clickAt(t.enter.x, t.enter.y); await sleep(1000); }
    return;
  }

  // dsh：若当前在管家界面，走鲸鱼菜单切回经典
  if (mode === "bot") {
    await clickAt(42, 954);     // 管家界面左下鲸鱼按钮
    await sleep(600);
    await clickAt(90, 862);     // 菜单里「切换经典 Agent 模式」
    await sleep(800);
  }
  return;

  // 全屏：优先用 AXFullScreen（可靠、可查询），不行再退回 Ctrl+Cmd+F
  const axFs = await osaOnce([
    'tell application "System Events" to tell process "DeepSeek Harness"',
    '  try',
    '    if (value of attribute "AXFullScreen" of window 1) is false then',
    '      set value of attribute "AXFullScreen" of window 1 to true',
    '      return "ax-fullscreen"',
    '    end if',
    '    return "already"',
    '  on error errm',
    '    return "err:" & errm',
    '  end try',
    'end tell',
  ].join("\n"));
  console.log("[switch] 全屏 AX: " + axFs);
  if (axFs.startsWith("err:")) {
    try { await osa(buildKeyScript(FULLSCREEN)); } catch (e) { console.log("[switch] 快捷键也失败: " + e.message); }
  }
}

// ── 鼠标注入：POST /mouse ──────────────────────────────────────────────
// 触控区要把手机变成 MacBook 触控板，而现有服务只有键盘注入，没有指针。
// 为什么用 cliclick 而不是 Quartz/PyObjC：/opt/homebrew/bin/cliclick 已装、
//   一行一条命令、语义直白；Quartz 要 Python 依赖，Swift 要编译链——都不如它省事。
// 代价：每条命令 fork 一个进程（约 10ms 级），所以前端要节流，拖动时按 30ms 发。
// 注意重复点击：cliclick 每次调用都是独立进程，多指手势必须由前端拆成原子命令。
const CLICLICK = "/opt/homebrew/bin/cliclick";
// pm-scroll：自编的最小滚轮注入器（见 bin/pm-scroll.swift）。先找 ~/bin，再找仓库内 bin/。
const PM_SCROLL = [
  path.join(os.homedir(), "bin", "pm-scroll"),
  path.join(DIR, "bin", "pm-scroll"),
].find((p) => fs.existsSync(p)) || null;
const MOUSE_TYPES = new Set(["move", "moveTo", "click", "doubleclick", "rightclick", "down", "up", "dragMove", "scroll", "scrollWheel"]);

function mouseArgv(body) {
  const t = body.type;
  const n = (v, def = 0) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : def);
  switch (t) {
    // cliclick 的相对语法是 m:+80,+40（用符号前缀），不是 m:+=80
    // 写错时它会报 "Invalid X axis coordinate"，而前端不检查错误 →
    // 结果就是"本地光标在动、Mac 上的真实指针纹丝不动"，点击自然全落空。
    case "move": {
      const sx = n(body.dx), sy = n(body.dy);
      return [`m:${sx >= 0 ? "+" : ""}${sx},${sy >= 0 ? "+" : ""}${sy}`];
    }
    case "moveTo": return [`m:${n(body.x)},${n(body.y)}`];     // 绝对定位（放大镜精修用）
    case "click": return ["c:."];                              // 在当前位置单击
    case "doubleclick": return ["dc:."];
    case "rightclick": return ["rc:."];
    case "down": return ["dd:."];                              // 按住（拖拽开始）
    case "up": return ["du:."];                                // 松开
    // 拖拽过程中必须用 dm（drag move）而不是 m：只有一个 "按住" 的状态延续着挪，
    // 否则窗口不会跟手，要等松手才一次性跳过去。
    case "dragMove": return ["dm:" + n(body.x) + "," + n(body.y)];
    // scroll 不走 cliclick：见 mouse() 里的降级说明
    default: return null;
  }
}

function mouse(body) {
  if (!MOUSE_TYPES.has(body.type)) return Promise.reject(new Error("unknown mouse type: " + body.type));
  // 滚动：降级实现（分页）。
  // 为什么降级：合成的滚轮事件（cliclick 没有该命令；CGEvent/CGEventCreateScrollWheelEvent
  //   在本机实测被系统丢弃，即使换成 PhoneRemote.app 的授权进程也一样，前后截图像素位移 0px）。
  //   键盘 PageUp/PageDown 走的是已经验证可用的按键注入，所以先保证「能用」。
  // 正数向上、负数向下；每 120 单位算一页，1~10 页。
  if (body.type === "scroll") {
    const dy = Number.isFinite(Number(body.dy)) ? Number(body.dy) : 0;
    if (!dy) return Promise.resolve();
    const pages = Math.max(1, Math.min(10, Math.round(Math.abs(dy) / 120) || 1));
    const action = dy > 0 ? "pageup" : "pagedown";
    let chain = Promise.resolve();
    for (let i = 0; i < pages; i++) chain = chain.then(() => osa(buildKeyScript(KEYS[action])));
    return chain;
  }
  // 真·像素滚动：保留实现，等滚轮事件问题解决后再启用（当前实测无效）
  if (body.type === "scrollWheel") {
    if (!PM_SCROLL) return Promise.reject(new Error("pm-scroll 未安装"));
    const argv = [String(Math.round(Number(body.dy) || 0)), String(Math.round(Number(body.dx) || 0)), body.unit === "line" ? "line" : "pixel"];
    return new Promise((resolve, reject) => {
      execFile(PM_SCROLL, argv, { timeout: 3000 }, (err, _o, stderr) => {
        if (err) reject(new Error((stderr || err.message).trim() || "pm-scroll failed"));
        else resolve();
      });
    });
  }
  const argv = mouseArgv(body);
  if (!argv) return Promise.reject(new Error("bad mouse args"));
  return new Promise((resolve, reject) => {
    execFile(CLICLICK, argv, { timeout: 3000 }, (err, _out, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim() || "cliclick failed（多为辅助功能未授权）"));
      else resolve();
    });
  });
}


// ── 语音回读：监听 DSH 会话转写 → 合成 → 按「谁发起的」路由 ───────────────
// 为什么监听转写文件而不是写 DSH 插件：
//   插件要装进 profile 并重启 DSH（会打断正在跑的会话），而转写文件是 DSH 自己
//   实时落盘的（session.v4.jsonl.zstd，zstd 压缩的 JSONL），对 DSH 零侵入。
// 触发点：`turn/end` —— 一轮结束才是"回复完成"，不是每条 assistant/message。
// 路由：/type 打进来（手机发起）时置一次 phoneArmed，下一轮 turn/end 的朗读走手机；
//       否则走 Mac 的 afplay。一次输入只消费一次，不会长期偏到手机。
const VOICE_PORT = 9899;
const SESS_ROOT = path.join(os.homedir(), ".dsh", "sessions");
let lastTranscriptMtime = 0;
let lastSpokenTurnSeq = 0;
/* 已念进度必须落盘：每次 kickstart/重部署会把内存清空，
   于是服务启动后的第一次轮询会把"最新一轮"又念一遍 —— 这就是老大听到的"双音轨"。
   落盘后重启不会重念。 */
const VOICE_STATE = path.join(DIR, ".voice-state.json");
let spokenByFile = new Map();
try {
  const j = JSON.parse(fs.readFileSync(VOICE_STATE, "utf8"));
  if (j && typeof j === "object") spokenByFile = new Map(Object.entries(j));
} catch (e) {}
let lastStateSave = 0;
function saveVoiceState() {
  const now = Date.now();
  if (now - lastStateSave < 500) return;
  lastStateSave = now;
  try { fs.writeFileSync(VOICE_STATE, JSON.stringify(Object.fromEntries(spokenByFile))); } catch (e) {}
}
/* 判定「这轮到底是谁发的」——不看日志、不靠时间猜，靠内容自证：
   1) 手机发出去的文字前面会夹一个不可见字符 U+2060（word joiner），
      它会随剪贴板一起进 DSH 的输入框，也会被写进转写文件；
   2) 同时记下手机发过的原文，做一次包含比对兜底（万一标记被编辑器吃掉）。
   只要这一轮的 user/message 里出现标记或那段原文，就判定为手机发起 —— 与时间无关。 */
/* 老大给的最简判据：**用户消息 == 我们写进剪贴板的那段文字 ⇒ 一定是手机发的**。
   Mac 上自己敲的字不可能和剪贴板一致，所以这个判据不会误判，也不用夹任何隐藏字符。
   （严格说读回来的是"我们刚写进去的那段"，等价于剪贴板内容；会话里不额外读系统剪贴板，免得再碰 TCC。） */
let lastPhoneText = "";

/* 真的去读系统剪贴板：这是"机制判定"的正主 —— 用户消息若与剪贴板逐字相同，
   只可能是走过 /type（写剪贴板 + ⌘V）那条路。全程 osascript，跟模型无关。 */
function readClipboard() {
  return new Promise((resolve) => {
    execFile("osascript", ["-e", "get the clipboard as text"], { timeout: 3000 },
      (err, out) => resolve(err ? "" : String(out || "")));
  });
}
let phoneArmed = false;
let phoneArmedAt = 0;
let pendingSpeech = null;          // { id, path, at, dur }
let speaking = null;               // 最近一次合成产物（供红点复读）
let macPlaying = false;            // Mac 侧 afplay 是否在播（给桌面按钮显示状态）

/* 钉住一个转写文件：newestTranscript() 会在多个项目的会话之间来回挑，
   于是 seq 不可比、turn/end 反复触发 —— 症状就是「双音轨 + 路由乱判」。
   规则：钉住的那个文件 90 秒内还有写入就继续用它；彻底静默了才允许换。 */
let pinnedFile = null;
function pickTranscript() {
  const newest = newestTranscript();
  if (pinnedFile) {
    try {
      const st = fs.statSync(pinnedFile);
      if (Date.now() - st.mtimeMs < 90000) return pinnedFile;
    } catch (e) { pinnedFile = null; }
  }
  if (newest) pinnedFile = newest;
  return pinnedFile;
}

function newestTranscript() {
  // 每个项目一个目录，每个会话一个 session-* 目录；取最近 5 分钟内动过的最新一个
  let best = null, bestT = 0;
  let projs = [];
  try { projs = fs.readdirSync(SESS_ROOT); } catch (e) { return null; }
  for (const pd of projs) {
    const pdir = path.join(SESS_ROOT, pd);
    let subs = [];
    try { subs = fs.readdirSync(pdir); } catch (e) { continue; }
    for (const sub of subs) {
      const f = path.join(pdir, sub, "session.v4.jsonl.zstd");
      let st;
      try { st = fs.statSync(f); } catch (e) { continue; }
      if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = f; }
    }
  }
  return best;
}

function zstdCat(f) {
  return new Promise((resolve, reject) => {
    execFile("zstd", ["-dc", f], { maxBuffer: 64 * 1024 * 1024, timeout: 20000 },
      (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

// 念之前先过滤：代码块、行内代码、URL、文件路径、表格符号都不进语音
// （genie-tts 技能里的硬规矩：「代码块/路径/表格会被逐字念出来，听着像坏了」）
function filterForSpeech(t) {
  let out = String(t)
    .replace(/```[\s\S]*?```/g, "。下面有一段代码。")
    .replace(/`[^`]*`/g, "，")
    .replace(/https?:\/\/\S+/g, "，")
    .replace(/(?:~|\/)[\w./-]{6,}/g, "，")
    .replace(/\|/g, "，")
    .replace(/[*#>]{1,}/g, "")
    .replace(/^\s*\|.*\|\s*$/gm, "\u0000")    // 表格整行先打标记
    .replace(/^(\s*\u0000\s*)+/gm, "。这里有一张表格，跳过。")
    .replace(/\u0000/g, "")
    .replace(/^\s*\d+[.、)）]\s*/gm, "")      // 去掉「1. 2.」编号：它会变成 <1 秒的碎片
    .replace(/^\s*[-•]\s*/gm, "")             // 去掉列表符号
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "，")              // 换行并成一句，别让代理按行切成碎句
    .replace(/，{2,}/g, "，")
    .trim()
    .slice(0, 4000);                            // 原来 1500 会把长回复念一半就没了

  /* 代理（dcm-voice-daemon）按句切块，每块要求产物 ≥1 秒；
     太短的句子（如「好。」「收到。」）会被判「输出异常」，整条合成失败。
     所以这里先把 <12 字的碎句并到相邻句子里。 */
  const parts = out.split(/(?<=[。！？；])/).map((x) => x.trim()).filter(Boolean);
  const merged = [];
  for (const p of parts) {
    if (merged.length && (p.length < 12 || merged[merged.length - 1].length < 12)) {
      merged[merged.length - 1] += p;
    } else {
      merged.push(p);
    }
  }
  return merged.join("");
}

function voiceSynth(text, outPath) {
  const body = JSON.stringify({ text, out: outPath });
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1", port: VOICE_PORT, path: "/say", method: "POST",
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
      timeout: 300000,
    }, (res) => {
      let b = "";
      res.on("data", (c) => { b += c; });
      res.on("end", () => {
        try {
          const d = JSON.parse(b || "{}");
          if (d.ok) resolve(d); else reject(new Error(String(d.error || "voice failed")));
        } catch (e) { reject(e); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("语音代理超时")));
    req.end(body);
  });
}

// 按标点把长文本切成 ~600 字一段：单次调用越短，失败面越小，也避免代理一次跑太久
function splitForSynth(text, limit = 220) {   // 段再小一点：第一声来得更快
  const parts = text.split(/(?<=[。！？；])/);
  const out = [];
  let cur = "";
  for (const p of parts) {
    if (cur.length + p.length > limit && cur) { out.push(cur); cur = p; }
    else cur += p;
  }
  if (cur) out.push(cur);
  return out.filter((x) => x.trim());
}

let speakBusy = false;

async function synthLong(clean, outPath) {
  const chunks = splitForSynth(clean);
  if (chunks.length <= 1) return voiceSynth(clean, outPath);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pm-say-"));
  const files = [];
  for (let i = 0; i < chunks.length; i++) {
    const f = path.join(dir, "p" + i + ".mp3");
    await voiceSynth(chunks[i], f);       // 逐段合成；任何一段失败都会抛出
    files.push(f);
  }
  const list = path.join(dir, "list.txt");
  fs.writeFileSync(list, files.map((f) => "file '" + f + "'").join("\n"));
  await new Promise((resolve, reject) => {
    execFile("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0",
      "-i", list, "-c", "copy", outPath], { timeout: 180000 },
      (e, _o, se) => (e ? reject(new Error((se || e.message).trim())) : resolve()));
  });
}

/* 分段流式：长回复如果等全部合成完再开播，用户要干等几十秒。
   这里改成分段入队 —— 第一段合成完就能播，播完再自动取下一段。 */
let speechQueue = [];            // 待合成的文本段（手机路由此处排队）
let advancing = false;

async function queueForPhone(clean) {
  speechQueue = splitForSynth(clean).map((t) => ({ text: t }));
  pendingSpeech = null;
  await advanceSpeechQueue();
}

async function advanceSpeechQueue() {
  if (advancing) return;
  if (!speechQueue.length) { pendingSpeech = null; return; }
  advancing = true;
  try {
    const item = speechQueue.shift();
    const id = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 5);
    const out = path.join(os.tmpdir(), "pm-speak-" + id + ".mp3");
    await voiceSynth(item.text, out);
    speaking = { id, path: out };
    pendingSpeech = { id, path: out, at: Date.now(), left: speechQueue.length };
    console.log("[voice] queued(PHONE) id=" + id + " 剩余段=" + speechQueue.length);
  } finally {
    advancing = false;
  }
}

async function speak(text, toPhone) {
  const clean = filterForSpeech(text);
  if (!clean) return;
  if (speakBusy) return;                  // 上一句还没念完，别叠着合成
  speakBusy = true;
  try {
    await doSpeak(clean, toPhone);
  } finally {
    speakBusy = false;
  }
}

async function doSpeak(clean, toPhone) {
  if (toPhone) { await queueForPhone(clean); return; }   // 手机：分段流式
  const id = Date.now().toString(36);
  const out = path.join(os.tmpdir(), "pm-speak-" + id + ".mp3");
  await synthLong(clean, out);           // Mac：整段合成后播
  speaking = { id, path: out };
  // 不论走哪边，先把 Mac 上残留的播放停掉：上一轮若在 Mac 念长文，
  // 手机这边又要开始念，两路一起就是"两边都在读"
  if (toPhone) {
    execFile("pkill", ["-x", "afplay"], () => {});   // 手机要念了，Mac 那边让开
    pendingSpeech = { id, path: out, at: Date.now() };
    console.log("[voice] queued(PHONE) id=" + id);
  } else {
    // 先停掉上一句：长回复要念几分钟，不掐就会两条音轨叠在一起（老大实测听到"重复两条"）
    console.log("[voice] afplay(MAC) " + path.basename(out));
    // 必须先等 pkill 结束再起 afplay：两个进程同时发，pkill 可能晚一步把新起的 afplay 杀掉，
    // 表现就是"日志有 afplay，但一点声音都没有"（老大实测到的）。
    execFile("pkill", ["-x", "afplay"], () => {
      const t0 = Date.now();
      macPlaying = true;
      execFile("afplay", [out], { timeout: 600000 }, (err, _o, se) => {
        macPlaying = false;
        // 记退出码+耗时：本会话里 ps/pgrep 被沙箱限制，看不到 afplay 进程，
        // 只能靠它自己的退出状态判断"到底播没播"。
        console.log("[voice] afplay 结束 err=" + (err ? String(err.message || err).slice(0, 80) : "null") +
          " 用时=" + ((Date.now() - t0) / 1000).toFixed(1) + "s " + String(se || "").slice(0, 60));
      });
    });
  }
}

async function pollTranscript() {
  const f = pickTranscript();
  if (!f) return;
  let st;
  try { st = fs.statSync(f); } catch (e) { return; }
  if (st.mtimeMs === lastTranscriptMtime) return;
  lastTranscriptMtime = st.mtimeMs;

  let raw;
  try { raw = await zstdCat(f); } catch (e) { return; }

  let lastTurnEnd = 0, lastTurnEndTime = 0, lastUserText = "";
  let turnText = [];            // 这一轮里所有 assistant 文本段（按顺序拼接）
  let lastText = "";
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch (e) { continue; }
    if (d.type === "turn/end") {
      lastTurnEnd = d.seq || lastTurnEnd;
      lastTurnEndTime = d.time || lastTurnEndTime;
    }
    if (d.type === "turn/start") { turnText = []; }   // 新的一轮，重新收集
    if (d.type === "user/message") {
      const c = (d.data && d.data.content) || [];
      const t = c.filter((x) => x.type === "text").map((x) => x.text).join("\n");
      if (t) lastUserText = t;
    }
    if (d.type === "assistant/message") {
      const parts = (d.data && d.data.message && d.data.message.content) || [];
      const txt = parts.filter((x) => x.type === "text").map((x) => x.text).join("\n").trim();
      if (txt) { lastText = txt; turnText.push(txt); }   // DSH 一轮会发多条 assistant/message，
                                                        // 只取最后一条会把回复念成"很短的一截"
    }
  }
  const prevSeq = spokenByFile.get(f) || 0;
  if (!lastTurnEnd || lastTurnEnd === prevSeq) return;
  spokenByFile.set(f, lastTurnEnd);
  saveVoiceState();
  lastSpokenTurnSeq = lastTurnEnd;
  if (!lastText) return;

  /* 判定"这一轮是不是手机发起的"：
     光看 phoneArmed 会踩坑 —— 手机刚发完，轮询可能先看到**上一轮**的 turn/end 就把标记吃掉了，
     于是这一轮被误判成 Mac 发起（老大实测：手机发的，声音却从 Mac 出）。
     所以再比一次时间：只有 turn 结束时间晚于 /type 时间的，才算这一轮。
     时间用转写里的 epoch ms，和 Date.now() 同一基准。 */
  const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
  const u = norm(lastUserText);
  const clipNow = norm(await readClipboard());                 // 机制判定：真读剪贴板
  const p = clipNow || norm(lastPhoneText);                    // 读不到才退回"我们写进去的原文"
  const exact = p.length >= 2 && u === p;                      // 与剪贴板逐字相同
  const prefix = p.length >= 4 && u.startsWith(p);             // 手机先粘、又在 Mac 上补了几句
  // 输入框里原本就有草稿时，手机文字会落在中间：长文本包含也算手机发起
  // （短文本不做，避免"好"这种词随便命中）
  const inside = p.length >= 8 && u.indexOf(p) > 0;
  const byContent = exact || prefix || inside;                 // 与时间无关
  const fresh = Date.now() - phoneArmedAt < 3 * 60 * 1000;
  const afterArm = phoneArmed && fresh && lastTurnEndTime >= phoneArmedAt;
  const toPhone = byContent || afterArm;                      // 时间只做兜底
  if (toPhone) { phoneArmed = false; lastPhoneText = ""; }
  const fullText = turnText.length ? turnText.join("\n") : lastText;   // 整轮内容
  console.log("[voice] turn=" + lastTurnEnd + " turnTime=" + lastTurnEndTime +
    " armedAt=" + (phoneArmedAt || "-") + " armed=" + phoneArmed +
    " clipSrc=" + (clipNow ? "clipboard" : "recorded") + " exact=" + exact + " prefix=" + prefix + " inside=" + inside +
    " afterArm=" + afterArm + " -> " + (toPhone ? "PHONE" : "MAC") +
    " textLen=" + fullText.length);
  try {
    await speak(fullText, toPhone);
  } catch (e) {
    console.error("语音失败（整条）:", e.message);
    try {
      const head = String(fullText).split(/(?<=[。！？])/).slice(0, 2).join("");
      await speak(head, toPhone);
    } catch (e2) { console.error("语音失败（兜底也失败）:", e2.message); }
  }
}
// ── /speak/watcher ────────────────────────────────────────────────────

function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > limit) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

function send(res, code, obj) {
  const body = typeof obj === "string" ? obj : JSON.stringify(obj);
  res.writeHead(code, { "content-type": typeof obj === "string" ? "text/plain; charset=utf-8" : "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 首页：返回遥控器网页（页面本身无秘密，token 由访问者从 URL 带入）
  if (req.method === "GET" && url.pathname === "/") {
    // no-store：主屏（PWA）会把 HTML 缓存住，改完刷新还是旧页面，排查起来极费时间
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    return res.end(INDEX);
  }
  // 临时验证页（P1 用）：只在 dev-mirror.html 存在时提供。生产同步前删掉这个文件即可失效。
  if (req.method === "GET" && url.pathname === "/dev-mirror") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    const p = path.join(DIR, "dev-mirror.html");
    if (!fs.existsSync(p)) return send(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(fs.readFileSync(p));
  }

  if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { ok: true });

  // 手机侧轮询：有没有新的要念的
  if (req.method === "GET" && url.pathname === "/say/pending") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    if (!pendingSpeech) return send(res, 200, { id: null });
    return send(res, 200, { id: pendingSpeech.id });
  }
  // 页面刚打开时问一句"上一句是啥"：不触发播放，只让红点变成可复读状态
  // ── 桌面端按钮用：复读 / 停止 / 状态 ──
  // 桌面端声纹按钮的定位：由服务端算 DSH 窗口位置，给那个小窗口用
  // （小窗口自己没有辅助功能权限，拿不到别的应用的窗口坐标）
  // 环境自检（给插件/分享版用）：缺什么权限、语音在不在，一句话说清
  if (req.method === "GET" && url.pathname === "/selfcheck") {
    const out = { accessibility: null, screenRecording: null, voice: null, voicePort: 9899 };
    const ax = await new Promise((res) => execFile("osascript", ["-e",
      'tell application "System Events" to get UI elements enabled'], { timeout: 3000 },
      (e, o) => res(!e && String(o).trim() === "true")));
    out.accessibility = ax;
    const shot = path.join(os.tmpdir(), "pm-selfcheck.jpg");
    const sr = await new Promise((res) => execFile("screencapture", ["-x", "-t", "jpg", "-o", shot], { timeout: 4000 },
      (e) => { try { res(!e && fs.statSync(shot).size > 10000); } catch { res(false); } }));
    out.screenRecording = sr;
    const v = await new Promise((res) => {
      const r = http.request({ host: "127.0.0.1", port: 9899, path: "/state", method: "GET", timeout: 2000 },
        (up) => { up.resume(); res(up.statusCode === 200); });
      r.on("error", () => res(false)); r.on("timeout", () => { r.destroy(); res(false); }); r.end();
    });
    out.voice = v;
    out.ok = out.accessibility && out.screenRecording;
    out.hint = out.ok ? "权限齐全"
      : [!out.accessibility && "缺「辅助功能」：系统设置 → 隐私与安全性 → 辅助功能 → 勾选 DeepSeek Harness",
         !out.screenRecording && "缺「屏幕录制」：系统设置 → 隐私与安全性 → 屏幕录制 → 勾选 DeepSeek Harness",
         !out.voice && "本地语音服务（127.0.0.1:9899）没在跑：语音回读会不可用，其它功能正常"].filter(Boolean).join("；");
    return send(res, 200, out);
  }
  // 桌面端声纹按钮的定位：由服务端算 DSH 窗口位置，给那个小窗口用
  // 选窗口要挑**最宽的那个**：DSH 有多个窗口（空的浮层、真正的聊天窗），front window 不可靠。
  // 坐标按窗口**右下角**算偏移，非全屏时也不会跑偏。
  if (req.method === "GET" && url.pathname === "/voicebtn") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    return execFile("osascript", ["-e", [
      'tell application "System Events"',
      '  set frontName to name of first application process whose frontmost is true',
      '  set bestW to 0',
      '  set bx to 0',
      '  set by to 0',
      '  set bw to 0',
      '  set bh to 0',
      '  try',
      '    tell process "DeepSeek Harness"',
      '      repeat with w in windows',
      '        set ws to size of w',
      '        if item 1 of ws > bestW then',
      '          set bestW to item 1 of ws',
      '          set bx to item 1 of (position of w)',
      '          set by to item 2 of (position of w)',
      '          set bw to item 1 of ws',
      '          set bh to item 2 of ws',
      '        end if',
      '      end repeat',
      '    end tell',
      '  end try',
      '  return frontName & "|" & (bx as text) & "|" & (by as text) & "|" & (bw as text) & "|" & (bh as text)',
      'end tell',
    ].join("\n")], { timeout: 5000 }, (e, out) => {
      if (e) return send(res, 500, { error: String(e.message).slice(0, 120) });
      const parts = String(out).trim().split("|");
      const front = parts[0] || "";
      const wx = Number(parts[1]) || 0, wy = Number(parts[2]) || 0;
      const ww = Number(parts[3]) || 0, wh = Number(parts[4]) || 0;
      // 全屏实测（1512×945）按钮在 (870,796)；换算成右下角偏移：右 642、下 160
      const visible = ww > 600 && front === "DeepSeek Harness";
      send(res, 200, {
        visible,
        x: wx + ww - 642, y: wy + wh - 160 - 26,
        playing: macPlaying, hasLast: !!speaking,
      });
    });
  }
  if (req.method === "GET" && url.pathname === "/say/state") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    return send(res, 200, { playing: macPlaying, hasLast: !!speaking });
  }
  // 测试判定逻辑（不改状态、不发语音）：POST {userText, clipText?}
  if (req.method === "POST" && url.pathname === "/say/testroute") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    let body = {};
    try { body = await readBody(req); } catch (e) {}
    const norm = (x) => String(x || "").replace(/\s+/g, " ").trim();
    const clipLive = norm(await readClipboard());
    const clip = body.clipText !== undefined ? norm(body.clipText) : (clipLive || norm(lastPhoneText));
    const u = norm(body.userText);
    const exact = clip.length >= 2 && u === clip;
    const prefix = clip.length >= 4 && u.startsWith(clip);
    const inside = clip.length >= 8 && u.indexOf(clip) > 0;
    return send(res, 200, {
      clipSrc: body.clipText !== undefined ? "given" : (clipLive ? "clipboard" : "recorded"),
      exact, prefix, inside, decision: (exact || prefix || inside) ? "PHONE" : "MAC",
    });
  }
  if (req.method === "GET" && url.pathname === "/mouse/pos") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    return execFile("/opt/homebrew/bin/cliclick", ["p:."], { timeout: 3000 }, (e, out) => {
      if (e) return send(res, 500, { error: String(e.message) });
      const m = String(out).trim().split(",").map((v) => Number(v.trim()));
      if (m.length !== 2 || !m.every(Number.isFinite)) return send(res, 500, { error: "bad pos" });
      send(res, 200, { x: m[0], y: m[1] });
    });
  }
  if (req.method === "GET" && url.pathname === "/say/status") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    let mt = null;
    try { mt = fs.statSync(pinnedFile).mtimeMs; } catch (e) {}
    return send(res, 200, {
      file: pinnedFile ? path.basename(path.dirname(pinnedFile)) : null,
      fileAgeMs: mt ? Date.now() - mt : null,
      phoneArmed, phoneArmedAgeMs: phoneArmedAt ? Date.now() - phoneArmedAt : null,
      lastSpokenTurnSeq, pending: pendingSpeech ? pendingSpeech.id : null,
      lastSpeech: speaking ? speaking.id : null,
    });
  }
  if (req.method === "GET" && url.pathname === "/say/last") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    return send(res, 200, { id: speaking ? speaking.id : null });
  }
  if (req.method === "GET" && url.pathname === "/say/audio") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    const id = url.searchParams.get("id");
    // 待播队列里的，或者"最近一次合成的"都算数 —— 后者让复读在队列被消费后依然有效
    const hit = [pendingSpeech, speaking].find((x) => x && x.id === id);
    if (!hit) return send(res, 404, { error: "gone" });
    let buf;
    try { buf = fs.readFileSync(hit.path); } catch (e) { return send(res, 404, { error: "missing" }); }
    res.writeHead(200, { "content-type": "audio/mpeg", "content-length": buf.length, "cache-control": "no-store" });
    return res.end(buf);
  }

  // 屏幕镜像：比 /type 更敏感（整块屏都在里面），token 必须校验
  if (req.method === "GET" && url.pathname === "/screen") {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    const num = (k) => {
      const v = url.searchParams.get(k);
      if (v === null || v === "") return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    try {
      const buf = await captureScreen({
        width: Math.max(160, Math.min(4096, num("width") || 728)),
        x: num("x"), y: num("y"), rw: num("rw"), rh: num("rh"),
      });
      res.writeHead(200, {
        "content-type": "image/jpeg",
        "content-length": buf.length,
        "cache-control": "no-store", // 镜像不能缓存，否则手机上看到的是旧帧
      });
      return res.end(buf);
    } catch (e) {
      const busy = String(e.message) === "busy";
      return send(res, busy ? 503 : 500, { error: String(e.message) });
    }
  }

  // 以下为注入类接口，一律校验 token
  if (req.method === "POST" && (url.pathname === "/type" || url.pathname === "/key" || url.pathname === "/launch" || url.pathname === "/mouse" || url.pathname === "/warm" || url.pathname === "/say/stop" || url.pathname === "/say" || url.pathname === "/say/arm" || url.pathname === "/say/ack" || url.pathname === "/say/replay" || url.pathname === "/say/testroute" || url.pathname === "/switch")) {
    if (!tokenOk(url.searchParams.get("t"))) return send(res, 401, { error: "bad token" });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e.message) }); }
    try {
      if (url.pathname === "/say") {
        // 手动朗读（也用于自检）：{text, to:"phone"|"mac"}，默认 phone
        const text = typeof body.text === "string" ? body.text : "";
        if (!text) return send(res, 400, { error: "text required" });
        try { await speak(text, body.to !== "mac"); }
        catch (e) { return send(res, 500, { error: String(e.message) }); }
        return send(res, 200, { ok: true, queued: body.to !== "mac" });
      }
      if (url.pathname === "/warm") {
        // 预热：合成一句极短文本（只写文件不播），把 GENIE 模型读进内存，避免首句等 27 秒
        // 预热文本不能太短：语音代理要求产物 ≥1 秒，两个字会被判「输出异常」
        await voiceSynth("语音预热，一二三四五六七八九十。", path.join(os.tmpdir(), "pm-warm.mp3"));
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/switch") {
        if (!Object.hasOwn(SWITCH, body.target)) return send(res, 400, { error: "unknown target: " + body.target });
        await switchTo(body.target);
        return send(res, 200, { ok: true, target: body.target, label: SWITCH[body.target].label });
      }
      if (url.pathname === "/say/ack") {
        // 手机播完一段 → 推进下一段（分段流式）
        await advanceSpeechQueue();
        return send(res, 200, { ok: true, more: !!pendingSpeech });
      }
      if (url.pathname === "/say/arm") {
        // 手动把"下一轮朗读走手机"的标记打上（自检/调试用，正常由 /type 自动置位）
        phoneArmed = true; phoneArmedAt = Date.now();
        return send(res, 200, { ok: true, armed: true });
      }
      if (url.pathname === "/say/replay") {
        // 桌面端复读：把最近一次合成在 Mac 上再放一遍
        if (!speaking) return send(res, 404, { error: "no speech yet" });
        execFile("pkill", ["-x", "afplay"], () => {
          macPlaying = true;
          execFile("afplay", [speaking.path], { timeout: 600000 }, () => { macPlaying = false; });
        });
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/say/stop") {
        // 只掐播放，**不清空待播**：清空会让 /say/audio 的 id 失效，
        // 红点就再也复读不出声了（老大实测踩到的就是这个）。
        execFile("pkill", ["-x", "afplay"], () => {});
        return send(res, 200, { ok: true });
      }
      if (url.pathname === "/type") {
        const text = typeof body.text === "string" ? body.text : "";
        const armed = !!text;
        if (text) {
          phoneArmed = true; phoneArmedAt = Date.now();
          lastPhoneText = String(text).trim();
          await typeText(text);                   // 写剪贴板 + ⌘V，原文同时记下来做比对
        }
        if (body.enter) await osa(buildKeyScript(KEYS.enter));
        // 把"这条已被记为手机发起"直接回给页面：手机上看得到，不必依赖日志
        return send(res, 200, { ok: true, armed });
      } else if (url.pathname === "/key") {
        const k = Object.hasOwn(KEYS, body.action) ? KEYS[body.action] : undefined;
        if (!k) return send(res, 400, { error: "unknown action: " + body.action });
        await osa(buildKeyScript(k));
        return send(res, 200, { ok: true });
      } else if (url.pathname === "/mouse") {
        console.log("[mouse] " + body.type + " " + JSON.stringify(body).slice(0, 80));
        await mouse(body);
        return send(res, 200, { ok: true });
      } else {
        if (!Object.hasOwn(APPS, body.app)) return send(res, 400, { error: "unknown app: " + body.app });
        await launchApp(body.app);
        return send(res, 200, { ok: true, launched: APPS[body.app].label });
      }
    } catch (e) {
      // 最常见：辅助功能权限未授予 → osascript 报 -1719 / -25211 / not allowed。原样回给前端。
      return send(res, 500, { error: String(e.message) });
    }
  }

  send(res, 404, { error: "not found" });
});

// 2 秒看一次转写文件；mtime 没变就直接返回，几乎不耗资源
setInterval(() => { pollTranscript().catch(() => {}); }, 2000);

server.listen(PORT, HOST, () => {
  execFile("tailscale", ["ip", "-4"], (err, out) => {
    const ip = (!err && out.trim().split("\n")[0]) || "<本机IP>";
    console.log(`phone-remote 已启动`);
    console.log(`  手机访问: http://${ip}:${PORT}/?t=${TOKEN}`);
    console.log(`  局域网也可用 ${os.hostname()}:${PORT}`);
  });
});
