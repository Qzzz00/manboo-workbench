'use strict';

// 来源:Aiboo origin/main 1f430c3f server/services/zipService.cjs
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const iconv = require('iconv-lite');

// ---- Limits (架构文档 §4.3 / §8) ----
const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 原始 zip <= 100MB
const MAX_TOTAL_UNCOMPRESSED_BYTES = 200 * 1024 * 1024; // 解压总大小 <= 200MB
const MAX_ENTRY_BYTES = 50 * 1024 * 1024; // 单 entry <= 50MB
const FORBIDDEN_EXTENSIONS = new Set(['.exe', '.sh', '.bat', '.cmd', '.ps1']);
const MODEL_SUFFIX = '.model3.json';

// Local file header magic bytes: "PK\x03\x04"
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// 通用标志 bit 11(EFS):置位表示条目名与注释是 UTF-8。Windows 资源管理器 / WinRAR 压的包不置位,
// 条目名按系统代码页(简体中文 = GBK/cp936)存字节。
const FLAG_EFS = 0x800;
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

// Unix file type bits encoded in the high 16 bits of the zip external attributes.
const S_IFMT = 0xf000;
const S_IFLNK = 0xa000; // symlink
const S_IFREG = 0x8000; // regular file
const S_IFDIR = 0x4000; // directory

function zipError(code, message) {
  const err = new Error(message || code);
  err.code = code;
  err.isZipError = true;
  return err;
}

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * 把 zip 条目名的原始字节解成字符串。
 *   - EFS 标志置位:必须是合法 UTF-8;
 *   - 未置位:先严格按 UTF-8 试(纯 ASCII 与 macOS/Linux 不打标志的包都落在这里),
 *     失败再按 GBK(Windows 简体中文包);两者都不合法(解出 U+FFFD)就拒绝。
 * adm-zip 自带的 entryName 是按 UTF-8 宽松解码的,坏字节已替换成 U+FFFD 不可逆,所以这里必须用 rawEntryName。
 * 2026-09-16 真机:Windows 压的 Live2D 包解出「����Rin.model3.json」,model3.json 里引用的中文文件名对不上磁盘。
 */
function decodeEntryName(entry) {
  const raw = Buffer.isBuffer(entry.rawEntryName) ? entry.rawEntryName : Buffer.from(String(entry.entryName), 'utf8');
  const efs = (entry.header.flags & FLAG_EFS) !== 0;
  let decoded = null;
  try {
    decoded = strictUtf8.decode(raw);
  } catch {
    decoded = null;
  }
  if (decoded === null && !efs) {
    const gbk = iconv.decode(raw, 'gbk');
    if (!gbk.includes('\uFFFD')) decoded = gbk;
  }
  if (decoded === null || decoded.includes('\uFFFD')) {
    throw zipError(
      'avatar_zip_bad_filename',
      `Zip entry name is neither valid UTF-8 nor GBK${efs ? ' (UTF-8 flag set)' : ''}: 0x${raw.toString('hex')}`,
    );
  }
  return decoded;
}

// Normalize a decoded entry name to forward slashes and strip a single leading "./".
function normalizeEntryName(name) {
  let normalized = String(name).replace(/\\/g, '/');
  if (normalized.startsWith('./')) normalized = normalized.slice(2);
  return normalized;
}

function isDirectoryEntry(entry, name) {
  return entry.isDirectory || name.endsWith('/');
}

// 解码 + 规范化,validateAndExtractZip / findModelEntry 共用,保证两边名字一致。
function entryNameOf(entry) {
  return normalizeEntryName(decodeEntryName(entry));
}

// Reject absolute paths, parent-dir traversal and NUL bytes.
function assertSafePath(name) {
  if (name.includes('\0')) {
    throw zipError('avatar_zip_path_traversal', `Zip entry contains NUL byte: ${name}`);
  }
  if (name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
    throw zipError('avatar_zip_path_traversal', `Zip entry uses an absolute path: ${name}`);
  }
  const segments = name.split('/');
  if (segments.some((segment) => segment === '..')) {
    throw zipError('avatar_zip_path_traversal', `Zip entry escapes the target directory: ${name}`);
  }
}

function assertNotForbiddenType(entry, name) {
  // External attributes carry the unix mode in the high 16 bits when present.
  const unixMode = (entry.header.attr >>> 16) & 0xffff;
  const fileType = unixMode & S_IFMT;
  if (fileType === S_IFLNK) {
    throw zipError('avatar_zip_invalid', `Zip entry is a symlink: ${name}`);
  }
  // Anything that is explicitly typed but not a regular file or directory
  // (char/block device, fifo, socket) is rejected.
  if (fileType !== 0 && fileType !== S_IFREG && fileType !== S_IFDIR) {
    throw zipError('avatar_zip_invalid', `Zip entry is not a regular file: ${name}`);
  }
  const ext = path.posix.extname(name).toLowerCase();
  if (FORBIDDEN_EXTENSIONS.has(ext)) {
    throw zipError('avatar_zip_invalid', `Zip entry has a forbidden extension: ${name}`);
  }
}

// model3.json 允许的最大嵌套深度（根文件 = 1，一级子目录 = 2…）。
// 平台导出的 Live2D 包常见「包名/模型名/model.model3.json」（深度 3），
// 这里放宽到 5 覆盖合理嵌套；过深视为异常包。
const MAX_MODEL_DEPTH = 5;

// 仅判断是否 *.model3.json（不限制深度；深度由 selectModelEntry 统一约束）。
function isModelJson(name) {
  return name.toLowerCase().endsWith(MODEL_SUFFIX);
}

