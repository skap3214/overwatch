import React, { useState } from "react";
import {
  Alert,
  Modal,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from "react-native";
import { ArrowLeft, X } from "lucide-react-native";
import { useColors } from "../theme";
import { monitorsApi } from "../services/monitors-api";
import type { ScheduledMonitor } from "../types";

type Props = {
  monitor: ScheduledMonitor | null; // null = create mode
  onClose: () => void;
  onSaved: () => void;
};

const SCHEDULE_PRESETS: Array<{ label: string; value: string }> = [
  { label: "Every 5 minutes", value: "every 5m" },
  { label: "Every 15 minutes", value: "every 15m" },
  { label: "Every 30 minutes", value: "every 30m" },
  { label: "Every hour", value: "every 1h" },
  { label: "Every day at 9am", value: "0 9 * * *" },
  { label: "Every Monday 9am", value: "0 9 * * 1" },
];

export function MonitorEditForm({ monitor, onClose, onSaved }: Props) {
  const colors = useColors();
  const isEdit = !!monitor;
  const [name, setName] = useState(monitor?.title ?? "");
  const [schedule, setSchedule] = useState(monitor?.scheduleLabel ?? "every 1h");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);

  const onSave = async () => {
    if (!name.trim()) {
      Alert.alert("Required", "Please give the monitor a name.");
      return;
    }
    if (!schedule.trim()) {
      Alert.alert("Required", "Please pick a schedule.");
      return;
    }
    if (!isEdit && !prompt.trim()) {
      Alert.alert("Required", "Please describe what the monitor should do.");
      return;
    }
    setBusy(true);
    try {
      if (isEdit && monitor) {
        await monitorsApi.update(monitor.id, {
          name: name.trim(),
          schedule: schedule.trim(),
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        });
      } else {
        await monitorsApi.create({
          name: name.trim(),
          schedule: schedule.trim(),
          prompt: prompt.trim(),
        });
      }
      onSaved();
      onClose();
    } catch (err) {
      Alert.alert(
        isEdit ? "Update failed" : "Create failed",
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal animationType="slide" presentationStyle="formSheet" onRequestClose={onClose}>
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
            {isEdit ? (
              <ArrowLeft size={20} color={colors.text} />
            ) : (
              <X size={20} color={colors.text} />
            )}
          </Pressable>
          <Text
            style={{
              flex: 1,
              color: colors.text,
              fontSize: 16,
              fontFamily: "IosevkaAile-Bold",
            }}
          >
            {isEdit ? "Edit monitor" : "New monitor"}
          </Text>
          <Pressable
            onPress={onSave}
            disabled={busy}
            hitSlop={8}
            style={{ opacity: busy ? 0.5 : 1 }}
          >
            <Text
              style={{
                color: colors.accent,
                fontFamily: "IosevkaAile-Bold",
                fontSize: 14,
              }}
            >
              {busy ? "…" : "Save"}
            </Text>
          </Pressable>
        </View>

        <ScrollView
          contentContainerStyle={{ padding: 16, gap: 16 }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Field label="Name" colors={colors}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="e.g. Check build status"
              placeholderTextColor={colors.textFaint}
              style={inputStyle(colors)}
            />
          </Field>

          <Field label="Schedule" colors={colors}>
            <TextInput
              value={schedule}
              onChangeText={setSchedule}
              placeholder='"every 30m" or "0 9 * * *"'
              placeholderTextColor={colors.textFaint}
              style={inputStyle(colors)}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
              {SCHEDULE_PRESETS.map((preset) => (
                <Pressable
                  key={preset.value}
                  onPress={() => setSchedule(preset.value)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 999,
                    backgroundColor:
                      schedule === preset.value ? colors.accent : colors.surface,
                  }}
                >
                  <Text
                    style={{
                      color: schedule === preset.value ? colors.bg : colors.textDim,
                      fontFamily: "IosevkaAile-Regular",
                      fontSize: 11,
                    }}
                  >
                    {preset.label}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Field>

          <Field
            label={isEdit ? "Prompt (leave blank to keep)" : "Prompt"}
            colors={colors}
          >
            <TextInput
              value={prompt}
              onChangeText={setPrompt}
              placeholder="What should the agent do when this fires?"
              placeholderTextColor={colors.textFaint}
              multiline
              numberOfLines={4}
              style={[
                inputStyle(colors),
                { minHeight: 100, textAlignVertical: "top" },
              ]}
            />
          </Field>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Field({
  label,
  colors,
  children,
}: {
  label: string;
  colors: ReturnType<typeof useColors>;
  children: React.ReactNode;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Text
        style={{
          color: colors.textDim,
          fontFamily: "IosevkaAile-Bold",
          fontSize: 11,
          textTransform: "uppercase",
          letterSpacing: 0.5,
        }}
      >
        {label}
      </Text>
      {children}
    </View>
  );
}

function inputStyle(colors: ReturnType<typeof useColors>) {
  return {
    backgroundColor: colors.surface,
    color: colors.text,
    fontFamily: "IosevkaAile-Regular" as const,
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: colors.border,
  };
}
