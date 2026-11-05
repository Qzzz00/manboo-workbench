import { describe, expect, it } from 'vitest'
import {
  AVATAR_PRESETS, AVATAR_PRESETS_PER_KIND, AVATAR_UPLOAD_MAX_BYTES, CROP_START, checkImageSize, checkUploadFile, cropSource, nudgeCrop, presetOf,
} from '../src/client/collab/avatarModel.ts'

describe('头像库', () => {
  it('人物与机器人各一套,数量来自那一个常量', () => {
    expect(AVATAR_PRESETS.filter(one => one.kind === 'human')).toHaveLength(AVATAR_PRESETS_PER_KIND)
    expect(AVATAR_PRESETS.filter(one => one.kind === 'agent')).toHaveLength(AVATAR_PRESETS_PER_KIND)
    expect(presetOf('agent-0')?.label).toBe('机器人 1')
    expect(presetOf('nope')).toBeUndefined()
  })
})

describe('上传校验', () => {
  it('格式与大小在选文件那一下挡', () => {
    expect(checkUploadFile({ type: 'image/gif', size: 10 })).toMatch(/PNG、JPG 或 WebP/)
    expect(checkUploadFile({ type: 'image/png', size: AVATAR_UPLOAD_MAX_BYTES + 1 })).toMatch(/超过/)
    expect(checkUploadFile({ type: 'image/webp', size: 1000 })).toBeUndefined()
  })
  it('解码后:坏图、太小、像素太多', () => {
    expect(checkImageSize(0, 0)).toMatch(/打不开/)
    expect(checkImageSize(20, 400)).toMatch(/太小/)
    expect(checkImageSize(8000, 6000)).toMatch(/像素太多/)
    expect(checkImageSize(800, 600)).toBeUndefined()
  })
})

describe('裁剪', () => {
  it('不缩放取居中最大的正方形;放大两倍边长减半', () => {
    expect(cropSource(800, 600, CROP_START)).toEqual({ sx: 100, sy: 0, side: 600 })
    expect(cropSource(800, 600, { zoom: 2, x: 0.5, y: 0.5 })).toEqual({ sx: 250, sy: 150, side: 300 })
  })
  it('往右拖 = 方框往左;拖出边界停在边上', () => {
    const moved = nudgeCrop(CROP_START, 50, 0, 800, 600, 192)
    expect(moved.x).toBeLessThan(0.5)
    expect(nudgeCrop(CROP_START, 10_000, 0, 800, 600, 192).x).toBe(0)
    // 正方形图不缩放时没地方挪
    expect(nudgeCrop(CROP_START, 30, 30, 500, 500, 192)).toEqual(CROP_START)
  })
})
