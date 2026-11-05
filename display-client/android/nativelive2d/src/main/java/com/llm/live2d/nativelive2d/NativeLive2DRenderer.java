package com.llm.live2d.nativelive2d;

import android.content.Context;
import android.graphics.Bitmap;
import android.opengl.GLES20;
import android.opengl.GLSurfaceView;
import android.opengl.GLUtils;
import android.os.SystemClock;
import android.util.Log;

import com.live2d.sdk.cubism.framework.CubismFramework;
import com.live2d.sdk.cubism.framework.math.CubismMatrix44;
import com.live2d.sdk.cubism.framework.rendering.android.CubismOffscreenManagerAndroid;
import com.live2d.sdk.cubism.framework.rendering.android.CubismShaderAndroid;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/**
 * GL 渲染循环：清屏（或背景贴图 cover 铺满）→ 模型 update+draw → 帧率节流。
 * 构图不走 CubismModelMatrix：JS 发来的「视口分数」直接构造 MVP——与 pixi 同一套
 * 「画布盒中心原点」假设，保证两端构图数学逐值等价（见 docs/superpowers/plans/2026-07-13）。
 */
final class NativeLive2DRenderer implements GLSurfaceView.Renderer {
    private static final String TAG = "NativeLive2D";

    /** 构图分数（相对 GL 视口）：锚点=画布盒底边中心。volatile 快照发布。 */
    static final class Layout {
        final float anchorXFrac;
        final float bottomYFrac;
        final float widthFrac;
        final float heightFrac;

        Layout(float anchorXFrac, float bottomYFrac, float widthFrac, float heightFrac) {
            this.anchorXFrac = anchorXFrac;
            this.bottomYFrac = bottomYFrac;
            this.widthFrac = widthFrac;
            this.heightFrac = heightFrac;
        }
    }

    private final Context context;
    private final TextureLoader textureLoader;
    /** 仅 GL 线程访问：阻止 queueEvent 在 EGL 建好前触发 GPU 资源创建。 */
    private final GlContextWorkQueue glContextWork = new GlContextWorkQueue();

    private volatile NativeLive2DModel model;
    private volatile Layout layout = new Layout(0.5f, 0.95f, 0.9f, 0.9f);
    private volatile int targetFps = 15;
    private volatile float[] clearColor = {0f, 0f, 0f, 1f};
    /** 掌机底栏由 GL 在模型之前绘制，才能形成「底栏 < 模型 < WebView 按钮」的真实层级。 */
    private volatile BottomBarSpec bottomBar = new BottomBarSpec(0f, 0x00000000);
    // 首帧回调：模型 setModel 后不立即通知 JS（那时角色还没画出来，切页 loading 门会早撤露黑），
    // 改在真正画完第一帧有模型的帧后触发，保证 JS onReady 时角色已可见。GL 线程读写。
    private volatile Runnable firstFrameCallback;

    private static final class PendingBackground {
        final Bitmap bitmap;
        final boolean clear;
        final long revision;

        PendingBackground(Bitmap bitmap, boolean clear, long revision) {
            this.bitmap = bitmap;
            this.clear = clear;
            this.revision = revision;
        }
    }

    // 桥线程解码后只发布最新载荷；GL 线程上传后保留 CPU Bitmap，供 EGL 重建时重新上传。
    private final AtomicReference<PendingBackground> pendingBackground = new AtomicReference<>();
    private final CompositeFrameGate compositeFrameGate = new CompositeFrameGate();
    private final AtomicLong lifecycleTraceSequence = new AtomicLong();
    private final AtomicReference<LifecycleFrameTrace> lifecycleTrace = new AtomicReference<>();
    private Bitmap retainedBackground;
    private long retainedBackgroundRevision;
    private int backgroundTextureId;
    private float backgroundAspect = 1f; // w/h

    private int surfaceWidth;
    private int surfaceHeight;
    /** 仅 GL 线程访问；onSurfaceChanged 前尺寸尚不可用于创建 Cubism 掩模缓冲。 */
    private boolean surfaceSizeReady;

