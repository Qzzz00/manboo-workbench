package com.llm.live2d.nativelive2d;

import android.content.Context;
import android.util.Log;

import com.live2d.sdk.cubism.framework.CubismDefaultParameterId.ParameterId;
import com.live2d.sdk.cubism.framework.CubismFramework;
import com.live2d.sdk.cubism.framework.CubismModelSettingJson;
import com.live2d.sdk.cubism.framework.ICubismModelSetting;
import com.live2d.sdk.cubism.framework.effect.CubismBreath;
import com.live2d.sdk.cubism.framework.effect.CubismLook;
import com.live2d.sdk.cubism.framework.id.CubismId;
import com.live2d.sdk.cubism.framework.id.CubismIdManager;
import com.live2d.sdk.cubism.framework.math.CubismMatrix44;
import com.live2d.sdk.cubism.framework.model.CubismUserModel;
import com.live2d.sdk.cubism.framework.motion.ACubismMotion;
import com.live2d.sdk.cubism.framework.motion.CubismBreathUpdater;
import com.live2d.sdk.cubism.framework.motion.CubismLookUpdater;
import com.live2d.sdk.cubism.framework.motion.CubismMotion;
import com.live2d.sdk.cubism.framework.motion.CubismPhysicsUpdater;
import com.live2d.sdk.cubism.framework.rendering.CubismRenderer;
import com.live2d.sdk.cubism.framework.rendering.android.CubismRendererAndroid;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

/**
 * LAppModel 的精简版：加载走 JS 传来的「增强版 model3.json」字符串（动作已注入命名组、
 * 纹理已按设备档降级、表情剔除——表情由 JS 拍平成参数经 setOverlayTargets 下发）。
 *
 * 与 Sample 的关键差异：
 * - 加载/注册物理（CubismPhysicsUpdater）——原生渲染够快，恢复物理（Ben 要求切底层不砍效果，
 *   区别于 liteApp 的「关物理」降配）。executionOrder=PHYSICS(600) 排在呼吸/朝向后。
 * - 不加载 expression/pose（本模型 pose 无；表情走 JS 参数通道保持与 WebView 同一份拍平逻辑）。
 * - update() 在 onLateUpdate（呼吸/朝向）之后、model.update() 之前写三层参数覆盖：
 *   overlay（平滑逼近，镜像 JS runOverlayFrame 的 easeTowards 分档系数）→ persistent（换装等每帧硬写）
 *   → mouth（口型最后写，最高优先）。
 */
final class NativeLive2DModel extends CubismUserModel {
    private static final String TAG = "NativeLive2D";

    // pixi-live2d-display 动作优先级对齐：IDLE=1 / NORMAL=2
    static final int PRIORITY_IDLE = 1;
    static final int PRIORITY_NORMAL = 2;

    // 待机循环/小动作拍双向淡化（秒）与间隔（毫秒），值取自 live2dEngine.ts 同名常量。
    private static final float IDLE_FADE_SECONDS = 0.9f;
    private static final long IDLE_BEAT_MIN_GAP_MS = 6000;
    private static final long IDLE_BEAT_MAX_GAP_MS = 14000;

    private final Context context;
    private final TextureLoader textureLoader;

    private ICubismModelSetting modelSetting;
    private String modelHomeDirectory = "";
    private String[] textureOverridePaths = new String[0];
    private final Map<String, ACubismMotion> motions = new HashMap<>();

    private String idleMotionGroup;
    private final List<String> idleBeatGroups = new ArrayList<>();
    private long nextIdleBeatAtMs;
    private final Random random = new Random();

    // ---- 参数覆盖三通道：桥线程整体替换（AtomicReference 发布），GL 线程每帧读 ----
    private final AtomicReference<Map<String, Float>> overlayTargets = new AtomicReference<>(new HashMap<>());
    private final AtomicReference<Map<String, Float>> persistentParams = new AtomicReference<>(new HashMap<>());
    private final AtomicReference<Map<String, Float>> mouthParams = new AtomicReference<>(new HashMap<>());

