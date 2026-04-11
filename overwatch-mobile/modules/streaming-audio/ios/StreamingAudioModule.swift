import ExpoModulesCore

public class StreamingAudioModule: Module {
    private var engine: StreamingAudioEngine?

    public func definition() -> ModuleDefinition {
        Name("StreamingAudio")

        Events("onChunkFinished", "onPlaybackStateChanged", "onRemoteCommand", "onError")

        Function("startSession") { (config: [String: Any]) in
            let sampleRate = config["sampleRate"] as? Int ?? 44100
            let channels = config["channels"] as? Int ?? 1

            self.engine?.stop()

            let newEngine = StreamingAudioEngine(sampleRate: sampleRate, channels: channels)
            newEngine.onChunkFinished = { [weak self] in
                self?.sendEvent("onChunkFinished", [:])
            }
            newEngine.onError = { [weak self] message in
                self?.sendEvent("onError", ["message": message])
            }

            do {
                try newEngine.start()
            } catch {
                self.sendEvent("onError", ["message": "Failed to start audio session: \(error.localizedDescription)"])
                return
            }

            self.engine = newEngine
        }

        Function("endSession") {
            self.engine?.stop()
            self.engine = nil
        }

        Function("feedPCM") { (pcmData: Data) in
            guard let engine = self.engine else { return }
            engine.feedPCM(pcmData)
        }

        Function("playFile") { (uri: String) in
            guard let engine = self.engine else { return }
            let fileUrl: URL
            if uri.hasPrefix("file://") {
                guard let url = URL(string: uri) else {
                    self.sendEvent("onError", ["message": "Invalid file URI: \(uri)"])
                    return
                }
                fileUrl = url
            } else {
                fileUrl = URL(fileURLWithPath: uri)
            }
            do {
                try engine.playFile(url: fileUrl)
            } catch {
                self.sendEvent("onError", ["message": "Failed to play file: \(error.localizedDescription)"])
            }
        }

        Function("markEndOfStream") {
            self.engine?.markEndOfStream()
        }

        Function("play") {
            self.engine?.play()
            self.sendEvent("onPlaybackStateChanged", ["isPlaying": true])
        }

        Function("pause") {
            self.engine?.pause()
            self.sendEvent("onPlaybackStateChanged", ["isPlaying": false])
        }

        Function("flushAndReset") {
            self.engine?.flushAndReset()
        }

        Function("setRate") { (rate: Double) in
            self.engine?.setRate(Float(rate))
        }

        Function("updateNowPlaying") { (_: [String: Any]) in
            // No-op — lock screen controls disabled for Overwatch
        }
    }
}