    private long lastFrameNanos;
    private long fpsWindowStartMs;
    private int fpsWindowFrames;

    // 底部软边渐隐（桌宠浮窗「上半身」构图防「赛博截肢」硬切）：模型画完后用一个渐变 quad
    // 把底部的 alpha 擦掉，等价于 Pixi 路径上的 CSS mask-image: linear-gradient(to bottom, #000 76%, transparent 98%)。
    // 单位与 CSS 一致：从画面顶部起算的比例，0=顶 1=底；start 之前全保留，end 之后全擦。
    // fadeEnd<=fadeStart 表示关闭（默认关，只有浮窗开）。GL 线程读，桥线程写。
    private volatile float fadeStart = 0f;
    private volatile float fadeEnd = 0f;
    // 背景圆角半径（surface 物理 px）：桌宠「显示背景」的圆角卡片——GL 是独立 SurfaceView，
    // CSS 圆角裁不到它（media overlay 也不吃 view outline 裁剪，实测），由背景 shader 做
    // 圆角矩形 SDF 擦 alpha。0=直角（屏保/主 App 默认，行为不变）。半径与 pet.css .pet-card 同源。
    private volatile float cornerRadiusPx = 0f;
    private int fadeProgram;
    private int fadeAttrPosition;
    private int fadeUniformStart;
    private int fadeUniformEnd;
    private java.nio.FloatBuffer fadeVertexBuffer;

    // 背景 quad 的极简着色器（模型渲染用 Cubism 自己的 shader，互不相干）
    private int bgProgram;
    private int bgAttrPosition;
    private int bgAttrUv;
    private int bgUniformTexture;
    private int bgUniformSize;
    private int bgUniformCorner;
    private int bgUniformScale;
    private int bgUniformOffset;
    private FloatBuffer bgVertexBuffer;
    private FloatBuffer bgUvBuffer;

    private final CubismMatrix44 mvp = CubismMatrix44.create();

    NativeLive2DRenderer(Context context) {
        this.context = context.getApplicationContext();
        this.textureLoader = new TextureLoader(context);
    }

    TextureLoader getTextureLoader() {
        return textureLoader;
    }

    NativeLive2DModel getModel() {
        return model;
    }

    void setModel(NativeLive2DModel model) {
        this.model = model;
    }

    void setLayout(Layout layout) {
        this.layout = layout;
    }

    void setBottomBar(float heightFraction, int argb) {
        bottomBar = new BottomBarSpec(heightFraction, argb);
    }

    void setTargetFps(int fps) {
        targetFps = Math.max(5, Math.min(60, fps));
    }

    void setClearColor(float r, float g, float b, float a) {
        // a=0 → 透明清屏（浮窗悬浮：GL 空白处露出桌面）；a=1 → 不透明（屏保/主App/DJ页，反正被背景图盖）。
        clearColor = new float[]{r, g, b, a};
    }

    /** 注册「首帧真画出来后」回调（GL 线程触发一次）：切页 loading 门等它而非 setModel 完成，防早撤露黑。 */
    void setFirstFrameCallback(Runnable cb) {
        firstFrameCallback = cb;
    }

    long beginLifecycleTrace(Long requestedId) {
        LifecycleFrameTrace current = lifecycleTrace.get();
        if (requestedId != null && current != null && current.id == requestedId) return current.id;
        long id = LifecycleTraceIdPolicy.resolve(
            requestedId,
            lifecycleTraceSequence.incrementAndGet()
        );
        LifecycleFrameTrace trace = new LifecycleFrameTrace(id, SystemClock.elapsedRealtime());
        lifecycleTrace.set(trace);
        traceLifecyclePhase(trace.id, trace.startedAtMs, "request");
        return id;
    }

    long awaitNextCompositeFrame(Long requestedId, Runnable callback) {
        long id = beginLifecycleTrace(requestedId);
        compositeFrameGate.awaitNextFrame(callback);
        return id;
    }

