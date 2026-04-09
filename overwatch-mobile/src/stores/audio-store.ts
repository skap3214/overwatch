import { create } from "zustand";

type AudioStore = {
  isPlaying: boolean;
  sessionActive: boolean;
  setIsPlaying: (playing: boolean) => void;
  setSessionActive: (active: boolean) => void;
};

export const useAudioStore = create<AudioStore>((set) => ({
  isPlaying: false,
  sessionActive: false,
  setIsPlaying: (isPlaying) => set({ isPlaying }),
  setSessionActive: (sessionActive) => set({ sessionActive }),
}));
