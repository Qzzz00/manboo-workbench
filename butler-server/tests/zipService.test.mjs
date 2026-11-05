// 来源:Aiboo origin/main 1f430c3f server/services/zipService.test.cjs(node:test → vitest)
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { require } from './_setup.mjs';

const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');
const { validateAndExtractZip, findModelEntry, MAX_ZIP_BYTES, MAX_MODEL_DEPTH } = require('../server/services/zipService.cjs');

const made = [];
function tmpDir(label) {
  const dir = mkdtempSync(join(tmpdir(), `butler-zip-test-${label}-`));
  made.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

function buildZip(entries) {
  const zip = new AdmZip();
  for (const [name, content] of entries) zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  return zip.toBuffer();
}

// adm-zip 写入时会规范化路径(去掉 .. 与开头 /),要测恶意名字得先放同长占位符再改字节。
function buildZipWithRawName(rawName) {
  const placeholder = '@'.repeat(rawName.length);
  const buf = buildZip([[placeholder, 'payload']]);
  const ph = Buffer.from(placeholder, 'ascii');
  const rn = Buffer.from(rawName, 'ascii');
  let idx = buf.indexOf(ph);
  while (idx !== -1) {
    rn.copy(buf, idx);
    idx = buf.indexOf(ph);
  }
  return buf;
}

// 模拟 Windows 资源管理器 / WinRAR 压出来的包:条目名按 GBK(cp936)存字节,通用标志 bit 11(EFS)不置位。
// adm-zip 的 decoder 选项决定写入字节;efs:false 让它不打 UTF-8 标志。
function buildGbkZip(entries) {
  const decoder = { encode: (s) => iconv.encode(s, 'gbk'), decode: (b) => iconv.decode(b, 'gbk'), efs: false };
  const zip = new AdmZip(null, { decoder });
  for (const [name, content] of entries) zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  return zip.toBuffer();
}

// 条目名字节任意(用来造既不是 UTF-8 也不是 GBK 的坏名字),不打 EFS 标志。
function buildRawNameZip(rawNameBytes) {
  const decoder = { encode: (s) => Buffer.from(s, 'latin1'), decode: (b) => b.toString('latin1'), efs: false };
  const zip = new AdmZip(null, { decoder });
  zip.addFile(Buffer.from(rawNameBytes).toString('latin1'), Buffer.from('payload'));
  return zip.toBuffer();
}

function flagsOf(buf) {
  return new AdmZip(buf).getEntries().map((e) => (e.header.flags & 0x800) !== 0);
}

const MODEL_JSON = JSON.stringify({ Version: 3, FileReferences: {} });
const codeOf = (fn) => {
  try { fn(); } catch (err) { return err.code; }
  return undefined;
};

describe('Live2D zip 校验与解压', () => {
  it('合法 zip → 返回 checksum/size/modelEntry 并解压', () => {
    const dir = tmpDir('ok');
    const buf = buildZip([
      ['yumi.model3.json', MODEL_JSON],
      ['yumi.moc3', 'fake-moc'],
      ['textures/texture_00.png', 'png-bytes'],
    ]);
    const result = validateAndExtractZip(buf, dir);
    expect(result.modelEntry).toBe('yumi.model3.json');
    expect(result.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sizeBytes).toBe(buf.length);
    expect(result.extractedFiles).toContain('textures/texture_00.png');
    expect(existsSync(join(dir, 'textures', 'texture_00.png'))).toBe(true);
  });

  it('一级子目录里的 model3.json 也接受', () => {
    const dir = tmpDir('subdir');
    const buf = buildZip([['model/char.model3.json', MODEL_JSON], ['model/char.moc3', 'fake']]);
    expect(validateAndExtractZip(buf, dir).modelEntry).toBe('model/char.model3.json');
  });

  it('缺 model3.json → avatar_zip_no_model,且目录无残留', () => {
    const dir = tmpDir('nomodel');
    const buf = buildZip([['readme.txt', 'hello'], ['textures/a.png', 'x']]);
    expect(codeOf(() => validateAndExtractZip(buf, dir))).toBe('avatar_zip_no_model');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('.. 路径穿越 → avatar_zip_path_traversal', () => {
    const dir = tmpDir('traversal');
    expect(codeOf(() => validateAndExtractZip(buildZipWithRawName('../evil.txt'), dir))).toBe('avatar_zip_path_traversal');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('绝对路径 → avatar_zip_path_traversal', () => {
    const dir = tmpDir('abs');
    expect(codeOf(() => validateAndExtractZip(buildZipWithRawName('/etc/passwd'), dir))).toBe('avatar_zip_path_traversal');
  });

  it('禁用可执行扩展名 → avatar_zip_invalid', () => {
    const dir = tmpDir('exe');
    const buf = buildZip([['yumi.model3.json', MODEL_JSON], ['malware.exe', 'MZ']]);
    expect(codeOf(() => validateAndExtractZip(buf, dir))).toBe('avatar_zip_invalid');
  });

  it('不是 zip(魔数不对) → avatar_zip_invalid', () => {
    const dir = tmpDir('notzip');
    expect(codeOf(() => validateAndExtractZip(Buffer.from('this is not a zip'), dir))).toBe('avatar_zip_invalid');
  });

  it('超过 100MB → upload_too_large', () => {
    const dir = tmpDir('toobig');
    expect(codeOf(() => validateAndExtractZip(Buffer.alloc(MAX_ZIP_BYTES + 1), dir))).toBe('upload_too_large');
  });

  it('包名/模型名/model.model3.json 二级嵌套(深度 3)成功', () => {
    const dir = tmpDir('deep2');
    const buf = buildZip([
      ['pack/char/char.model3.json', MODEL_JSON],
      ['pack/char/char.moc3', 'moc'],
      ['pack/char/tex/t.png', 'png'],
    ]);
    expect(validateAndExtractZip(buf, dir).modelEntry).toBe('pack/char/char.model3.json');
    expect(existsSync(join(dir, 'pack', 'char', 'tex', 't.png'))).toBe(true);
  });

  it('文件名含空格和括号的嵌套(真实 NexEli 结构)成功', () => {
    const dir = tmpDir('space');
    const buf = buildZip([
      ['Nex Eli (2)/Nex Eli/Nex Eli .model3.json', MODEL_JSON],
      ['Nex Eli (2)/Nex Eli/Nex Eli .moc3', 'moc'],
    ]);
    expect(validateAndExtractZip(buf, dir).modelEntry).toBe('Nex Eli (2)/Nex Eli/Nex Eli .model3.json');
  });

  it('多个 model3.json:同深度取字典序最小,浅层优先', () => {
    const dir = tmpDir('multi');
    expect(validateAndExtractZip(buildZip([['b/y.model3.json', MODEL_JSON], ['a/x.model3.json', MODEL_JSON]]), dir).modelEntry).toBe('a/x.model3.json');
    expect(validateAndExtractZip(buildZip([['z/deep/m.model3.json', MODEL_JSON], ['a/x.model3.json', MODEL_JSON]]), dir).modelEntry).toBe('a/x.model3.json');
  });

  it('超过 MAX_MODEL_DEPTH 的深层 model3.json → avatar_zip_no_model', () => {
    const dir = tmpDir('toodeep');
    const tooDeep = `${'a/'.repeat(MAX_MODEL_DEPTH)}m.model3.json`;
    expect(codeOf(() => validateAndExtractZip(buildZip([[tooDeep, MODEL_JSON]]), dir))).toBe('avatar_zip_no_model');
  });

  it('findModelEntry 与 validateAndExtractZip 用同一确定性规则', () => {
    const dir = tmpDir('find');
    const buf = buildZip([['z/deep/m.model3.json', MODEL_JSON], ['b/y.model3.json', MODEL_JSON], ['a/x.model3.json', MODEL_JSON]]);
    expect(findModelEntry(buf)).toBe(validateAndExtractZip(buf, dir).modelEntry);
    expect(findModelEntry(Buffer.from('garbage'))).toBeNull();
  });
});

describe('Live2D zip 条目名编码(Windows GBK 包)', () => {
  // 真机 2026-09-16 的包结构:model3.json 引用中文 moc3 / 贴图目录 / 表情文件,均为 GBK 条目名。
  const GBK_MODEL = JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: '爱伶Rin.moc3',
      Textures: ['爱伶Rin.4096/texture_00.png'],
      Physics: '爱伶Rin.physics3.json',
      Expressions: [{ Name: '害羞', File: '害羞.exp3.json' }],
    },
  });
  const GBK_ENTRIES = [
    ['爱伶Rin.model3.json', GBK_MODEL],
    ['爱伶Rin.moc3', 'moc'],
    ['爱伶Rin.4096/texture_00.png', 'png'],
    ['爱伶Rin.physics3.json', '{}'],
    ['害羞.exp3.json', '{}'],
    ['【雪熊企划】黑客少女.png', 'png'],
    ['animations/动画.motion3.json', '{}'],
  ];

  it('测试夹具本身:GBK 包不带 EFS 标志,adm-zip 默认 entryName 解出来是乱码', () => {
    const buf = buildGbkZip(GBK_ENTRIES);
    expect(flagsOf(buf).every((f) => f === false)).toBe(true);
    const names = new AdmZip(buf).getEntries().map((e) => e.entryName);
    expect(names.some((n) => n.includes('\uFFFD'))).toBe(true);
  });

  it('GBK 名字解压后文件名正确,model3.json 引用的文件都在,modelEntry 是解码后的名字', () => {
    const dir = tmpDir('gbk');
    const buf = buildGbkZip(GBK_ENTRIES);
    const result = validateAndExtractZip(buf, dir);
    expect(result.modelEntry).toBe('爱伶Rin.model3.json');
    expect(result.extractedFiles).toEqual(expect.arrayContaining(GBK_ENTRIES.map(([n]) => n)));
    expect(result.extractedFiles.some((n) => n.includes('\uFFFD'))).toBe(false);
    const model = JSON.parse(readFileSync(join(dir, result.modelEntry), 'utf8'));
    const refs = [model.FileReferences.Moc, ...model.FileReferences.Textures, model.FileReferences.Physics, ...model.FileReferences.Expressions.map((e) => e.File)];
    for (const ref of refs) expect(existsSync(join(dir, ref))).toBe(true);
    expect(existsSync(join(dir, '【雪熊企划】黑客少女.png'))).toBe(true);
    expect(existsSync(join(dir, 'animations', '动画.motion3.json'))).toBe(true);
    // 乱码目录/文件不得落盘
    expect(readdirSync(dir).some((n) => n.includes('\uFFFD'))).toBe(false);
    expect(findModelEntry(buf)).toBe('爱伶Rin.model3.json');
  });

  it('GBK 目录条目(以 / 结尾)同样按 GBK 解码,不落乱码目录', () => {
    const dir = tmpDir('gbkdir');
    const decoder = { encode: (s) => iconv.encode(s, 'gbk'), decode: (b) => iconv.decode(b, 'gbk'), efs: false };
    const zip = new AdmZip(null, { decoder });
    zip.addFile('表情/', Buffer.alloc(0));
    zip.addFile('表情/哭.exp3.json', Buffer.from('{}'));
    zip.addFile('m.model3.json', Buffer.from(MODEL_JSON));
    const result = validateAndExtractZip(zip.toBuffer(), dir);
    expect(result.extractedFiles).toEqual(expect.arrayContaining(['表情/哭.exp3.json', 'm.model3.json']));
    expect(readdirSync(dir).sort()).toEqual(['m.model3.json', '表情']);
  });

  it('带 UTF-8 标志位(EFS)的中文名 zip 行为不变', () => {
    const dir = tmpDir('utf8flag');
    const buf = buildZip([['凛Rin.model3.json', MODEL_JSON], ['表情/嘟嘴.exp3.json', '{}']]);
    expect(flagsOf(buf).every((f) => f === true)).toBe(true);
    const result = validateAndExtractZip(buf, dir);
    expect(result.modelEntry).toBe('凛Rin.model3.json');
    expect(existsSync(join(dir, '表情', '嘟嘴.exp3.json'))).toBe(true);
  });

  it('无标志位但字节本身是合法 UTF-8 → 按 UTF-8 解,不误判成 GBK', () => {
    const dir = tmpDir('utf8noflag');
    const decoder = { encode: (s) => Buffer.from(s, 'utf8'), decode: (b) => b.toString('utf8'), efs: false };
    const zip = new AdmZip(null, { decoder });
    zip.addFile('凛Rin.model3.json', Buffer.from(MODEL_JSON));
    const buf = zip.toBuffer();
    expect(flagsOf(buf)).toEqual([false]);
    expect(validateAndExtractZip(buf, dir).modelEntry).toBe('凛Rin.model3.json');
  });

  it('条目名既不是 UTF-8 也不是 GBK(坏字节) → avatar_zip_bad_filename,目录无残留', () => {
    const dir = tmpDir('badname');
    // 0x81 0x20:GBK 双字节的第二字节不允许 0x20;单独的 0x81 也不是合法 UTF-8。
    const buf = buildRawNameZip([0x81, 0x20, 0x2e, 0x74, 0x78, 0x74]);
    let err;
    try { validateAndExtractZip(buf, dir); } catch (e) { err = e; }
    expect(err?.code).toBe('avatar_zip_bad_filename');
    expect(err?.message).toMatch(/UTF-8|GBK/);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('打了 EFS 标志但字节不是合法 UTF-8 → avatar_zip_bad_filename(不写 U+FFFD 文件名)', () => {
    const dir = tmpDir('badflag');
    const decoder = { encode: (s) => Buffer.from(s, 'latin1'), decode: (b) => b.toString('latin1'), efs: true };
    const zip = new AdmZip(null, { decoder });
    zip.addFile(Buffer.from([0xc1, 0xdd, 0x2e, 0x74, 0x78, 0x74]).toString('latin1'), Buffer.from('x'));
    zip.addFile('m.model3.json', Buffer.from(MODEL_JSON));
    expect(codeOf(() => validateAndExtractZip(zip.toBuffer(), dir))).toBe('avatar_zip_bad_filename');
    expect(readdirSync(dir)).toEqual([]);
  });

  it('GBK 名字里的 .. 越界与禁用扩展名照样拒绝', () => {
    const dir = tmpDir('gbktraversal');
    const decoder = { encode: (s) => iconv.encode(s, 'gbk'), decode: (b) => iconv.decode(b, 'gbk'), efs: false };
    // adm-zip 写入时会规范化 ..,用 latin1 占位再替换字节的老办法造 GBK 的 "../坏.txt"
    const raw = Buffer.concat([Buffer.from('../'), iconv.encode('坏', 'gbk'), Buffer.from('.txt')]);
    const placeholder = '@'.repeat(raw.length);
    const zip = new AdmZip(null, { decoder });
    zip.addFile(placeholder, Buffer.from('payload'));
    const buf = zip.toBuffer();
    let idx = buf.indexOf(Buffer.from(placeholder, 'ascii'));
    while (idx !== -1) { raw.copy(buf, idx); idx = buf.indexOf(Buffer.from(placeholder, 'ascii')); }
    expect(codeOf(() => validateAndExtractZip(buf, dir))).toBe('avatar_zip_path_traversal');
    expect(readdirSync(dir)).toEqual([]);
    expect(codeOf(() => validateAndExtractZip(buildGbkZip([['m.model3.json', MODEL_JSON], ['木马.exe', 'MZ']]), dir))).toBe('avatar_zip_invalid');
  });
});