    void markHostResumed(long id) {
        LifecycleFrameTrace trace = lifecycleTrace.get();
        if (trace != null && trace.id == id && !trace.hostResumedLogged
            && LifecycleTracePhasePolicy.isHostResumed(true)) {
            trace.hostResumedLogged = true;
            traceLifecyclePhase(trace.id, trace.startedAtMs, "host_resumed");
        }
    }

    void setBackgroundBitmap(Bitmap bitmap) {
        long revision = compositeFrameGate.requestBackgroundChange();
        PendingBackground old = pendingBackground.getAndSet(
            new PendingBackground(bitmap, bitmap == null, revision));
        if (old != null && old.bitmap != null && old.bitmap != bitmap) {
            old.bitmap.recycle();
        }
    }

    int getSurfaceWidth() {
        return surfaceWidth;
    }

    int getSurfaceHeight() {
        return surfaceHeight;
    }

    /** 仅 GL 线程调用。 */
    boolean isSurfaceSizeReady() {
        return surfaceSizeReady;
    }

    /** 仅 GL 线程调用；GL 上下文可用时立即运行，否则在 onSurfaceCreated 末尾顺序补跑。 */
    void runWhenGlContextReady(Runnable work) {
        glContextWork.enqueue(work);
    }

    @Override
    public void onSurfaceCreated(javax.microedition.khronos.opengles.GL10 unused,
                                 javax.microedition.khronos.egl.EGLConfig config) {
        glContextWork.markNotReady();
        surfaceSizeReady = false;
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA);

        if (!CubismFramework.isInitialized()) {
            CubismFramework.initialize();
        }

        // 上下文（重）建：失效的旧 GL 资源全部丢弃重来
        CubismShaderAndroid.getInstance().releaseInvalidShaderProgram();
        CubismShaderAndroid.deleteInstance();
        textureLoader.releaseAll();
        backgroundTextureId = 0;
        bgProgram = 0;
        compositeFrameGate.invalidateBackground();

        lastFrameNanos = System.nanoTime();
        fpsWindowStartMs = System.currentTimeMillis();
        fpsWindowFrames = 0;

