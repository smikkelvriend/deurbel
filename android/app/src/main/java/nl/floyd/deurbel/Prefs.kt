package nl.floyd.deurbel

import android.content.Context

/** Kleine opslag voor de instellingen van de app zelf. */
object Prefs {
    private fun p(c: Context) = c.getSharedPreferences("deurbel", Context.MODE_PRIVATE)

    fun server(c: Context): String = p(c).getString("server", "") ?: ""
    fun setServer(c: Context, url: String) = p(c).edit().putString("server", url.trim().trimEnd('/')).apply()

    fun serviceOn(c: Context): Boolean = p(c).getBoolean("service", true)
    fun setServiceOn(c: Context, on: Boolean) = p(c).edit().putBoolean("service", on).apply()

    fun lastUpdateCheck(c: Context): Long = p(c).getLong("updCheck", 0)
    fun setLastUpdateCheck(c: Context, t: Long) = p(c).edit().putLong("updCheck", t).apply()
}
