/**
 * 原生那半边的接缝(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * Java 那几件在这台机器上编不出来也看不出错(要 JDK + gradle),
 * 可**两头必须对上的那几处**用读源文件比就能钉住:插件名、reject 的 code、
 * 清单里那条权限、FileProvider 的那条路径、登记的位置(必须在 super.onCreate 之前)。
 * 对不上的时候,屏上的样子是「按下去什么都不发生」——那种错最难查。
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { APK_UPDATE_NEED_PERMISSION_CODE } from '../src/update/apkUpdater';

const appRoot = resolve(process.cwd());
const java = (name: string) => readFileSync(join(appRoot, `android/app/src/main/java/ai/ben/butler/${name}`), 'utf8');
const plugin = java('ApkUpdatePlugin.java');

describe('ApkUpdatePlugin 与网页那半边对得上', () => {
  it('插件名就是 registerPlugin 里那个(对不上就是「按下去什么都不发生」)', () => {
    expect(plugin).toContain('@CapacitorPlugin(name = "ApkUpdate")');
    expect(readFileSync(join(appRoot, 'src/update/apkUpdater.ts'), 'utf8')).toContain("registerPlugin<ApkUpdateNative>('ApkUpdate')");
  });

  it('★没给安装权限那个 code 两边逐字相同', () => {
    expect(plugin).toContain(`CODE_NEED_PERMISSION = "${APK_UPDATE_NEED_PERMISSION_CODE}"`);
  });

  it('四个方法都在(info / download / install / openInstallPermission)', () => {
    for (const method of ['public void info(', 'public void download(', 'public void install(', 'public void openInstallPermission(']) {
      expect(plugin).toContain(method);
    }
    // 进度事件的名字与 addListener('progress') 对上
    expect(plugin).toContain('notifyListeners("progress"');
  });

  it('★校验码对不上就把文件删掉(不许留在盘上等人误点)', () => {
    const at = plugin.indexOf('if (!gotSha.equals(wantSha))');
    expect(at).toBeGreaterThan(0);
    expect(plugin.slice(at, at + 400)).toContain('target.delete()');
  });

  it('★只装刚下的那一份(这件插件不是「装任意 apk」的口子)', () => {
    expect(plugin).toContain('getCanonicalPath()');
    expect(plugin).toContain('只装刚刚下下来的那一份');
  });

  it('下载不在桥那条线程上跑(几十秒的下载不该占着它)', () => {
    expect(plugin).toContain('pool.execute(');
  });
});

describe('在 MainActivity 里登记', () => {
  const main = java('MainActivity.java');

  it('★登记在 super.onCreate 之前 —— 晚了网页那边就查不到它', () => {
    const at = main.indexOf('registerPlugin(ApkUpdatePlugin.class)');
    expect(at).toBeGreaterThan(0);
    // 比的是**那一句调用**,不是注释里提到的那几个字(文件头正好写着这条规矩)。
    const call = main.indexOf('super.onCreate(savedInstanceState);');
    expect(call).toBeGreaterThan(0);
    expect(at).toBeLessThan(call);
  });
});

describe('清单与 FileProvider', () => {
  const manifest = readFileSync(join(appRoot, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  const paths = readFileSync(join(appRoot, 'android/app/src/main/res/xml/file_paths.xml'), 'utf8');

  it('★REQUEST_INSTALL_PACKAGES 在清单里(少了它调起安装器直接被系统拦)', () => {
    expect(manifest).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
  });

  it('★FileProvider 盖得住包落的那个目录(盖不住就 IllegalArgumentException)', () => {
    expect(paths).toContain('<external-files-path');
    expect(paths).toContain('path="update/"');
    // 插件里那个子目录名与上面那条路径对得上
    expect(plugin).toContain('String DIR = "update"');
    expect(manifest).toContain('${applicationId}.fileprovider');
    expect(plugin).toContain('".fileprovider"');
  });
});