        Log.i(TAG, "surface created");
        // 先完成旧资源清理，再允许模型创建新的 shader/纹理；否则会马上把刚失效的资源又绑回去。
        glContextWork.markReady();
    }

    @Override
    public void onSurfaceChanged(javax.microedition.khronos.opengles.GL10 unused, int width, int height) {
        GLES20.glViewport(0, 0, width, height);
        boolean sizeChanged = width != surfaceWidth || height != surfaceHeight;
        surfaceWidth = width;
        surfaceHeight = height;
        surfaceSizeReady = width > 0 && height > 0;

        NativeLive2DModel current = model;
        if (surfaceSizeReady && current != null && current.isLoaded()) {
            // 渲染器持有掩模缓冲，尺寸变化/上下文重建后重建并重绑纹理
            current.setupRendererAndTextures(width, height);
        }
        Log.i(TAG, "surface changed " + width + "x" + height + (sizeChanged ? "" : " (same)"));
    }

    @Override
    public void onDrawFrame(javax.microedition.khronos.opengles.GL10 unused) {
        // Snapshot at frame start: a request registered mid-frame cannot claim work already in progress.
        LifecycleFrameTrace frameTrace = lifecycleTrace.get();
        long frameStartMs = System.currentTimeMillis();
        long now = System.nanoTime();
        // delta 限幅 80ms：大 hitch（GC/切后台）直接喂动作系统会瞬移（对齐 WebView 引擎限幅）
        float deltaSeconds = Math.min((now - lastFrameNanos) / 1_000_000_000f, 0.08f);
        lastFrameNanos = now;

        float[] cc = clearColor;
        GLES20.glClearColor(cc[0], cc[1], cc[2], cc[3]);
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT | GLES20.GL_DEPTH_BUFFER_BIT);
        GLES20.glClearDepthf(1.0f);

        consumePendingBackground();
        boolean backgroundDrawn = drawBackground();
        if (ownsCurrentFrame(frameTrace) && !frameTrace.backgroundLogged
            && LifecycleTracePhasePolicy.isBackgroundReady(
                backgroundDrawn,
                backgroundTextureId,
                surfaceWidth,
                surfaceHeight
            )) {
            frameTrace.backgroundLogged = true;
            traceLifecyclePhase(frameTrace.id, frameTrace.startedAtMs, "background_ready");
        }
        drawBottomBar();

        NativeLive2DModel current = model;
        if (current != null && current.isLoaded()) {
            CubismOffscreenManagerAndroid.getInstance().beginFrameProcess();

            long t0 = System.currentTimeMillis();
            current.update(deltaSeconds);
            long t1 = System.currentTimeMillis();
            buildMvp(current);
            current.draw(mvp);
            if (ownsCurrentFrame(frameTrace) && !frameTrace.modelFrameLogged) {
                frameTrace.modelFrameLogged = true;
                traceLifecyclePhase(frameTrace.id, frameTrace.startedAtMs, "model_first_frame");
            }
            long t2 = System.currentTimeMillis();
            updateMsAccum += t1 - t0;
            drawMsAccum += t2 - t1;

            CubismOffscreenManagerAndroid.getInstance().endFrameProcess();
            CubismOffscreenManagerAndroid.getInstance().releaseStaleRenderTextures();

            // 模型之后、上屏之前擦底部 alpha（背景层也一并淡出，整体才像「飘着的幽灵」）。
            drawBottomFade();

            // 首帧真画完（有模型的一帧）后触发一次就绪回调 → JS onReady → 切页 loading 门此刻才撤，角色已可见。
            Runnable cb = firstFrameCallback;
            if (cb != null) {
                firstFrameCallback = null;
                cb.run();
            }
        }

        Runnable compositeReady = compositeFrameGate.completeFrame(current != null && current.isLoaded());
        if (compositeReady != null) {
            if (ownsCurrentFrame(frameTrace)) {
                traceLifecyclePhase(frameTrace.id, frameTrace.startedAtMs, "composite_ready");
            }
            compositeReady.run();
        }

        throttleAndCountFps(frameStartMs);
    }

    /**
     * 用 scissor 只写视口底部。颜色按预乘 alpha 写入透明 Surface，随后模型正常绘制在其上。
     */
    private void drawBottomBar() {
        BottomBarSpec spec = bottomBar;
        int height = spec.pixelHeight(surfaceHeight);
        if (height <= 0 || surfaceWidth <= 0) return;

        GLES20.glEnable(GLES20.GL_SCISSOR_TEST);
        GLES20.glScissor(0, 0, surfaceWidth, height);
        GLES20.glClearColor(
            spec.redPremultiplied,
            spec.greenPremultiplied,
            spec.bluePremultiplied,
            spec.alpha
        );
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT);
        GLES20.glDisable(GLES20.GL_SCISSOR_TEST);
    }

    /**
     * 视口分数 → NDC 矩阵。画布盒单位坐标假设中心原点（[-cw/2..cw/2]×[-ch/2..ch/2]，y 向上）——
     * 与 pixi-live2d-display 同一假设，两端偏差自然一致。
     */
    private void buildMvp(NativeLive2DModel current) {
        Layout lt = layout;
        float cw = current.getCanvasWidthUnits();
        float ch = current.getCanvasHeightUnits();
        float sx = lt.widthFrac * 2f / cw;
        float sy = lt.heightFrac * 2f / ch;
        float tx = lt.anchorXFrac * 2f - 1f;
        // 底边（unit y=-ch/2）落在 NDC 的 1-2*bottomYFrac 处
        float ty = (1f - 2f * lt.bottomYFrac) + sy * ch / 2f;

        float[] m = {
            sx, 0f, 0f, 0f,
            0f, sy, 0f, 0f,
            0f, 0f, 1f, 0f,
            tx, ty, 0f, 1f,
        };
        mvp.setMatrix(m);
    }

    // ---- 背景贴图 ----

    private void consumePendingBackground() {
        PendingBackground pending = pendingBackground.getAndSet(null);
        if (pending != null) {
            if (pending.clear) {
                deleteBackgroundTexture();
                Bitmap previous = retainedBackground;
                retainedBackground = null;
                retainedBackgroundRevision = pending.revision;
                if (previous != null) previous.recycle();
                compositeFrameGate.markBackgroundDrawn(pending.revision);
                return;
            }

            uploadBackground(pending.bitmap);
            Bitmap previous = retainedBackground;
            retainedBackground = pending.bitmap;
            retainedBackgroundRevision = pending.revision;
            if (previous != null && previous != retainedBackground) previous.recycle();
            compositeFrameGate.markBackgroundDrawn(pending.revision);
            return;
        }

        if (backgroundTextureId == 0) {
            if (retainedBackground != null) uploadBackground(retainedBackground);
            compositeFrameGate.markBackgroundDrawn(retainedBackgroundRevision);
        }
    }

    private void uploadBackground(Bitmap bitmap) {
        deleteBackgroundTexture();
        int[] tex = new int[1];
        GLES20.glGenTextures(1, tex, 0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, tex[0]);
        GLUtils.texImage2D(GLES20.GL_TEXTURE_2D, 0, bitmap, 0);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE);
        GLES20.glTexParameteri(GLES20.GL_TEXTURE_2D, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE);
        backgroundTextureId = tex[0];
        backgroundAspect = bitmap.getHeight() > 0 ? (float) bitmap.getWidth() / bitmap.getHeight() : 1f;
    }

    private void deleteBackgroundTexture() {
        if (backgroundTextureId == 0) return;
        GLES20.glDeleteTextures(1, new int[]{backgroundTextureId}, 0);
        backgroundTextureId = 0;
    }

    /** Controller 销毁宿主时在 GL 线程调用，释放 GPU 与最终 CPU retained source。 */
    void destroy() {
        deleteBackgroundTexture();
        PendingBackground pending = pendingBackground.getAndSet(null);
        if (pending != null && pending.bitmap != null && pending.bitmap != retainedBackground) {
            pending.bitmap.recycle();
        }
        if (retainedBackground != null) {
            retainedBackground.recycle();
            retainedBackground = null;
        }
    }

    private void ensureBackgroundProgram() {
        if (bgProgram != 0) return;
        // uScale/uOffset：陀螺仪视差——quad 过扫放大后按 NDC 偏移（uScale=1+MAX 时 offset≤MAX 不露边）。
        // 圆角 SDF 用 gl_FragCoord（屏幕空间），不随 quad 位移，圆角卡片构图不受影响。
        String vertex = "attribute vec2 aPos; attribute vec2 aUv; varying vec2 vUv;"
            + " uniform vec2 uScale; uniform vec2 uOffset;"
            + " void main(){ gl_Position = vec4(aPos * uScale + uOffset, 0.0, 1.0); vUv = aUv; }";
        // 圆角：uCorner>0 时对圆角矩形 SDF 求 alpha（1px 过渡带抗锯齿），输出预乘 alpha
        // （调用侧随之开 GL_ONE/ONE_MINUS_SRC_ALPHA 混合）；uCorner=0 走原不透明路径。
        // gl_FragCoord 是 surface 物理像素（vUv 被 cover 内缩过，不能用来定位）。
        String fragment = "precision mediump float; varying vec2 vUv; uniform sampler2D uTex;"
            + " uniform vec2 uSize; uniform float uCorner;"
            + " void main(){ vec4 c = texture2D(uTex, vUv); float alpha = 1.0;"
            + " if (uCorner > 0.5) {"
            + "   vec2 halfSz = uSize * 0.5;"
            + "   vec2 q = abs(gl_FragCoord.xy - halfSz) - (halfSz - vec2(uCorner));"
            + "   float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - uCorner;"
            + "   alpha = clamp(0.5 - d, 0.0, 1.0);"
            + " }"
            + " gl_FragColor = vec4(c.rgb * alpha, alpha); }";
        int vs = compileShader(GLES20.GL_VERTEX_SHADER, vertex);
        int fs = compileShader(GLES20.GL_FRAGMENT_SHADER, fragment);
        bgProgram = GLES20.glCreateProgram();
        GLES20.glAttachShader(bgProgram, vs);
        GLES20.glAttachShader(bgProgram, fs);
        GLES20.glLinkProgram(bgProgram);
        GLES20.glDeleteShader(vs);
        GLES20.glDeleteShader(fs);
        bgAttrPosition = GLES20.glGetAttribLocation(bgProgram, "aPos");
        bgAttrUv = GLES20.glGetAttribLocation(bgProgram, "aUv");
        bgUniformTexture = GLES20.glGetUniformLocation(bgProgram, "uTex");
        bgUniformSize = GLES20.glGetUniformLocation(bgProgram, "uSize");
        bgUniformCorner = GLES20.glGetUniformLocation(bgProgram, "uCorner");
        bgUniformScale = GLES20.glGetUniformLocation(bgProgram, "uScale");
        bgUniformOffset = GLES20.glGetUniformLocation(bgProgram, "uOffset");

        float[] vertices = {-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f};
        bgVertexBuffer = ByteBuffer.allocateDirect(vertices.length * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer().put(vertices);
        bgUvBuffer = ByteBuffer.allocateDirect(8 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
    }

    private static int compileShader(int type, String source) {
        int shader = GLES20.glCreateShader(type);
        GLES20.glShaderSource(shader, source);
        GLES20.glCompileShader(shader);
        return shader;
    }

    /**
     * 底部渐隐区间（CSS 语义：从画面顶部起算的比例，0=顶 1=底）。end<=start 表示关闭。
     * 与 pet.css 的 mask-image: linear-gradient(to bottom, #000 76%, transparent 98%) 对齐。
     */
    public void setBottomFade(float start, float end) {
        fadeStart = start;
        fadeEnd = end;
    }

    /** 背景圆角半径（物理 px），0=直角。见 cornerRadiusPx 字段注释。 */
    public void setCornerRadius(float px) {
        cornerRadiusPx = Math.max(0f, px);
    }

    // 陀螺仪背景视差：JS 发来归一化偏移（[-1,1]，方向已按 CSS 视差语义调好），GL 按
    // BG_PARALLAX_MAX_NDC 折成 NDC 位移。背景 quad 按 1+MAX 过扫放大，位移到顶也不露边。
    // 0.10 ≈ 半屏宽的 10%（略大于老 CSS 路径 16px≈0.08 的手感，真机调出来的值）。
    // 桥线程写，GL 线程读。
    private static final float BG_PARALLAX_MAX_NDC = 0.10f;
    private volatile float bgParallaxX;
    private volatile float bgParallaxY;

    /** 背景视差归一化偏移（[-1,1]）；x 右正、y 上正（NDC 语义，调用方负责方向换算）。 */
    public void setBackgroundParallax(float nx, float ny) {
        bgParallaxX = Math.max(-1f, Math.min(1f, nx));
        bgParallaxY = Math.max(-1f, Math.min(1f, ny));
    }

    private void ensureFadeProgram() {
        if (fadeProgram != 0) return;
        // NDC y(+1 顶 / -1 底) 换算成「从顶部起算的比例」，好与 CSS 百分比同语义。
        String vertex = "attribute vec2 aPos; varying float vRatio;"
            + " void main(){ gl_Position = vec4(aPos, 0.0, 1.0); vRatio = (1.0 - aPos.y) * 0.5; }";
        // 只输出 alpha：配合 glBlendFunc(GL_ZERO, GL_ONE_MINUS_SRC_ALPHA)，alpha 越大擦得越干净。
        String fragment = "precision mediump float; varying float vRatio; uniform float uStart; uniform float uEnd;"
            + " void main(){ float a = clamp((vRatio - uStart) / max(uEnd - uStart, 1e-4), 0.0, 1.0);"
            + " gl_FragColor = vec4(0.0, 0.0, 0.0, a); }";
        int vs = compileShader(GLES20.GL_VERTEX_SHADER, vertex);
        int fs = compileShader(GLES20.GL_FRAGMENT_SHADER, fragment);
        fadeProgram = GLES20.glCreateProgram();
        GLES20.glAttachShader(fadeProgram, vs);
        GLES20.glAttachShader(fadeProgram, fs);
        GLES20.glLinkProgram(fadeProgram);
        GLES20.glDeleteShader(vs);
        GLES20.glDeleteShader(fs);
        fadeAttrPosition = GLES20.glGetAttribLocation(fadeProgram, "aPos");
        fadeUniformStart = GLES20.glGetUniformLocation(fadeProgram, "uStart");
        fadeUniformEnd = GLES20.glGetUniformLocation(fadeProgram, "uEnd");

        float[] vertices = {-1f, -1f, 1f, -1f, -1f, 1f, 1f, 1f};
        fadeVertexBuffer = ByteBuffer.allocateDirect(vertices.length * 4)
            .order(ByteOrder.nativeOrder()).asFloatBuffer().put(vertices);
    }

    /**
     * 模型画完后擦掉底部 alpha，做出「下半身淡出」的幽灵效果。
     * 必须用 GL_ZERO/GL_ONE_MINUS_SRC_ALPHA（dst *= 1-src_a）而不是叠一层黑：
     * 浮窗是透明合成的，叠色会变成黑渐变糊在桌面上，只有擦 alpha 才是真的「淡出」。
     */
    private void drawBottomFade() {
        if (!(fadeEnd > fadeStart)) return;
        ensureFadeProgram();
        GLES20.glUseProgram(fadeProgram);
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_ZERO, GLES20.GL_ONE_MINUS_SRC_ALPHA);
        GLES20.glUniform1f(fadeUniformStart, fadeStart);
        GLES20.glUniform1f(fadeUniformEnd, fadeEnd);

        fadeVertexBuffer.position(0);
        GLES20.glEnableVertexAttribArray(fadeAttrPosition);
        GLES20.glVertexAttribPointer(fadeAttrPosition, 2, GLES20.GL_FLOAT, false, 0, fadeVertexBuffer);
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);
        GLES20.glDisableVertexAttribArray(fadeAttrPosition);

        // 复原 Cubism 渲染依赖的预乘 alpha 混合，别把下一帧的模型绘制带歪。
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA);
    }

    private boolean drawBackground() {
        if (backgroundTextureId == 0 || surfaceWidth <= 0 || surfaceHeight <= 0) return false;
        ensureBackgroundProgram();

        // cover 铺满：贴图与视口宽高比取交，裁掉超出的一维（uv 内缩）
        float viewAspect = (float) surfaceWidth / surfaceHeight;
        float u0 = 0f, u1 = 1f, v0 = 0f, v1 = 1f;
        if (backgroundAspect > viewAspect) {
            float crop = (1f - viewAspect / backgroundAspect) / 2f;
            u0 = crop;
            u1 = 1f - crop;
        } else {
            float crop = (1f - backgroundAspect / viewAspect) / 2f;
            v0 = crop;
            v1 = 1f - crop;
        }
        // GL y 向上、图片 v 向下：翻转 v
        float[] uvs = {u0, v1, u1, v1, u0, v0, u1, v0};
        bgUvBuffer.clear();
        bgUvBuffer.put(uvs);

        GLES20.glUseProgram(bgProgram);
        // 圆角开：擦角 alpha 需要预乘混合（与 Cubism 模型绘制同一 blend func）；
        // 圆角关：保持历史的不透明直写，屏保/主 App 行为不变。
        float corner = cornerRadiusPx;
        if (corner > 0.5f) {
            GLES20.glEnable(GLES20.GL_BLEND);
            GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA);
        } else {
            GLES20.glDisable(GLES20.GL_BLEND);
        }
        GLES20.glUniform2f(bgUniformSize, (float) surfaceWidth, (float) surfaceHeight);
        GLES20.glUniform1f(bgUniformCorner, corner);
        float overscan = 1f + BG_PARALLAX_MAX_NDC;
        GLES20.glUniform2f(bgUniformScale, overscan, overscan);
        GLES20.glUniform2f(bgUniformOffset,
            bgParallaxX * BG_PARALLAX_MAX_NDC, bgParallaxY * BG_PARALLAX_MAX_NDC);
        GLES20.glActiveTexture(GLES20.GL_TEXTURE0);
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, backgroundTextureId);
        GLES20.glUniform1i(bgUniformTexture, 0);

        bgVertexBuffer.position(0);
        GLES20.glEnableVertexAttribArray(bgAttrPosition);
        GLES20.glVertexAttribPointer(bgAttrPosition, 2, GLES20.GL_FLOAT, false, 0, bgVertexBuffer);
        bgUvBuffer.position(0);
        GLES20.glEnableVertexAttribArray(bgAttrUv);
        GLES20.glVertexAttribPointer(bgAttrUv, 2, GLES20.GL_FLOAT, false, 0, bgUvBuffer);

        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4);

        GLES20.glDisableVertexAttribArray(bgAttrPosition);
        GLES20.glDisableVertexAttribArray(bgAttrUv);
        GLES20.glEnable(GLES20.GL_BLEND);
        GLES20.glBlendFunc(GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA);
        return true;
    }

    /** 帧率节流（睡满帧预算，把 CPU 让给 WebView UI 线程）+ 每 5s 打一条 fps 日志。 */
    private void throttleAndCountFps(long frameStartMs) {
        long budgetMs = 1000L / targetFps;
        long elapsed = System.currentTimeMillis() - frameStartMs;
        long sleepMs = budgetMs - elapsed;
        if (sleepMs > 1) {
            try {
                Thread.sleep(sleepMs);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }

        fpsWindowFrames++;
        long windowMs = System.currentTimeMillis() - fpsWindowStartMs;
        if (windowMs >= 5000) {
            int n = Math.max(fpsWindowFrames, 1);
            Log.i(TAG, String.format("fps=%.1f avg(update=%dms draw=%dms work=%dms) target=%d",
                fpsWindowFrames * 1000f / windowMs, updateMsAccum / n, drawMsAccum / n,
                (updateMsAccum + drawMsAccum) / n, targetFps));
            fpsWindowStartMs = System.currentTimeMillis();
            fpsWindowFrames = 0;
            updateMsAccum = 0;
            drawMsAccum = 0;
        }
    }

    private long updateMsAccum;
    private long drawMsAccum;

    private static final class LifecycleFrameTrace {
        final long id;
        final long startedAtMs;
        volatile boolean hostResumedLogged;
        boolean backgroundLogged;
        boolean modelFrameLogged;

        LifecycleFrameTrace(long id, long startedAtMs) {
            this.id = id;
            this.startedAtMs = startedAtMs;
        }
    }

    private static void traceLifecyclePhase(long id, long startedAtMs, String phase) {
        try {
            Log.i(
                TAG,
                LifecycleTraceFormatter.format(
                    "[native-live2d]",
                    id,
                    phase,
                    SystemClock.elapsedRealtime() - startedAtMs
                )
            );
        } catch (RuntimeException ignored) {
            // Instrumentation must never own renderer control flow.
        }
    }

    private boolean ownsCurrentFrame(LifecycleFrameTrace frameTrace) {
        LifecycleFrameTrace currentTrace = lifecycleTrace.get();
        return frameTrace != null
            && currentTrace != null
            && LifecycleTraceFramePolicy.ownsFrame(frameTrace.id, currentTrace.id);
    }
}
