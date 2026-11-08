// dsh-phone-remote · host 侧
//
// 为什么是"插件 + 它拉起的服务"，而不是纯插件：
//   DSH 的 web 服务只监听 127.0.0.1，手机经局域网访问不到；
//   而手机遥控器必须能从局域网访问。所以本插件在启动时 spawn 同包内的 server/server.js
//   （绑定 0.0.0.0:8787）。子进程的 responsible process 是 DeepSeek Harness，
//   因此**继承 DSH 已获得的「辅助功能」「屏幕录制」权限**，无需再单独授权一个应用。
//
// 生命周期：apply 时启动；插件卸载/DSH 退出时杀掉。端口被占（例如旧版独立服务还在跑）
// 时只记一条日志，不抛错——不影响 DSH 启动。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-phone-remote'
export const inject = []

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'server', 'server.cjs')   // .cjs：插件包是 ESM，服务本体是 CommonJS

export function apply(ctx) {
  if (!existsSync(SERVER)) {
    ctx.logger?.warn?.('[phone-remote] 找不到 server.js，插件未启动')
    return
  }

  let child = null
  let stopping = false

  const start = () => {
    if (child) return
    child = spawn(process.execPath, [SERVER], {
      cwd: dirname(SERVER),
      env: { ...process.env, PORT: process.env.PHONE_REMOTE_PORT || '8787', HOST: '0.0.0.0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout?.on('data', (b) => {
      const s = String(b).trim()
      if (s) console.log('[phone-remote] ' + s.replace(/\n/g, ' | '))
    })
    child.stderr?.on('data', (b) => console.error('[phone-remote] ' + String(b).trim()))
    child.on('exit', (code) => {
      child = null
      if (stopping) return
      console.log('[phone-remote] 服务退出 code=' + code + '，2 秒后重启')
      setTimeout(() => { if (!stopping) start() }, 2000)
    })
  }

  start()

  ctx.effect(() => () => {
    stopping = true
    try { child?.kill('SIGTERM') } catch {}
  })
}
