// @vitest-environment node
/**
 * 选题的关联素材(2026-09-21)。这一份钉的是 server/topicAssets.ts 顶上写的那两条认定规则,
 * 以及「读不到 ≠ 零个」这条分寸。
 */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  TOPIC_ASSET_SUBDIR, TOPIC_DIR,
  ensureTopicDir, isSafeTopicName, listTopicAssets, topicDirOf,
} from '../src/server/topicAssets.ts'
import { TOPIC_DELIVERABLE_FILES } from '../src/templates.ts'
import { loadStarterLayoutTemplate } from './helpers/starterLayer.ts'
import { TOPIC_STAGES } from '../src/protocol.ts'
const OPS_TEMPLATE = await loadStarterLayoutTemplate()

async function workdir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'topic-assets-'))
}

async function touch(path: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '')
}

describe('目录约定', () => {
  it('选题目录就叫「选题」,而且运营模板真的会去建它', () => {
    expect(TOPIC_DIR).toBe('选题')
    expect(OPS_TEMPLATE.folders.map(f => f.rel)).toContain(TOPIC_DIR)
  })

  it('六段各自该产出哪份文件,六段一个不落', () => {
    expect(Object.keys(TOPIC_DELIVERABLE_FILES).sort()).toEqual([...TOPIC_STAGES].sort())
  })

  it('选题名当不了目录名的一律不认:带斜杠、点开头、空的', () => {
    expect(isSafeTopicName('露营锅具怎么选')).toBe(true)
    expect(isSafeTopicName('a/b')).toBe(false)
    expect(isSafeTopicName('a\\b')).toBe(false)
    expect(isSafeTopicName('..')).toBe(false)
    expect(isSafeTopicName('.隐藏')).toBe(false)
    expect(isSafeTopicName('  ')).toBe(false)
  })

  it('名字不合法时**不拼一条半截路径出来**', () => {
    expect(topicDirOf('/w/选题', '../跑出去')).toBeUndefined()
    expect(topicDirOf('/w/选题', '露营')).toBe('/w/选题/露营')
  })
})

describe('哪些文件算这条选题的', () => {
  it('两条规则:自己目录里的都算,素材库里以选题名开头的算', async () => {
    const root = await workdir()
    const topics = join(root, TOPIC_DIR)
    await touch(join(topics, '露营锅具怎么选', TOPIC_ASSET_SUBDIR, '开箱.mp4'))
    await touch(join(root, '素材/图片素材/露营锅具怎么选-封面.png'))
    await touch(join(root, '素材/图片素材/别人的封面.png'))

    const [row] = await listTopicAssets({
      topicsDir: topics,
      materialDirs: { 图片素材: join(root, '素材/图片素材') },
      names: ['露营锅具怎么选'],
    })
    expect(row?.files.map(f => f.name)).toEqual(['开箱.mp4', '露营锅具怎么选-封面.png'])
    expect(row?.files.map(f => f.from)).toEqual([TOPIC_ASSET_SUBDIR, '图片素材'])
  })

  it('**没有第三条规则**:名字里含选题名但不是开头的不算', async () => {
    const root = await workdir()
    await touch(join(root, '素材/成片/转发-露营锅具怎么选.mp4'))
    const [row] = await listTopicAssets({
      topicsDir: join(root, TOPIC_DIR),
      materialDirs: { 成片: join(root, '素材/成片') },
      names: ['露营锅具怎么选'],
    })
    expect(row?.files).toEqual([])
  })

  it('目录还没建过 = 没有素材,**不是错**', async () => {
    const root = await workdir()
    const [row] = await listTopicAssets({
      topicsDir: join(root, TOPIC_DIR),
      materialDirs: { 成片: join(root, '素材/成片') },
      names: ['还没建过'],
    })
    expect(row?.files).toEqual([])
    expect(row?.errors).toBeUndefined()
  })

  it('子目录与点开头的文件不算素材', async () => {
    const root = await workdir()
    const own = join(root, TOPIC_DIR, '选题一', TOPIC_ASSET_SUBDIR)
    await mkdir(join(own, '一个子目录'), { recursive: true })
    await touch(join(own, '.DS_Store'))
    await touch(join(own, '真的素材.png'))
    const [row] = await listTopicAssets({ topicsDir: join(root, TOPIC_DIR), materialDirs: {}, names: ['选题一'] })
    expect(row?.files.map(f => f.name)).toEqual(['真的素材.png'])
  })

  it('名字当不了目录名的那一条**整条跳过**,不拿一个改过的名字冒充它', async () => {
    const root = await workdir()
    const rows = await listTopicAssets({
      topicsDir: join(root, TOPIC_DIR),
      materialDirs: {},
      names: ['好名字', '坏/名字'],
    })
    expect(rows.map(r => r.name)).toEqual(['好名字'])
  })

  it('截断一定说出来', async () => {
    const root = await workdir()
    const own = join(root, TOPIC_DIR, '选题一', TOPIC_ASSET_SUBDIR)
    await mkdir(own, { recursive: true })
    for (let i = 0; i < 5; i++) await writeFile(join(own, `素材${i}.png`), '')
    const [row] = await listTopicAssets({
      topicsDir: join(root, TOPIC_DIR), materialDirs: {}, names: ['选题一'], maxPerTopic: 3,
    })
    expect(row?.files).toHaveLength(3)
    expect(row?.truncated).toBe(true)
  })

  it('一批选题一次问完,回的顺序就是问的顺序', async () => {
    const root = await workdir()
    const rows = await listTopicAssets({
      topicsDir: join(root, TOPIC_DIR), materialDirs: {}, names: ['甲', '乙', '丙'],
    })
    expect(rows.map(r => r.name)).toEqual(['甲', '乙', '丙'])
  })
})

describe('建这条选题的目录', () => {
  it('建出 `选题/<名>/素材/`,回绝对路径', async () => {
    const root = await workdir()
    const made = await ensureTopicDir(join(root, TOPIC_DIR), '露营锅具怎么选')
    expect(made.ok).toBe(true)
    expect(made.ok && made.dir).toBe(join(root, TOPIC_DIR, '露营锅具怎么选'))
    // 建完再列一次:目录在了,素材还是零个(建目录不造文件)。
    const [row] = await listTopicAssets({ topicsDir: join(root, TOPIC_DIR), materialDirs: {}, names: ['露营锅具怎么选'] })
    expect(row?.files).toEqual([])
  })

  it('建第二次不报错(recursive),也不动里面已有的东西', async () => {
    const root = await workdir()
    const topics = join(root, TOPIC_DIR)
    await ensureTopicDir(topics, '选题一')
    await touch(join(topics, '选题一', TOPIC_ASSET_SUBDIR, '已经有的.png'))
    expect((await ensureTopicDir(topics, '选题一')).ok).toBe(true)
    const [row] = await listTopicAssets({ topicsDir: topics, materialDirs: {}, names: ['选题一'] })
    expect(row?.files.map(f => f.name)).toEqual(['已经有的.png'])
  })

  it('名字不合法:拒绝并说出为什么,**一个目录都不建**', async () => {
    const root = await workdir()
    const made = await ensureTopicDir(join(root, TOPIC_DIR), '../跑出去')
    expect(made.ok).toBe(false)
    expect(made.ok === false && made.reason).toContain('选题名')
  })
})
