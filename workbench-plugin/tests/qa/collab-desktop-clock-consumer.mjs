/** E clock delta: existing natural logs only; controlled fetch variants are explicitly UI cases. */
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
export async function clockAcceptance({ dir, plugin, primary, api, record, startChild, until, browser, evaluate, shown }) {
  const state = await api(primary, '/state')
  let selected, runs
  for (const task of state.tasks.tasks) {
    const result = await api(primary, `/collab/runs?task_id=${task.id}`)
    if (result.runs.some(run => run.execution_started_observed_at && run.execution_finished_observed_at)) { selected = task; runs = result.runs; break }
  }
  assert(selected, 'prior natural started/replied must project observation times')
  const activity = await api(primary, `/collab/note/activity?id=${selected.id}`)
  writeFileSync(join(dir, 'clock-real-api.json'), JSON.stringify({ task: selected, runs, activity }, null, 2))
  record('real_archived_execution_clock_projection', { taskId: selected.id, runs, provenance: 'prior natural started/replied logs; no append or new CLI' })
  const require = createRequire(import.meta.url)
  const vite = join(dirname(createRequire(require.resolve('vitest/package.json')).resolve('vite/package.json')), 'bin/vite.js')
  startChild(process.execPath, [vite, '--config', 'dev/collab-board/vite.config.mjs', '--port', '9991', '--strictPort'], { cwd: plugin })
  await until(() => fetch('http://127.0.0.1:9991/desktop-test.html').then(r => r.ok).catch(() => false), Boolean, 'Vite')
  const client = await browser()
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: String.raw`
    window.__clockCase = 'real'; const original = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await original(...args);
      if (!/\/collab\/(runs|note\/activity)\?/.test(String(args[0])) || window.__clockCase === 'real') return response;
      const body = await response.json();
      const segments = [...(body.runs || []), ...(body.items || []).filter(x => x.type === 'run').map(x => x.segment)];
      for (const run of segments) {
        if (window.__clockCase === 'legacy') { delete run.execution_started_observed_at; delete run.execution_finished_observed_at; }
        if (window.__clockCase === 'unknown-long') { run.status = 'unknown'; run.source = 'codex/受控长来源'.repeat(40); }
      }
      return new Response(JSON.stringify(body), { status: response.status, headers: response.headers });
    };` })
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  const url = `http://127.0.0.1:9991/desktop-test.html?live=1&view=goals&api=${encodeURIComponent(primary.url)}`
  await client.send('Page.navigate', { url })
  const open = async () => {
    await shown(`!!document.querySelector('[data-note-id="${selected.id}"] .ben-cl__note-title')`)
    await evaluate(`document.querySelector('[data-note-id="${selected.id}"] .ben-cl__note-title').click()`)
    await shown(`!!document.querySelector('.ben-cl__dialog .ben-cl__runs')`)
  }
  await open()
  const panel = "document.querySelector('.ben-cl__dialog .ben-cl__runs')"
  await shown(`${panel}?.textContent.includes('本机核到开工：') && !${panel}.textContent.includes('本机核到开工：未知')`)
  await shown(`Array.from(document.querySelectorAll('.ben-cl__talk [data-kind="run"]')).some(el => el.textContent.includes('收到结果：'))`)
  record('production_detail_activity_real_fields', { text: await evaluate(`${panel}.textContent`) })
  for (const mode of ['legacy', 'unknown-long']) {
    await evaluate(`window.__clockCase = ${JSON.stringify(mode)}; document.querySelector('button[aria-label="关上"]').click()`)
    await open()
    if (mode === 'legacy') await shown(`${panel}.textContent.includes('本机核到开工：未知 · 收到结果：未知')`)
    else {
      await shown(`${panel}.querySelector('[data-status="unknown"]')?.textContent.includes('不当作在跑')`)
      await client.send('Emulation.setDeviceMetricsOverride', { width: 520, height: 900, deviceScaleFactor: 1, mobile: false })
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
      const geometry = await evaluate(`Array.from(document.querySelectorAll('.ben-cl__dialog .ben-cl__runs li, .ben-cl__dialog .ben-cl__talk [data-kind="run"]')).map(el => ({ width: el.clientWidth, scroll: el.scrollWidth }))`)
      assert(geometry.length && geometry.every(one => one.scroll <= one.width + 1), JSON.stringify(geometry))
      record('controlled_unknown_history_narrow_long_wrap', { geometry, note: 'UI transport variant only; not a newly observed disconnection' })
    }
    await evaluate(`${panel}.scrollIntoView({ block: 'center' }); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(dir, `clock-${mode}.png`), Buffer.from(screenshot.data, 'base64'))
  }
  await evaluate(`window.__clockCase = 'real'; document.querySelector('button[aria-label="关上"]').click(); Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '时间线').click()`)
  await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false })
  await shown(`document.querySelector('.ben-cl__timeline-actual')?.textContent.includes('本机核到开工：')`)
  const timelineText = await evaluate(`document.querySelector('.ben-cl__timeline-actual').textContent`)
  assert(timelineText.includes('派出记录日期：') && timelineText.includes('收到结果：'))
  assert(await evaluate(`document.body.textContent.includes('计划与会话记录')`))
  const screenshot = await client.send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(dir, 'clock-timeline.png'), Buffer.from(screenshot.data, 'base64'))
  record('production_timeline_real_fields_plan_separate', { text: timelineText })
  assert.deepEqual(await evaluate('window.__errs'), [])
}
