import React, { useMemo, useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { ArrowLeft, Bell, AlertTriangle, Cog } from "lucide-react-native";
import { useColors } from "../theme";
import { useNotificationsStore } from "../stores/notifications-store";
import { useMonitorsStore } from "../stores/monitors-store";
import { MonitorDetailScreen } from "./MonitorDetailScreen";
import type { NotificationEvent, NotificationKind, ScheduledMonitor } from "../types";

type Props = {
  visible: boolean;
  onClose: () => void;
};

const FILTERS: Array<{ key: "all" | "scheduler" | "errors"; label: string }> = [
  { key: "all", label: "All" },
  { key: "scheduler", label: "Scheduled" },
  { key: "errors", label: "Errors" },
];

const KIND_ICON: Record<NotificationKind, typeof Bell> = {
  scheduled_task_status: Cog,
  scheduled_task_result: Bell,
  scheduled_task_error: AlertTriangle,
  delegated_session_update: Bell,
  system_notice: Bell,
};

const KIND_LABEL: Record<NotificationKind, string> = {
  scheduled_task_status: "Status",
  scheduled_task_result: "Result",
  scheduled_task_error: "Error",
  delegated_session_update: "Delegated",
  system_notice: "System",
};

export function NotificationsHistoryScreen({ visible, onClose }: Props) {
  const colors = useColors();
  const all = useNotificationsStore((s) => s.notifications);
  const markSeen = useNotificationsStore((s) => s.markSeen);
  const monitors = useMonitorsStore((s) => s.monitors);
  const [filter, setFilter] = useState<"all" | "scheduler" | "errors">("all");
  const [openMonitor, setOpenMonitor] = useState<ScheduledMonitor | null>(null);

  const filtered = useMemo(() => {
    if (filter === "all") return all;
    if (filter === "errors") {
      return all.filter((n) => n.kind === "scheduled_task_error");
    }
    return all.filter(
      (n) =>
        n.kind === "scheduled_task_result" ||
        n.kind === "scheduled_task_status" ||
        n.kind === "scheduled_task_error",
    );
  }, [all, filter]);

  const onTap = (n: NotificationEvent) => {
    if (n.status === "new") {
      // Local-only ack for the alpha. The remote ack path travels back via
      // a future provider_event { provider: "overwatch", kind: "notification.ack" }
      // — once the orchestrator forwards them. For now the orchestrator's
      // notifications surface as ui-only events and don't need a server ack.
      markSeen(n.id);
    }
    // If this notification has a jobId / source.id, deep-link to the monitor.
    const jobId =
      (n.metadata?.jobId as string | undefined) ?? n.source.id ?? undefined;
    if (jobId) {
      const monitor = monitors.find((m) => m.id === jobId);
      if (monitor) setOpenMonitor(monitor);
    }
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            paddingHorizontal: 16,
            paddingVertical: 12,
            borderBottomWidth: 1,
            borderBottomColor: colors.border,
            gap: 12,
          }}
        >
          <Pressable onPress={onClose} hitSlop={8}>
            <ArrowLeft size={20} color={colors.text} />
          </Pressable>
          <Text
            style={{
              flex: 1,
              color: colors.text,
              fontSize: 16,
              fontFamily: "IosevkaAile-Bold",
            }}
          >
            Notifications
          </Text>
          <Text
            style={{
              color: colors.textDim,
              fontSize: 12,
              fontFamily: "IosevkaAile-Regular",
            }}
          >
            {all.length}
          </Text>
        </View>

        {/* Filter chips */}
        <View
          style={{
            flexDirection: "row",
            gap: 6,
            paddingHorizontal: 16,
            paddingVertical: 10,
          }}
        >
          {FILTERS.map((f) => (
            <Pressable
              key={f.key}
              onPress={() => setFilter(f.key)}
              style={{
                paddingHorizontal: 12,
                paddingVertical: 6,
                borderRadius: 999,
                backgroundColor: filter === f.key ? colors.accent : colors.surface,
              }}
            >
              <Text
                style={{
                  color: filter === f.key ? colors.bg : colors.textDim,
                  fontFamily: "IosevkaAile-Bold",
                  fontSize: 11,
                }}
              >
                {f.label}
              </Text>
            </Pressable>
          ))}
        </View>

        <ScrollView contentContainerStyle={{ padding: 16, gap: 6 }}>
          {filtered.length === 0 && (
            <Text
              style={{
                color: colors.textDim,
                fontFamily: "IosevkaAile-Regular",
                fontSize: 12,
                paddingVertical: 24,
                textAlign: "center",
              }}
            >
              No notifications.
            </Text>
          )}
          {filtered.map((n) => {
            const Icon = KIND_ICON[n.kind] ?? Bell;
            const isError = n.kind === "scheduled_task_error";
            const tint = isError ? colors.error : colors.textDim;
            return (
              <Pressable
                key={n.id}
                onPress={() => onTap(n)}
                style={({ pressed }) => ({
                  flexDirection: "row",
                  gap: 10,
                  padding: 12,
                  backgroundColor:
                    n.status === "new" ? colors.surfaceAlt : colors.surface,
                  borderRadius: 12,
                  opacity: pressed ? 0.5 : 1,
                })}
              >
                <View style={{ marginTop: 2 }}>
                  <Icon size={14} color={tint} />
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <View
                    style={{
                      flexDirection: "row",
                      gap: 8,
                      alignItems: "center",
                    }}
                  >
                    <Text
                      style={{
                        flex: 1,
                        color: colors.text,
                        fontSize: 13,
                        fontFamily: "IosevkaAile-Bold",
                      }}
                      numberOfLines={1}
                    >
                      {n.title}
                    </Text>
                    <Text
                      style={{
                        color: colors.textFaint,
                        fontSize: 10,
                        fontFamily: "IosevkaAile-Regular",
                      }}
                    >
                      {timeAgo(n.createdAt)}
                    </Text>
                  </View>
                  <Text
                    style={{
                      color: colors.textDim,
                      fontSize: 11,
                      fontFamily: "IosevkaAile-Regular",
                      lineHeight: 16,
                    }}
                    numberOfLines={3}
                  >
                    {n.body}
                  </Text>
                  <View
                    style={{
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 6,
                      marginTop: 4,
                    }}
                  >
                    <Text
                      style={{
                        color: colors.textFaint,
                        fontSize: 9,
                        fontFamily: "IosevkaAile-Bold",
                        textTransform: "uppercase",
                      }}
                    >
                      {KIND_LABEL[n.kind]}
                    </Text>
                    {n.source?.type && (
                      <Text
                        style={{
                          color: colors.textFaint,
                          fontSize: 9,
                          fontFamily: "IosevkaAile-Regular",
                        }}
                      >
                        · {n.source.type}
                      </Text>
                    )}
                  </View>
                </View>
              </Pressable>
            );
          })}
        </ScrollView>

        {openMonitor && (
          <MonitorDetailScreen
            monitor={openMonitor}
            onClose={() => setOpenMonitor(null)}
          />
        )}
      </View>
    </Modal>
  );
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}
