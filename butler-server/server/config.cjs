'use strict';

// 本机配置:~/.dsh/workbench/butler.json,首次启动生成。
//   { version: 1, port: 8792, token: '<64 hex>' }
// token 是工作台插件(8791)代理请求时带的 X-Workbench-Token;也用作预览 URL 的签名密钥。
// 文件权限 0600;token 不进日志、不进 /health、不进任何出口(AGENTS.md 凭据纪律)。
// 环境变量 BUTLER_CONFIG_FILE / BUTLER_HOME 只给测试与灰度用,生产走默认路径。

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_PORT = 8792;

function home() {
  return process.env.HOME || os.homedir();
}

function configFile() {
  return process.env.BUTLER_CONFIG_FILE || path.join(home(), '.dsh', 'workbench', 'butler.json');
}

// 数据根目录:数据库 butler.sqlite 与 uploads/ 都在这里。
function butlerHome() {
  return process.env.BUTLER_HOME || path.join(home(), '.dsh', 'workbench', 'butler');
}

function isValidPort(n) {
  return Number.isInteger(n) && n > 0 && n < 65536;
}

function isValidToken(t) {
  return typeof t === 'string' && /^[0-9a-f]{32,}$/i.test(t);
}

let cached = null;

/**
 * 读取(缺失/损坏则生成)配置。同一进程内只读一次。
 * 只在两种情况下写文件:文件不存在;或 token 非法(从没生成过)。端口不合法退回默认值但不改写文件。
 */
function loadConfig() {
  if (cached) return cached;
  const file = configFile();
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const port = raw && isValidPort(raw.port) ? raw.port : DEFAULT_PORT;
  let token = raw && isValidToken(raw.token) ? raw.token : null;
  let dirty = raw === null;
  if (!token) {
    token = crypto.randomBytes(32).toString('hex');
    dirty = true;
  }
  if (dirty) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 文件里别的块(endpoints 等,见 lib/endpoints.cjs)原样留着,只补 version / port / token。
    const keep = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const data = { ...keep, version: 1, port, token };
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 非 POSIX 文件系统忽略 */
    }
  }
  cached = { port, token, file };
  return cached;
}

/** 测试用:清掉进程内缓存,让下一次 loadConfig 重读文件。 */
function resetConfigCache() {
  cached = null;
}

module.exports = { DEFAULT_PORT, loadConfig, resetConfigCache, configFile, butlerHome };
