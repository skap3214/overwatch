import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { X } from "lucide-react-native";
import { useColors } from "../theme";
import { usePairingStore } from "../stores/pairing-store";
import type { STTProvider, TTSProvider } from "../stores/pairing-store";

type Props = {
  onClose: () => void;
};

interface QRPayload {
  // Short keys
  r?: string; // relayUrl
  u?: string; // userId
  t?: string; // pairingToken
  stt?: STTProvider;
  tts?: TTSProvider;
  // Long keys
  relay?: string;
  user?: string;
  token?: string;
  sttProvider?: STTProvider;
  ttsProvider?: TTSProvider;
}

export function QRScanner({ onClose }: Props) {
  const colors = useColors();
  const [permission, requestPermission] = useCameraPermissions();
  const [scanned, setScanned] = useState(false);
  const setPairing = usePairingStore((s) => s.setPairing);

  const handleBarCodeScanned = async ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);

    try {
      // Tolerate two QR shapes: JSON `{r,u,t}` (what the CLI prints) and a
      // URL form `overwatch://pair?r=...&u=...&t=...` (future-proof). Reject
      // anything else cleanly so a stray scan (Wi-Fi QR, etc.) doesn't crash
      // the scanner.
      let payload: QRPayload | null = null;
      const trimmed = data.trim();
      if (trimmed.startsWith("{")) {
        payload = JSON.parse(trimmed) as QRPayload;
      } else if (
        trimmed.startsWith("overwatch://pair") ||
        trimmed.startsWith("https://overwatch")
      ) {
        const url = new URL(trimmed);
        payload = {
          r: url.searchParams.get("r") ?? undefined,
          u: url.searchParams.get("u") ?? undefined,
          t: url.searchParams.get("t") ?? undefined,
          stt: normalizeSTTProvider(url.searchParams.get("stt")),
          tts: normalizeTTSProvider(url.searchParams.get("tts")),
        };
      } else {
        throw new Error("That QR isn't an Overwatch pairing code");
      }

      const relayUrl = payload.r ?? payload.relay;
      const userId = payload.u ?? payload.user;
      const pairingToken = payload.t ?? payload.token;
      const sttProvider = normalizeSTTProvider(payload.stt ?? payload.sttProvider);
      const ttsProvider = normalizeTTSProvider(payload.tts ?? payload.ttsProvider);
      if (!userId || !pairingToken) {
        throw new Error("Invalid QR payload — missing user or token");
      }

      await setPairing({ relayUrl, userId, pairingToken, sttProvider, ttsProvider });
      onClose();
    } catch (err) {
      // Allow the scanner to keep working — re-arm and let the user try again.
      // We don't surface an alert because cameras emit transient bad reads
      // mid-focus; the next good frame will succeed.
      console.warn("[QR] ignored bad scan:", err instanceof Error ? err.message : String(err));
      setScanned(false);
    }
  };

  if (!permission) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
        <Text style={{ color: colors.text, fontFamily: "IosevkaAile-Regular" }}>
          Loading camera...
        </Text>
      </View>
    );
  }

  if (!permission.granted) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bg }]}>
        <Text
          style={{
            color: colors.text,
            fontFamily: "IosevkaAile-Regular",
            textAlign: "center",
            marginBottom: 16,
          }}
        >
          Camera permission is needed to scan the QR code from your computer.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={{
            backgroundColor: colors.accent,
            paddingHorizontal: 24,
            paddingVertical: 12,
            borderRadius: 12,
          }}
        >
          <Text
            style={{
              color: colors.bg,
              fontFamily: "IosevkaAile-Medium",
              fontSize: 14,
            }}
          >
            Grant Permission
          </Text>
        </Pressable>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: "#000" }]}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={scanned ? undefined : handleBarCodeScanned}
      />

      <View style={styles.overlay}>
        <Pressable onPress={onClose} style={styles.closeButton}>
          <X size={28} color="#fff" />
        </Pressable>

        <View style={styles.scanArea}>
          <View style={[styles.corner, styles.topLeft]} />
          <View style={[styles.corner, styles.topRight]} />
          <View style={[styles.corner, styles.bottomLeft]} />
          <View style={[styles.corner, styles.bottomRight]} />
        </View>

        <Text style={styles.hint}>
          Scan the QR code from{"\n"}`overwatch start`
        </Text>
      </View>
    </View>
  );
}

function normalizeSTTProvider(value: unknown): STTProvider | undefined {
  if (value === "grok") return "xai";
  return value === "deepgram" || value === "xai" ? value : undefined;
}

function normalizeTTSProvider(value: unknown): TTSProvider | undefined {
  return value === "cartesia" || value === "xai" ? value : undefined;
}

const CORNER_SIZE = 24;
const CORNER_WIDTH = 3;

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: "center", justifyContent: "center" },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
  },
  closeButton: { position: "absolute", top: 60, right: 20, padding: 8 },
  scanArea: { width: 240, height: 240, position: "relative" },
  corner: {
    position: "absolute",
    width: CORNER_SIZE,
    height: CORNER_SIZE,
    borderColor: "#fff",
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderLeftWidth: CORNER_WIDTH,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: CORNER_WIDTH,
    borderRightWidth: CORNER_WIDTH,
  },
  hint: {
    color: "#fff",
    fontFamily: "IosevkaAile-Regular",
    fontSize: 14,
    textAlign: "center",
    marginTop: 32,
    opacity: 0.8,
  },
});
