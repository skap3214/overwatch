import React, { useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { Clock3 } from "lucide-react-native";
import { useMonitorsStore } from "../stores/monitors-store";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";

type Props = {
  visible: boolean;
  onClose: () => void;
};

function formatCountdown(nextRunAt: string | null, now: number): string {
  if (!nextRunAt) return "—";
  const diffMs = new Date(nextRunAt).getTime() - now;
  if (diffMs <= 0) return "now";

  const totalSeconds = Math.ceil(diffMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatLastRun(lastFiredAt: string | null, now: number): string | null {
  if (!lastFiredAt) return null;
  const diffMs = now - new Date(lastFiredAt).getTime();
  if (diffMs < 60_000) return "ran moments ago";
  const totalMinutes = Math.floor(diffMs / 60_000);
  if (totalMinutes < 60) return `ran ${totalMinutes}m ago`;
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) return `ran ${totalHours}h ago`;
  return `ran ${Math.floor(totalHours / 24)}d ago`;
}

export function MonitorsDropdown({ visible, onClose }: Props) {
  const colors = useColors();
  const monitors = useMonitorsStore((s) => s.monitors);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [visible]);

  useEffect(() => {
    if (visible && monitors.length === 0) {
      onClose();
    }
  }, [visible, monitors.length, onClose]);

  return (
    <Modal
      transparent
      animationType="fade"
      visible={visible}
      onRequestClose={onClose}
    >
      <Pressable
        onPress={onClose}
        style={{
          flex: 1,
          backgroundColor: "rgba(0, 0, 0, 0.18)",
          paddingHorizontal: 16,
        }}
      >
        <View
          style={{
            marginTop: Platform.OS === "ios" ? 106 : 82,
            alignItems: "center",
          }}
        >
          <Pressable onPress={(event) => event.stopPropagation()}>
            <GlassSurface
              style={{
                width: "100%",
                maxWidth: 400,
                minWidth: 320,
                borderRadius: 20,
                overflow: "hidden",
              }}
              fallbackStyle={{
                backgroundColor: colors.surface,
                borderWidth: 1,
                borderColor: colors.border,
              }}
              tintColor={colors.surface}
            >
              {monitors.length === 0 ? (
                <View style={{ paddingHorizontal: 18, paddingVertical: 22 }}>
                  <Text
                    style={{
                      color: colors.textDim,
                      fontSize: 12,
                      lineHeight: 18,
                      fontFamily: "IosevkaAile-Regular",
                    }}
                  >
                    No scheduled monitors yet. The agent can create them with
                    schedule_create.
                  </Text>
                </View>
              ) : (
                <View style={{ paddingHorizontal: 14, paddingVertical: 6 }}>
                  {monitors.map((monitor, index) => {
                    const lastRun = formatLastRun(monitor.lastFiredAt, now);
                    return (
                      <View
                        key={monitor.id}
                        style={{
                          paddingHorizontal: 8,
                          paddingVertical: 12,
                          borderBottomWidth: index === monitors.length - 1 ? 0 : 1,
                          borderBottomColor: colors.border,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 12,
                        }}
                      >
                        {/* Icon */}
                        <View
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 999,
                            backgroundColor: colors.surfaceAlt,
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          <Clock3 size={15} color={colors.textDim} />
                        </View>

                        {/* Title + schedule */}
                        <View style={{ flex: 1, gap: 2 }}>
                          <Text
                            numberOfLines={1}
                            style={{
                              color: colors.text,
                              fontSize: 13,
                              fontFamily: "IosevkaAile-Bold",
                            }}
                          >
                            {monitor.title}
                          </Text>
                          <Text
                            numberOfLines={1}
                            style={{
                              color: colors.textDim,
                              fontSize: 11,
                              fontFamily: "IosevkaAile-Regular",
                            }}
                          >
                            {monitor.scheduleLabel}
                            {lastRun ? ` · ${lastRun}` : ""}
                          </Text>
                        </View>

                        {/* Next run */}
                        <Text
                          style={{
                            color: colors.text,
                            fontSize: 12,
                            fontFamily: "IosevkaAile-Medium",
                          }}
                        >
                          {formatCountdown(monitor.nextRunAt, now)}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              )}
            </GlassSurface>
          </Pressable>
        </View>
      </Pressable>
    </Modal>
  );
}
