package nl.floyd.deurbel

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.BitmapFactory
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.webkit.CookieManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.concurrent.thread

/**
 * Houdt een verbinding open met de Deurbel-server (zoals ntfy dat doet) en laat
 * meteen een melding zien bij aanbellen, personen, pakketten of beweging.
 * Geen Google/Firebase en geen ntfy nodig.
 */
class DeurbelService : Service() {
    @Volatile private var running = false
    @Volatile private var conn: HttpURLConnection? = null
    private var worker: Thread? = null
    private var wakeLock: PowerManager.WakeLock? = null
    private val shown = HashMap<String, Int>() // gebeurtenis-id -> meldings-id

    companion object {
        const val CH_RING = "ring"
        const val CH_EVENT = "events"
        const val CH_SERVICE = "service"
        private const val ID_SERVICE = 1

        fun start(c: Context) {
            if (!Prefs.serviceOn(c) || Prefs.server(c).isEmpty()) return
            try { ContextCompat.startForegroundService(c, Intent(c, DeurbelService::class.java)) } catch (_: Exception) {}
        }
        fun stop(c: Context) { c.stopService(Intent(c, DeurbelService::class.java)) }
        fun restart(c: Context) { stop(c); start(c) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = NotificationCompat.Builder(this, CH_SERVICE)
            .setSmallIcon(R.drawable.ic_bell)
            .setContentTitle("Deurbel luistert mee")
            .setContentText("Je krijgt meteen een melding als er wordt aangebeld")
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(openApp(""))
            .build()
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID_SERVICE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        else startForeground(ID_SERVICE, n)
        if (!running) {
            running = true
            worker = thread(name = "deurbel-stream") { loop() }
        } else {
            conn?.disconnect() // opnieuw verbinden met (mogelijk) nieuwe cookie/server
        }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        conn?.disconnect()
        worker?.interrupt()
        super.onDestroy()
    }

    private fun loop() {
        var wait = 2000L
        while (running) {
            val server = Prefs.server(this)
            try {
                val c = URL("$server/api/stream").openConnection() as HttpURLConnection
                conn = c
                c.setRequestProperty("Accept", "text/event-stream")
                c.setRequestProperty("Cookie", CookieManager.getInstance().getCookie(server) ?: "")
                c.connectTimeout = 15000
                c.readTimeout = 90000 // server stuurt elke 25 s een ping
                if (c.responseCode == 401) { Thread.sleep(60000); continue } // nog niet ingelogd in de app
                wait = 2000L
                c.inputStream.bufferedReader().use { r ->
                    while (running) {
                        val line = r.readLine() ?: break
                        if (line.startsWith("data: ")) handle(line.substring(6))
                    }
                }
            } catch (_: InterruptedException) {
                return
            } catch (_: Exception) {
                // geen verbinding (niet thuis, server weg): straks opnieuw
            }
            try { Thread.sleep(wait) } catch (_: InterruptedException) { return }
            wait = (wait * 2).coerceAtMost(60000L)
        }
    }

    private fun handle(data: String) {
        val msg = try { JSONObject(data) } catch (_: Exception) { return }
        when (msg.optString("type")) {
            "event" -> {
                val ev = msg.optJSONObject("event") ?: return
                if (ev.has("push") && !ev.optBoolean("push")) return // server zegt: geen melding (rustige uren, gepauzeerd, …)
                if (System.currentTimeMillis() - ev.optLong("time") > 120000) return
                notifyEvent(ev, null)
            }
            "event-update" -> {
                val ev = msg.optJSONObject("event") ?: return
                val snap = ev.optString("snapshot")
                if (snap.isNotEmpty() && shown.containsKey(ev.optString("id"))) {
                    val bmp = fetchImage("/api/snapshot/$snap")
                    if (bmp != null) notifyEvent(ev, bmp)
                }
            }
        }
    }

    private fun fetchImage(path: String): android.graphics.Bitmap? = try {
        val server = Prefs.server(this)
        val c = URL(server + path).openConnection() as HttpURLConnection
        c.setRequestProperty("Cookie", CookieManager.getInstance().getCookie(server) ?: "")
        c.connectTimeout = 10000; c.readTimeout = 15000
        c.inputStream.use { BitmapFactory.decodeStream(it) }
    } catch (_: Exception) { null }

    private fun notifyEvent(ev: JSONObject, picture: android.graphics.Bitmap?) {
        val kind = ev.optString("kind")
        val id = ev.optString("id")
        val title = when (kind) {
            "ring" -> "Er wordt aangebeld"
            "person" -> "Persoon bij de deur"
            "package" -> "Pakket bij de deur"
            else -> "Beweging"
        }
        val time = SimpleDateFormat("HH:mm", Locale("nl")).format(Date(ev.optLong("time")))
        val text = "${ev.optString("device")} · $time" + (ev.optString("detail").takeIf { it.isNotEmpty() }?.let { " · $it" } ?: "")
        val nid = shown.getOrPut(id) { (System.currentTimeMillis() % 100000).toInt() + 10 }
        val serial = ev.optString("serial")
        val b = NotificationCompat.Builder(this, if (kind == "ring") CH_RING else CH_EVENT)
            .setSmallIcon(R.drawable.ic_bell)
            .setContentTitle(title)
            .setContentText(text)
            .setAutoCancel(true)
            .setOnlyAlertOnce(picture != null) // foto erbij = geen tweede geluid
            .setCategory(if (kind == "ring") NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_EVENT)
            .setPriority(if (kind == "ring") NotificationCompat.PRIORITY_MAX else NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(openApp("live=$serial"))
            .addAction(0, "Live bekijken", openApp("live=$serial"))
        if (picture != null) {
            b.setLargeIcon(picture).setStyle(NotificationCompat.BigPictureStyle().bigPicture(picture).bigLargeIcon(null as android.graphics.Bitmap?))
        }
        if (kind == "ring") wake()
        (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).notify(nid, b.build())
        if (shown.size > 50) shown.keys.take(25).forEach { shown.remove(it) }
    }

    private fun wake() {
        try {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            @Suppress("DEPRECATION")
            wakeLock = pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "deurbel:ring").apply { acquire(5000) }
        } catch (_: Exception) {}
    }

    private fun openApp(hash: String): PendingIntent {
        val i = Intent(this, MainActivity::class.java).putExtra("hash", hash).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(this, hash.hashCode(), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun createChannels() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        val ring = NotificationChannel(CH_RING, "Aanbellen", NotificationManager.IMPORTANCE_HIGH).apply {
            description = "Iemand belt aan"
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 400, 200, 400)
            setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).build())
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        }
        val ev = NotificationChannel(CH_EVENT, "Personen, pakketten en beweging", NotificationManager.IMPORTANCE_DEFAULT)
        val svc = NotificationChannel(CH_SERVICE, "Achtergrondverbinding", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Nodig om meldingen direct te ontvangen. Je kunt deze melding verbergen."
            setShowBadge(false)
        }
        nm.createNotificationChannels(listOf(ring, ev, svc))
    }
}
