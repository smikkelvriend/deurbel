package nl.floyd.deurbel

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Na het opstarten van de telefoon (of na een app-update) de meldingendienst weer starten. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        DeurbelService.start(context)
    }
}
