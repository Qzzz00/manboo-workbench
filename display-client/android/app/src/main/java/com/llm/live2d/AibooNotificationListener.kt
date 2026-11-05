package com.llm.live2d

import android.app.Notification
import android.content.pm.PackageManager
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

/**
 * 监听系统通知，维护一份最近通知的 JSON 快照供屏保读取。
 *
 * 需要用户在「设置 > 通知 > 设备和应用通知（通知使用权）」里手动授予访问权限
 * （特殊权限，无法用运行时弹窗申请）。未授予时本服务不会被系统绑定，快照保持 "[]"。
 */
class AibooNotificationListener : NotificationListenerService() {

    override fun onListenerConnected() {
        super.onListenerConnected()
        refresh()
    }

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        refresh()
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        refresh()
    }

    private fun refresh() {
        try {
            latestJson = buildJson(activeNotifications, packageManager)
        } catch (_: Throwable) {
            // 通知访问被收回等场景：保持上一份快照，绝不崩
        }
    }

    companion object {
        private const val MAX_ITEMS = 8

        @Volatile
        private var latestJson: String = "[]"

        /** 供 ScreensaverBridge 读取的最近通知快照。 */
        fun snapshotJson(): String = latestJson

        private fun buildJson(
            notifications: Array<StatusBarNotification>?,
            pm: PackageManager,
        ): String {
            val arr = JSONArray()
            if (notifications == null) return "[]"

            // 最新在前
            val sorted = notifications.sortedByDescending { it.postTime }
            for (sbn in sorted) {
                if (arr.length() >= MAX_ITEMS) break
                val n = sbn.notification ?: continue

                // 过滤：常驻/进行中（如下载）、分组摘要
                if ((n.flags and Notification.FLAG_ONGOING_EVENT) != 0) continue
                if ((n.flags and Notification.FLAG_GROUP_SUMMARY) != 0) continue

                val extras = n.extras ?: continue

                // 过滤媒体播放类通知（音乐/播客）——音乐归 AI DJ/音乐播放器区，消息通知只放真消息
                if (extras.containsKey(Notification.EXTRA_MEDIA_SESSION)) continue
                val template = extras.getString(Notification.EXTRA_TEMPLATE)
                if (template != null && template.contains("MediaStyle")) continue
                val title = extras.getCharSequence(Notification.EXTRA_TITLE)?.toString()?.trim().orEmpty()
                val text = extras.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.trim().orEmpty()
                if (title.isEmpty() && text.isEmpty()) continue

                val appLabel = appLabelOf(pm, sbn.packageName)

                val obj = JSONObject()
                obj.put("key", sbn.key ?: "${sbn.packageName}-${sbn.postTime}")
                obj.put("pkg", sbn.packageName)
                obj.put("appLabel", appLabel)
                obj.put("title", title)
                obj.put("text", text)
                obj.put("postTime", sbn.postTime)
                arr.put(obj)
            }
            return arr.toString()
        }

        private fun appLabelOf(pm: PackageManager, pkg: String): String {
            return try {
                val ai = pm.getApplicationInfo(pkg, 0)
                pm.getApplicationLabel(ai).toString()
            } catch (_: Throwable) {
                pkg
            }
        }
    }
}
