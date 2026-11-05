// @vitest-environment node
/**
 * Mac 上那几样转换真能用(2026-10-01,手机读对话卡 C)。只在 macOS 上跑:系统自带的 qlmanage / sips / textutil / osascript,
 * 不装任何东西;临时目录用完即删。
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createMacPreviewTools } from '../src/server/macPreview.ts'

const dirs: string[] = []
afterEach(() => { while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true }) })

/** 两页的最小 PDF。 */
function tinyPdf(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => { offsets.push(body.length); body += `${i + 1} 0 obj\n${obj}\nendobj\n` })
  const xref = body.length
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return body
}

describe.runIf(process.platform === 'darwin')('Mac 上的转换', () => {
  it('PDF 页数、逐页出 JPEG;rtf 出正文;临时目录不留', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wb-macpreview-'))
    dirs.push(dir)
    const before = readdirSync(tmpdir()).filter(name => name.startsWith('wb-preview-')).length
    const tools = createMacPreviewTools()
    const pdf = join(dir, 'a.pdf')
    writeFileSync(pdf, tinyPdf())
    expect(await tools.pdfPages(pdf)).toBe(2)
    const page = await tools.pdfPage(pdf, 1, 400)
    expect(page?.subarray(0, 2).toString('hex')).toBe('ffd8')
    expect(await tools.pdfPage(pdf, 5, 400)).toBeUndefined()
    const rtf = join(dir, 'a.rtf')
    writeFileSync(rtf, '{\\rtf1\\ansi\\deff0 {\\fonttbl {\\f0 Helvetica;}}\\f0 hello world\\par}')
    expect(await tools.toHtml(rtf)).toMatch(/hello/)
    const jpeg = page === undefined ? undefined : join(dir, 'p.jpg')
    if (jpeg !== undefined) {
      writeFileSync(jpeg, page!)
      expect((await tools.toJpeg(jpeg, 100))?.subarray(0, 2).toString('hex')).toBe('ffd8')
    }
    expect(await tools.toHtml(join(dir, 'nope.rtf'))).toBeUndefined()
    expect(readdirSync(tmpdir()).filter(name => name.startsWith('wb-preview-')).length).toBe(before)
    expect(existsSync(pdf)).toBe(true)
  }, 60_000)
})
