export type SessionConfig = {
  sampleRate: number;
  channels: number;
};

export type NowPlayingMetadata = {
  title?: string;
  artist?: string;
  artworkUrl?: string;
  durationSeconds?: number;
  elapsedSeconds?: number;
  rate?: number;
};

export type StreamingAudioEvents = {
  onChunkFinished: () => void;
  onPlaybackStateChanged: (event: { isPlaying: boolean }) => void;
  onRemoteCommand: (event: {
    command: "play" | "pause" | "nextTrack" | "previousTrack";
  }) => void;
  onError: (event: { message: string }) => void;
};
