// @vitest-environment node
/**
 * 手机从电脑取文件 · 8791 这一侧的纯逻辑(2026-09-25,卡 J `feat/phone-fetch-file`)。
 *
 *   ① 认出「把 X 发到我手机上」(宁可漏认);
 *   ② 一句话 → 在哪找(项目)、找什么(词);
 *   ③ 按文件名找,不读内容;隐藏 / .git / 像密钥的不进结果;
 *   ④ 取件单:只有开给的那台设备能取、会过期;取之前再核一遍。
 *
 * 用到磁盘的用例只在 mkdtemp 的临时目录里建文件、只删那个临时目录。
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  FETCH_MAX_BYTES,
  checkOfferFile,
  contentDisposition,
  createFileOffers,
  fetchBlockReason,
  fetchKindOf,
  fetchMimeOf,
  notFoundNote,
  fileWantHint,
  isPointingToken,
  parseFetchRequest,
  planFileQuery,
  queryTokens,
  rankFound,
  searchLocalFiles,
  sha256OfFile,
  withinFetchRoots,
} from '../src/server/fileFetch.ts'

const dirs: string[] = []
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})
function sandbox(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wb-fetch-'))
  dirs.push(dir)
  return dir
}

describe('① 认出「把 X 发到我手机上」', () => {
  it.each([
    ['把工作台仓库的 README 发到我手机上', '工作台仓库的 README'],
    ['把工作台仓库的README发我', '工作台仓库的README'],
    ['帮我把 README 发到手机', 'README'],
    ['把产品说明.pdf 传到我手机', '产品说明.pdf'],
    ['麻烦把首页截图发给我', '首页截图'],
    ['发我一下工作台的 README', '工作台的 README'],
    ['给我发一下工作台的 README', '工作台的 README'],
    ['把 README 发过来', 'README'],
    ['工作台的 README 发我一下', '工作台的 README'],
    ['把「录屏.mov」发到这台手机上吧', '录屏.mov'],
    ['把录屏发我手机上', '录屏'],
    ['把会议纪要发到我的平板上', '会议纪要'],
    /**
     * ★ 2026-10-04 早她在手机上的原话(卡 `claude/phone-file-send-loop`)。
     * 老那一版认不出它:大正则只吃掉了「发到我」,剩下的「这个手机上」被当成另一段交代。
     */
    ['官网逐字稿,这份文件发到我这个手机上。', '官网逐字稿,这份文件'],
    ['把官网逐字稿发到我这个手机上', '官网逐字稿'],
    ['把官网逐字稿弄到手机上', '官网逐字稿'],
    ['把逐字稿同步到我手机', '逐字稿'],
    ['把逐字稿推给我', '逐字稿'],
    ['把那份参赛逐字稿传给我', '那份参赛逐字稿'],
    ['官网逐字稿发我这边', '官网逐字稿'],
    ['给我看看那份官网逐字稿', '官网逐字稿'],
    ['那份官网逐字稿给我看一下', '那份官网逐字稿'],
  ])('%s → %s', (said, query) => {
    expect(parseFetchRequest(said)).toEqual({ query })
  })

  it.each([
    '把这个功能做了',
    '把 README 改一下再发我',
    '把这周的数据整理成一份发我',
    '发个消息给我同事',
    '把 README 发给张三',
    '让 Codex 把 README 发给 Claude 看看',
    '别把 README 发我',
    '把这个发我',
    '你发我的那个文件在哪',
    '把 README 发我,然后把首页改成黑色的,再跑一遍测试',
    '',
    // ★ 2026-10-04 放宽「送到我这儿」那一段之后,这几句仍然一个都不许认成要文件。
    '发个消息给 Kimi',
    '给 Codex 发一句话,让他接着做',
    '把这段文案发给豆包改一下',
    '把这个链接发到群里',
    '把那份方案发给客户',
    '给我看看进度',
    '给我看看都有哪几家能派',
    '给我看看这个功能做到哪了',
    '把这个文件发到那台电脑上',
    // 落到她身上了,可不是她手机:另一条路 / 反方向。
    '把方案发我邮箱',
    '把这份稿子发我微信',
    '把这个文件发到我电脑上',
  ])('不岔:%s', (said) => {
    expect(parseFetchRequest(said)).toBeUndefined()
  })

  /**
   * 宽一格的那一档({@link fileWantHint}):它不岔路,只决定"这件事要有传输回执才算办完"
   * 与"第一条消息里告诉事务官走哪个口"。窄的那一档漏掉的那几句在这里要接得住。
   */
  describe('宽一格:认不准也不许掉地上', () => {
    it.each([
      '官网逐字稿,这份文件发到我这个手机上。',
      '把 README 改一下再发我',
      '把这周的数据整理成一份发我',
      '把 README 发我,然后把首页改成黑色的,再跑一遍测试',
      '把官网逐字稿导出成 PDF 发到我手机上',
    ])('要文件:%s', (said) => {
      expect(fileWantHint(said)).not.toBeUndefined()
    })

    it.each([
      '发个消息给 Kimi',
      '把这段文案发给豆包改一下',
      '把这个功能做了',
      '别把 README 发我',
      '把那份方案发给客户',
      '给我看看进度',
      '把方案发我邮箱',
      '把这个文件发到我电脑上',
      '',
    ])('不是要文件:%s', (said) => {
      expect(fileWantHint(said)).toBeUndefined()
    })

    it('窄的那一档认出来的,宽的那一档一定也认得出', () => {
      const said = '把工作台仓库的 README 发到我手机上'
      expect(parseFetchRequest(said)?.query).toBe('工作台仓库的 README')
      expect(fileWantHint(said)?.query).toBe('工作台仓库的 README')
    })
  })
})

