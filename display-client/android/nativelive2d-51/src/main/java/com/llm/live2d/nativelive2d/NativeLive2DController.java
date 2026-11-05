package com.llm.live2d.nativelive2d;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.ViewGroup;

import com.live2d.sdk.cubism.core.Live2DCubismCore;
import com.live2d.sdk.cubism.framework.CubismFramework;
import com.live2d.sdk.cubism.framework.CubismFrameworkConfig.LogLevel;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.function.LongConsumer;

/**
 * 原生 Live2D 渲染层的宿主无关控制器：主 App（Capacitor 插件）与充电屏保（DreamService
 * 的 addJavascriptInterface 桥）共用同一套 GL 视图/模型编排，宿主只负责：
 *  1) 把 GL 层插到自己 WebView 之下（attachUnder）；2) 自己的 WebView/窗口透明；3) 参数透传。
 *
 * 线程约定：所有公开方法任意线程可调；视图操作内部切主线程；模型加载/动作起播经
 * GLSurfaceView.queueEvent 进 GL 线程；参数状态为不可变 map 整体发布。
 */
public final class NativeLive2DController {
    private static final String TAG = "NativeLive2D";
    private static boolean frameworkStarted;

    public interface ShowModelCallback {
        /** result 非 null 即成功；否则 error 描述原因。可能在 GL 线程回调。 */
        void onResult(JSONObject result, String error);
    }

    private final Context context;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    /** GL 宿主：View 树内是 {@link NativeLive2DView}，动态壁纸是 {@link WallpaperGLHost}。 */
    private Live2DGLHost glHost;
    private Boolean coreAvailable;

    public NativeLive2DController(Context context) {
        this.context = context.getApplicationContext();
    }

    /** Cubism 核心 .so 是否可用（armeabi-v7a 无 .so 的机型返回 false，宿主据此回落 WebView）。 */
    public boolean isCoreAvailable() {
        if (coreAvailable == null) {
            try {
                Live2DCubismCore.getVersion();
                coreAvailable = true;
            } catch (Throwable t) {
                Log.w(TAG, "Cubism core unavailable", t);
                coreAvailable = false;
            }
        }
        return coreAvailable;
    }

    public boolean isAttached() {
        return glHost != null;
    }

    public Live2DGLHost getHost() {
        return glHost;
    }

    private void ensureFrameworkStarted() {
        if (frameworkStarted) return;
        CubismFramework.Option option = new CubismFramework.Option();
        option.logFunction = message -> Log.d(TAG, message);
        option.loggingLevel = LogLevel.WARNING;
        // 5-r.1 的 Option 没有 loadFileFunction（框架不自己读文件，moc/physics/motion 全由 AssetLoader 喂 bytes）
        CubismFramework.cleanUp();
        CubismFramework.startUp(option);
        frameworkStarted = true;
    }

    /** UI 线程调用：把 GL 层插到 parent 的 index 处（index 0 = 画在最底）。幂等。 */
    public void attachUnderOnUiThread(ViewGroup parent, int index, ViewGroup.LayoutParams params) {
        attachUnderOnUiThread(parent, index, params, false);
    }

    /** transparentOverlay=true：GL 走 media overlay 透明合成（U3 固定浮窗悬浮，见 NativeLive2DView）。 */
    public void attachUnderOnUiThread(ViewGroup parent, int index, ViewGroup.LayoutParams params,
                                      boolean transparentOverlay) {
        if (glHost != null) return;
        ensureFrameworkStarted();
        NativeLive2DView view = new NativeLive2DView(context, transparentOverlay);
        parent.addView(view, index, params);
        glHost = view;
        Log.i(TAG, "GL layer attached (host=" + parent.getClass().getSimpleName()
            + ", transparentOverlay=" + transparentOverlay + ")");
    }

