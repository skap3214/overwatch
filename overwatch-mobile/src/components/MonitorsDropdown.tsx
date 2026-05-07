import React, { useEffect, useState } from "react";
import {
  Modal,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { Clock3, Pause as PauseIcon, AlertTriangle, Plus } from "lucide-react-native";
import { useMonitorsStore } from "../stores/monitors-store";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";
import { MonitorDetailScreen } from "./MonitorDetailScreen";
import { MonitorEditForm } from "./MonitorEditForm";
import type { ScheduledMonitor } from "../types";

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
  const actions = useMonitorsStore((s) => s.actions);
  const [now, setNow] = useState(() => Date.now());
  const [detail, setDetail] = useState<ScheduledMonitor | null>(null);
  const [editing, setEditing] = useState<ScheduledMonitor | null>(null);
  const [creating, setCreating] = useState(false);

  const canCreate = actions.can_create;

  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [visible]);

  // Don't auto-close — even with zero monitors, in Hermes mode the user can
  // tap "+ New". Local mode keeps original behavior of auto-closing on empty.
  useEffect(() => {
    if (visible && monitors.length === 0 && !canCreate) {
      onClose();
    }
  }, [visible, monitors.length, canCreate, onClose]);

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
              {monitors.length === 0 && !canCreate ? (
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
                    const isPaused = !!monitor.paused;
                    const hasError = monitor.lastStatus === "error";
                    const tint = isPaused
                      ? "#eab308"
                      : hasError
                        ? colors.error
                        : colors.textDim;
                    const Icon = isPaused
                      ? PauseIcon
                      : hasError
                        ? AlertTriangle
                        : Clock3;
                    return (
                      <Pressable
                        key={monitor.id}
                        onPress={() => setDetail(monitor)}
                        style={({ pressed }) => ({
                          paddingHorizontal: 8,
                          paddingVertical: 12,
                          borderBottomWidth:
                            index === monitors.length - 1 && !canCreate ? 0 : 1,
                          borderBottomColor: colors.border,
                          flexDirection: "row",
                          alignItems: "center",
                          gap: 12,
                          opacity: pressed ? 0.5 : 1,
                        })}
                      >
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
                          <Icon size={15} color={tint} />
                        </View>
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
                            {isPaused ? " · paused" : ""}
                            {hasError && !isPaused ? " · errored" : ""}
                          </Text>
                        </View>
                        <Text
                          style={{
                            color: isPaused ? colors.textFaint : colors.text,
                            fontSize: 12,
                            fontFamily: "IosevkaAile-Medium",
                          }}
                        >
                          {isPaused ? "—" : formatCountdown(monitor.nextRunAt, now)}
                        </Text>
                      </Pressable>
                    );
                  })}

                  {canCreate && (
                    <Pressable
                      onPress={() => setCreating(true)}
                      style={({ pressed }) => ({
                        paddingHorizontal: 8,
                        paddingVertical: 12,
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 12,
                        opacity: pressed ? 0.5 : 1,
                      })}
                    >
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
                        <Plus size={15} color={colors.textDim} />
                      </View>
                      <Text
                        style={{
                          flex: 1,
                          color: colors.textDim,
                          fontSize: 13,
                          fontFamily: "IosevkaAile-Medium",
                        }}
                      >
                        New monitor
                      </Text>
                    </Pressable>
                  )}
                </View>
              )}
            </GlassSurface>
          </Pressable>
        </View>
      </Pressable>

      {detail && (
        <MonitorDetailScreen
          monitor={detail}
          onClose={() => setDetail(null)}
          onEdit={(m) => {
            setDetail(null);
            setEditing(m);
          }}
        />
      )}
      {editing && (
        <MonitorEditForm
          monitor={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            // The bridge will refresh on the next poll/refresh; nothing to do here.
          }}
        />
      )}
      {creating && (
        <MonitorEditForm
          monitor={null}
          onClose={() => setCreating(false)}
          onSaved={() => {}}
        />
      )}
    </Modal>
  );
}
