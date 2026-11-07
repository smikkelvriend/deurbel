package nl.floyd.deurbel

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.app.DownloadManager
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import kotlin.concurrent.thread

class MainActivity : AppCompatActivity() {
    private lateinit var web: WebView
    private lateinit var root: FrameLayout
    private var fullscreenView: View? = null
    private var pendingPermission: PermissionRequest? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.BLACK
        window.navigationBarColor = Color.BLACK

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        web = WebView(this).apply { setBackgroundColor(Color.BLACK) }
        root.addView(web, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        setContentView(root)

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true)

        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            userAgentString = "$userAgentString DeurbelApp/${versionCode()}"
        }
        web.addJavascriptInterface(Bridge(), "DeurbelApp")

        web.webViewClient = object : WebViewClient() {
            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) showOffline(error.description?.toString() ?: "")
            }
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                val server = Prefs.server(this@MainActivity)
                // links buiten het dashboard in de gewone browser openen
                if (server.isNotEmpty() && !url.startsWith(server)) {
                    startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))); return true
                }
                return false
            }
            override fun onPageFinished(view: WebView, url: String) {
                CookieManager.getInstance().flush()
                DeurbelService.start(this@MainActivity) // cookie is nu bekend, dienst (her)verbinden
            }
        }

        web.webChromeClient = object : WebChromeClient() {
            // microfoon voor terugpraten
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread {
                    if (ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                        request.grant(request.resources)
                    } else {
                        pendingPermission = request
                        ActivityCompat.requestPermissions(this@MainActivity, arrayOf(Manifest.permission.RECORD_AUDIO), 2)
                    }
                }
            }
            // volledig scherm voor video
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                fullscreenView = view
                root.addView(view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                web.visibility = View.GONE
                window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            }
            override fun onHideCustomView() {
                fullscreenView?.let { root.removeView(it) }
                fullscreenView = null
                web.visibility = View.VISIBLE
                window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            }
        }

        // opnames en foto's opslaan
        web.setDownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            try {
                val name = URLUtil.guessFileName(url, contentDisposition, mimeType)
                val req = DownloadManager.Request(Uri.parse(url))
                    .addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    .addRequestHeader("User-Agent", userAgent)
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Deurbel/$name")
                (getSystemService(DOWNLOAD_SERVICE) as DownloadManager).enqueue(req)
                Toast.makeText(this, "Opslaan in Downloads/Deurbel…", Toast.LENGTH_SHORT).show()
            } catch (e: Exception) {
                Toast.makeText(this, "Opslaan mislukt: ${e.message}", Toast.LENGTH_LONG).show()
            }
        }

        askNotificationPermission()
        if (Prefs.server(this).isEmpty()) askServer(first = true) else openDashboard(intent)
        checkForUpdate(false)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        openDashboard(intent)
    }

    private fun openDashboard(i: Intent?) {
        val server = Prefs.server(this)
        if (server.isEmpty()) return
        val hash = i?.getStringExtra("hash") ?: ""
        val target = server + "/" + (if (hash.isNotEmpty()) "#$hash" else "")
        if (hash.isNotEmpty() && web.url?.startsWith(server) == true) {
            web.evaluateJavascript("location.hash='$hash'", null)
        } else {
            web.loadUrl(target)
        }
    }

    private fun showOffline(reason: String) {
        val server = Prefs.server(this)
        val html = """
            <html><body style="background:#000;color:#fff;font-family:monospace;padding:28px">
            <h2>DEURBEL</h2><p>De server is niet bereikbaar.</p>
            <p style="color:#888">$server<br>$reason</p>
            <p style="color:#888">Ben je thuis op wifi? Of buiten de deur: staat Tailscale aan?</p>
            <p><a style="color:#fff" href="javascript:DeurbelApp.reload()">↻ Opnieuw proberen</a></p>
            <p><a style="color:#fff" href="javascript:DeurbelApp.changeServer()">Server-adres wijzigen</a></p>
            </body></html>""".trimIndent()
        web.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }

    private fun askServer(first: Boolean) {
        val input = EditText(this).apply {
            setText(Prefs.server(this@MainActivity).ifEmpty { "http://192.168.0.236:8095" })
            setSelection(text.length)
        }
        AlertDialog.Builder(this)
            .setTitle(if (first) "Welkom bij Deurbel" else "Server-adres")
            .setMessage("Het adres van je Deurbel-server, bijvoorbeeld http://192.168.0.236:8095 of je Tailscale-adres (https://….ts.net).")
            .setView(input)
            .setCancelable(!first)
            .setPositiveButton("Opslaan") { _, _ ->
                var url = input.text.toString().trim()
                if (!url.startsWith("http")) url = "http://$url"
                Prefs.setServer(this, url)
                openDashboard(null)
                DeurbelService.restart(this)
            }
            .apply { if (!first) setNegativeButton("Annuleren", null) }
            .show()
    }

    private fun askNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 2) {
            val req = pendingPermission ?: return
            pendingPermission = null
            if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) req.grant(req.resources) else req.deny()
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when {
            fullscreenView != null -> web.webChromeClient?.onHideCustomView()
            web.canGoBack() -> web.goBack()
            else -> moveTaskToBack(true) // app op de achtergrond, meldingen blijven werken
        }
    }

    private fun versionCode(): Long =
        try { packageManager.getPackageInfo(packageName, 0).longVersionCode } catch (e: Exception) { 0 }

    /** Kijkt op GitHub of er een nieuwere APK is. */
    private fun checkForUpdate(manual: Boolean) {
        if (!manual && System.currentTimeMillis() - Prefs.lastUpdateCheck(this) < 6 * 3600_000L) return
        Prefs.setLastUpdateCheck(this, System.currentTimeMillis())
        thread {
            try {
                val c = URL("https://api.github.com/repos/smikkelvriend/deurbel/releases/tags/apk-latest").openConnection() as HttpURLConnection
                c.setRequestProperty("Accept", "application/vnd.github+json")
                c.connectTimeout = 10000; c.readTimeout = 10000
                val j = JSONObject(c.inputStream.bufferedReader().readText())
                val latest = Regex("versionCode:\\s*(\\d+)").find(j.optString("body"))?.groupValues?.get(1)?.toLongOrNull() ?: 0
                val assets = j.optJSONArray("assets")
                val apkUrl = if (assets != null && assets.length() > 0) assets.getJSONObject(0).optString("browser_download_url") else ""
                runOnUiThread {
                    if (latest > versionCode() && apkUrl.isNotEmpty()) {
                        AlertDialog.Builder(this)
                            .setTitle("Nieuwe versie van de app")
                            .setMessage("Versie 1.$latest staat klaar (jij hebt 1.${versionCode()}). Downloaden en installeren?")
                            .setPositiveButton("Downloaden") { _, _ -> startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(apkUrl))) }
                            .setNegativeButton("Later", null).show()
                    } else if (manual) Toast.makeText(this, "Je hebt de nieuwste versie (1.${versionCode()})", Toast.LENGTH_SHORT).show()
                }
            } catch (e: Exception) {
                if (manual) runOnUiThread { Toast.makeText(this, "Kon niet controleren: ${e.message}", Toast.LENGTH_SHORT).show() }
            }
        }
    }

    /** Functies die het dashboard kan aanroepen (window.DeurbelApp). */
    inner class Bridge {
        @JavascriptInterface fun version(): String = "1.${versionCode()}"
        @JavascriptInterface fun changeServer() = runOnUiThread { askServer(first = false) }
        @JavascriptInterface fun reload() = runOnUiThread { openDashboard(null) }
        @JavascriptInterface fun checkUpdate() = runOnUiThread { checkForUpdate(true) }
        @JavascriptInterface fun serviceOn(): Boolean = Prefs.serviceOn(this@MainActivity)
        @JavascriptInterface fun setServiceOn(on: Boolean) = runOnUiThread {
            Prefs.setServiceOn(this@MainActivity, on)
            if (on) DeurbelService.start(this@MainActivity) else DeurbelService.stop(this@MainActivity)
        }
        @JavascriptInterface fun openNotificationSettings() = runOnUiThread {
            startActivity(Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, packageName))
        }
        @SuppressLint("BatteryLife")
        @JavascriptInterface fun askBatteryExemption() = runOnUiThread {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            if (pm.isIgnoringBatteryOptimizations(packageName)) {
                Toast.makeText(this@MainActivity, "Staat al goed", Toast.LENGTH_SHORT).show()
            } else {
                startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
            }
        }
    }
}
