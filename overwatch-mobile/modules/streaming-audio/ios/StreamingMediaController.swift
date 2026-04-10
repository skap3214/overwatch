import MediaPlayer
import UIKit

final class StreamingMediaController {
    var onPlayCommand: (() -> Void)?
    var onPauseCommand: (() -> Void)?
    var onNextTrackCommand: (() -> Void)?
    var onPreviousTrackCommand: (() -> Void)?

    private var playTarget: Any?
    private var pauseTarget: Any?
    private var nextTarget: Any?
    private var prevTarget: Any?
    private var artworkTask: URLSessionDataTask?

    func register() {
        let center = MPRemoteCommandCenter.shared()

        playTarget = center.playCommand.addTarget { [weak self] _ in
            self?.onPlayCommand?()
            return .success
        }
        center.playCommand.isEnabled = true

        pauseTarget = center.pauseCommand.addTarget { [weak self] _ in
            self?.onPauseCommand?()
            return .success
        }
        center.pauseCommand.isEnabled = true

        nextTarget = center.nextTrackCommand.addTarget { [weak self] _ in
            self?.onNextTrackCommand?()
            return .success
        }
        center.nextTrackCommand.isEnabled = true

        prevTarget = center.previousTrackCommand.addTarget { [weak self] _ in
            self?.onPreviousTrackCommand?()
            return .success
        }
        center.previousTrackCommand.isEnabled = true
    }

    func updatePlaybackState(isPlaying: Bool) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = info[MPNowPlayingInfoPropertyElapsedPlaybackTime] ?? 0
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? 1.0 : 0.0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        MPNowPlayingInfoCenter.default().playbackState = isPlaying ? .playing : .paused
    }

    func deregister() {
        let center = MPRemoteCommandCenter.shared()

        if let target = playTarget {
            center.playCommand.removeTarget(target)
            playTarget = nil
        }
        if let target = pauseTarget {
            center.pauseCommand.removeTarget(target)
            pauseTarget = nil
        }
        if let target = nextTarget {
            center.nextTrackCommand.removeTarget(target)
            nextTarget = nil
        }
        if let target = prevTarget {
            center.previousTrackCommand.removeTarget(target)
            prevTarget = nil
        }

        center.playCommand.isEnabled = false
        center.pauseCommand.isEnabled = false
        center.nextTrackCommand.isEnabled = false
        center.previousTrackCommand.isEnabled = false

        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil

        artworkTask?.cancel()
        artworkTask = nil
    }

    func updateNowPlaying(
        title: String,
        artist: String,
        artworkUrl: String?,
        durationSeconds: Double?,
        elapsedSeconds: Double?,
        rate: Double?
    ) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
        info[MPMediaItemPropertyTitle] = title
        info[MPMediaItemPropertyArtist] = artist

        if let duration = durationSeconds {
            info[MPMediaItemPropertyPlaybackDuration] = duration
        }
        if let elapsed = elapsedSeconds {
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = elapsed
        }
        if let rate = rate {
            info[MPNowPlayingInfoPropertyPlaybackRate] = rate
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        if let urlString = artworkUrl, let url = URL(string: urlString) {
            loadArtwork(from: url)
        }
    }

    private func loadArtwork(from url: URL) {
        artworkTask?.cancel()
        artworkTask = URLSession.shared.dataTask(with: url) { [weak self] data, _, error in
            guard let self = self, error == nil, let data = data, let image = UIImage(data: data) else { return }

            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }

            DispatchQueue.main.async {
                var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [String: Any]()
                info[MPMediaItemPropertyArtwork] = artwork
                MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            }
        }
        artworkTask?.resume()
    }
}
