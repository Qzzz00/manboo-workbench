/**
 * 在 Mac 上把一个文件转成手机看得了的样子(2026-10-01,手机读对话卡 C)。
 *
 * 统筹 10-01:「安卓手机上可没有快速预览」—— 转换**都在 Mac 这头做**,手机只收图片 / 文字 / 能直接播的音视频:
 *   - 缩略图:Quick Look(`qlmanage -t`),Keynote / Pages / Office / PDF / 视频首帧 / 图片都出得来;
 *   - 图片转 JPEG(HEIC、TIFF 这类安卓不认的,顺带缩小):`sips`;
 *   - 文档正文(docx / doc / rtf / odt):`textutil -convert html`;
 *   - 音频转 m4a(flac / aiff / caf…):`afconvert`;
 *   - PDF 页数与逐页出图:系统自带的 PDFKit(JXA,`osascript -l JavaScript`),不装任何东西。
 *
 * 全是系统自带的命令,只读原文件;输出写进一个临时目录,**读进内存就整个删掉**(不在别处留她文件的副本)。
 * 出不来(命令不在、超时、格式不认)一律 undefined —— 调用方退一档,不报错。
 */
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

export interface MacPreviewTools {
  /** Quick Look 缩略图(PNG),边长 ≤ px。 */
  thumbnail: (file: string, px: number) => Promise<{ mime: string, bytes: Buffer } | undefined>
  /** 转成 JPEG;给了 maxPx 就顺带缩到长边 ≤ maxPx。 */
  toJpeg: (file: string, maxPx?: number) => Promise<Buffer | undefined>
  /** 文档正文转成一页 HTML。 */
  toHtml: (file: string) => Promise<string | undefined>
  /** 音频转成 m4a(AAC)。 */
  toM4a: (file: string) => Promise<Buffer | undefined>
  pdfPages: (file: string) => Promise<number | undefined>
  /** PDF 第 page 页(从 0 数)出一张 JPEG,宽 px。 */
  pdfPage: (file: string, page: number, px: number) => Promise<Buffer | undefined>
}

const TIMEOUT_MS = 30_000

function run(command: string, args: readonly string[], options: { maxBuffer?: number } = {}): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, [...args], { timeout: TIMEOUT_MS, maxBuffer: options.maxBuffer ?? 1024 * 1024, encoding: 'utf8' }, (error, stdout) => {
      resolve(error === null ? stdout : undefined)
    })
  })
}

/** 开一个临时目录,干完就删(不管成没成)。 */
async function inTemp<T>(work: (dir: string) => Promise<T>): Promise<T | undefined> {
  let dir: string | undefined
  try {
    dir = await mkdtemp(join(tmpdir(), 'wb-preview-'))
    return await work(dir)
  }
  catch {
    return undefined
  }
  finally {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

async function readOrUndefined(file: string): Promise<Buffer | undefined> {
  try {
    const bytes = await readFile(file)
    return bytes.length === 0 ? undefined : bytes
  }
  catch {
    return undefined
  }
}

const PDF_PAGES_JXA = `function run(argv) {
  ObjC.import('Quartz');
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  return doc.isNil() ? '' : String(doc.pageCount);
}`

const PDF_PAGE_JXA = `function run(argv) {
  ObjC.import('Quartz'); ObjC.import('AppKit');
  const doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (doc.isNil()) return '';
  const index = Number(argv[1]);
  if (!(index >= 0 && index < doc.pageCount)) return '';
  const page = doc.pageAtIndex(index);
  const box = page.boundsForBox($.kPDFDisplayBoxMediaBox);
  const width = Number(argv[2]);
  const height = Math.max(1, Math.round(box.size.height * width / box.size.width));
  const image = page.thumbnailOfSizeForBox($.NSMakeSize(width, height), $.kPDFDisplayBoxMediaBox);
  const rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  const data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypeJPEG, $({ NSImageCompressionFactor: 0.8 }));
  data.writeToFileAtomically(argv[3], true);
  return 'ok';
}`

export function createMacPreviewTools(): MacPreviewTools {
  return {
    thumbnail: async (file, px) => await inTemp(async (dir) => {
      await run('/usr/bin/qlmanage', ['-t', '-s', String(px), '-o', dir, file])
      const bytes = await readOrUndefined(join(dir, `${basename(file)}.png`))
      return bytes === undefined ? undefined : { mime: 'image/png', bytes }
    }),
    toJpeg: async (file, maxPx) => await inTemp(async (dir) => {
      const out = join(dir, 'out.jpg')
      await run('/usr/bin/sips', ['-s', 'format', 'jpeg', ...(maxPx === undefined ? [] : ['-Z', String(maxPx)]), file, '--out', out])
      return await readOrUndefined(out)
    }),
    toHtml: async (file) => {
      const html = await run('/usr/bin/textutil', ['-convert', 'html', '-stdout', file], { maxBuffer: 32 * 1024 * 1024 })
      return html === undefined || html.trim() === '' ? undefined : html
    },
    toM4a: async (file) => await inTemp(async (dir) => {
      const out = join(dir, 'out.m4a')
      await run('/usr/bin/afconvert', ['-f', 'm4af', '-d', 'aac', file, out])
      return await readOrUndefined(out)
    }),
    pdfPages: async (file) => {
      const out = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_PAGES_JXA, file])
      const n = Number(out?.trim())
      return Number.isInteger(n) && n > 0 ? n : undefined
    },
    pdfPage: async (file, page, px) => await inTemp(async (dir) => {
      const out = join(dir, 'page.jpg')
      const said = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PDF_PAGE_JXA, file, String(page), String(px), out])
      return said?.trim() === 'ok' ? await readOrUndefined(out) : undefined
    }),
  }
}
