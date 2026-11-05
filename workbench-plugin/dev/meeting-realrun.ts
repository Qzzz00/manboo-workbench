/**
 * 会议模式的一次**真跑**(2026-09-21)。用法与它读/写什么见 `dev/README.md`。
 *
 * 真的那几段:
 *   - 真的火山识别(经本机 8792 `/api/asr`;回环不要令牌);
 *   - 真的模型(走 modelService 定的那一家,**只读** `~/.dsh/workbench/model.json`,一个字不写);
 *   - 真的落盘(写在 `--out` 指的目录里,**不碰 Ben 的工作目录**)。
 * 假的那一段:音频本身 —— `dev/假会议-测试音频.m4a` 是 TTS 念出来的一段假会议,见 README。
 *
 * 自动化用例里转写与模型都是打桩的(tests/server-meeting.test.ts);这个脚本存在的唯一理由
 * 是**量真实数字**:一段音频要转多久、花多少、模型吃多少 token。数字记在
 * `docs/交接-0921-会议模式.md` 第五节 —— 那一节里的数,每一个都是这个脚本跑出来的。
 */
import { mkdtempSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMeetingService } from '../src/server/meeting.ts'
import { createModelService } from '../src/server/modelService.ts'

function argOf(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)
  return at < 0 ? undefined : process.argv[at + 1]
}

async function main(): Promise<void> {
  const home = process.env.HOME ?? ''
  // fileURLToPath 而不是 .pathname:中文文件名在 URL 里是百分号转义的,直接拿 pathname 会 ENOENT。
  const audio = argOf('audio') ?? fileURLToPath(new URL('./假会议-测试音频.m4a', import.meta.url))
  const out = argOf('out') ?? mkdtempSync(join(tmpdir(), 'wb-meeting-realrun-'))
  const butlerUrl = argOf('butler') ?? 'http://127.0.0.1:8792'
  const workdir = join(out, 'workdir')
  await mkdir(workdir, { recursive: true })
  console.log(`产物落在 ${workdir}`)

  // dshHome 故意不传:这一跑**绝不碰 DSH 的 settings.yaml / .env**。
  const model = createModelService({
    modelFile: `${home}/.dsh/workbench/model.json`,
    credentialFile: `${home}/.dsh/workbench/credentials.json`,
  })

  let asrCalls = 0
  let asrBytes = 0
  let asrMs = 0
  let modelMs = 0

  const service = createMeetingService({
    file: join(out, 'meetings.json'),
    workdir: () => workdir,
    transcribe: async (wav) => {
      asrCalls += 1
      asrBytes += wav.length
      const at = Date.now()
      const res = await fetch(`${butlerUrl}/api/asr`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ audio: wav.toString('base64') }),
      })
      asrMs += Date.now() - at
      const body = await res.text()
      if (!res.ok) throw new Error(`8792 回了 ${res.status}:${body.slice(0, 200)}`)
      return (JSON.parse(body) as { text?: string }).text ?? ''
    },
    chat: async (prompt) => {
      const endpoint = await model.endpoint()
      if (!endpoint.ready) throw new Error('模型服务没接上')
      const at = Date.now()
      const res = await fetch(`${endpoint.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(endpoint.key === undefined ? {} : { authorization: `Bearer ${endpoint.key}` }),
        },
        body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }], max_tokens: 2000, temperature: 0.4 }),
      })
      modelMs = Date.now() - at
      if (!res.ok) throw new Error(`模型回了 ${res.status}`)
      const json = await res.json() as { choices?: { message?: { content?: string } }[], usage?: Record<string, number> }
      console.log('模型用量:', JSON.stringify(json.usage ?? {}))
      return json.choices?.[0]?.message?.content ?? ''
    },
  })

  const started = await service.start({ title: '假会议(测试音频)' })
  if (!started.ok || started.id === undefined || started.dir === undefined) {
    console.error('开不了:', started.error)
    process.exitCode = 1
    return
  }

  const bytes = await readFile(audio)
  const seg = await service.segment({ id: started.id, seq: 1, bytes, mimeType: 'audio/mp4' })
  console.log(`收了一段 ${(bytes.length / 1024).toFixed(0)}KB:`, JSON.stringify(seg))

  const wall = Date.now()
  await service.finish({ id: started.id })
  await service.idle()
  const total = Date.now() - wall

  const view = await service.get(started.id)
  console.log('—— 结果 ——')
  console.log('status:', view?.status, '| 音频', view?.seconds, '秒 | error:', view?.error ?? '(无)')
  console.log('待办:', JSON.stringify(view?.todos, null, 1))
  console.log('拿不准:', JSON.stringify(view?.unsure, null, 1))
  console.log('—— 数字 ——')
  console.log(`ASR ${asrCalls} 次,送出去 ${(asrBytes / 1024 / 1024).toFixed(2)}MB wav,识别合计 ${asrMs}ms`)
  console.log(`模型一次 ${modelMs}ms;整条(解码 + 识别 + 梳理)${total}ms`)
  console.log(`转写与纪要:${started.dir}`)
}

void main().catch((error: unknown) => { console.error('真跑失败:', error); process.exitCode = 1 })
