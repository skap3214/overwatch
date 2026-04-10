import ExpoModulesCore

public class StreamingAudioModule: Module {
    private var engine: StreamingAudioEngine?
    private var mediaController: StreamingMediaController?

    public func definition() -> ModuleDefinition {
        Name("StreamingAudio")

        Events("onChunkFinished", "onPlaybackStateChanged", "onRemoteCommand", "onError")

        Function("startSession") { (config: [String: Any]) in
            let sampleRate = config["sampleRate"] as? Int ?? 44100
            let channels = config["channels"] as? Int ?? 1

            self.engine?.stop()
            self.mediaController?.deregister()

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

            let controller = StreamingMediaController()
            controller.onPlayCommand = { [weak self] in
                self?.engine?.play()
                self?.mediaController?.updatePlaybackState(isPlaying: true)
                self?.sendEvent("onPlaybackStateChanged", ["isPlaying": true])
                self?.sendEvent("onRemoteCommand", ["command": "play"])
            }
            controller.onPauseCommand = { [weak self] in
                self?.engine?.pause()
                self?.mediaController?.updatePlaybackState(isPlaying: false)
                self?.sendEvent("onPlaybackStateChanged", ["isPlaying": false])
                self?.sendEvent("onRemoteCommand", ["command": "pause"])
            }
            controller.onNextTrackCommand = { [weak self] in
                self?.sendEvent("onRemoteCommand", ["command": "nextTrack"])
            }
            controller.onPreviousTrackCommand = { [weak self] in
                self?.sendEvent("onRemoteCommand", ["command": "previousTrack"])
            }
            controller.register()
            self.mediaController = controller
        }

        Function("endSession") {
            self.engine?.stop()
            self.engine = nil
            self.mediaController?.deregister()
            self.mediaController = nil
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
            self.mediaController?.updatePlaybackState(isPlaying: true)
            self.sendEvent("onPlaybackStateChanged", ["isPlaying": true])
        }

        Function("pause") {
            self.engine?.pause()
            self.mediaController?.updatePlaybackState(isPlaying: false)
            self.sendEvent("onPlaybackStateChanged", ["isPlaying": false])
        }

        Function("flushAndReset") {
            self.engine?.flushAndReset()
        }

        Function("setRate") { (rate: Double) in
            self.engine?.setRate(Float(rate))
        }

        Function("updateNowPlaying") { (meta: [String: Any]) in
            guard let controller = self.mediaController else { return }
            controller.updateNowPlaying(
                title: meta["title"] as? String ?? "Read Aloud",
                artist: meta["artist"] as? String ?? "YouLearn",
                artworkUrl: meta["artworkUrl"] as? String,
                durationSeconds: meta["durationSeconds"] as? Double,
                elapsedSeconds: meta["elapsedSeconds"] as? Double,
                rate: meta["rate"] as? Double
            )
        }
    }
}
