import React, { useState } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { X } from "lucide-react-native";
import { useColors } from "../theme";
import { usePairingStore } from "../stores/pairing-store";

type Props = {
  onClose: () => void;
};

interface QRPayload {
  // Short keys
  r?: string; // relayUrl
  u?: string; // userId
  t?: string; // pairingToken
  // Long keys
  relay?: string;
  user?: string;
  token?: string;
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
      const parsed = JSON.parse(data) as QRPayload;
      const relayUrl = parsed.r ?? parsed.relay;
      const userId = parsed.u ?? parsed.user;
      const pairingToken = parsed.t ?? parsed.token;

      if (!userId || !pairingToken) {
        throw new Error("Invalid QR payload — missing user or token");
      }

      await setPairing({ relayUrl, userId, pairingToken });
      onClose();
    } catch (err) {
      console.error("[QR] scan error:", err);
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
