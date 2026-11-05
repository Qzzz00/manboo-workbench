package ai.ben.butler;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 在 App 里把新手机包下下来、装上(2026-10-03,卡 claude/phone-in-app-update)。
 *
 * <p>维护者原话:「手机端现在每次更新我都得跳转官网去下载,而且包也没有版本号……」
 * 跳官网那条路的毛病不是多两步,是中间有四处会断:下完落在浏览器的「下载」里、她得自己找到那个文件、
 * 系统再问一次「安装未知应用」、而官网上那份是不是电脑清单里那一份谁也看不出来。
 *
 * <p>三件事必须在原生做:
 * <ul>
 *   <li><b>流式下载</b>:一个 30MB 以上的 APK 在 WebView 里是一条 40MB 的 ArrayBuffer
 *       (再转 base64 过桥就是 54MB);{@code fileSink.ts} 为 40MB 的附件已经不得不改成 512KB 分块 ——
 *       装一个包不该走那条路;</li>
 *   <li><b>sha256 算在落盘那一条流上</b>:算完才知道要不要装。<b>对不上就把文件删掉</b>,
 *       一个核不过的包不许留在盘上等人误点;</li>
 *   <li><b>调起系统安装器</b>:只有原生够得着(FileProvider + ACTION_VIEW)。</li>
 * </ul>
 *
 * <p><b>这件插件不自己装包</b>:它把那个文件交给系统安装器,装不装由她在系统那几屏上点。
 * 第一次系统会先问允不允许这个 App「安装未知应用」—— 没允许时回
 * {@link #CODE_NEED_PERMISSION},网页那边据此多给一颗「去系统设置里允许」的键
 * (口径与 DeskPhonePlugin 的「去系统设置里打开」一致:做不到就如实说,不装作开了)。
 *
 * <p>外壳与文案在 {@code src/update/apkUpdater.ts} 与 {@code src/update/phoneUpdate.ts}。
 */
@CapacitorPlugin(name = "ApkUpdate")
public class ApkUpdatePlugin extends Plugin {

    /** 落在 App 自己的外部目录底下这个子目录里(res/xml/file_paths.xml 的 external-files-path 盖住它)。 */
    static final String DIR = "update";
    static final String FILE = "butler-update.apk";

    /**
     * 系统还不允许这个 App 装包。
     * <b>与 src/update/apkUpdater.ts 的 APK_UPDATE_NEED_PERMISSION_CODE 逐字相同</b>(改一处要改两处)。
     */
    static final String CODE_NEED_PERMISSION = "NEED_INSTALL_PERMISSION";

    /** 一次读多少。64KB:比 8KB 少几千次系统调用,又不至于让进度跳得太粗。 */
    private static final int BUFFER = 64 * 1024;
    /** 进度最多这么频繁地往网页那边发一条(发太密只会把桥塞满)。 */
    private static final long PROGRESS_EVERY_MS = 200;
    private static final int CONNECT_TIMEOUT_MS = 15_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    /** 跟几次跳转。CDN 常有一跳;跟不完就当失败,不无限跟。 */
    private static final int MAX_REDIRECTS = 5;

    /** 下载跑在它上面:桥那条线程不该被一个几十秒的下载占住。 */
    private final ExecutorService pool = Executors.newSingleThreadExecutor();

    /** 这个包自己是哪一版(系统从 APK 里读出来的,比网页侧那份 build.json 更贴近"真装着的是什么")。 */
    @PluginMethod
    public void info(PluginCall call) {
        JSObject out = new JSObject();
        try {
            PackageManager pm = getContext().getPackageManager();
            PackageInfo pkg = pm.getPackageInfo(getContext().getPackageName(), 0);
            out.put("versionName", pkg.versionName);
            out.put("versionCode", Build.VERSION.SDK_INT >= Build.VERSION_CODES.P ? pkg.getLongVersionCode() : (long) pkg.versionCode);
        } catch (PackageManager.NameNotFoundException e) {
            // 问不到就缺席(网页那边退到 build.json 那一格)—— 不编一个版本号。
        }
        out.put("canInstall", canInstall());
        call.resolve(out);
    }

    /** Android 8 起装包要这一项;8 以下由 unknown sources 那个全局开关管,这里一律算允许。 */
    private boolean canInstall() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return true;
        return getContext().getPackageManager().canRequestPackageInstalls();
    }

    @PluginMethod
    public void openInstallPermission(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("这会儿没有窗口可以打开系统设置");
            return;
        }
        Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()))
            : new Intent(Settings.ACTION_SECURITY_SETTINGS);
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(intent);
                call.resolve();
            } catch (ActivityNotFoundException e) {
                call.reject("这台手机上打不开那一页:自己进 系统设置 → 应用 → 事务官 → 安装未知应用");
            }
        });
    }

    /**
     * 下到 App 自己的目录里,边下边算 sha256。
     * <b>对不上就删掉文件并 reject</b> —— 一个核不过的包不许留在盘上。
     */
    @PluginMethod
    public void download(PluginCall call) {
        String url = call.getString("url");
        String wantSha = call.getString("sha256");
        if (url == null || url.isEmpty()) {
            call.reject("没说要下哪个包");
            return;
        }
        if (wantSha == null || !wantSha.matches("(?i)[0-9a-f]{64}")) {
            // 核不了就不下:下一个核不过的 30MB 包,下完也只能删。
            call.reject("电脑没给这个包的校验码,核不了就不下");
            return;
        }
        pool.execute(() -> runDownload(call, url, wantSha.toLowerCase()));
    }

    private void runDownload(PluginCall call, String url, String wantSha) {
        File dir = new File(getContext().getExternalFilesDir(null), DIR);
        File target = new File(dir, FILE);
        if (!dir.exists() && !dir.mkdirs()) {
            call.reject("建不出存放目录:" + dir.getAbsolutePath());
            return;
        }
        // 上一趟留下的那一份先删:下一半断了的字节留着,下一次核对会以"坏包"收场。
        if (target.exists() && !target.delete()) {
            call.reject("删不掉上一次下的那一份:" + target.getAbsolutePath());
            return;
        }

        HttpURLConnection conn = null;
        try {
            conn = open(url);
            int status = conn.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                call.reject("服务器回了 HTTP " + status + " —— 这一版的包还在不在那个地址上?");
                return;
            }
            long total = conn.getContentLengthLong();
            MessageDigest sha = MessageDigest.getInstance("SHA-256");
            long received = 0;
            long lastSent = 0;
            byte[] buffer = new byte[BUFFER];
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(target)) {
                int read;
                while ((read = in.read(buffer)) >= 0) {
                    out.write(buffer, 0, read);
                    sha.update(buffer, 0, read);
                    received += read;
                    long now = System.currentTimeMillis();
                    if (now - lastSent >= PROGRESS_EVERY_MS) {
                        lastSent = now;
                        emitProgress(received, total);
                    }
                }
                out.getFD().sync();
            }
            emitProgress(received, total);

            String gotSha = hex(sha.digest());
            if (!gotSha.equals(wantSha)) {
                // 对不上就删:留着它,下一次「再按一次」会把同一份坏字节又装一遍。
                //noinspection ResultOfMethodCallIgnored
                target.delete();
                call.reject("下下来这一份和电脑上记的校验码对不上(路上传坏了)");
                return;
            }

            JSObject result = new JSObject();
            result.put("path", target.getAbsolutePath());
            result.put("bytes", received);
            result.put("sha256", gotSha);
            call.resolve(result);
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            target.delete();
            // 原样把原因带回去(网页那边照实显示,不改一个字、也不劝她去官网)。
            String why = e.getMessage();
            call.reject(why == null || why.isEmpty() ? e.getClass().getSimpleName() : why);
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /**
     * 开连接,自己跟跳转。
     * <b>HttpURLConnection 不跟跨协议的跳转</b>(http → https 会停在 302 上),
     * 而阿里云那边的包将来换成 CDN 很可能就是一跳 —— 所以这里自己跟。
     */
    private HttpURLConnection open(String url) throws Exception {
        String at = url;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
            URL parsed = new URL(at);
            String scheme = parsed.getProtocol();
            if (!"http".equals(scheme) && !"https".equals(scheme)) {
                throw new IllegalArgumentException("只认 http / https 的地址,这个是 " + scheme);
            }
            HttpURLConnection conn = (HttpURLConnection) parsed.openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            int status = conn.getResponseCode();
            boolean moved = status == HttpURLConnection.HTTP_MOVED_PERM
                || status == HttpURLConnection.HTTP_MOVED_TEMP
                || status == HttpURLConnection.HTTP_SEE_OTHER
                || status == 307
                || status == 308;
            if (!moved) return conn;
            String next = conn.getHeaderField("Location");
            conn.disconnect();
            if (next == null || next.isEmpty()) throw new IllegalStateException("服务器说换地址了(HTTP " + status + "),又没说换到哪儿");
            at = new URL(parsed, next).toString();
        }
        throw new IllegalStateException("跳转跟了 " + MAX_REDIRECTS + " 次还没到头,不跟了");
    }

    private void emitProgress(long received, long total) {
        JSObject data = new JSObject();
        data.put("received", received);
        // 服务器没报总数就**不报这一格**(网页那边据此只说下了多少,不编一个百分比)。
        if (total > 0) data.put("total", total);
        notifyListeners("progress", data);
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        return sb.toString();
    }

    /** 把下好的那个包交给系统安装器。装不装由她在系统那几屏上点。 */
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null || path.isEmpty()) {
            call.reject("没说要装哪个文件");
            return;
        }
        File file = new File(path);
        // 只认自己刚下的那一份(按真实路径比,`../` 绕不出去)——
        // 这件插件不能变成「装手机上任意一个 apk」的口子。
        try {
            File allowed = new File(new File(getContext().getExternalFilesDir(null), DIR), FILE);
            if (!file.getCanonicalPath().equals(allowed.getCanonicalPath())) {
                call.reject("只装刚刚下下来的那一份");
                return;
            }
        } catch (Exception e) {
            call.reject("这个文件找不到了");
            return;
        }
        if (!file.isFile()) {
            call.reject("刚下的那个包已经不在了(被清理掉了?)再按一次");
            return;
        }
        if (!canInstall()) {
            call.reject("系统还不允许这个 App 安装未知应用", CODE_NEED_PERMISSION);
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("这会儿没有窗口可以调起系统安装器");
            return;
        }
        Uri uri;
        try {
            uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        } catch (IllegalArgumentException e) {
            call.reject("这个位置的文件交不出去:" + e.getMessage());
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, "application/vnd.android.package-archive");
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        activity.runOnUiThread(() -> {
            try {
                activity.startActivity(intent);
                call.resolve();
            } catch (ActivityNotFoundException e) {
                call.reject("这台手机上没有能装 apk 的系统组件");
            }
        });
    }
}
