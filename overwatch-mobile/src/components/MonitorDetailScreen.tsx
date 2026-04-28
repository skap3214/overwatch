import React, { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import {
  ArrowLeft,
  Pause,
  Play,
  Zap,
  Trash2,
  ChevronRight,
  XCircle,
  CheckCircle,
} from "lucide-react-native";
import { useColors } from "../theme";
import { monitorsApi } from "../services/monitors-api";
import type { JobRun, ScheduledMonitor } from "../types";

type Props = {
  monitor: ScheduledMonitor | null;
  onClose: () => void;
  onEdit?: (monitor: ScheduledMonitor) => void;
};

export function MonitorDetailScreen({ monitor, onClose, onEdit }: Props) {
  const colors = useColors();
  const [runs, setRuns] = useState<JobRun[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [openRun, setOpenRun] = useState<JobRun | null>(null);

  useEffect(() => {
    if (!monitor) return;
    setLoading(true);
    monitorsApi
      .listRuns(monitor.id)
      .then((r) => setRuns(r.runs))
      .catch((err) => console.warn("listRuns failed", err))
      .finally(() => setLoading(false));
  }, [monitor]);

  if (!monitor) return null;

  const runAction = async (
    label: string,
    op: () => Promise<unknown>,
  ): Promise<void> => {
    setBusy(true);
    try {
      await op();
    } catch (err) {
      Alert.alert(label, err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  };

  const onPause = () => runAction("Pause", () => monitorsApi.pause(monitor.id));
  const onResume = () => runAction("Resume", () => monitorsApi.resume(monitor.id));
  const onRunNow = () => runAction("Run now", () => monitorsApi.run(monitor.id));
  const onDelete = () =>
    Alert.alert(
      "Delete monitor",
      `Delete "${monitor.title}"?`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () =>
            runAction("Delete", async () => {
              await monitorsApi.remove(monitor.id);
              onClose();
            }),
        },
      ],
    );

  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="formSheet"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        {/* Header */}
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
            numberOfLines={1}
          >
            {monitor.title}
          </Text>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 16 }}
          showsVerticalScrollIndicator={false}
        >
          {/* Status row */}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            <Badge
              text={monitor.paused ? "Paused" : monitor.state ?? "Scheduled"}
              tone={monitor.paused ? "warning" : "info"}
              colors={colors}
            />
            {monitor.lastStatus === "ok" && (
              <Badge text="Last ok" tone="success" colors={colors} />
            )}
            {monitor.lastStatus === "error" && (
              <Badge text="Last error" tone="error" colors={colors} />
            )}
            {monitor.recurring && (
              <Badge text="Recurring" tone="info" colors={colors} />
            )}
            {monitor.source && (
              <Badge text={monitor.source} tone="info" colors={colors} />
            )}
          </View>

          {/* Schedule */}
          <Section title="Schedule" colors={colors}>
            <KV label="Schedule" value={monitor.scheduleLabel} colors={colors} />
            <KV
              label="Next run"
              value={formatTime(monitor.nextRunAt)}
              colors={colors}
            />
            <KV
              label="Last run"
              value={formatTime(monitor.lastFiredAt)}
              colors={colors}
            />
            {monitor.repeat && (
              <KV
                label="Repeat"
                value={`${monitor.repeat.completed} / ${monitor.repeat.times ?? "∞"}`}
                colors={colors}
              />
            )}
            {monitor.lastError && (
              <KV
                label="Last error"
                value={monitor.lastError}
                colors={colors}
                error
              />
            )}
          </Section>

          {/* Actions */}
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {monitor.paused ? (
              <ActionButton
                onPress={onResume}
                disabled={busy}
                colors={colors}
                icon={<Play size={14} color={colors.text} />}
                text="Resume"
              />
            ) : (
              <ActionButton
                onPress={onPause}
                disabled={busy}
                colors={colors}
                icon={<Pause size={14} color={colors.text} />}
                text="Pause"
              />
            )}
            <ActionButton
              onPress={onRunNow}
              disabled={busy}
              colors={colors}
              icon={<Zap size={14} color={colors.text} />}
              text="Run now"
            />
            {onEdit && (
              <ActionButton
                onPress={() => onEdit(monitor)}
                disabled={busy}
                colors={colors}
                text="Edit"
              />
            )}
            <ActionButton
              onPress={onDelete}
              disabled={busy}
              colors={colors}
              icon={<Trash2 size={14} color={colors.error} />}
              text="Delete"
              dangerous
            />
          </View>

          {/* Runs */}
          <Section title="Run history" colors={colors}>
            {loading && <ActivityIndicator color={colors.textDim} />}
            {!loading && runs.length === 0 && (
              <Text
                style={{
                  color: colors.textDim,
                  fontFamily: "IosevkaAile-Regular",
                  fontSize: 12,
                }}
              >
                No runs yet.
              </Text>
            )}
            {runs.map((run) => (
              <Pressable
                key={run.id}
                onPress={() => setOpenRun(run)}
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  paddingVertical: 10,
                  borderBottomWidth: 1,
                  borderBottomColor: colors.border,
                  gap: 8,
                }}
              >
                <Text
                  style={{
                    flex: 1,
                    color: colors.text,
                    fontFamily: "IosevkaAile-Regular",
                    fontSize: 12,
                  }}
                >
                  {formatTime(run.ranAt)}
                </Text>
                <ChevronRight size={14} color={colors.textFaint} />
              </Pressable>
            ))}
          </Section>
        </ScrollView>

        {openRun && (
          <RunOutputModal
            jobId={monitor.id}
            run={openRun}
            onClose={() => setOpenRun(null)}
          />
        )}
      </View>
    </Modal>
  );
}