    /**
     * 动态壁纸专用：不进 View 树，EGL 与渲染线程由 {@link WallpaperGLHost} 自管。
     *
     * <p>返回的 host 需由壁纸 Engine 在自己的 onSurfaceCreated/onSurfaceChanged/onSurfaceDestroyed
     * 回调里驱动（见 {@link WallpaperGLHost#onEngineSurfaceCreated}）。可任意线程调用。
     *
     * @return 已 attach 的 host；若已 attach 过则返回既有实例
     */
    public WallpaperGLHost attachToSurfaceHolder() {
        if (glHost instanceof WallpaperGLHost) return (WallpaperGLHost) glHost;
        if (glHost != null) {
            Log.w(TAG, "attachToSurfaceHolder ignored: already attached to a View host");
            return null;
        }
        ensureFrameworkStarted();
        WallpaperGLHost host = new WallpaperGLHost(new NativeLive2DRenderer(context));
        glHost = host;
        Log.i(TAG, "GL layer attached (host=WallpaperGLHost)");
        return host;
    }

    public void runOnUi(Runnable action) {
        if (Looper.myLooper() == Looper.getMainLooper()) action.run();
        else mainHandler.post(action);
    }

    // ---- 模型 ----

    /**
     * 加载并显示模型。要求 attachUnderOnUiThread 已由宿主在 UI 线程完成。
     * opts: { settingsJson, modelDir, textures?, idleMotionGroup?, idleBeatGroups?,
     *         persistentParams?, targetFps?, layout?, backgroundColor? }
     */
    public void showModel(JSONObject opts, ShowModelCallback callback) {
        showModel(opts, null, callback);
    }

    public void showModel(JSONObject opts, LongConsumer onHostResumed, ShowModelCallback callback) {
        if (!isCoreAvailable()) {
            callback.onResult(null, "cubism core unavailable on this device");
            return;
        }
        final String settingsJson = opts.optString("settingsJson", null);
        String modelDirRaw = opts.optString("modelDir", null);
        if (settingsJson == null || modelDirRaw == null) {
            callback.onResult(null, "settingsJson and modelDir are required");
            return;
        }
        final String dir = modelDirRaw.endsWith("/") ? modelDirRaw : modelDirRaw + "/";
        final String[] textures = toStringArray(opts.optJSONArray("textures"));
        final String idleGroup = optStringOrNull(opts, "idleMotionGroup");
        final List<String> beatGroups = toStringList(opts.optJSONArray("idleBeatGroups"));
        final Map<String, Float> persistent = toFloatMap(opts.optJSONObject("persistentParams"));
        final int targetFps = opts.optInt("targetFps", 15);
        final JSONObject layoutObj = opts.optJSONObject("layout");
        final String backgroundColor = optStringOrNull(opts, "backgroundColor");
        final Long lifecycleTraceId = opts.has("lifecycleTraceId") && !opts.isNull("lifecycleTraceId")
            ? opts.optLong("lifecycleTraceId")
            : null;

        runOnUi(() -> {
            Live2DGLHost host = glHost;
            if (host == null) {
                callback.onResult(null, "GL layer not attached");
                return;
            }
            NativeLive2DRenderer renderer = host.getLive2DRenderer();
            long resolvedTraceId = renderer.beginLifecycleTrace(lifecycleTraceId);
            host.setHostVisible(true);
            // ★必须 onResume：若此 host 之前被 hide() onPause 过（DJ 页切走再切回复用同一 view），
            // GL 渲染线程仍处暂停态，queueEvent 的模型加载与 onDrawFrame 都不会执行 → 角色不画、黑屏、
            // 首帧回调永不触发（loading 门卡到超时露黑，Ben「来回切换加载不出来也显示」的真根因）。onResume 幂等。
            host.onHostResume();
            renderer.markHostResumed(resolvedTraceId);
            if (onHostResumed != null) onHostResumed.accept(resolvedTraceId);
            renderer.setTargetFps(targetFps);
            if (layoutObj != null) renderer.setLayout(parseLayout(layoutObj));
            if (backgroundColor != null) applyClearColor(renderer, backgroundColor);

            host.queueEvent(() -> renderer.runWhenGlContextReady(() -> {
                try {
                    // loadFromSettings 会创建 Cubism renderer、shader 和纹理，必须等 EGL 上下文真实就绪。
                    if (!CubismFramework.isInitialized()) CubismFramework.initialize();

                    NativeLive2DModel old = renderer.getModel();
                    if (old != null) {
                        renderer.setModel(null);
                        old.release();
                    }

                    NativeLive2DModel model = new NativeLive2DModel(context, renderer.getTextureLoader());
                    // 首次 onSurfaceCreated 与 onSurfaceChanged 是两个回调：前者已有 EGL，但尚无可靠尺寸。
                    // 传 0 让模型只完成 CPU 解析；后者会恰好一次创建 renderer/纹理，避免首屏重复上传。
                    int surfaceWidth = renderer.isSurfaceSizeReady() ? renderer.getSurfaceWidth() : 0;
                    int surfaceHeight = renderer.isSurfaceSizeReady() ? renderer.getSurfaceHeight() : 0;
                    boolean ok = model.loadFromSettings(
                        settingsJson.getBytes(StandardCharsets.UTF_8),
                        dir, textures, idleGroup, beatGroups,
                        surfaceWidth, surfaceHeight);
                    if (!ok) {
                        model.release();
                        callback.onResult(null, "model load failed (see logcat)");
                        return;
                    }
                    model.setPersistentParams(persistent);
                    renderer.setModel(model);

                    JSONObject result = new JSONObject();
                    result.put("canvasWidthPx", model.getCanvasWidthPixel());
                    result.put("canvasHeightPx", model.getCanvasHeightPixel());
                    List<String> ids = new ArrayList<>();
                    List<float[]> ranges = model.snapshotParameterRanges(ids);
                    JSONArray paramsArray = new JSONArray();
                    for (int i = 0; i < ids.size(); i++) {
                        JSONObject p = new JSONObject();
                        p.put("id", ids.get(i));
                        p.put("min", ranges.get(i)[0]);
                        p.put("max", ranges.get(i)[1]);
                        p.put("def", ranges.get(i)[2]);
                        paramsArray.put(p);
                    }
                    result.put("params", paramsArray);
                    Log.i(TAG, "model loaded: " + dir + " params=" + ids.size());
                    // 不立即回调：setModel 后角色还没画出来，此刻通知 JS 会让切页 loading 门早撤露黑。
                    // 改在渲染器画完第一帧后触发（GL 线程），保证 JS onReady 时角色已可见。
                    final JSONObject resultFinal = result;
                    renderer.setFirstFrameCallback(() -> callback.onResult(resultFinal, null));
                } catch (Throwable t) {
                    Log.e(TAG, "showModel failed", t);
                    callback.onResult(null, "showModel failed: " + t.getMessage());
                }
            }));
        });
    }

