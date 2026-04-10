import AVFoundation

final class StreamingAudioEngine {
    private struct ScheduledChunk {
        let id: Int
        let data: Data
    }

    private let controlQueue = DispatchQueue(label: "com.youlearn.streaming-audio.control")

    private var engine = AVAudioEngine()
    private var playerNode = AVAudioPlayerNode()
    private var timePitchNode = AVAudioUnitTimePitch()

    private var scheduledBufferCount = 0
    private var endOfStreamMarked = false
    private var pendingChunks: [Data] = []
    private var scheduledChunks: [ScheduledChunk] = []
    private var isPaused = false
    private var sessionActive = false
    private var sessionInterrupted = false
    private var shouldResumeAfterInterruption = false
    private var bufferGeneration = 0
    private var nextChunkId = 0
    private var observersRegistered = false
    private var graphConfigured = false

    private let sampleRate: Double
    private let channels: UInt32
    private let pcmFormat: AVAudioFormat

    var onChunkFinished: (() -> Void)?
    var onError: ((String) -> Void)?

    init(sampleRate: Int, channels: Int) {
        self.sampleRate = Double(sampleRate)
        self.channels = UInt32(channels)
        self.pcmFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: self.sampleRate,
            channels: AVAudioChannelCount(self.channels),
            interleaved: false
        )!
    }

    func start() throws {
        try controlQueue.sync {
            try activateSessionIfNeeded()
            try rebuildAudioGraph(restoreQueuedAudio: false)
            sessionActive = true
            registerObserversIfNeeded()
        }
    }

    func feedPCM(_ data: Data) {
        guard !data.isEmpty else { return }

        controlQueue.async {
            guard self.sessionActive else { return }

            self.pendingChunks.append(data)
            do {
                try self.ensurePlaybackEngineReady(resumePlayback: !self.isPaused && !self.sessionInterrupted)
                self.drainPendingChunksIfPossible()
            } catch {
                self.emitError("Failed to queue audio: \(error.localizedDescription)")
            }
        }
    }

    func markEndOfStream() {
        controlQueue.async {
            self.endOfStreamMarked = true
            if self.scheduledBufferCount == 0 && self.pendingChunks.isEmpty {
                self.fireChunkFinished()
            }
        }
    }

    func playFile(url: URL) throws {
        let fileData = try Data(contentsOf: url)
        guard fileData.count > 44 else {
            throw NSError(
                domain: "StreamingAudioEngine",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "WAV file too small"]
            )
        }

        let pcmData = Data(fileData.dropFirst(44))

        controlQueue.async {
            guard self.sessionActive else { return }

            self.pendingChunks.append(pcmData)
            self.endOfStreamMarked = true

            do {
                try self.ensurePlaybackEngineReady(resumePlayback: !self.isPaused && !self.sessionInterrupted)
                self.drainPendingChunksIfPossible()
            } catch {
                self.emitError("Failed to play audio file: \(error.localizedDescription)")
            }
        }
    }

    func play() {
        controlQueue.async {
            guard self.sessionActive else { return }

            self.isPaused = false
            self.shouldResumeAfterInterruption = true

            do {
                try self.ensurePlaybackEngineReady(resumePlayback: true)
                self.drainPendingChunksIfPossible()
            } catch {
                self.emitError("Failed to resume audio: \(error.localizedDescription)")
            }
        }
    }

    func pause() {
        controlQueue.async {
            guard self.sessionActive else { return }

            self.isPaused = true
            self.shouldResumeAfterInterruption = false
            self.playerNode.pause()
        }
    }

    func flushAndReset() {
        controlQueue.async {
            self.bufferGeneration += 1
            self.playerNode.stop()
            self.scheduledBufferCount = 0
            self.endOfStreamMarked = false
            self.pendingChunks.removeAll()
            self.scheduledChunks.removeAll()

            if !self.isPaused && !self.sessionInterrupted {
                do {
                    try self.ensurePlaybackEngineReady(resumePlayback: true)
                } catch {
                    self.emitError("Failed to reset audio engine: \(error.localizedDescription)")
                }
            }
        }
    }

    func setRate(_ rate: Float) {
        controlQueue.async {
            self.timePitchNode.rate = rate
        }
    }

    func stop() {
        unregisterObservers()

        controlQueue.sync {
            self.sessionActive = false
            self.sessionInterrupted = false
            self.shouldResumeAfterInterruption = false

            self.bufferGeneration += 1
            self.playerNode.stop()
            self.engine.stop()

            self.scheduledBufferCount = 0
            self.endOfStreamMarked = false
            self.pendingChunks.removeAll()
            self.scheduledChunks.removeAll()
            self.isPaused = false
            self.nextChunkId = 0

            self.tearDownAudioGraph()

            do {
                try AVAudioSession.sharedInstance().setActive(
                    false,
                    options: .notifyOthersOnDeactivation
                )
            } catch {
            }
        }
    }

    @objc private func handleInterruption(notification: Notification) {
        guard
            let userInfo = notification.userInfo,
            let typeValue = userInfo[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else {
            return
        }

        controlQueue.async {
            switch type {
            case .began:
                self.sessionInterrupted = true
                self.shouldResumeAfterInterruption = !self.isPaused
                self.playerNode.pause()
            case .ended:
                self.sessionInterrupted = false
                let shouldResume = self.shouldResumeAfterInterruption ||
                    ((userInfo[AVAudioSessionInterruptionOptionKey] as? UInt).map {
                        AVAudioSession.InterruptionOptions(rawValue: $0)
                            .contains(.shouldResume)
                    } ?? false)

                do {
                    try self.ensurePlaybackEngineReady(resumePlayback: shouldResume && !self.isPaused)
                    self.drainPendingChunksIfPossible()
                } catch {
                    self.emitError("Failed to recover from interruption: \(error.localizedDescription)")
                }
            @unknown default:
                break
            }
        }
    }

    @objc private func handleMediaServicesReset() {
        controlQueue.async {
            guard self.sessionActive else { return }

            do {
                try self.rebuildAudioGraph(restoreQueuedAudio: true)
                self.drainPendingChunksIfPossible()
            } catch {
                self.emitError("Failed to recover audio after media services reset: \(error.localizedDescription)")
            }
        }
    }

    @objc private func handleEngineConfigurationChange() {
        controlQueue.async {
            guard self.sessionActive else { return }

            do {
                try self.rebuildAudioGraph(restoreQueuedAudio: true)
                self.drainPendingChunksIfPossible()
            } catch {
                self.emitError("Failed to recover audio configuration: \(error.localizedDescription)")
            }
        }
    }

    private func registerObserversIfNeeded() {
        guard !observersRegistered else { return }
        observersRegistered = true

        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleInterruption),
            name: AVAudioSession.interruptionNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleMediaServicesReset),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: nil
        )
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handleEngineConfigurationChange),
            name: .AVAudioEngineConfigurationChange,
            object: engine
        )
    }

    private func unregisterObservers() {
        guard observersRegistered else { return }
        observersRegistered = false
        NotificationCenter.default.removeObserver(self)
    }

    private func activateSessionIfNeeded() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playback, mode: .spokenAudio)
        try session.setActive(true)
    }

    private func configureAudioGraphIfNeeded() {
        guard !graphConfigured else { return }

        engine.attach(playerNode)
        engine.attach(timePitchNode)
        engine.connect(playerNode, to: timePitchNode, format: pcmFormat)
        engine.connect(timePitchNode, to: engine.mainMixerNode, format: pcmFormat)
        timePitchNode.rate = timePitchNode.rate == 0 ? 1.0 : timePitchNode.rate
        graphConfigured = true
    }

    private func tearDownAudioGraph() {
        if graphConfigured {
            engine.detach(timePitchNode)
            engine.detach(playerNode)
        }
        graphConfigured = false
        engine = AVAudioEngine()
        playerNode = AVAudioPlayerNode()
        let previousRate = timePitchNode.rate
        timePitchNode = AVAudioUnitTimePitch()
        timePitchNode.rate = previousRate == 0 ? 1.0 : previousRate
    }

    private func ensurePlaybackEngineReady(resumePlayback: Bool) throws {
        try activateSessionIfNeeded()
        configureAudioGraphIfNeeded()

        if !engine.isRunning {
            engine.prepare()
            try engine.start()
        }

        if resumePlayback {
            playerNode.play()
        }
    }

    private func rebuildAudioGraph(restoreQueuedAudio: Bool) throws {
        let queuedData = restoreQueuedAudio
            ? (scheduledChunks.map(\.data) + pendingChunks)
            : pendingChunks

        if observersRegistered {
            NotificationCenter.default.removeObserver(
                self,
                name: .AVAudioEngineConfigurationChange,
                object: engine
            )
        }

        bufferGeneration += 1
        playerNode.stop()
        engine.stop()
        scheduledBufferCount = 0
        scheduledChunks.removeAll()

        tearDownAudioGraph()
        try ensurePlaybackEngineReady(resumePlayback: !isPaused && !sessionInterrupted)

        pendingChunks = queuedData

        if observersRegistered {
            NotificationCenter.default.addObserver(
                self,
                selector: #selector(handleEngineConfigurationChange),
                name: .AVAudioEngineConfigurationChange,
                object: engine
            )
        }
    }

    private func drainPendingChunksIfPossible() {
        guard sessionActive, !isPaused, !sessionInterrupted else { return }

        while !pendingChunks.isEmpty {
            let chunk = pendingChunks.removeFirst()
            do {
                try scheduleChunk(chunk)
            } catch {
                emitError("Failed to schedule audio buffer: \(error.localizedDescription)")
                pendingChunks.insert(chunk, at: 0)
                return
            }
        }

        if endOfStreamMarked && scheduledBufferCount == 0 {
            fireChunkFinished()
        }
    }

    private func scheduleChunk(_ data: Data) throws {
        let buffer = try makePCMBuffer(from: data)
        let chunk = ScheduledChunk(id: nextChunkId, data: data)
        nextChunkId += 1

        scheduledChunks.append(chunk)
        scheduledBufferCount += 1
        let generation = bufferGeneration

        playerNode.scheduleBuffer(buffer, completionCallbackType: .dataConsumed) { [weak self] _ in
            self?.controlQueue.async {
                guard let self else { return }
                guard generation == self.bufferGeneration else { return }

                self.scheduledBufferCount = max(0, self.scheduledBufferCount - 1)
                self.scheduledChunks.removeAll { $0.id == chunk.id }

                if self.endOfStreamMarked &&
                    self.scheduledBufferCount == 0 &&
                    self.pendingChunks.isEmpty {
                    self.fireChunkFinished()
                }
            }
        }
    }

    private func makePCMBuffer(from data: Data) throws -> AVAudioPCMBuffer {
        let frameCount = UInt32(data.count / 2)
        guard frameCount > 0 else {
            throw NSError(
                domain: "StreamingAudioEngine",
                code: -2,
                userInfo: [NSLocalizedDescriptionKey: "PCM chunk is empty"]
            )
        }

        guard let buffer = AVAudioPCMBuffer(
            pcmFormat: pcmFormat,
            frameCapacity: frameCount
        ) else {
            throw NSError(
                domain: "StreamingAudioEngine",
                code: -3,
                userInfo: [NSLocalizedDescriptionKey: "Failed to create audio buffer"]
            )
        }

        buffer.frameLength = frameCount

        guard let floatData = buffer.floatChannelData?[0] else {
            throw NSError(
                domain: "StreamingAudioEngine",
                code: -4,
                userInfo: [NSLocalizedDescriptionKey: "Audio buffer is missing channel data"]
            )
        }

        data.withUnsafeBytes { rawBuffer in
            guard let baseAddress = rawBuffer.baseAddress else { return }
            let int16Ptr = baseAddress.assumingMemoryBound(to: Int16.self)
            for index in 0..<Int(frameCount) {
                floatData[index] = Float(int16Ptr[index]) / 32768.0
            }
        }

        return buffer
    }

    private func fireChunkFinished() {
        endOfStreamMarked = false
        DispatchQueue.main.async { [weak self] in
            self?.onChunkFinished?()
        }
    }

    private func emitError(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            self?.onError?(message)
        }
    }
}
