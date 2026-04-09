package expo.modules.streamingaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Build
import android.os.IBinder
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat as MediaNotificationCompat

class StreamingAudioService : Service() {
    companion object {
        const val CHANNEL_ID = "streaming_audio_playback"
        const val NOTIFICATION_ID = 9473
        const val ACTION_PLAY = "expo.modules.streamingaudio.PLAY"
        const val ACTION_PAUSE = "expo.modules.streamingaudio.PAUSE"
        const val ACTION_NEXT = "expo.modules.streamingaudio.NEXT"
        const val ACTION_PREV = "expo.modules.streamingaudio.PREV"
        var activeSession: MediaSessionCompat? = null
        var currentTitle: String = "Read Aloud"
        var currentArtist: String = "YouLearn"
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PLAY -> activeSession?.controller?.transportControls?.play()
            ACTION_PAUSE -> activeSession?.controller?.transportControls?.pause()
            ACTION_NEXT -> activeSession?.controller?.transportControls?.skipToNext()
            ACTION_PREV -> activeSession?.controller?.transportControls?.skipToPrevious()
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_STICKY
    }

    override fun onDestroy() {
        activeSession = null
        super.onDestroy()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Audio Playback",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Read aloud audio playback"
                setShowBadge(false)
            }
            val manager = getSystemService(NotificationManager::class.java)
            manager?.createNotificationChannel(channel)
        }
    }

    private fun buildNotification(): Notification {
        val session = activeSession

        val builder = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(currentTitle)
            .setContentText(currentArtist)
            .setOngoing(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)

        if (session != null) {
            val style = MediaNotificationCompat.MediaStyle()
                .setMediaSession(session.sessionToken)
                .setShowActionsInCompactView(0, 1, 2)
            builder.setStyle(style)

            builder.addAction(android.R.drawable.ic_media_previous, "Previous",
                buildActionIntent(ACTION_PREV, 0))

            val isPlaying = session.controller?.playbackState?.state == PlaybackStateCompat.STATE_PLAYING
            if (isPlaying) {
                builder.addAction(android.R.drawable.ic_media_pause, "Pause",
                    buildActionIntent(ACTION_PAUSE, 1))
            } else {
                builder.addAction(android.R.drawable.ic_media_play, "Play",
                    buildActionIntent(ACTION_PLAY, 1))
            }

            builder.addAction(android.R.drawable.ic_media_next, "Next",
                buildActionIntent(ACTION_NEXT, 2))
        }

        return builder.build()
    }

    private fun buildActionIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, StreamingAudioService::class.java).apply {
            this.action = action
        }
        return PendingIntent.getForegroundService(
            this, requestCode, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
    }
}