    // overlay 平滑状态（仅 GL 线程访问）。语义镜像 live2dEngine：首次追踪时快照基线，
    // 目标移除后缓动回基线（而非瞬回默认值）。
    private final Map<String, Float> overlayCurrent = new HashMap<>();
    private final Map<String, Float> baselineParams = new HashMap<>();
    private final Set<String> trackedParamIds = new HashSet<>();
    private final Map<String, CubismId> idCache = new HashMap<>();

    NativeLive2DModel(Context context, TextureLoader textureLoader) {
        this.context = context.getApplicationContext();
        this.textureLoader = textureLoader;
    }

    /** GL 线程调用。settingsJson=增强版 model3.json 文本；modelDir=assets 相对目录（含尾斜杠）。 */
    boolean loadFromSettings(byte[] settingsJson, String modelDir, String[] texturePaths,
                             String idleGroup, List<String> beatGroups, int surfaceWidth, int surfaceHeight) {
        modelHomeDirectory = modelDir;
        textureOverridePaths = texturePaths != null ? texturePaths : new String[0];
        idleMotionGroup = idleGroup;
        idleBeatGroups.clear();
        if (beatGroups != null) idleBeatGroups.addAll(beatGroups);
        nextIdleBeatAtMs = System.currentTimeMillis() + randomGap();

        modelSetting = new CubismModelSettingJson(settingsJson);

        String mocFile = modelSetting.getModelFileName();
        if (mocFile == null || mocFile.isEmpty()) {
            Log.e(TAG, "settings has no moc file");
            return false;
        }
        byte[] mocBytes = AssetLoader.loadBytes(context, modelHomeDirectory + mocFile);
        if (mocBytes.length == 0) return false;
        loadModel(mocBytes);
        if (model == null) {
            Log.e(TAG, "loadModel failed: " + mocFile);
            return false;
        }

        // 物理：加载 physics3.json 并注册物理更新器（默认 executionOrder=PHYSICS(600)，
        // 排在呼吸/朝向之后跑——物理由角度参数驱动，须在其后。切原生渲染后恢复此效果，
        // Ben 明确要求保留物理，不再走 liteApp「关物理」的降配）。update() 里已有的
        // updateScheduler.onLateUpdate 会按序自动跑它，无需改 update()。
        String physicsFile = modelSetting.getPhysicsFileName();
        if (physicsFile != null && !physicsFile.isEmpty()) {
            byte[] physicsBytes = AssetLoader.loadBytes(context, modelHomeDirectory + physicsFile);
            if (physicsBytes.length > 0) {
                loadPhysics(physicsBytes); // 父类 CubismUserModel：内部 CubismPhysics.create → 赋 protected physics 字段
                if (physics != null) {
                    updateScheduler.addUpdatableList(new CubismPhysicsUpdater(physics));
                } else {
                    Log.w(TAG, "loadPhysics failed: " + physicsFile);
                }
            }
        }
        // Pose/Expressions：不加载（见类注释）。

        // 呼吸（Sample 默认参数，pixi-live2d-display 同款效果）
        CubismIdManager idManager = CubismFramework.getIdManager();
        CubismId idAngleX = idManager.getId(ParameterId.ANGLE_X.getId());
        CubismId idAngleY = idManager.getId(ParameterId.ANGLE_Y.getId());
        CubismId idAngleZ = idManager.getId(ParameterId.ANGLE_Z.getId());
        CubismId idBodyAngleX = idManager.getId(ParameterId.BODY_ANGLE_X.getId());
        CubismId idEyeBallX = idManager.getId(ParameterId.EYE_BALL_X.getId());
        CubismId idEyeBallY = idManager.getId(ParameterId.EYE_BALL_Y.getId());

        breath = CubismBreath.create();
        List<CubismBreath.BreathParameterData> breathParameters = new ArrayList<>();
        breathParameters.add(new CubismBreath.BreathParameterData(idAngleX, 0.0f, 15.0f, 6.5345f, 0.5f));
        breathParameters.add(new CubismBreath.BreathParameterData(idAngleY, 0.0f, 8.0f, 3.5345f, 0.5f));
        breathParameters.add(new CubismBreath.BreathParameterData(idAngleZ, 0.0f, 10.0f, 5.5345f, 0.5f));
        breathParameters.add(new CubismBreath.BreathParameterData(idBodyAngleX, 0.0f, 4.0f, 15.5345f, 0.5f));
        breathParameters.add(new CubismBreath.BreathParameterData(
            idManager.getId(ParameterId.BREATH.getId()), 0.5f, 0.5f, 3.2345f, 0.5f));
        breath.setParameters(breathParameters);
        updateScheduler.addUpdatableList(new CubismBreathUpdater(breath));

        // 朝向（focus/待机拍经 dragManager 驱动头+眼+身）
        look = CubismLook.create();
        List<CubismLook.LookParameterData> lookParameters = new ArrayList<>();
        lookParameters.add(new CubismLook.LookParameterData(idAngleX, 30.0f));
        lookParameters.add(new CubismLook.LookParameterData(idAngleY, 0.0f, 30.0f));
        lookParameters.add(new CubismLook.LookParameterData(idAngleZ, 0.0f, 0.0f, -30.0f));
        lookParameters.add(new CubismLook.LookParameterData(idBodyAngleX, 10.0f));
        lookParameters.add(new CubismLook.LookParameterData(idEyeBallX, 1.0f));
        lookParameters.add(new CubismLook.LookParameterData(idEyeBallY, 0.0f, 1.0f));
        look.setParameters(lookParameters);
        updateScheduler.addUpdatableList(new CubismLookUpdater(look, dragManager));

        updateScheduler.sortUpdatableList();

        model.saveParameters();

        // 动作：增强版 settings 里每个命名组 1 个文件（group_0）
        for (int i = 0; i < modelSetting.getMotionGroupCount(); i++) {
            preloadMotionGroup(modelSetting.getMotionGroupName(i));
        }
        motionManager.stopAllMotions();

        // GLSurfaceView 可能已经建好 EGL、但还没回调 onSurfaceChanged。此时先完成 CPU 侧模型解析；
        // 等尺寸就绪后由 NativeLive2DRenderer.onSurfaceChanged 恰好一次创建 shader/纹理，避免重复上传。
        if (surfaceWidth > 0 && surfaceHeight > 0) {
            setupRendererAndTextures(surfaceWidth, surfaceHeight);
        }
        return true;
    }

