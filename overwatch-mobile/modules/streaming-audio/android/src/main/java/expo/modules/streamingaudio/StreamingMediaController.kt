package expo.modules.streamingaudio

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import java.net.URL

class StreamingMediaController(private val context: Context) {
    private var mediaSession: MediaSessionCompat? = null

    var onPlayCommand: (() -> Unit)? = null
    var onPauseCommand: (() -> Unit)? = null
    var onNextTrackCommand: (() -> Unit)? = null
    var onPreviousTrackCommand: (() -> Unit)? = null

    fun register() {
        val session = MediaSessionCompat(context, "StreamingAudio")
        session.setCallback(object : MediaSessionCompat.Callback() {
            override fun onPlay() {
                onPlayCommand?.invoke()
            }
            override fun onPause() {
                onPauseCommand?.invoke()
            }
            override fun onSkipToNext() {
                onNextTrackCommand?.invoke()
            }
            override fun onSkipToPrevious() {
                onPreviousTrackCommand?.invoke()
            }
        })
        session.isActive = true
        mediaSession = session

        updatePlaybackState(true)
    }

    fun deregister() {
        mediaSession?.isActive = false
        mediaSession?.release()
        mediaSession = null
    }

    fun getSession(): MediaSessionCompat? = mediaSession

    fun updateNowPlaying(
        title: String,
        artist: String,
        artworkUrl: String?,
        durationSeconds: Double?,
        elapsedSeconds: Double?,
        rate: Double?
    ) {
        val session = mediaSession ?: return

        val builder = MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)

        if (durationSeconds != null) {
            builder.putLong(
                MediaMetadataCompat.METADATA_KEY_DURATION,
                (durationSeconds * 1000).toLong()
            )
        }

        session.setMetadata(builder.build())

        updatePlaybackState(
            isPlaying = rate != null && rate > 0,
            position = ((elapsedSeconds ?: 0.0) * 1000).toLong(),
            speed = rate?.toFloat() ?: 1.0f
        )

        if (artworkUrl != null) {
            loadArtworkAsync(artworkUrl)
        }
    }

    fun updatePlaybackState(isPlaying: Boolean, position: Long = 0, speed: Float = 1.0f) {
        val session = mediaSession ?: return
        val state = if (isPlaying) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED
        val stateBuilder = PlaybackStateCompat.Builder()
            .setActions(
                PlaybackStateCompat.ACTION_PLAY or
                PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS
            )
            .setState(state, position, speed)
        session.setPlaybackState(stateBuilder.build())
    }

    private fun loadArtworkAsync(urlString: String) {
        Thread {
            try {
                val url = URL(urlString)
                val bitmap = BitmapFactory.decodeStream(url.openStream())
                if (bitmap != null) {
                    val session = mediaSession ?: return@Thread
                    val currentMetadata = session.controller?.metadata
                    val builder = MediaMetadataCompat.Builder(currentMetadata)
                        .putBitmap(MediaMetadataCompat.METADATA_KEY_ART, bitmap)
                    session.setMetadata(builder.build())
                }
            } catch (_: Exception) {}
        }.start()
    }
}