describe('② 一句话 → 在哪找、找什么', () => {
  const projects = [
    { name: 'desktop-workbench', path: '/repo/desktop-workbench' },
    { name: 'Echo', path: '/repo/Echo' },
  ]

  it('「工作台仓库的 README」→ 只在 desktop-workbench 里找 readme', () => {
    const plan = planFileQuery('工作台仓库的 README', projects)
    expect(plan.project?.path).toBe('/repo/desktop-workbench')
    expect(plan.terms).toEqual(['readme'])
    expect(plan.label).toBe('desktop-workbench · readme')
  })

  it('没点项目名就在所有授权目录里找,词原样保留(小写)', () => {
    const plan = planFileQuery('产品说明.pdf', projects)
    expect(plan.project).toBeUndefined()
    expect(plan.terms).toEqual(['产品说明.pdf'])
  })

  it('只说了项目、没说文件 → 没有词(由上层问「要哪一个」)', () => {
    const plan = planFileQuery('工作台仓库', projects)
    expect(plan.project?.name).toBe('desktop-workbench')
    expect(plan.terms).toEqual([])
    expect(notFoundNote(plan, { authorized: true, workDirLabel: '事务官文件夹' })).toContain('要里面哪一个文件')
  })

  it('「仓库」「那个」这类词与单字不算词', () => {
    expect(queryTokens('工作台 那个 README')).toEqual(['工作台', '那个', 'README'])
    const plan = planFileQuery('那个 仓库 的 a README', [])
    expect(plan.terms).toEqual(['readme'])
  })

  it('认不像的项目不认(宁可在所有目录里找,也不在别人的仓库里找)', () => {
    const plan = planFileQuery('小红书 周报', projects)
    expect(plan.project).toBeUndefined()
    expect(plan.terms).toEqual(['小红书', '周报'])
  })
})

