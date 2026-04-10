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
  newArchEnabled: false,
  splash: {
    backgroundColor: "#0c0c0c",
  },
  ios: {
    bundleIdentifier: "com.youlearn.overwatch",
    supportsTablet: false,
    infoPlist: {
      NSMicrophoneUsageDescription:
        "Overwatch uses the microphone for push-to-talk voice commands.",
      NSAppTransportSecurity: {
        NSAllowsArbitraryLoads: true,
      },
      ITSAppUsesNonExemptEncryption: false,
      UIBackgroundModes: ["audio"],
    },
  },
  android: {
    package: "com.youlearn.overwatch",
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
    [
      "expo-camera",
      {
        cameraPermission:
          "Overwatch uses the camera to scan QR codes for connecting to your computer.",
      },
    ],
  ],
  extra: {
    eas: {
      projectId: "705a277b-52f9-4c49-9803-cd70d4dd2573",
    },
  },
});