    /** GL 上下文（重）建后：重建渲染器并重绑纹理。 */
    void setupRendererAndTextures(int surfaceWidth, int surfaceHeight) {
        if (model == null) return;
        deleteRenderer();
        CubismRenderer renderer = CubismRendererAndroid.create(
            Math.max(surfaceWidth, 1), Math.max(surfaceHeight, 1));
        setupRenderer(renderer);

        int textureCount = modelSetting.getTextureCount();
        for (int i = 0; i < textureCount; i++) {
            String texturePath = i < textureOverridePaths.length && textureOverridePaths[i] != null
                ? textureOverridePaths[i]
                : modelHomeDirectory + modelSetting.getTextureFileName(i);
            if (texturePath == null || texturePath.isEmpty()) continue;
            TextureLoader.TextureInfo info = textureLoader.createTextureFromAsset(texturePath);
            if (info == null) {
                Log.w(TAG, "texture load failed: " + texturePath);
                continue;
            }
            this.<CubismRendererAndroid>getRenderer().bindTexture(i, info.id);
        }
        this.<CubismRendererAndroid>getRenderer().isPremultipliedAlpha(true);
    }

    private void preloadMotionGroup(String group) {
        int count = modelSetting.getMotionCount(group);
        for (int i = 0; i < count; i++) {
            String file = modelSetting.getMotionFileName(group, i);
            if (file == null || file.isEmpty()) continue;
            byte[] buffer = AssetLoader.loadBytes(context, modelHomeDirectory + file);
            if (buffer.length == 0) continue;
            // 单文件容错（catch Throwable：debug 包 Java assert 是激活的）——部分工具导出的
            // motion3 缺曲线段类型标记，JS 框架静默吞（CSM_ASSERT 为 no-op），Java 会
            // AssertionError；坏一个动作不能杀整个模型，跳过即可（该组起播时静默失败）。
            CubismMotion motion;
            try {
                motion = loadMotion(buffer);
            } catch (Throwable t) {
                Log.w(TAG, "skip malformed motion: " + file + " (" + t + ")");
                continue;
            }
            if (motion == null) continue;

            float fadeIn = modelSetting.getMotionFadeInTimeValue(group, i);
            if (fadeIn != -1.0f) motion.setFadeInTime(fadeIn);
            float fadeOut = modelSetting.getMotionFadeOutTimeValue(group, i);
            if (fadeOut != -1.0f) motion.setFadeOutTime(fadeOut);

            // 待机循环与小动作拍统一 0.9s 双向淡化（对齐 live2dEngine 的 IDLE_BEAT_FADE_S）
            if (group.equals(idleMotionGroup) || idleBeatGroups.contains(group)) {
                motion.setFadeInTime(IDLE_FADE_SECONDS);
                motion.setFadeOutTime(IDLE_FADE_SECONDS);
            }
            // 小动作拍强制单遍：这批 motion3 文件 Meta 全标了 Loop=true，JS 端（pixi-live2d-display 0.4.0）
            // 不读该标志所以播一遍就回 idle；本框架读标志，循环动作永不 finished → 待机看门狗
            // 永远不再触发 → 抽到 cradle/swing 就一直左右摇（「不倒翁」实录根因）。只有 idle 主循环保留循环。
            motion.setLoop(group.equals(idleMotionGroup));
            motions.put(group + "_" + i, motion);
        }
    }