describe('③ 按文件名找', () => {
  function fixture(): string {
    const root = sandbox()
    mkdirSync(join(root, 'desktop-workbench', 'docs'), { recursive: true })
    mkdirSync(join(root, 'desktop-workbench', '.git'), { recursive: true })
    mkdirSync(join(root, 'desktop-workbench', 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(root, 'desktop-workbench', 'README.md'), 'root readme')
    writeFileSync(join(root, 'desktop-workbench', 'docs', 'README.md'), 'docs readme')
    writeFileSync(join(root, 'desktop-workbench', 'docs', 'readme-旧版备份.md'), 'old')
    writeFileSync(join(root, 'desktop-workbench', '.git', 'README'), 'git')
    writeFileSync(join(root, 'desktop-workbench', 'node_modules', 'x', 'README.md'), 'nm')
    writeFileSync(join(root, 'desktop-workbench', '.env.readme'), 'secret')
    writeFileSync(join(root, 'desktop-workbench', 'id_rsa'), 'key')
    writeFileSync(join(root, 'desktop-workbench', 'server-readme.pem'), 'key')
    return root
  }

  it('只比相对根的路径;隐藏、.git、node_modules、像密钥的都不进结果;文件名命中的排前面、浅的在前', async () => {
    const root = fixture()
    const outcome = await searchLocalFiles({ roots: [{ path: join(root, 'desktop-workbench'), label: '工作台' }], terms: ['readme'], whereLabel: '工作台' })
    const ranked = rankFound(outcome.files, ['readme'])
    expect(ranked.map(file => file.path.slice(root.length))).toEqual([
      '/desktop-workbench/README.md',
      '/desktop-workbench/docs/README.md',
      '/desktop-workbench/docs/readme-旧版备份.md',
    ])
    expect(ranked[0]?.where).toBe('工作台')
    expect(ranked[1]?.where).toBe('工作台 / docs')
    expect(outcome.total).toBe(3)
  })

  it('绝对路径里的词不算(根所在的那一截不参与比较)', async () => {
    const root = fixture()
    // 根的绝对路径里有 wb-fetch-,用它当词:相对路径里没有,一个都不该中。
    const outcome = await searchLocalFiles({ roots: [{ path: root, label: '扫描根' }], terms: ['wb-fetch'] })
    expect(outcome.files).toEqual([])
  })

  it('符号链接不跟(一条指向别处的链接既不是文件也不是目录)', async () => {
    const root = fixture()
    const outside = sandbox()
    writeFileSync(join(outside, 'README-外面的.md'), 'outside')
    symlinkSync(join(outside, 'README-外面的.md'), join(root, 'desktop-workbench', 'README-链接.md'))
    symlinkSync(outside, join(root, 'desktop-workbench', '外面'))
    const outcome = await searchLocalFiles({ roots: [{ path: root, label: '扫描根' }], terms: ['readme'] })
    expect(outcome.files.some(file => file.name.includes('链接') || file.name.includes('外面'))).toBe(false)
  })

  it('一个根读不到只记一句,不让整次搜索失败', async () => {
    const root = fixture()
    const outcome = await searchLocalFiles({
      roots: [{ path: join(root, '没有这个目录'), label: '扫描根' }, { path: root, label: '事务官文件夹' }],
      terms: ['readme'],
    })
    expect(outcome.errors).toHaveLength(1)
    expect(outcome.files.length).toBeGreaterThan(0)
  })

  it('扫到上限就停,如实标截断', async () => {
    const root = fixture()
    const outcome = await searchLocalFiles({ roots: [{ path: root, label: '扫描根' }], terms: ['readme'] }, { scanLimit: 3 })
    expect(outcome.truncated).toBe(true)
  })
})

describe('④ 取件单与取之前那一道', () => {
  it('只有开给的那台设备取得到;过期了谁都取不到;回环能看', () => {
    let now = 1_000
    const offers = createFileOffers({ now: () => now, ttlMs: 60_000, newId: () => `o${now}` })
    const offer = offers.add({ path: '/x/README.md', name: 'README.md', bytes: 3, where: '工作台', device_id: 'phone-1', source: 'typed' })
    expect(offers.forDevice(offer.id, 'phone-1')?.name).toBe('README.md')
    expect(offers.forDevice(offer.id, 'phone-2')).toBeUndefined()
    expect(offers.get(offer.id)?.path).toBe('/x/README.md')
    now += 60_001
    expect(offers.forDevice(offer.id, 'phone-1')).toBeUndefined()
    expect(offers.get(offer.id)).toBeUndefined()
  })

  it('超过上限的旧单被挤掉', () => {
    let n = 0
    const offers = createFileOffers({ keep: 2, newId: () => `o${++n}` })
    const first = offers.add({ path: '/a', name: 'a', bytes: 1, where: '', device_id: 'p', source: 'typed' })
    offers.add({ path: '/b', name: 'b', bytes: 1, where: '', device_id: 'p', source: 'typed' })
    offers.add({ path: '/c', name: 'c', bytes: 1, where: '', device_id: 'p', source: 'typed' })
    expect(offers.get(first.id)).toBeUndefined()
    expect(offers.size()).toBe(2)
  })

  it('取之前再核:隐藏、像密钥、不在根底下、没了、超上限,各说各的', async () => {
    const root = sandbox()
    const outside = sandbox()
    writeFileSync(join(root, 'ok.md'), 'hello')
    writeFileSync(join(outside, 'far.md'), 'far')
    symlinkSync(join(outside, 'far.md'), join(root, 'link.md'))
    writeFileSync(join(root, 'big.bin'), '')
    truncateSync(join(root, 'big.bin'), FETCH_MAX_BYTES + 1)

    expect(await checkOfferFile(join(root, 'ok.md'), [root])).toEqual({ ok: true, bytes: 5 })
    expect(await checkOfferFile(join(root, '.env'), [root])).toMatchObject({ ok: false, status: 403 })
    expect(await checkOfferFile(join(root, 'id_rsa'), [root])).toMatchObject({ ok: false, status: 403 })
    expect(await checkOfferFile(join(root, 'link.md'), [root])).toMatchObject({ ok: false, status: 403 })
    expect(await checkOfferFile(join(outside, 'far.md'), [root])).toMatchObject({ ok: false, status: 403 })
    expect(await checkOfferFile(join(root, '没了.md'), [root])).toMatchObject({ ok: false, status: 410 })
    const big = await checkOfferFile(join(root, 'big.bin'), [root])
    expect(big).toMatchObject({ ok: false, status: 413 })
    expect(big.ok ? '' : big.error).toContain('200MB')
  })

  it('sha256 流式算得对', async () => {
    const root = sandbox()
    writeFileSync(join(root, 'a.txt'), 'abc')
    expect(await sha256OfFile(join(root, 'a.txt'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('零碎', () => {
  it('fetchBlockReason:隐藏段、node_modules、像密钥的名字', () => {
    expect(fetchBlockReason('/a/.ssh/config')).toContain('隐藏')
    expect(fetchBlockReason('/a/node_modules/x/README.md')).toContain('node_modules')
    expect(fetchBlockReason('/a/credentials.json')).toContain('密钥')
    expect(fetchBlockReason('/a/README.md')).toBeUndefined()
  })

  it('withinFetchRoots 按路径段比', () => {
    expect(withinFetchRoots('/a/b/c.md', ['/a/b'])).toBe(true)
    expect(withinFetchRoots('/a/bc/c.md', ['/a/b'])).toBe(false)
  })

  it('MIME 与大类', () => {
    expect(fetchMimeOf('说明.PDF')).toBe('application/pdf')
    expect(fetchKindOf('说明.pdf')).toBe('pdf')
    expect(fetchKindOf('README.md')).toBe('text')
    expect(fetchKindOf('首页.png')).toBe('image')
    expect(fetchKindOf('录屏.mov')).toBe('video')
    expect(fetchKindOf('数据.xlsx')).toBe('other')
  })

  it('Content-Disposition 带 UTF-8 名字', () => {
    expect(contentDisposition('产品说明.pdf')).toBe(`attachment; filename="____.pdf"; filename*=UTF-8''${encodeURIComponent('产品说明.pdf')}`)
  })
})
