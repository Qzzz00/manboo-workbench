import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginDir = resolve(here, '..', '..')
const root = resolve(pluginDir, '..')
const outDir = resolve(root, 'docs', '交接-1023-协作区画布三处')
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const VITE_PORT = 4321
const CHROME_PORT = 4322 + Math.floor(Math.random() * 100)
const tmpUserData = fs.mkdtempSync(join(tmpdir(), 'chrome-three-fixes-'))

const sleep = ms => new Promise(r => setTimeout(r, ms))

fs.mkdirSync(outDir, { recursive: true })

let viteProc = null
let chromeProc = null
let finished = false

function killVite() {
  if (viteProc !== null) {
    try {
      if (viteProc.pid) process.kill(-viteProc.pid, 'SIGKILL')
    } catch { /* ignored */ }
    try {
      viteProc.kill('SIGKILL')
    } catch { /* ignored */ }
    viteProc = null
  }
}

function killChrome() {
  if (chromeProc !== null) {
    try { chromeProc.kill('SIGKILL') } catch { /* ignored */ }
    chromeProc = null
  }
  try {
    fs.rmSync(tmpUserData, { recursive: true, force: true })
  } catch { /* ignored */ }
}

function cleanup() {
  killChrome()
  killVite()
}

process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(1) })
process.on('SIGTERM', () => { cleanup(); process.exit(1) })

// 120s 兜底看门狗，超时必退
const watchdog = setTimeout(() => {
  if (finished) return
  console.error('Watchdog timeout (120s), aborting...')
  cleanup()
  process.exit(1)
}, 120_000)

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  ws.onmessage = event => {
    const msg = JSON.parse(String(event.data))
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve: ok, reject: bad } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error !== undefined) bad(new Error(msg.error.message ?? 'CDP error'))
      else ok(msg.result)
    }
  }
  const ready = new Promise((ok, bad) => {
    ws.onopen = () => ok()
    ws.onerror = err => bad(new Error(`CDP connection failed: ${String(err)}`))
  })
  const send = (method, params = {}, sessionId) => new Promise((ok, bad) => {
    const id = ++seq
    pending.set(id, { resolve: ok, reject: bad })
    ws.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const close = () => { try { ws.close() } catch { /* ignored */ } }
  return { ready, send, close }
}

async function waitForUrl(url, maxRetries = 50) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch { /* wait */ }
    await sleep(150)
  }
  throw new Error(`Failed to connect to ${url}`)
}

