/**
 * write-build-stamp.mjs 的类型(脚本本体是 .mjs,不在 tsconfig 的 include 里;
 * tests/build-stamp.test.ts 要 import 那几个纯函数,strict 下没有声明就报 TS7016)。
 * 改签名时这两份一起改。
 */
export interface ButlerAppBuildStamp {
  /** butler-app 这棵子树在 HEAD 里的 tree id,40 位小写十六进制。 */
  butler_app_tree: string;
  /** 写这一份的时刻,ISO 8601(UTC,带 Z)。 */
  built_at: string;
  /** 构建时 butler-app 底下有未提交的改动(含未跟踪文件)。 */
  dirty: boolean;
  /** 这个包是哪一版(= workbench-plugin/package.json 的 version,三段数字)。 */
  version: string;
  /** Android 的 versionCode,从 version 算出来(见 versionCodeOf)。 */
  version_code: number;
}

export function buildStamp(args: { tree: string; dirty: boolean; now: Date; version: string }): ButlerAppBuildStamp;

/** `git rev-parse HEAD:butler-app`。路径相对仓库根,所以 cwd 可以是仓库里任意目录。取不到就抛。 */
export function readTree(cwd: string): string;

/** `git status --porcelain -- :/butler-app` 非空。取不到就抛。 */
export function readDirty(cwd: string): boolean;

/** `workbench-plugin/package.json` 的 version(手机包与工作台同源)。取不到 / 形状不对就抛。 */
export function readAppVersion(): string;

/** `(major * 100 + minor) * 10000 + patch`。单调递增;算不出来就抛。 */
export function versionCodeOf(version: string): number;

/** gradle 读的那两行(`versionName=` / `versionCode=`)。 */
export function versionProperties(args: { version: string }): string;
