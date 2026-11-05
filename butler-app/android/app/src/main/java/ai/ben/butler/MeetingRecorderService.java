package ai.ben.butler;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaRecorder;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;

/**
 * 会议录音的**前台服务**(2026-09-21)。
 *
 * <p>为什么非要一个服务:Ben 要的是「开会时手机录音」—— 开会的人会把手机扣在桌上、屏幕会灭。
 * Android 一旦锁屏就会冻住 WebView 里的 {@code MediaRecorder},录出来的是一段残片。
 * 只有挂着一条常驻通知的前台服务(类型 {@code microphone})才会被系统当成"还在替用户干活"而不冻。
 *
 * <p>录的是 <b>AAC / MPEG_4(.m4a)</b>:体积是 wav 的二十分之一,而且 macOS 自带的 {@code afconvert}
 * 就解得开它(电脑那侧 server/meeting.ts 的解码兜底),不必要求 Ben 先装 ffmpeg。
 *
 * <p><b>每到 segmentMs 就换一个文件</b>:stop 当前这个、立刻 start 下一个。
 * 这样每一段都是**各自完整**的 m4a(m4a 的 moov 在文件末尾,不停就写不出来),
 * 掉电或者被杀最多丢正在录的那一段,而不是整场。
 *
 * <p><b>一个字节都不删</b>:这个文件里没有任何 delete。录完的段留在 App 的文件目录里,
 * 传给电脑之后也不删 —— 传丢了还能手动补(交接第三节)。
 */
public class MeetingRecorderService extends Service {

    public static final String ACTION_START = "ai.ben.butler.meeting.START";
    public static final String ACTION_PAUSE = "ai.ben.butler.meeting.PAUSE";
    public static final String ACTION_RESUME = "ai.ben.butler.meeting.RESUME";
    public static final String ACTION_STOP = "ai.ben.butler.meeting.STOP";

    public static final String EXTRA_DIR = "dir";
    public static final String EXTRA_SEGMENT_MS = "segmentMs";

    private static final String TAG = "MeetingRecorder";
    private static final String CHANNEL_ID = "meeting-recording";
    private static final int NOTIFICATION_ID = 0x4D45; // 'ME'
    /** 录音格式。和网页那一侧挑的 mimeType 对齐(见 src/meeting/recorder.ts)。 */
    private static final String MIME_TYPE = "audio/mp4";
    private static final int SAMPLE_RATE = 44100;
    private static final int BIT_RATE = 64000;

    /** 一段录完了 / 出事了,说给插件听。 */
    public interface Listener {
        void onSegment(int seq, String path, long ms, String mimeType);
        void onError(String message);
    }

    /**
     * 唯一的那个监听者。**静态**:这个 App 只有一个 Activity、一次只开一场会,
     * 而服务与插件之间为了一条回调去搭一整套 binder 不值当。插件在 start 之前挂上、stop 之后摘掉。
     */
    private static volatile Listener listener;

    public static void setListener(Listener value) {
        listener = value;
    }

    /** 此刻的音量(0~1)。界面那根电平条读它;没在录就是 0。 */
    private static volatile float level = 0f;

    public static float currentLevel() {
        return level;
    }

    /**
     * 此刻在不在录(2026-10-09)。插件的 {@code status()} 读这几格:App 被划掉又重开时,网页据此接回这一场。
     * 服务一 onDestroy 就清零 —— 进程被杀时整个进程都没了,这几格自然也没了(那时网页按「录到一半断了」收尾)。
     */
    private static volatile boolean recordingNow = false;
    private static volatile boolean pausedNow = false;
    private static volatile int seqNow = 0;
    private static volatile String dirNow = null;

    public static boolean isRecording() { return recordingNow; }
    public static boolean isPaused() { return pausedNow; }
    public static int currentSeq() { return seqNow; }
    public static String currentDir() { return dirNow; }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private MediaRecorder recorder;
    private File dir;
    private long segmentMs = 10 * 60 * 1000L;
    private int seq = 0;
    private long segmentStartedAt = 0L;
    private boolean paused = false;
    private File currentFile;

    private final Runnable rotate = new Runnable() {
        @Override
        public void run() {
            rotateSegment();
        }
    };

