/**
 * 手机远程对等守门用的两件工具(2026-09-25,卡 S)。**不是测试文件本身**(vitest 的 include 只收 *.test.ts)。
 *
 *   - `phonePathLiterals()`:用 TypeScript 的语法树扫 src 里每一个路径字面量(`'/state'`、
 *     `` `${PROXY}/avatars/${id}` ``、`` `ws://${host}:${port}/live` ``……),注释里的不算。模板里的 `${…}` 记成 `:x`。
 *   - `workerAllows()`:读 channel-worker/src/rpc.ts 的白名单(RPC_ALLOWED)原文,判一条 method + path 放不放。
 *     两个子项目互不 import(AGENTS.md),这里读的是文件文本 —— 与 swarmSource.test.ts 读 workbench-plugin 同一个做法。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';

/** butler-app 根(vitest 在这里跑;jsdom 环境下 import.meta.url 不是 file:,同 swarmSource.test.ts 用 cwd)。 */
const ROOT = resolve(process.cwd());
const SRC = join(ROOT, 'src');
export const WORKER_RPC_FILE = resolve(ROOT, '../channel-worker/src/rpc.ts');
export const WORKER_ASR_FILE = resolve(ROOT, '../channel-worker/src/asrRelay.ts');

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(path);
  }
  return out;
}

/** 一个模板 / 字符串 → 路径(不带查询串)。不像路径就 undefined。 */
function pathOf(text: string): string | undefined {
  let s = text;
  if (!/^\/[a-z]/.test(s)) {
    // `${base}/pair/claim`、`ws://${host}:${port}/live`:前面是地址,后面才是路径。
    const m = /^(?:[a-z]+:\/\/)?:x(?::(?::x|\d+))?(\/[a-z].*)$/.exec(s);
    if (m === null) return undefined;
    s = m[1] ?? '';
  }
  return s.split('?')[0];
}

/** src 里每一个路径字面量 → 出现在哪几处(`文件:行`)。 */
export function phonePathLiterals(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    // 同一个文件里的字符串常量(`const PROXY = '/butler/proxy/api'`):模板开头用到它就拼上。
    const consts = new Map<string, string>();
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
        && (ts.isStringLiteral(node.initializer) || ts.isNoSubstitutionTemplateLiteral(node.initializer))) {
        consts.set(node.name.text, node.initializer.text);
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
    const visit = (node: ts.Node): void => {
      let raw: string | undefined;
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) raw = node.text;
      else if (ts.isTemplateExpression(node)) {
        raw = node.head.text;
        for (const span of node.templateSpans) {
          const e = span.expression;
          raw += (raw === '' && ts.isIdentifier(e) && consts.has(e.text) ? consts.get(e.text) : ':x') + span.literal.text;
        }
      }
      const path = raw === undefined ? undefined : pathOf(raw);
      if (path !== undefined) {
        const at = `${relative(ROOT, file)}:${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        found.set(path, [...(found.get(path) ?? []), at]);
        return;
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return found;
}

export interface WorkerRule { method: string; path: string | RegExp }

/** channel-worker/src/rpc.ts 的 RPC_ALLOWED,从原文里读出来。 */
export function workerWhitelist(): WorkerRule[] {
  const text = readFileSync(WORKER_RPC_FILE, 'utf8');
  const start = text.indexOf('export const RPC_ALLOWED');
  const end = text.indexOf('\n]\n', start);
  if (start < 0 || end < 0) throw new Error('channel-worker/src/rpc.ts 里找不到 RPC_ALLOWED —— 它改名了?这份守门要跟着改');
  const body = text.slice(start, end);
  const rules: WorkerRule[] = [];
  const re = /\{\s*method:\s*'(GET|POST|PUT|DELETE)',\s*path:\s*(?:'([^']+)'|\/((?:\\\/|[^/\n])+)\/)\s*\}/g;
  for (let m = re.exec(body); m !== null; m = re.exec(body)) {
    rules.push({ method: m[1] ?? '', path: m[2] !== undefined ? m[2] : new RegExp(m[3] ?? '') });
  }
  // 读漏一条就等于守门瞎了一只眼:数一数 `method:` 出现几次,对不上就当场说。
  const written = body.match(/\bmethod:\s*'/g)?.length ?? 0;
  if (rules.length < 10 || rules.length !== written) throw new Error(`白名单写了 ${written} 条、只读出 ${rules.length} 条,格式大概变了 —— 这份守门要跟着改`);
  return rules;
}

/** 工人放不放这一条(`:x` 换成一个样本段再比)。 */
export function workerAllows(method: string, path: string, rules: readonly WorkerRule[] = workerWhitelist()): boolean {
  const sample = path.split('/').map((seg) => (seg === ':x' ? 'x1' : seg)).join('/');
  return rules.some((rule) => rule.method === method && (typeof rule.path === 'string' ? rule.path === sample : rule.path.test(sample)));
}

/** 读工人那一侧某个文件里一个字符串常量的值(两端「逐字一样」的那几样)。 */
export function workerConst(file: string, name: string): string | undefined {
  const m = new RegExp(`export const ${name} = '([^']*)'`).exec(readFileSync(file, 'utf8'));
  return m?.[1];
}
