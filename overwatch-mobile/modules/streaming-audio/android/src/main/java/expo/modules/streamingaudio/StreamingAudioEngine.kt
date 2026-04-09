package expo.modules.streamingaudio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioTrack
import android.media.MediaPlayer
import android.media.PlaybackParams
import android.os.Handler
import android.os.HandlerThread
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/**
 * Hybrid audio engine:
 * - FILE mode: Uses MediaPlayer for playFile() — reliable completion callback,
 *   pause/resume, screen-off, and speed control handled natively.
 * - STREAMING mode: Uses AudioTrack for feedPCM() — raw PCM streaming with
 *   playback-head polling for completion detection.
 */
class StreamingAudioEngine(
    private val sampleRate: Int,
    private val channels: Int
) {
    companion object {
        private const val TAG = "StreamAudio"
    }

    private enum class Mode { NONE, FILE, STREAMING }

    // --- Shared state ---
    private var writerThread: HandlerThread? = null
    private var writerHandler: Handler? = null
    private val isPaused = AtomicBoolean(false)
    @Volatile private var active = false
    @Volatile private var currentRate: Float = 1.0f
    @Volatile private var currentMode = Mode.NONE

    var onChunkFinished: (() -> Unit)? = null
    var onError: ((String) -> Unit)? = null

    // --- FILE mode (MediaPlayer) ---
    @Volatile private var mediaPlayer: MediaPlayer? = null
    private val fileCompletionPending = AtomicBoolean(false)

    // --- STREAMING mode (AudioTrack) ---
    private var audioTrack: AudioTrack? = null
    private val endOfStreamMarked = AtomicBoolean(false)
    private val pendingWriteCount = AtomicInteger(0)
    private val pendingBuffers = mutableListOf<ByteArray>()
    private val bufferLock = Any()
    private val writeGeneration = AtomicInteger(0)
    @Volatile private var totalFramesWritten = 0L
    @Volatile private var headAtChunkStart = 0
    private val pollGeneration = AtomicInteger(0)
    private val playGeneration = AtomicInteger(0)

    fun start() {
        val channelConfig = if (channels == 1)
            AudioFormat.CHANNEL_OUT_MONO
        else
            AudioFormat.CHANNEL_OUT_STEREO

        val minBufSize = AudioTrack.getMinBufferSize(
            sampleRate, channelConfig, AudioFormat.ENCODING_PCM_16BIT
        )

        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()

        val format = AudioFormat.Builder()
            .setSampleRate(sampleRate)
            .setChannelMask(channelConfig)
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .build()

        audioTrack = AudioTrack(
            attributes, format, minBufSize * 4,
            AudioTrack.MODE_STREAM, AudioManager.AUDIO_SESSION_ID_GENERATE
        )

        val thread = HandlerThread("StreamingAudioWriter")
        thread.start()
        writerThread = thread
        writerHandler = Handler(thread.looper)

        audioTrack?.play()
        active = true
        headAtChunkStart = audioTrack?.playbackHeadPosition ?: 0
        Log.d(TAG, "start()")
    }

    // ========================
    // FILE mode (MediaPlayer)
    // ========================

    fun playFile(uri: String) {
        if (!active) return

        val path = if (uri.startsWith("file://")) uri.removePrefix("file://") else uri
        Log.d(TAG, "playFile: path=$path isPaused=${isPaused.get()}")

        releaseMediaPlayer()
        resetStreamingState()
        currentMode = Mode.FILE

        try {
            val mp = MediaPlayer()
            mp.setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .build()
            )
            mp.setDataSource(path)

            mp.setOnCompletionListener {
                if (isPaused.get()) {
                    Log.d(TAG, "MediaPlayer onCompletion while paused — deferring")
                    fileCompletionPending.set(true)
                } else {
                    Log.d(TAG, "MediaPlayer onCompletion — firing")
                    fireChunkFinished()
                }
            }

            mp.setOnErrorListener { _, what, extra ->
                Log.e(TAG, "MediaPlayer error: what=$what extra=$extra")
                onError?.invoke("MediaPlayer error: what=$what extra=$extra")
                true
            }

            mp.prepare()

            if (currentRate != 1.0f) {
                try {
                    mp.playbackParams = PlaybackParams().setSpeed(currentRate).setPitch(1.0f)
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to set rate on MediaPlayer: ${e.message}")
                }
            }

            mediaPlayer = mp

            if (!isPaused.get()) {
                mp.start()
                Log.d(TAG, "playFile: started")
            } else {
                Log.d(TAG, "playFile: prepared, waiting for play()")
            }
        } catch (e: Exception) {
            Log.e(TAG, "playFile failed: ${e.message}")
            onError?.invoke("Failed to play file: ${e.message}")
            currentMode = Mode.NONE
        }
    }

    // ========================
    // STREAMING mode (AudioTrack)
    // ========================

    fun feedPCM(data: ByteArray) {
        if (!active) return

        if (currentMode == Mode.FILE) {
            releaseMediaPlayer()
        }
        currentMode = Mode.STREAMING

        if (isPaused.get()) {
            synchronized(bufferLock) {
                pendingBuffers.add(data)
            }
            return
        }

        writeToTrack(data)
    }

    fun markEndOfStream() {
        endOfStreamMarked.set(true)
        val hasPending = synchronized(bufferLock) { pendingBuffers.isNotEmpty() }
        val pending = pendingWriteCount.get()
        Log.d(TAG, "markEndOfStream: pendingWrites=$pending hasPendingBuffers=$hasPending totalFrames=$totalFramesWritten")
        if (pending == 0 && !hasPending) {
            startPlaybackPoll()
        }
    }

    // ========================
    // Shared controls
    // ========================

    fun play() {
        Log.d(TAG, "play() mode=$currentMode isPaused=${isPaused.get()} completionPending=${fileCompletionPending.get()}")
        isPaused.set(false)

        when (currentMode) {
            Mode.FILE -> {
                if (fileCompletionPending.compareAndSet(true, false)) {
                    Log.d(TAG, "play() FILE: deferred completion — firing now")
                    fireChunkFinished()
                    return
                }
                try {
                    mediaPlayer?.start()
                } catch (e: Exception) {
                    Log.e(TAG, "MediaPlayer start failed: ${e.message}")
                    onError?.invoke("MediaPlayer start failed: ${e.message}")
                }
            }
            Mode.STREAMING -> {
                playGeneration.incrementAndGet()
                audioTrack?.play()

                val buffersToWrite: List<ByteArray>
                synchronized(bufferLock) {
                    buffersToWrite = pendingBuffers.toList()
                    pendingBuffers.clear()
                }
                if (buffersToWrite.isNotEmpty()) {
                    Log.d(TAG, "play() draining ${buffersToWrite.size} pending buffers")
                }
                for (buf in buffersToWrite) {
                    writeToTrack(buf)
                }
            }
            Mode.NONE -> {}
        }
    }

    fun pause() {
        Log.d(TAG, "pause() mode=$currentMode isPaused=${isPaused.get()}")
        isPaused.set(true)

        when (currentMode) {
            Mode.FILE -> {
                try {
                    mediaPlayer?.pause()
                } catch (e: Exception) {
                    Log.w(TAG, "MediaPlayer pause failed: ${e.message}")
                }
            }
            Mode.STREAMING -> {
                audioTrack?.pause()
            }
            Mode.NONE -> {}
        }
    }

    fun flushAndReset() {
        Log.d(TAG, "flushAndReset() mode=$currentMode")

        releaseMediaPlayer()
        resetStreamingState()

        isPaused.set(false)
        currentMode = Mode.NONE

        audioTrack?.pause()
        audioTrack?.flush()
        headAtChunkStart = audioTrack?.playbackHeadPosition ?: 0
        audioTrack?.play()
    }

    fun setRate(rate: Float) {
        currentRate = rate
        when (currentMode) {
            Mode.FILE -> {
                try {
                    mediaPlayer?.playbackParams = PlaybackParams().setSpeed(rate).setPitch(1.0f)
                } catch (_: Exception) {}
            }
            Mode.STREAMING -> {
                try {
                    audioTrack?.playbackParams = PlaybackParams().setSpeed(rate).setPitch(1.0f)
                } catch (_: Exception) {}
            }
            Mode.NONE -> {}
        }
    }

    fun stop() {
        Log.d(TAG, "stop()")
        active = false

        releaseMediaPlayer()

        writeGeneration.incrementAndGet()
        pollGeneration.incrementAndGet()
        totalFramesWritten = 0

        try { audioTrack?.stop() } catch (_: Exception) {}
        try { audioTrack?.release() } catch (_: Exception) {}
        audioTrack = null

        writerThread?.quitSafely()
        writerThread = null
        writerHandler = null

        synchronized(bufferLock) { pendingBuffers.clear() }
        pendingWriteCount.set(0)
        endOfStreamMarked.set(false)
        currentMode = Mode.NONE
    }

    // ========================
    // Private helpers
    // ========================

    private fun releaseMediaPlayer() {
        fileCompletionPending.set(false)
        try {
            mediaPlayer?.setOnCompletionListener(null)
            mediaPlayer?.setOnErrorListener(null)
            mediaPlayer?.stop()
        } catch (_: Exception) {}
        try { mediaPlayer?.release() } catch (_: Exception) {}
        mediaPlayer = null
    }

    private fun resetStreamingState() {
        writeGeneration.incrementAndGet()
        pollGeneration.incrementAndGet()
        synchronized(bufferLock) { pendingBuffers.clear() }
        pendingWriteCount.set(0)
        endOfStreamMarked.set(false)
        totalFramesWritten = 0
    }

    private fun writeToTrack(data: ByteArray) {
        pendingWriteCount.incrementAndGet()
        val gen = writeGeneration.get()
        writerHandler?.post {
            if (gen != writeGeneration.get()) {
                pendingWriteCount.decrementAndGet()
                return@post
            }
            try {
                var offset = 0
                while (offset < data.size) {
                    if (gen != writeGeneration.get()) {
                        pendingWriteCount.decrementAndGet()
                        return@post
                    }
                    val written = audioTrack?.write(
                        data, offset, data.size - offset,
                        AudioTrack.WRITE_BLOCKING
                    ) ?: 0
                    if (written <= 0) {
                        if (isPaused.get() && offset < data.size) {
                            val unwritten = data.copyOfRange(offset, data.size)
                            synchronized(bufferLock) {
                                pendingBuffers.add(unwritten)
                            }
                            Log.d(TAG, "writeToTrack: paused, saved ${data.size - offset} bytes to pendingBuffers")
                        }
                        break
                    }
                    totalFramesWritten += written / 2
                    offset += written
                }
            } catch (e: Exception) {
                onError?.invoke("AudioTrack write failed: ${e.message}")
            }
            if (gen != writeGeneration.get()) {
                pendingWriteCount.decrementAndGet()
                return@post
            }
            val remaining = pendingWriteCount.decrementAndGet()
            if (remaining == 0 && endOfStreamMarked.get() && !isPaused.get()) {
                Log.d(TAG, "writeToTrack: all writes done, starting poll. totalFrames=$totalFramesWritten")
                startPlaybackPoll()
            }
        }
    }

    private fun startPlaybackPoll() {
        val gen = pollGeneration.get()
        val targetFrames = totalFramesWritten
        val startHead = headAtChunkStart
        Log.d(TAG, "startPlaybackPoll: gen=$gen startHead=$startHead targetFrames=$targetFrames")

        var lastHead = -1
        var stallCount = 0
        var lastPlayGen = playGeneration.get()
        val maxStallPolls = 10

        writerHandler?.postDelayed(object : Runnable {
            override fun run() {
                if (gen != pollGeneration.get()) return

                val currentPlayGen = playGeneration.get()
                if (currentPlayGen != lastPlayGen) {
                    stallCount = 0
                    lastPlayGen = currentPlayGen
                }

                val head = audioTrack?.playbackHeadPosition ?: 0
                val playedFrames = (head - startHead).toLong()
                val paused = isPaused.get()

                if (playedFrames >= targetFrames) {
                    Log.d(TAG, "poll: COMPLETE played=$playedFrames target=$targetFrames")
                    fireChunkFinished()
                    return
                }

                if (!paused) {
                    if (head == lastHead) {
                        stallCount++
                        if (stallCount >= maxStallPolls) {
                            Log.w(TAG, "poll: STALLED — forcing completion")
                            fireChunkFinished()
                            return
                        }
                    } else {
                        stallCount = 0
                    }
                } else {
                    stallCount = 0
                }
                lastHead = head

                writerHandler?.postDelayed(this, 50)
            }
        }, 50)
    }

    private fun fireChunkFinished() {
        endOfStreamMarked.set(false)
        Handler(android.os.Looper.getMainLooper()).post {
            onChunkFinished?.invoke()
        }
    }
}
