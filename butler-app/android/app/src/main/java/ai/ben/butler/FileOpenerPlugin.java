package ai.ben.butler;

import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Environment;

import androidx.core.content.FileProvider;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.IOException;

/**
 * 打开 / 分享电脑发来的文件(2026-09-25,卡 J「手机从电脑取文件」)。
 *
 * <p>为什么要一个原生插件:文件落在系统「文档 / 事务官」里(见 src/channel/fileSink.ts),
 * WebView 自己打不开 PDF,也够不到微信、文件管理器这些别的 App。只有原生能用 FileProvider
 * 把文件交给系统,让系统弹「用什么打开」/「发给谁」。
 *
 * <p>两条边界:
 * <ul>
 *   <li><b>只认「文档 / 事务官」里的文件</b>(按真实路径比,{@code ../} 绕不出去)——
 *       网页那边递过来的是一个字符串,这件插件不能变成「打开手机上任意一个文件」的口子;</li>
 *   <li><b>只给读权限</b>({@code FLAG_GRANT_READ_URI_PERMISSION}),而且只给这一次打开的那个应用。</li>
 * </ul>
 *
 * <p>FileProvider 的 authority 是 {@code ${applicationId}.fileprovider}(AndroidManifest.xml 里早就登记了,
 * res/xml/file_paths.xml 的 external-path 盖住了公共「文档」目录)。
 */
@CapacitorPlugin(name = "FileOpener")
public class FileOpenerPlugin extends Plugin {

    /** 与 src/channel/fileSink.ts 的 WBCH_SAVE_FOLDER 同一个名字。 */
    static final String FOLDER = "事务官";

    private File baseDir() {
        return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), FOLDER);
    }

    /** `file:///storage/...`、绝对路径、或相对「文档」的 `事务官/x` 三种都认。 */
    private File resolve(String raw) {
        if (raw == null || raw.isEmpty()) return null;
        String path = raw.startsWith("file://") ? Uri.parse(raw).getPath() : raw;
        if (path == null) return null;
        if (path.startsWith("/")) return new File(path);
        return new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), path);
    }

    private boolean inside(File file) throws IOException {
        String base = baseDir().getCanonicalPath() + File.separator;
        return file.getCanonicalPath().startsWith(base);
    }

    @PluginMethod
    public void open(PluginCall call) {
        launch(call, false);
    }

    @PluginMethod
    public void share(PluginCall call) {
        launch(call, true);
    }

    private void launch(PluginCall call, boolean share) {
        File file = resolve(call.getString("path"));
        if (file == null) {
            call.reject("没说要打开哪个文件");
            return;
        }
        try {
            if (!inside(file)) {
                call.reject("只打开「文档 / 事务官」里的文件");
                return;
            }
        } catch (IOException e) {
            call.reject("这个文件找不到了");
            return;
        }
        if (!file.isFile()) {
            call.reject("这个文件已经不在了(被删或挪走了)");
            return;
        }
        String mime = call.getString("mimeType", "*/*");
        Uri uri;
        try {
            uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", file);
        } catch (IllegalArgumentException e) {
            call.reject("这个位置的文件交不出去:" + e.getMessage());
            return;
        }
        Intent intent;
        if (share) {
            intent = new Intent(Intent.ACTION_SEND);
            intent.setType(mime);
            intent.putExtra(Intent.EXTRA_STREAM, uri);
            intent.putExtra(Intent.EXTRA_TITLE, call.getString("name", file.getName()));
        } else {
            intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, mime);
        }
        // 经 chooser 转一道时,读权限要挂在 ClipData 上才跟得过去(安卓的老坑)。
        intent.setClipData(ClipData.newRawUri(file.getName(), uri));
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        Intent chooser = Intent.createChooser(intent, share ? "发给…" : "用什么打开");
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            getActivity().startActivity(chooser);
            call.resolve();
        } catch (ActivityNotFoundException e) {
            call.reject("手机上没有能打开这种文件的应用");
        }
    }
}