    public void releaseModel() {
        Live2DGLHost view = glHost;
        if (view == null) return;
        view.queueEvent(() -> {
            NativeLive2DModel model = view.getLive2DRenderer().getModel();
            if (model != null) {
                view.getLive2DRenderer().setModel(null);
                model.release();
            }
        });
    }

    // ---- 状态通道 ----

    private NativeLive2DModel currentModel() {
        Live2DGLHost view = glHost;
        return view != null ? view.getLive2DRenderer().getModel() : null;
    }

    public void setOverlayTargets(JSONObject params) {
        NativeLive2DModel model = currentModel();
        if (model != null) model.setOverlayTargets(toFloatMap(params));
    }

    public void setPersistentParams(JSONObject params) {
        NativeLive2DModel model = currentModel();
        if (model != null) model.setPersistentParams(toFloatMap(params));
    }

    public void setMouthParams(JSONObject params) {
        NativeLive2DModel model = currentModel();
        if (model != null) model.setMouthParams(toFloatMap(params));
    }

    public void playMotion(String group) {
        Live2DGLHost view = glHost;
        if (group == null || view == null) return;
        view.queueEvent(() -> {
            NativeLive2DModel model = view.getLive2DRenderer().getModel();
            if (model != null) model.startMotionByGroup(group, NativeLive2DModel.PRIORITY_NORMAL);
        });
    }

    public void setFocus(float x, float y) {
        NativeLive2DModel model = currentModel();
        if (model != null) model.setFocus(x, y);
    }

    public void setLayout(JSONObject layout) {
        Live2DGLHost view = glHost;
        if (view != null && layout != null) {
            view.getLive2DRenderer().setLayout(parseLayout(layout));
        }
    }