function RunOutputModal({
  jobId,
  run,
  onClose,
}: {
  jobId: string;
  run: JobRun;
  onClose: () => void;
}) {
  const colors = useColors();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    monitorsApi
      .readRun(jobId, run.id)
      .then((r) => setContent(r.content))
      .catch((err) => setError(err instanceof Error ? err.message : "read failed"));
  }, [jobId, run.id]);

  return (
    <Modal animationType="slide" onRequestClose={onClose}>
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
              fontSize: 14,
              fontFamily: "IosevkaAile-Bold",
            }}
          >
            Run {formatTime(run.ranAt)}
          </Text>
        </View>
        <ScrollView contentContainerStyle={{ padding: 16 }}>
          {!content && !error && <ActivityIndicator color={colors.textDim} />}
          {error && (
            <Text
              style={{
                color: colors.error,
                fontFamily: "IosevkaAile-Regular",
                fontSize: 12,
              }}
            >
              {error}
            </Text>
          )}
          {content && (
            <Text
              style={{
                color: colors.text,
                fontFamily: "IosevkaAile-Regular",
                fontSize: 13,
                lineHeight: 20,
              }}
              selectable
            >
              {content}
            </Text>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function Section({
  title,
  colors,
  children,
}: {
  title: string;
  colors: ReturnType<typeof useColors>;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Text
        style={{
          color: colors.textDim,
          fontFamily: "IosevkaAile-Bold",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {title}
      </Text>
      <View
        style={{
          backgroundColor: colors.surface,
          borderRadius: 12,
          padding: 12,
          gap: 8,
        }}
      >
        {children}
      </View>
    </View>
  );
}

function KV({
  label,
  value,
  colors,
  error,
}: {
  label: string;
  value: string;
  colors: ReturnType<typeof useColors>;
  error?: boolean;
}) {
  return (
    <View style={{ flexDirection: "row", gap: 8 }}>
      <Text
        style={{
          width: 92,
          color: colors.textDim,
          fontFamily: "IosevkaAile-Regular",
          fontSize: 12,
        }}
      >
        {label}
      </Text>
      <Text
        style={{
          flex: 1,
          color: error ? colors.error : colors.text,
          fontFamily: "IosevkaAile-Regular",
          fontSize: 12,
        }}
        selectable
      >
        {value}
      </Text>
    </View>
  );
}

function Badge({
  text,
  tone,
  colors,
}: {
  text: string;
  tone: "info" | "success" | "warning" | "error";
  colors: ReturnType<typeof useColors>;
}) {
  const tint =
    tone === "success"
      ? colors.success
      : tone === "warning"
        ? "#eab308"
        : tone === "error"
          ? colors.error
          : colors.textDim;
  const Icon =
    tone === "success" ? CheckCircle : tone === "error" ? XCircle : null;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tint + "55",
        backgroundColor: tint + "11",
      }}
    >
      {Icon && <Icon size={11} color={tint} />}
      <Text
        style={{
          color: tint,
          fontSize: 10,
          fontFamily: "IosevkaAile-Bold",
        }}
      >
        {text}
      </Text>
    </View>
  );
}

function ActionButton({
  onPress,
  disabled,
  colors,
  icon,
  text,
  dangerous,
}: {
  onPress: () => void;
  disabled?: boolean;
  colors: ReturnType<typeof useColors>;
  icon?: React.ReactNode;
  text: string;
  dangerous?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: colors.surface,
        borderRadius: 999,
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {icon}
      <Text
        style={{
          color: dangerous ? colors.error : colors.text,
          fontFamily: "IosevkaAile-Medium",
          fontSize: 12,
        }}
      >
        {text}
      </Text>
    </Pressable>
  );
}

function formatTime(value: string | null | undefined): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}