    /** GL 线程每帧调用。 */
    void update(float deltaSeconds) {
        if (model == null) return;

        model.loadParameters();
        if (motionManager.isFinished()) {
            maybeStartIdleOrBeat();
        } else {
            motionManager.updateMotion(model, deltaSeconds);
        }
        model.saveParameters();

        opacity = model.getModelOpacity();

        // 呼吸 + 朝向 + 物理（按 executionOrder 依次跑：LOOK 400 → BREATH 500 → PHYSICS 600；
        // 物理在角度参数写完后演算，驱动头发/裙摆等摆动）。pose/blink/expression 仍不注册。
        updateScheduler.onLateUpdate(model, deltaSeconds);

        applyOverlayTargets();
        applyHardWrites(persistentParams.get());
        applyHardWrites(mouthParams.get());

        model.update();
    }

    /** 待机恢复 + 小动作拍调度（对齐 ensureIdle/tickIdleBeat 的行为骨架）。 */
    private void maybeStartIdleOrBeat() {
        long now = System.currentTimeMillis();
        if (!idleBeatGroups.isEmpty() && now >= nextIdleBeatAtMs) {
            nextIdleBeatAtMs = now + randomGap();
            String group = idleBeatGroups.get(random.nextInt(idleBeatGroups.size()));
            if (startMotionByGroup(group, PRIORITY_NORMAL)) return;
        }
        if (idleMotionGroup != null) {
            startMotionByGroup(idleMotionGroup, PRIORITY_IDLE);
        }
    }

    private long randomGap() {
        return IDLE_BEAT_MIN_GAP_MS + (long) (random.nextFloat() * (IDLE_BEAT_MAX_GAP_MS - IDLE_BEAT_MIN_GAP_MS));
    }

    /** 任一线程可请求，实际起播须在 GL 线程（由 Renderer queueEvent 转发）。 */
    boolean startMotionByGroup(String group, int priority) {
        ACubismMotion motion = motions.get(group + "_0");
        if (motion == null) {
            Log.i(TAG, "motion not found: " + group);
            return false;
        }
        if (!motionManager.reserveMotion(priority)) return false;
        return motionManager.startMotionPriority(motion, priority) != -1;
    }

    // ---- 三通道参数状态（桥线程写） ----

    void setOverlayTargets(Map<String, Float> targets) {
        overlayTargets.set(targets);
    }

    void setPersistentParams(Map<String, Float> params) {
        persistentParams.set(params);
    }

    void setMouthParams(Map<String, Float> params) {
        mouthParams.set(params);
    }

    void setFocus(float x, float y) {
        // JS focusController 的 y 轴向下为正；Cubism dragManager 向上为正 → 取反。
        dragManager.set(clamp(x), clamp(-y));
    }

    private static float clamp(float v) {
        return Math.max(-1f, Math.min(1f, v));
    }

    // ---- overlay 平滑（镜像 live2dEngine.getOverlayFactor 分档 + easeTowards） ----