    /**
     * 底部软边渐隐（桌宠浮窗「上半身」构图防赛博截肢）。
     * {start, end}：从画面顶部起算的比例（0=顶 1=底），end<=start 关闭。
     * 对齐 Pixi 路径的 pet.css mask-image: linear-gradient(to bottom, #000 76%, transparent 98%)。
     */
    public void setBottomFade(JSONObject opts) {
        Live2DGLHost view = glHost;
        if (view == null || opts == null) return;
        view.getLive2DRenderer().setBottomFade(
            (float) opts.optDouble("start", 0),
            (float) opts.optDouble("end", 0)
        );
    }

    /** 背景圆角半径（物理 px）：桌宠「显示背景」的圆角卡片用（GL 层不吃 CSS/view outline 裁剪）。
     *  0=直角。由桥在 showModel 时一次性下发。 */
    public void setCornerRadius(float px) {
        Live2DGLHost view = glHost;
        if (view == null) return;
        view.getLive2DRenderer().setCornerRadius(px);
    }

    /** 陀螺仪背景视差：归一化偏移（[-1,1]，y 上正）。背景画在 GL 层，CSS transform 动不到它，
     *  主舞台原生渲染时由这里替代 CSS 视差路径。任意线程可调（渲染器侧 volatile 快照）。 */
    public void setBackgroundParallax(float nx, float ny) {
        Live2DGLHost view = glHost;
        if (view == null) return;
        view.getLive2DRenderer().setBackgroundParallax(nx, ny);
    }

    public void setBackground(JSONObject opts) {
        Live2DGLHost view = glHost;
        if (view == null || opts == null) return;
        NativeLive2DRenderer renderer = view.getLive2DRenderer();

        String color = optStringOrNull(opts, "color");
        if (color != null) applyClearColor(renderer, color);

        if (opts.has("bottomBarHeightFraction") || opts.has("bottomBarColor")) {
            float heightFraction = (float) opts.optDouble("bottomBarHeightFraction", 0);
            String bottomBarColor = optStringOrNull(opts, "bottomBarColor");
            int argb = 0;
            if (bottomBarColor != null) {
                try {
                    argb = Color.parseColor(bottomBarColor);
                } catch (IllegalArgumentException e) {
                    Log.w(TAG, "bad bottom bar color: " + bottomBarColor);
                }
            }
            renderer.setBottomBar(heightFraction, argb);
        }

        String assetPath = optStringOrNull(opts, "assetPath");
        String dataUrl = optStringOrNull(opts, "dataUrl");
        boolean clearImage = opts.optBoolean("clearImage", false);
        if (assetPath != null) {
            Bitmap bitmap = decodeAssetBitmap(assetPath);
            if (bitmap != null) renderer.setBackgroundBitmap(bitmap);
            else Log.w(TAG, "background asset decode failed: " + assetPath);
        } else if (dataUrl != null) {
            Bitmap bitmap = decodeDataUrlBitmap(dataUrl);
            if (bitmap != null) renderer.setBackgroundBitmap(bitmap);
            else Log.w(TAG, "background dataUrl decode failed");
        } else if (clearImage) {
            renderer.setBackgroundBitmap(null);
        }
    }

    // ---- 可见性/生命周期 ----

    public void hideAfterPause(Runnable onPaused) {
        runOnUi(() -> {
            Live2DGLHost host = glHost;
            if (host != null) {
                host.setHostVisible(false);
                host.onHostPause();
            }
            onPaused.run();
        });
    }

    public void showAfterFrame(Long requestedTraceId, LongConsumer onHostResumed, Runnable onFrame) {
        runOnUi(() -> {
            Live2DGLHost host = glHost;
            if (host == null) { onFrame.run(); return; }
            NativeLive2DRenderer renderer = host.getLive2DRenderer();
            long traceId = renderer.awaitNextCompositeFrame(requestedTraceId, onFrame);
            host.setHostVisible(true);
            host.onHostResume();
            renderer.markHostResumed(traceId);
            if (onHostResumed != null) onHostResumed.accept(traceId);
        });
    }

