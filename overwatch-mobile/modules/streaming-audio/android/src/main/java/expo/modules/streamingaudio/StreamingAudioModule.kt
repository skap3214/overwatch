package expo.modules.streamingaudio

import android.content.Intent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class StreamingAudioModule : Module() {
    private var engine: StreamingAudioEngine? = null
    private var mediaController: StreamingMediaController? = null

    override fun definition() = ModuleDefinition {
        Name("StreamingAudio")

        Events("onChunkFinished", "onPlaybackStateChanged", "onRemoteCommand", "onError")

        Function("startSession") { config: Map<String, Any?> ->
            val sampleRate = (config["sampleRate"] as? Number)?.toInt() ?: 44100
            val channels = (config["channels"] as? Number)?.toInt() ?: 1
            val context = appContext.reactContext ?: return@Function

            engine?.stop()
            mediaController?.deregister()

            val newEngine = StreamingAudioEngine(sampleRate, channels)
            newEngine.onChunkFinished = {
                sendEvent("onChunkFinished", emptyMap<String, Any>())
            }
            newEngine.onError = { message ->
                sendEvent("onError", mapOf("message" to message))
            }
            newEngine.start()
            engine = newEngine

            val controller = StreamingMediaController(context)
            controller.onPlayCommand = {
                engine?.play()
                sendEvent("onPlaybackStateChanged", mapOf("isPlaying" to true))
                sendEvent("onRemoteCommand", mapOf("command" to "play"))
                refreshNotification(context)
            }
            controller.onPauseCommand = {
                engine?.pause()
                sendEvent("onPlaybackStateChanged", mapOf("isPlaying" to false))
                sendEvent("onRemoteCommand", mapOf("command" to "pause"))
                refreshNotification(context)
            }
            controller.onNextTrackCommand = {
                sendEvent("onRemoteCommand", mapOf("command" to "nextTrack"))
            }
            controller.onPreviousTrackCommand = {
                sendEvent("onRemoteCommand", mapOf("command" to "previousTrack"))
            }
            controller.register()
            mediaController = controller

            StreamingAudioService.activeSession = controller.getSession()

            try {
                val serviceIntent = Intent(context, StreamingAudioService::class.java)
                context.startForegroundService(serviceIntent)
            } catch (_: Exception) {}
        }

        Function("endSession") {
            engine?.stop()
            engine = null
            mediaController?.deregister()
            mediaController = null
            StreamingAudioService.activeSession = null

            val context = appContext.reactContext ?: return@Function null
            try {
                val serviceIntent = Intent(context, StreamingAudioService::class.java)
                context.stopService(serviceIntent)
            } catch (_: Exception) {}
        }

        Function("feedPCM") { pcmData: ByteArray ->
            val engine = engine ?: return@Function
            engine.feedPCM(pcmData)
        }

        Function("playFile") { uri: String ->
            val engine = engine ?: return@Function
            engine.playFile(uri)
        }

        Function("markEndOfStream") {
            engine?.markEndOfStream()
        }

        Function("play") {
            engine?.play()
            mediaController?.updatePlaybackState(true)
            sendEvent("onPlaybackStateChanged", mapOf("isPlaying" to true))
            val context = appContext.reactContext
            if (context != null) refreshNotification(context)
        }

        Function("pause") {
            engine?.pause()
            mediaController?.updatePlaybackState(false)
            sendEvent("onPlaybackStateChanged", mapOf("isPlaying" to false))
            val context = appContext.reactContext
            if (context != null) refreshNotification(context)
        }

        Function("flushAndReset") {
            engine?.flushAndReset()
        }

        Function("setRate") { rate: Double ->
            engine?.setRate(rate.toFloat())
        }

        Function("updateNowPlaying") { meta: Map<String, Any?> ->
            val title = meta["title"] as? String ?: "Read Aloud"
            val artist = meta["artist"] as? String ?: "YouLearn"

            StreamingAudioService.currentTitle = title
            StreamingAudioService.currentArtist = artist

            mediaController?.updateNowPlaying(
                title = title,
                artist = artist,
                artworkUrl = meta["artworkUrl"] as? String,
                durationSeconds = (meta["durationSeconds"] as? Number)?.toDouble(),
                elapsedSeconds = (meta["elapsedSeconds"] as? Number)?.toDouble(),
                rate = (meta["rate"] as? Number)?.toDouble()
            )

            val context = appContext.reactContext
            if (context != null) refreshNotification(context)
        }
    }

    private fun refreshNotification(context: android.content.Context) {
        try {
            val serviceIntent = Intent(context, StreamingAudioService::class.java)
            context.startService(serviceIntent)
        } catch (_: Exception) {}
    }
}
