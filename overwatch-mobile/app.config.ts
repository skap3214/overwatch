import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "Overwatch",
  slug: "overwatch-mobile",
  version: "1.0.0",
  scheme: "overwatch",
  orientation: "portrait",
  userInterfaceStyle: "dark",
  icon: "./assets/icon.png",
  newArchEnabled: true,
  splash: {
    backgroundColor: "#0c0c0c",
  },
  ios: {
    bundleIdentifier: "com.overwatch.mobile",
    supportsTablet: false,
    infoPlist: {
      NSMicrophoneUsageDescription:
        "Overwatch uses the microphone for push-to-talk voice commands.",
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      UIBackgroundModes: ["audio"],
    },
  },
  android: {
    package: "com.overwatch.mobile",
    adaptiveIcon: {
      foregroundImage: "./assets/adaptive-icon.png",
      backgroundColor: "#0c0c0c",
    },
    edgeToEdgeEnabled: true,
    permissions: [
      "android.permission.RECORD_AUDIO",
      "android.permission.FOREGROUND_SERVICE",
      "android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK",
    ],
  },
  plugins: [
    [
      "expo-audio",
      {
        microphonePermission:
          "Overwatch uses the microphone for push-to-talk voice commands.",
      },
    ],
  ],
});
