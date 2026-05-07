import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  Pressable,
  ScrollView,
  Modal,
} from "react-native";
import {
  Sun,
  Moon,
  Monitor,
  ChevronLeft,
  Hand,
  QrCode,
  Unplug,
  Volume2,
  VolumeOff,
} from "lucide-react-native";
import { GlassSurface } from "./GlassSurface";
import { useThemeStore, type ThemeMode } from "../stores/theme-store";
import { usePairingStore } from "../stores/pairing-store";
import { useConversationStore } from "../stores/conversation";
import { useColors } from "../theme";
import { QRScanner } from "./QRScanner";

type Props = { onClose: () => void };

const THEME_OPTIONS: { mode: ThemeMode; Icon: typeof Sun }[] = [
  { mode: "light", Icon: Sun },
  { mode: "dark", Icon: Moon },
  { mode: "system", Icon: Monitor },
];

const STATUS_LABELS: Record<"connected" | "connecting" | "disconnected", string> = {
  connected: "Connected",
  connecting: "Connecting...",
  disconnected: "Disconnected",
};

const AMBER = "#f59e0b";

export function SettingsPage({ onClose }: Props) {
  const colors = useColors();
  const transportState = useConversationStore((s) => s.transportState);
  const userId = usePairingStore((s) => s.userId);
  const isPaired = usePairingStore((s) => Boolean(s.userId && s.pairingToken));
  const clearPairing = usePairingStore((s) => s.clearPairing);

  const {
    mode: themeMode,
    setMode: setThemeMode,
    hand,
    setHand,
    ttsEnabled,
    setTTSEnabled,
  } = useThemeStore();
  const [showQR, setShowQR] = useState(false);

  const handleDisconnect = useCallback(() => {
    void clearPairing();
  }, [clearPairing]);

  const dotColor =
    transportState === "connected"
      ? colors.success
      : transportState === "connecting"
        ? colors.accent
        : colors.textDim;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 24 }}
      keyboardDismissMode="on-drag"
    >
      <Pressable
        onPress={onClose}
        hitSlop={16}
        style={{ alignSelf: "flex-start" }}
      >
        <ChevronLeft size={28} color={colors.text} />
      </Pressable>

      <Modal visible={showQR} animationType="slide">
        <QRScanner onClose={() => setShowQR(false)} />
      </Modal>

      {/* Connection */}
      <View
        style={{
          gap: 12,
          backgroundColor: colors.surface,
          borderRadius: 16,
          padding: 16,
        }}
      >
        <Text
          style={{
            color: colors.textDim,
            fontSize: 12,
            fontFamily: "IosevkaAile-Regular",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Connection
        </Text>

        {isPaired ? (
          <>
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                paddingVertical: 8,
              }}
            >
              <View
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 5,
                  backgroundColor: dotColor,
                }}
              />
              <Text
                style={{
                  color: colors.text,
                  fontFamily: "IosevkaAile-Medium",
                  fontSize: 15,
                }}
              >
                {STATUS_LABELS[transportState]}
              </Text>
            </View>

            <Text
              style={{
                color: colors.textDim,
                fontFamily: "IosevkaAile-Regular",
                fontSize: 13,
                textAlign: "center",
              }}
            >
              User: {userId.slice(0, 8) || "—"}
            </Text>

            <Pressable
              onPress={handleDisconnect}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                backgroundColor: colors.bg,
                paddingVertical: 12,
                borderRadius: 12,
              }}
            >
              <Unplug size={16} color={colors.textDim} />
              <Text
                style={{
                  color: colors.textDim,
                  fontFamily: "IosevkaAile-Medium",
                  fontSize: 14,
                }}
              >
                Unpair
              </Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            onPress={() => setShowQR(true)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 10,
              backgroundColor: colors.accent,
              paddingVertical: 14,
              borderRadius: 12,
            }}
          >
            <QrCode size={18} color={colors.bg} />
            <Text
              style={{
                color: colors.bg,
                fontFamily: "IosevkaAile-Medium",
                fontSize: 14,
              }}
            >
              Scan QR Code
            </Text>
          </Pressable>
        )}
      </View>

      {/* Theme */}
      <View
        style={{
          gap: 10,
          backgroundColor: colors.surface,
          borderRadius: 16,
          padding: 16,
        }}
      >
        <Text
          style={{
            color: colors.textDim,
            fontSize: 12,
            fontFamily: "IosevkaAile-Regular",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Appearance
        </Text>
        <View
          style={{
            flexDirection: "row",
            backgroundColor: colors.bg,
            borderRadius: 12,
            padding: 4,
          }}
        >
          {THEME_OPTIONS.map(({ mode, Icon }) => {
            const selected = themeMode === mode;
            const inner = (
              <Icon
                size={18}
                color={selected ? colors.text : colors.textFaint}
              />
            );
            return (
              <Pressable
                key={mode}
                onPress={() => setThemeMode(mode)}
                style={{ flex: 1 }}
              >
                {selected ? (
                  <GlassSurface
                    style={{
                      alignItems: "center",
                      justifyContent: "center",
                      paddingVertical: 12,
                      borderRadius: 8,
                    }}
                    fallbackStyle={{ backgroundColor: colors.surfaceAlt }}
                    tintColor={colors.surfaceAlt}
                  >
                    {inner}
                  </GlassSurface>
                ) : (
                  <View
                    style={{
                      alignItems: "center",
                      justifyContent: "center",
                      paddingVertical: 12,
                      borderRadius: 8,
                    }}
                  >
                    {inner}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Hand */}
      <View
        style={{
          gap: 10,
          backgroundColor: colors.surface,
          borderRadius: 16,
          padding: 16,
        }}
      >
        <Text
          style={{
            color: colors.textDim,
            fontSize: 12,
            fontFamily: "IosevkaAile-Regular",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Mic position
        </Text>
        <View
          style={{
            flexDirection: "row",
            backgroundColor: colors.bg,
            borderRadius: 12,
            padding: 4,
          }}
        >
          {(["left", "right"] as const).map((side) => {
            const selected = hand === side;
            const inner = (
              <>
                <View
                  style={
                    side === "left"
                      ? { transform: [{ scaleX: -1 }] }
                      : undefined
                  }
                >
                  <Hand
                    size={16}
                    color={selected ? colors.text : colors.textFaint}
                  />
                </View>
                <Text
                  style={{
                    color: selected ? colors.text : colors.textFaint,
                    fontSize: 13,
                    fontFamily: "IosevkaAile-Regular",
                  }}
                >
                  {side === "left" ? "Left" : "Right"}
                </Text>
              </>
            );
            return (
              <Pressable
                key={side}
                onPress={() => setHand(side)}
                style={{ flex: 1 }}
              >
                {selected ? (
                  <GlassSurface
                    style={{
                      alignItems: "center",
                      justifyContent: "center",
                      paddingVertical: 12,
                      borderRadius: 8,
                      flexDirection: "row",
                      gap: 6,
                    }}
                    fallbackStyle={{ backgroundColor: colors.surfaceAlt }}
                    tintColor={colors.surfaceAlt}
                  >
                    {inner}
                  </GlassSurface>
                ) : (
                  <View
                    style={{
                      alignItems: "center",
                      justifyContent: "center",
                      paddingVertical: 12,
                      borderRadius: 8,
                      flexDirection: "row",
                      gap: 6,
                    }}
                  >
                    {inner}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Voice response */}
      <View
        style={{
          gap: 10,
          backgroundColor: colors.surface,
          borderRadius: 16,
          padding: 16,
        }}
      >
        <Text
          style={{
            color: colors.textDim,
            fontSize: 12,
            fontFamily: "IosevkaAile-Regular",
            textTransform: "uppercase",
            letterSpacing: 1,
          }}
        >
          Voice response
        </Text>
        <View
          style={{
            flexDirection: "row",
            backgroundColor: colors.bg,
            borderRadius: 12,
            padding: 4,
          }}
        >
          {([true, false] as const).map((enabled) => {
            const selected = ttsEnabled === enabled;
            const Icon = enabled ? Volume2 : VolumeOff;
            const label = enabled ? "On" : "Off";
            const inner = (
              <>
                <Icon
                  size={16}
                  color={selected ? colors.text : colors.textFaint}
                />
                <Text
                  style={{
                    color: selected ? colors.text : colors.textFaint,
                    fontSize: 13,
                    fontFamily: "IosevkaAile-Regular",
                  }}
                >
                  {label}
                </Text>
              </>
            );
            return (
              <Pressable
                key={label}
                onPress={() => setTTSEnabled(enabled)}
                style={{ flex: 1 }}
              >
                {selected ? (
                  <GlassSurface
                    style={{
                      alignItems: "center",
                      justifyContent: "center",
                      paddingVertical: 12,
                      borderRadius: 8,
                      flexDirection: "row",
                      gap: 6,
                    }}
                    fallbackStyle={{ backgroundColor: colors.surfaceAlt }}
                    tintColor={colors.surfaceAlt}
                  >
                    {inner}
                  </GlassSurface>
                ) : (
                  <View
                    style={{
                      alignItems: "center",
                      justifyContent: "center",
                      paddingVertical: 12,
                      borderRadius: 8,
                      flexDirection: "row",
                      gap: 6,
                    }}
                  >
                    {inner}
                  </View>
                )}
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* AMBER reserved for future "reconnecting" indicator */}
      <View style={{ height: 0, backgroundColor: AMBER }} />
    </ScrollView>
  );
}