    private final Runnable meter = new Runnable() {
        @Override
        public void run() {
            MediaRecorder active = recorder;
            if (active != null && !paused) {
                try {
                    // getMaxAmplitude 的量程是 0~32767。开方之后那根条才看得出动静(同网页那一侧的做法)。
                    level = Math.min(1f, (float) Math.sqrt(active.getMaxAmplitude() / 32767.0));
                } catch (Exception ignored) {
                    level = 0f;
                }
            } else {
                level = 0f;
            }
            handler.postDelayed(this, 150);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (ACTION_START.equals(action)) {
            String path = intent.getStringExtra(EXTRA_DIR);
            long requested = intent.getLongExtra(EXTRA_SEGMENT_MS, segmentMs);
            // 一段太短会把一次会切成几百个文件,太长又失去了"掉电只丢一段"的意义。
            segmentMs = Math.max(5_000L, Math.min(requested, 60 * 60 * 1000L));
            dir = path == null ? new File(getFilesDir(), "meetings") : new File(path);
            if (!dir.exists() && !dir.mkdirs()) {
                fail("录音目录建不出来:" + dir.getAbsolutePath());
                stopSelf();
                return START_NOT_STICKY;
            }
            startInForeground();
            seq = 0;
            paused = false;
            if (startSegment()) {
                recordingNow = true;
                pausedNow = false;
                dirNow = dir.getAbsolutePath();
                handler.postDelayed(rotate, segmentMs);
                handler.post(meter);
            } else {
                stopSelf();
            }
        } else if (ACTION_PAUSE.equals(action)) {
            pauseSegment();
        } else if (ACTION_RESUME.equals(action)) {
            resumeSegment();
        } else if (ACTION_STOP.equals(action)) {
            finishAll();
            recordingNow = false;
            pausedNow = false;
            stopSelf();
        }
        // START_NOT_STICKY:被系统杀掉之后**不要**自己悄悄重启一个空的录音服务 ——
        // 那会留下一条谁也没要的常驻通知,而且录的是一场已经结束的会。
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        handler.removeCallbacks(rotate);
        handler.removeCallbacks(meter);
        finishAll();
        level = 0f;
        recordingNow = false;
        pausedNow = false;
        dirNow = null;
        super.onDestroy();
    }

    private void startInForeground() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "会议录音", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("开会时在后台录音");
            channel.setShowBadge(false);
            manager.createNotificationChannel(channel);
        }
        Intent open = new Intent(this, MainActivity.class);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int pendingFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) pendingFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, pendingFlags);

        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Notification.Builder(this, CHANNEL_ID)
            : new Notification.Builder(this);
        Notification notification = builder
            .setContentTitle("事务官正在录这场会")
            .setContentText("屏幕可以关。点一下回到会议页。")
            .setSmallIcon(android.R.drawable.presence_audio_online)
            .setOngoing(true)
            .setContentIntent(tap)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private boolean startSegment() {
        int next = seq + 1;
        File target = new File(dir, String.format(java.util.Locale.US, "%02d.m4a", next));
        MediaRecorder made = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S
            ? new MediaRecorder(this)
            : new MediaRecorder();
        try {
            made.setAudioSource(MediaRecorder.AudioSource.MIC);
            made.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4);
            made.setAudioEncoder(MediaRecorder.AudioEncoder.AAC);
            made.setAudioChannels(1);
            made.setAudioSamplingRate(SAMPLE_RATE);
            made.setAudioEncodingBitRate(BIT_RATE);
            made.setOutputFile(target.getAbsolutePath());
            made.prepare();
            made.start();
        } catch (Exception error) {
            Log.w(TAG, "起不了这一段", error);
            try { made.release(); } catch (Exception ignored) { }
            fail("录音起不来:" + (error.getMessage() == null ? error.getClass().getSimpleName() : error.getMessage()));
            return false;
        }
        recorder = made;
        currentFile = target;
        seq = next;
        seqNow = next;
        segmentStartedAt = SystemClock.elapsedRealtime();
        return true;
    }

    /** 收掉当前这一段并把它报上去。返回它录了多久。 */
    private long stopSegment() {
        MediaRecorder active = recorder;
        recorder = null;
        level = 0f;
        if (active == null) return 0L;
        long ms = SystemClock.elapsedRealtime() - segmentStartedAt;
        try {
            active.stop();
        } catch (Exception error) {
            // stop 抛了通常是"这一段太短,还没写出一帧"。文件可能是空的,**但不删** —— 报上去,
            // 电脑那侧会说"这一段解不开",人至少知道发生过什么。
            Log.w(TAG, "这一段收不干净", error);
        }
        try { active.release(); } catch (Exception ignored) { }
        File file = currentFile;
        currentFile = null;
        if (file != null && file.exists() && file.length() > 0) {
            Listener at = listener;
            if (at != null) at.onSegment(seq, file.getAbsolutePath(), ms, MIME_TYPE);
        }
        return ms;
    }

    private void rotateSegment() {
        if (paused) { handler.postDelayed(rotate, segmentMs); return; }
        stopSegment();
        if (startSegment()) handler.postDelayed(rotate, segmentMs);
    }

    private void pauseSegment() {
        if (paused) return;
        paused = true;
        pausedNow = true;
        handler.removeCallbacks(rotate);
        // **不用 MediaRecorder.pause()**(API 24 才有,而且各家实现差异很大):
        // 直接把这一段收掉。继续时开新的一段 —— 分段本来就是这套东西的单位。
        stopSegment();
    }

    private void resumeSegment() {
        if (!paused) return;
        paused = false;
        pausedNow = false;
        if (startSegment()) handler.postDelayed(rotate, segmentMs);
    }

    private void finishAll() {
        handler.removeCallbacks(rotate);
        handler.removeCallbacks(meter);
        stopSegment();
        paused = false;
    }

    private void fail(String message) {
        Listener at = listener;
        if (at != null) at.onError(message);
    }
}