    public void showAfterFrame(Runnable onFrame) {
        showAfterFrame(null, null, onFrame);
    }

    public void hide() {
        hideAfterPause(() -> {});
    }

    public void show() {
        showAfterFrame(() -> {});
    }

    /** 宿主 pause（Activity onPause / Dream stopped / 壁纸不可见）：只在可见时暂停渲染线程。 */
    public void pauseIfVisible() {
        Live2DGLHost host = glHost;
        if (host != null && host.isHostVisible()) host.onHostPause();
    }

    public void resumeIfVisible() {
        Live2DGLHost host = glHost;
        if (host != null && host.isHostVisible()) host.onHostResume();
    }

    /** 彻底销毁（宿主 detach）：卸模型 + 脱离宿主（View 树移除 / 壁纸销毁 EGL）。 */
    public void destroy() {
        Live2DGLHost host = glHost;
        glHost = null;
        if (host == null) return;
        host.queueEvent(() -> {
            NativeLive2DRenderer renderer = host.getLive2DRenderer();
            NativeLive2DModel model = renderer.getModel();
            if (model != null) {
                renderer.setModel(null);
                model.release();
            }
            renderer.destroy();
        });
        runOnUi(() -> {
            host.onHostPause();
            host.detachFromHost();
        });
    }

    // ---- 解析工具 ----

    static NativeLive2DRenderer.Layout parseLayout(JSONObject obj) {
        return new NativeLive2DRenderer.Layout(
            (float) obj.optDouble("anchorXFrac", 0.5),
            (float) obj.optDouble("bottomYFrac", 0.95),
            (float) obj.optDouble("widthFrac", 0.9),
            (float) obj.optDouble("heightFrac", 0.9));
    }

    static void applyClearColor(NativeLive2DRenderer renderer, String hex) {
        try {
            // Color.parseColor 支持 #RRGGBB（alpha=255 不透明）与 #AARRGGBB（带 alpha）。
            // 浮窗传 #00000000 → alpha 0 透明悬浮；现有场景传 6 位 hex 自动 alpha 255，行为不变。
            int c = Color.parseColor(hex);
            renderer.setClearColor(
                Color.red(c) / 255f, Color.green(c) / 255f, Color.blue(c) / 255f, Color.alpha(c) / 255f);
        } catch (IllegalArgumentException e) {
            Log.w(TAG, "bad background color: " + hex);
        }
    }

    /** 背景图解码（调用线程执行），限边 1600px 防 1GB 机内存峰值。 */
    private Bitmap decodeAssetBitmap(String assetPath) {
        try (InputStream in = context.getAssets().open(assetPath)) {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeStream(in, null, bounds);
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / sample > 1600) sample *= 2;
            try (InputStream again = context.getAssets().open(assetPath)) {
                BitmapFactory.Options options = new BitmapFactory.Options();
                options.inSampleSize = sample;
                return BitmapFactory.decodeStream(again, null, options);
            }
        } catch (Exception e) {
            return null;
        }
    }

    private static Bitmap decodeDataUrlBitmap(String dataUrl) {
        try {
            int comma = dataUrl.indexOf(',');
            byte[] bytes = Base64.decode(dataUrl.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (Exception e) {
            return null;
        }
    }

    private static String optStringOrNull(JSONObject obj, String key) {
        String v = obj.optString(key, null);
        return (v == null || v.isEmpty() || "null".equals(v)) ? null : v;
    }

    static Map<String, Float> toFloatMap(JSONObject obj) {
        Map<String, Float> map = new HashMap<>();
        if (obj == null) return map;
        Iterator<String> keys = obj.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            double value = obj.optDouble(key, Double.NaN);
            if (!Double.isNaN(value)) map.put(key, (float) value);
        }
        return map;
    }

    static String[] toStringArray(JSONArray array) {
        List<String> list = toStringList(array);
        return list.toArray(new String[0]);
    }

    static List<String> toStringList(JSONArray array) {
        List<String> list = new ArrayList<>();
        if (array == null) return list;
        for (int i = 0; i < array.length(); i++) {
            String v = array.optString(i, null);
            if (v != null) list.add(v);
        }
        return list;
    }
}
