import ExpoModulesCore
import AVFoundation

public class FastRecorderModule: Module {
    /// Persistent recorder — created once, reused across recordings.
    private var recorder: AVAudioRecorder?
    private var currentURL: URL?
    private var recordingDir: URL?
    private var isPrepared = false

    private let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44100,
        AVNumberOfChannelsKey: 1,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
        AVEncoderBitRateKey: 128000,
    ]

    public func definition() -> ModuleDefinition {
        Name("FastRecorder")

        OnCreate {
            // Set up the recording directory once
            let docs = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            self.recordingDir = docs.appendingPathComponent("fast-recorder", isDirectory: true)
            try? FileManager.default.createDirectory(at: self.recordingDir!, withIntermediateDirectories: true)
        }

        /// Warm up: create the recorder and prepare it so the next start() is instant.
        /// Call this on app mount. The audio session stays in .playback until start().
        AsyncFunction("warmup") {
            try self.createRecorderIfNeeded()
            self.recorder?.prepareToRecord()
            self.isPrepared = true
        }

        /// Start recording. Switches audio session to .playAndRecord, then immediately
        /// calls record() on the pre-prepared recorder.
        AsyncFunction("start") { () -> String in
            let t0 = CFAbsoluteTimeGetCurrent()

            // Switch to playAndRecord
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playAndRecord, options: [.defaultToSpeaker, .allowBluetoothA2DP])
            try session.setActive(true)

            let t1 = CFAbsoluteTimeGetCurrent()

            // Ensure recorder exists with a fresh URL
            try self.createRecorderIfNeeded()

            if !self.isPrepared {
                self.recorder?.prepareToRecord()
            }
            self.isPrepared = false

            let t2 = CFAbsoluteTimeGetCurrent()

            guard let recorder = self.recorder else {
                throw NSError(domain: "FastRecorder", code: -1, userInfo: [
                    NSLocalizedDescriptionKey: "Recorder not initialized"
                ])
            }

            recorder.record()

            let t3 = CFAbsoluteTimeGetCurrent()
            let sessionMs = Int((t1 - t0) * 1000)
            let prepareMs = Int((t2 - t1) * 1000)
            let recordMs = Int((t3 - t2) * 1000)
            let totalMs = Int((t3 - t0) * 1000)
            NSLog("[FastRecorder] start: session=%dms prepare=%dms record=%dms total=%dms", sessionMs, prepareMs, recordMs, totalMs)

            return self.currentURL?.absoluteString ?? ""
        }

        /// Stop recording. Returns the file URI. Switches audio session back to .playback.
        AsyncFunction("stop") { () -> String? in
            guard let recorder = self.recorder, recorder.isRecording else {
                return nil
            }

            recorder.stop()
            let uri = self.currentURL?.absoluteString

            // Switch back to playback so AirPods don't route to the phone
            let session = AVAudioSession.sharedInstance()
            try? session.setCategory(.playback, options: [.duckOthers])
            try? session.setActive(true, options: [])

            // Pre-create next recorder with a new file for the next recording
            DispatchQueue.global(qos: .userInitiated).async {
                try? self.createRecorderIfNeeded()
                self.recorder?.prepareToRecord()
                self.isPrepared = true
            }

            return uri
        }

        Function("isRecording") { () -> Bool in
            return self.recorder?.isRecording ?? false
        }
    }

    private func createRecorderIfNeeded() throws {
        // Always create a new URL for each recording
        let fileName = "rec_\(Int(Date().timeIntervalSince1970 * 1000)).m4a"
        let url = recordingDir!.appendingPathComponent(fileName)
        self.currentURL = url

        // Reuse existing recorder if possible by just updating the URL
        // AVAudioRecorder doesn't support changing URL, so we must recreate
        self.recorder = try AVAudioRecorder(url: url, settings: settings)
        self.isPrepared = false
    }
}