async function main() {
  console.log('1. Starting Vite dev server on port', VITE_PORT)
  const viteBin = resolve(pluginDir, 'node_modules', '.bin', 'vite')
  viteProc = spawn(
    viteBin,
    ['--config', 'dev/collab-board/vite.config.mjs', '--port', String(VITE_PORT), '--strictPort'],
    { cwd: pluginDir, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  )
  viteProc.stdout.on('data', d => {
    // console.log('[Vite]', d.toString().trim())
  })
  viteProc.stderr.on('data', d => {
    console.error('[Vite err]', d.toString().trim())
  })

  await waitForUrl(`http://127.0.0.1:${VITE_PORT}/`)
  console.log('   Vite server is ready.')

  console.log('2. Starting Chrome on debug port', CHROME_PORT)
  chromeProc = spawn(chrome, [
    '--headless=new',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${tmpUserData}`,
    `--remote-debugging-port=${CHROME_PORT}`,
    'about:blank',
  ], { stdio: 'ignore' })

  await waitForUrl(`http://127.0.0.1:${CHROME_PORT}/json/version`)
  console.log('   Chrome is ready.')

  const target = await (await fetch(`http://127.0.0.1:${CHROME_PORT}/json/new?about:blank`, { method: 'PUT' })).json()
  const client = cdp(target.webSocketDebuggerUrl)
  await client.ready
  await client.send('Page.enable')

  // ─────────────────────────────────────────────────────────────
  // 验收一: 组件模式 (非全屏) - 量真实 DOM Rect
  // ─────────────────────────────────────────────────────────────
  console.log('\n=== 验收一: 组件模式 (非全屏) ===')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1200, height: 800, deviceScaleFactor: 2, mobile: false,
  })
  await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/?full=0&view=goals` })
  await sleep(1500)

  const widgetEval = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const minimap = document.querySelector('.react-flow__minimap');
      const controls = document.querySelector('.react-flow__controls');
      const foot = document.querySelector('.ben-cl__foot');
      return {
        hasMinimap: minimap !== null,
        controlsRect: controls ? controls.getBoundingClientRect().toJSON() : null,
        footRect: foot ? foot.getBoundingClientRect().toJSON() : null,
      };
    })()`,
    returnByValue: true,
  })

  const wData = widgetEval.result.value
  console.log('   组件模式小地图存在:', wData.hasMinimap, '(期望: false - 不渲染)')
  if (wData.hasMinimap) throw new Error('组件模式不应渲染小地图！')

  if (!wData.controlsRect || !wData.footRect) throw new Error('未找到 controls 或 foot 元素！')
  const wGap = wData.footRect.top - wData.controlsRect.bottom
  console.log(`   缩放控件底部: ${wData.controlsRect.bottom}px, 底条顶部: ${wData.footRect.top}px`)
  console.log(`   真实垂直间距 (gap): ${wGap}px >= 0 (控件完全在底条之上，不被横线挡)`)
  if (wGap < 0) throw new Error(`缩放控件被底条挡住！重叠 ${-wGap}px`)

  const wShot = await client.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(resolve(outDir, '01-组件模式-无小地图-控件不遮挡.png'), Buffer.from(wShot.data, 'base64'))
  console.log('   已保存截图: 01-组件模式-无小地图-控件不遮挡.png')

  // ─────────────────────────────────────────────────────────────
  // 验收二: 全屏模式 - 量真实 DOM Rect、小地图渲染、间距
  // ─────────────────────────────────────────────────────────────
  console.log('\n=== 验收二: 全屏模式 ===')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 2, mobile: false,
  })
  await client.send('Page.navigate', { url: `http://127.0.0.1:${VITE_PORT}/?full=1&view=goals` })
  await sleep(1500)

  const fullEval = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const minimap = document.querySelector('.react-flow__minimap');
      const controls = document.querySelector('.react-flow__controls');
      const foot = document.querySelector('.ben-cl__foot');

      return {
        hasMinimap: minimap !== null,
        minimapRect: minimap ? minimap.getBoundingClientRect().toJSON() : null,
        controlsRect: controls ? controls.getBoundingClientRect().toJSON() : null,
        footRect: foot ? foot.getBoundingClientRect().toJSON() : null,
      };
    })()`,
    returnByValue: true,
  })

  const fData = fullEval.result.value
  console.log('   全屏模式小地图存在:', fData.hasMinimap, '(期望: true - 渲染)')
  if (!fData.hasMinimap) throw new Error('全屏模式必须渲染小地图！')
  console.log(`   小地图位置: top=${fData.minimapRect.top}px, right=${fData.minimapRect.right}px, width=${fData.minimapRect.width}px`)

  const fGap = fData.footRect.top - fData.controlsRect.bottom
  console.log(`   全屏缩放控件底部: ${fData.controlsRect.bottom}px, 底条顶部: ${fData.footRect.top}px`)
  console.log(`   真实垂直间距 (gap): ${fGap}px >= 0 (不相交)`)
  if (fGap < 0) throw new Error(`全屏缩放控件被底条挡住！重叠 ${-fGap}px`)

  const fShot = await client.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(resolve(outDir, '02-全屏模式-有小地图.png'), Buffer.from(fShot.data, 'base64'))
  console.log('   已保存截图: 02-全屏模式-有小地图.png')

  // ─────────────────────────────────────────────────────────────
  // 验收三: Agent 光标物理屏幕尺寸与缩放逆补偿 (fitView 与 100% 双档实测)
  // ─────────────────────────────────────────────────────────────
  console.log('\n=== 验收三: Agent 光标物理屏幕尺寸实测 (覆盖 fitView 与 100% 双档) ===')

  // 1. fitView 档测量 (小缩放档，通常 zoom ~0.38)
  const fitMeasure = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const flow = window.__collabFlow;
      const zoom = flow ? flow.getZoom() : null;
      const cursor = document.querySelector('.ben-cl__cursor');
      const cursorTag = document.querySelector('.ben-cl__cursor-tag');
      const avatar = cursorTag ? cursorTag.querySelector('.ben-cl__avatar') : null;
      const personName = cursorTag ? cursorTag.querySelector('.ben-cl__person-name') : null;
      const note = document.querySelector('.ben-cl__note');

      return {
        zoom,
        hasCursor: cursor !== null,
        cursorName: personName ? personName.textContent : null,
        tagRect: cursorTag ? cursorTag.getBoundingClientRect().toJSON() : null,
        avatarRect: avatar ? avatar.getBoundingClientRect().toJSON() : null,
        noteRect: note ? note.getBoundingClientRect().toJSON() : null,
      };
    })()`,
    returnByValue: true,
  })
  const fitD = fitMeasure.result.value
  console.log(`   [档位 A: fitView] 当前画布缩放 zoom = ${fitD.zoom?.toFixed(4)}`)
  console.log(`   - 卡片实际屏幕宽度: ${fitD.noteRect?.width?.toFixed(2)}px (受画布缩放缩小，正常)`)
  console.log(`   - 光标标签屏幕高度: ${fitD.tagRect?.height?.toFixed(2)}px (期望: ~28px, 逆补偿生效)`)
  console.log(`   - 头像实际屏幕尺寸: ${fitD.avatarRect?.width?.toFixed(2)}px x ${fitD.avatarRect?.height?.toFixed(2)}px (期望: ~22px x 22px)`)

  if (!fitD.hasCursor) throw new Error('fitView 档位未找到光标！')
  if (Math.abs(fitD.tagRect.height - 28) > 2) {
    throw new Error(`fitView 档位光标标签高度未逆补偿！实际高度: ${fitD.tagRect.height}px (期望 ~28px)`)
  }
  if (Math.abs(fitD.avatarRect.width - 22) > 1.5 || Math.abs(fitD.avatarRect.height - 22) > 1.5) {
    throw new Error(`fitView 档位头像尺寸未逆补偿！实际尺寸: ${fitD.avatarRect.width}x${fitD.avatarRect.height}px (期望 ~22x22px)`)
  }

  // 保存 fitView 档位光标截图
  const fitShot = await client.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(resolve(outDir, '03-Agent光标-规格与在做.png'), Buffer.from(fitShot.data, 'base64'))
  console.log('   已保存截图: 03-Agent光标-规格与在做.png')

  // 2. 100% zoom 档位测量 (zoom = 1.0)
  console.log('   切换到 100% 缩放 (zoom = 1.0)...')
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      if (window.__collabFlow) {
        window.__collabFlow.setViewport({ x: 0, y: 0, zoom: 1.0 });
      }
    })()`,
  })
  await sleep(600)

  const zoom100Measure = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const flow = window.__collabFlow;
      const zoom = flow ? flow.getZoom() : null;
      const cursorTag = document.querySelector('.ben-cl__cursor-tag');
      const avatar = cursorTag ? cursorTag.querySelector('.ben-cl__avatar') : null;
      const note = document.querySelector('.ben-cl__note');

      return {
        zoom,
        tagRect: cursorTag ? cursorTag.getBoundingClientRect().toJSON() : null,
        avatarRect: avatar ? avatar.getBoundingClientRect().toJSON() : null,
        noteRect: note ? note.getBoundingClientRect().toJSON() : null,
      };
    })()`,
    returnByValue: true,
  })
  const z100D = zoom100Measure.result.value
  console.log(`   [档位 B: 100% 缩放] 当前画布缩放 zoom = ${z100D.zoom?.toFixed(4)}`)
  console.log(`   - 卡片实际屏幕宽度: ${z100D.noteRect?.width?.toFixed(2)}px (100% 原尺寸 240px)`)
  console.log(`   - 光标标签屏幕高度: ${z100D.tagRect?.height?.toFixed(2)}px (期望: ~28px)`)
  console.log(`   - 头像实际屏幕尺寸: ${z100D.avatarRect?.width?.toFixed(2)}px x ${z100D.avatarRect?.height?.toFixed(2)}px (期望: ~22px x 22px)`)

  if (Math.abs(z100D.tagRect.height - 28) > 2) {
    throw new Error(`100% 档位光标标签高度异常！实际高度: ${z100D.tagRect.height}px (期望 ~28px)`)
  }
  if (Math.abs(z100D.avatarRect.width - 22) > 1.5 || Math.abs(z100D.avatarRect.height - 22) > 1.5) {
    throw new Error(`100% 档位头像尺寸异常！实际尺寸: ${z100D.avatarRect.width}x${z100D.avatarRect.height}px (期望 ~22x22px)`)
  }
  console.log('   ✓ 实测证明: Agent 光标物理屏幕尺寸在 fitView 小缩放与 100% 缩放下恒定保持 28px 高度与 22px 头像，卡片随画布缩放，光标始终清晰可辨！')

  // 复位回 fitView 状态，准备静止监测
  await client.send('Runtime.evaluate', {
    expression: 'window.__collabFlow && window.__collabFlow.fitView({ padding: 0.12, maxZoom: 1 })',
  })
  await sleep(600)

  // ─────────────────────────────────────────────────────────────
  // 验收四: 证明持续静止运行小地图 0 变动 (捕获完整 Mutation 与 ResizeObserver 证据)
  // ─────────────────────────────────────────────────────────────
  console.log('\n=== 验收四: 静止场景小地图变动与 ResizeObserver 监控 ===')
  await client.send('Runtime.evaluate', {
    expression: `(() => {
      window.__minimapMutations = [];
      window.__resizeObserverErrors = [];
      window.addEventListener('error', e => {
        if (e.message && e.message.includes('ResizeObserver')) {
          window.__resizeObserverErrors.push({ message: e.message, time: Date.now() });
        }
      });
      const svg = document.querySelector('.react-flow__minimap-svg');
      if (svg) {
        const obs = new MutationObserver((records) => {
          for (const r of records) {
            window.__minimapMutations.push({
              type: r.type,
              targetTag: r.target.tagName,
              targetClass: r.target.getAttribute ? (r.target.getAttribute('class') || '') : '',
              attributeName: r.attributeName || null,
              oldValue: r.oldValue || null,
              newValue: r.attributeName && r.target.getAttribute ? r.target.getAttribute(r.attributeName) : null,
              addedCount: r.addedNodes.length,
              removedCount: r.removedNodes.length,
              time: Date.now(),
            });
          }
        });
        obs.observe(svg, {
          childList: true,
          attributes: true,
          subtree: true,
          attributeOldValue: true,
        });
        window.__minimapObserver = obs;
      }
    })()`,
  })

  console.log('   静止监听小地图 SVG DOM 变动中 (等待 5.5 秒，历经 5 次 1 秒心跳节拍)...')
  await sleep(5500)

  const mutationCheck = await client.send('Runtime.evaluate', {
    expression: `(() => ({
      mutations: window.__minimapMutations,
      errors: window.__resizeObserverErrors,
    }))()`,
    returnByValue: true,
  })

  const { mutations, errors } = mutationCheck.result.value
  console.log(`   5 秒心跳节拍内小地图 SVG 变动记录数: ${mutations.length}`)
  console.log(`   5 秒心跳节拍内 ResizeObserver 异常数: ${errors.length}`)

  if (errors.length > 0) {
    console.error('   [FAIL] 捕获到 ResizeObserver 错误:', JSON.stringify(errors, null, 2))
    throw new Error(`捕获到 ${errors.length} 次 ResizeObserver loop 异常！`)
  }

  if (mutations.length > 0) {
    console.error('   [FAIL] 静止场景捕获到小地图 DOM 变动明细:')
    console.table(mutations)
    throw new Error(`静止场景下小地图 SVG 存在 ${mutations.length} 次非预期变动！必须为 0！`)
  }
  console.log('   ✓ 严苛断言通过: 静止状态下 5 秒内 0 次 SVG DOM 变动，0 次 ResizeObserver 异常！证明深度比较消除了每秒重刷根因！')

  // ─────────────────────────────────────────────────────────────
  // 验收五: 真实等待 60 秒无事件光标收掉 (真运行证明)
  // ─────────────────────────────────────────────────────────────
  console.log('\n=== 验收五: 真实等待 60 秒无事件光标收掉 ===')
  const initialCursorCheck = await client.send('Runtime.evaluate', {
    expression: "document.querySelector('.ben-cl__cursor') !== null",
    returnByValue: true,
  })
  console.log(`   [t=0s] 光标初始状态存在: ${initialCursorCheck.result.value}`)
  if (!initialCursorCheck.result.value) throw new Error('光标在 t=0s 时应当存在！')

  console.log('   开始真实等待 62 秒 (每 10 秒报告一次进度)...')
  for (let s = 10; s <= 60; s += 10) {
    await sleep(10000)
    const check = await client.send('Runtime.evaluate', {
      expression: "document.querySelector('.ben-cl__cursor') !== null",
      returnByValue: true,
    })
    console.log(`   [t=${s}s] 等待中... 光标存在: ${check.result.value}`)
  }

  // 再等 2 秒跨过 60s 阈值
  await sleep(2500)

  const finalCursorCheck = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const cursor = document.querySelector('.ben-cl__cursor');
      return {
        hasCursor: cursor !== null,
        nowMs: Date.now(),
      };
    })()`,
    returnByValue: true,
  })

  console.log(`   [t=62.5s] 光标状态: hasCursor = ${finalCursorCheck.result.value.hasCursor} (期望: false - 超过 60s 自动消失)`)
  if (finalCursorCheck.result.value.hasCursor) {
    throw new Error('超过 60 秒无事件后光标仍未收掉！')
  }
  console.log('   ✓ 真实运行证明: Agent 光标在 60 秒无事件后已被成功从 DOM 中收掉！')

  const expiredShot = await client.send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(resolve(outDir, '04-Agent光标-60s无事件后自动收掉.png'), Buffer.from(expiredShot.data, 'base64'))
  console.log('   已保存截图: 04-Agent光标-60s无事件后自动收掉.png')

  console.log('\n========================================')
  console.log('全部 5 项独立真实浏览器验收通过！')
  console.log('========================================')

  client.close()
  finished = true
  clearTimeout(watchdog)
  cleanup()
  process.exit(0)
}

main().catch(err => {
  console.error('\n验收执行出错:', err)
  finished = true
  clearTimeout(watchdog)
  cleanup()
  process.exit(1)
})