    private void applyOverlayTargets() {
        Map<String, Float> targets = overlayTargets.get();
        for (String id : targets.keySet()) ensureTracked(id);
        if (trackedParamIds.isEmpty()) return;

        for (String paramId : trackedParamIds) {
            Float baseline = baselineParams.get(paramId);
            float base = baseline != null ? baseline : 0f;
            Float explicit = targets.get(paramId);
            float target = explicit != null ? explicit : base;
            Float currentBoxed = overlayCurrent.get(paramId);
            float current = currentBoxed != null ? currentBoxed : base;

            float factor = overlayFactor(paramId, explicit != null);
            float next = Math.abs(target - current) <= 0.0005f ? target : current + (target - current) * factor;
            if (Float.isNaN(next) || Float.isInfinite(next)) continue;

            overlayCurrent.put(paramId, next);
            writeParam(paramId, next);
        }
    }

    private void ensureTracked(String paramId) {
        if (trackedParamIds.contains(paramId)) return;
        trackedParamIds.add(paramId);
        baselineParams.put(paramId, model.getParameterValue(cubismId(paramId)));
    }

    private static float overlayFactor(String paramId, boolean hasExplicitTarget) {
        if (paramId.equals("ParamEyeBallX") || paramId.equals("ParamEyeBallY")) {
            return hasExplicitTarget ? 0.24f : 0.16f;
        }
        if (paramId.startsWith("ParamAngle") || paramId.startsWith("ParamBodyAngle")) {
            return hasExplicitTarget ? 0.14f : 0.09f;
        }
        if (paramId.startsWith("ParamBrow") || paramId.startsWith("ParamCheek")) {
            return hasExplicitTarget ? 0.18f : 0.12f;
        }
        if (paramId.equals("ParamMouthOpenY")) {
            return hasExplicitTarget ? 0.22f : 0.14f;
        }
        if (paramId.equals("ParamMouthForm")) {
            return hasExplicitTarget ? 0.18f : 0.12f;
        }
        return hasExplicitTarget ? 0.16f : 0.1f;
    }

    private void applyHardWrites(Map<String, Float> params) {
        if (params.isEmpty()) return;
        for (Map.Entry<String, Float> entry : params.entrySet()) {
            Float value = entry.getValue();
            if (value == null || value.isNaN() || value.isInfinite()) continue;
            writeParam(entry.getKey(), value);
        }
    }

    private void writeParam(String paramId, float value) {
        model.setParameterValue(cubismId(paramId), value);
    }

    private CubismId cubismId(String paramId) {
        CubismId id = idCache.get(paramId);
        if (id == null) {
            id = CubismFramework.getIdManager().getId(paramId);
            idCache.put(paramId, id);
        }
        return id;
    }

    // ---- 绘制与元数据 ----

    void draw(CubismMatrix44 mvp) {
        if (model == null || getRenderer() == null) return;
        this.<CubismRendererAndroid>getRenderer().setMvpMatrix(mvp);
        this.<CubismRendererAndroid>getRenderer().drawModel();
    }

    boolean isLoaded() {
        return model != null;
    }

    float getCanvasWidthUnits() {
        return model != null ? model.getCanvasWidth() : 1f;
    }

    float getCanvasHeightUnits() {
        return model != null ? model.getCanvasHeight() : 1f;
    }

    float getCanvasWidthPixel() {
        return model != null ? model.getCanvasWidthPixel() : 1f;
    }

    float getCanvasHeightPixel() {
        return model != null ? model.getCanvasHeightPixel() : 1f;
    }

    /** 参数表（id/min/max/default），JS 拍平表情时当 baseline 用。 */
    List<float[]> snapshotParameterRanges(List<String> outIds) {
        List<float[]> ranges = new ArrayList<>();
        if (model == null) return ranges;
        int count = model.getParameterCount();
        for (int i = 0; i < count; i++) {
            outIds.add(model.getParameterId(i).getString());
            ranges.add(new float[]{
                model.getParameterMinimumValue(i),
                model.getParameterMaximumValue(i),
                model.getParameterDefaultValue(i),
            });
        }
        return ranges;
    }

    void release() {
        delete();
    }
}