/**
 * 从候选的 *.model3.json 路径中确定性选出「主 model entry」：
 *   - 深度升序（浅层优先，符合「根目录/越靠近根越像主模型」直觉）；
 *   - 同深度按字典序升序取最小（不依赖 zip 枚举顺序，跨上传/恢复稳定）；
 * 返回 zip 内真实相对路径；无候选返回 null。
 */
function selectModelEntry(candidates) {
  const sorted = candidates
    .map((name) => ({ name, depth: name.split('/').length }))
    .filter((c) => c.depth <= MAX_MODEL_DEPTH)
    .sort((a, b) => a.depth - b.depth || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sorted.length > 0 ? sorted[0].name : null;
}

/**
 * Validate an uploaded Live2D zip, then extract it into `targetDir`.
 *
 * @param {Buffer} zipBuffer raw uploaded zip bytes
 * @param {string} targetDir directory to extract the unpacked files into
 * @returns {{ checksum: string, sizeBytes: number, modelEntry: string, extractedFiles: string[] }}
 *
 * Throws an Error with `.code` in:
 *   'upload_too_large'           原始 buffer 超 100MB
 *   'avatar_zip_invalid'         不是 zip / magic 不对 / 解压超限 / 含禁用类型
 *   'avatar_zip_no_model'        没找到 *.model3.json
 *   'avatar_zip_path_traversal'  含绝对路径 / .. / NUL
 *   'avatar_zip_bad_filename'    条目名既不是合法 UTF-8 也不是合法 GBK
 */
function validateAndExtractZip(zipBuffer, targetDir) {
  if (!Buffer.isBuffer(zipBuffer)) {
    throw zipError('avatar_zip_invalid', 'Uploaded file is not a buffer');
  }
  if (zipBuffer.length > MAX_ZIP_BYTES) {
    throw zipError('upload_too_large', 'Uploaded zip exceeds 100MB');
  }
  if (zipBuffer.length < ZIP_MAGIC.length || !zipBuffer.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC)) {
    throw zipError('avatar_zip_invalid', 'Uploaded file is not a valid zip (bad magic bytes)');
  }

  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    throw zipError('avatar_zip_invalid', 'Uploaded file could not be parsed as a zip');
  }

  let entries;
  try {
    entries = zip.getEntries();
  } catch {
    throw zipError('avatar_zip_invalid', 'Uploaded zip is corrupt');
  }

  // ---- Pass 1: security & size validation (no disk writes yet) ----
  let totalUncompressed = 0;
  const modelCandidates = [];
  const fileEntries = [];

  for (const entry of entries) {
    const name = entryNameOf(entry);
    assertSafePath(name);
    assertNotForbiddenType(entry, name);

    if (isDirectoryEntry(entry, name)) continue;

    const entrySize = entry.header.size;
    if (entrySize > MAX_ENTRY_BYTES) {
      throw zipError('avatar_zip_invalid', `Zip entry exceeds 50MB: ${name}`);
    }
    totalUncompressed += entrySize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) {
      throw zipError('avatar_zip_invalid', 'Unpacked zip exceeds 200MB');
    }

    if (isModelJson(name)) {
      modelCandidates.push(name);
    }
    fileEntries.push({ entry, name });
  }

  const modelEntry = selectModelEntry(modelCandidates);
  if (!modelEntry) {
    throw zipError(
      'avatar_zip_no_model',
      `Zip does not contain a *.model3.json within ${MAX_MODEL_DEPTH} directory levels`,
    );
  }

  // ---- Pass 2: extract to disk (paths already validated) ----
  const resolvedTarget = path.resolve(targetDir);
  fs.mkdirSync(resolvedTarget, { recursive: true });
  const extractedFiles = [];

  for (const { entry, name } of fileEntries) {
    const destPath = path.resolve(resolvedTarget, name);
    // Defense in depth: never write outside the target directory.
    if (destPath !== resolvedTarget && !destPath.startsWith(resolvedTarget + path.sep)) {
      throw zipError('avatar_zip_path_traversal', `Zip entry escapes the target directory: ${name}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, entry.getData());
    extractedFiles.push(name);
  }

  return {
    checksum: sha256Hex(zipBuffer),
    sizeBytes: zipBuffer.length,
    modelEntry,
    extractedFiles,
  };
}

// 只读取 zip 的 model entry 名（*.model3.json），不解压。用于版本恢复：选择规则
// 与 validateAndExtractZip 完全一致（selectModelEntry 确定性选择），保证恢复出的
// 新版本 model_entry 与当初上传时完全相同。包解析失败或无匹配返回 null。
function findModelEntry(zipBuffer) {
  if (!Buffer.isBuffer(zipBuffer)) return null;
  let zip;
  try {
    zip = new AdmZip(zipBuffer);
  } catch {
    return null;
  }
  let entries;
  try {
    entries = zip.getEntries();
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    let name;
    try {
      name = entryNameOf(entry);
    } catch {
      return null;
    }
    if (isDirectoryEntry(entry, name)) continue;
    if (isModelJson(name)) candidates.push(name);
  }
  return selectModelEntry(candidates);
}

module.exports = {
  validateAndExtractZip,
  findModelEntry,
  decodeEntryName,
  sha256Hex,
  MAX_ZIP_BYTES,
  MAX_TOTAL_UNCOMPRESSED_BYTES,
  MAX_ENTRY_BYTES,
  MAX_MODEL_DEPTH,
};
