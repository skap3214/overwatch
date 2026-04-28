import React from "react";
import { Pressable, Text, View } from "react-native";
import { Cpu, Check } from "lucide-react-native";
import { useColors, type Colors } from "../theme";
import { useHarnessStore } from "../stores/harness-store";
import type { AgentProviderInfo, HarnessCapabilities } from "../types";

const CAPS: Array<{ key: keyof HarnessCapabilities; label: string }> = [
  { key: "hasNativeCron", label: "Cron" },
  { key: "hasNativeSkills", label: "Skills" },
  { key: "hasNativeMemory", label: "Memory" },
  { key: "hasSessionContinuity", label: "Sessions" },
  { key: "emitsReasoning", label: "Reasoning" },
];

/**
 * HarnessInfoSection — picker UI for the agent harness, modelled after the
 * terminal selector in `setup.ts`. Renders the live provider registry from the
 * backend (`harness.snapshot.providers`), with the active one highlighted.
 *
 * Switching providers requires a backend restart, so for now this is a
 * read-only display + install hint. Tapping a not-installed row shows the
 * install instruction. Future enhancement: a real "Switch" affordance that
 * calls a backend `/api/v1/config/harness` endpoint.
 */
export function HarnessInfoSection() {
  const colors = useColors();
  const active = useHarnessStore((s) => s.active);
  const providers = useHarnessStore((s) => s.providers);

  return (
    <View
      style={{
        gap: 10,
        backgroundColor: colors.surface,
        borderRadius: 16,
        padding: 16,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text
          style={{
            color: colors.textDim,
            fontSize: 12,
            fontFamily: "IosevkaAile-Regular",
            textTransform: "uppercase",
            letterSpacing: 1,
            flex: 1,
          }}
        >
          Agent
        </Text>
        <Text
          style={{
            color: colors.textFaint,
            fontSize: 10,
            fontFamily: "IosevkaAile-Regular",
          }}
        >
          {providers.length} available
        </Text>
      </View>

      <View style={{ gap: 8 }}>
        {providers.map((provider) => (
          <ProviderRow
            key={provider.id}
            provider={provider}
            active={provider.id === active}
            colors={colors}
          />
        ))}
      </View>

      <Text
        style={{
          color: colors.textFaint,
          fontFamily: "IosevkaAile-Regular",
          fontSize: 10,
          lineHeight: 14,
        }}
      >
        To switch agents, run `overwatch agent set <id>` or use
        `overwatch setup --agent <id>`, then restart.
      </Text>
    </View>
  );
}

function ProviderRow({
  provider,
  active,
  colors,
}: {
  provider: AgentProviderInfo;
  active: boolean;
  colors: Colors;
}) {
  const [showInstall, setShowInstall] = React.useState(false);
  const installable = !provider.installed && !!provider.installInstruction;

  return (
    <Pressable
      onPress={() => {
        if (installable) setShowInstall((v) => !v);
      }}
      style={({ pressed }) => ({
        backgroundColor: active ? colors.surfaceAlt : colors.bg,
        borderRadius: 12,
        padding: 12,
        borderWidth: 1,
        borderColor: active ? colors.accent + "55" : colors.border,
        opacity: pressed && installable ? 0.7 : 1,
      })}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
        }}
      >
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: 10,
            backgroundColor: colors.surface,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {active ? (
            <Check size={16} color={colors.success} />
          ) : (
            <Cpu
              size={16}
              color={provider.installed ? colors.text : colors.textFaint}
            />
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text
            style={{
              color: provider.installed ? colors.text : colors.textDim,
              fontFamily: "IosevkaAile-Bold",
              fontSize: 13,
            }}
          >
            {provider.name}
          </Text>
          <Text
            style={{
              color: colors.textDim,
              fontFamily: "IosevkaAile-Regular",
              fontSize: 11,
            }}
            numberOfLines={1}
          >
            {provider.tagline}
          </Text>
        </View>
        <View style={{ flexDirection: "row", gap: 4 }}>
          {active && (
            <Pill
              text="Active"
              tone="success"
              colors={colors}
            />
          )}
          {!active && provider.installed && (
            <Pill text="Installed" tone="info" colors={colors} />
          )}
          {!provider.installed && (
            <Pill text="Not installed" tone="warning" colors={colors} />
          )}
        </View>
      </View>

      <Text
        style={{
          color: colors.textFaint,
          fontFamily: "IosevkaAile-Regular",
          fontSize: 11,
          lineHeight: 16,
          marginTop: 6,
        }}
      >
        {provider.description}
      </Text>

      {/* Capability chips */}
      <View
        style={{
          flexDirection: "row",
          flexWrap: "wrap",
          gap: 4,
          marginTop: 8,
        }}
      >
        {CAPS.map(({ key, label }) => {
          const has = !!provider.capabilities[key];
          return (
            <View
              key={key}
              style={{
                paddingHorizontal: 6,
                paddingVertical: 2,
                borderRadius: 999,
                borderWidth: 1,
                borderColor: has ? colors.success + "55" : colors.border,
                backgroundColor: has ? colors.success + "11" : "transparent",
              }}
            >
              <Text
                style={{
                  color: has ? colors.success : colors.textFaint,
                  fontFamily: "IosevkaAile-Bold",
                  fontSize: 9,
                }}
              >
                {label}
              </Text>
            </View>
          );
        })}
      </View>

      {showInstall && installable && (
        <View
          style={{
            marginTop: 8,
            padding: 8,
            backgroundColor: colors.surface,
            borderRadius: 8,
          }}
        >
          <Text
            style={{
              color: colors.textDim,
              fontFamily: "IosevkaAile-Bold",
              fontSize: 10,
              textTransform: "uppercase",
              letterSpacing: 0.5,
              marginBottom: 4,
            }}
          >
            Install
          </Text>
          <Text
            style={{
              color: colors.text,
              fontFamily: "IosevkaAile-Regular",
              fontSize: 11,
              lineHeight: 16,
            }}
            selectable
          >
            {provider.installInstruction}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

function Pill({
  text,
  tone,
  colors,
}: {
  text: string;
  tone: "success" | "info" | "warning";
  colors: Colors;
}) {
  const tint =
    tone === "success"
      ? colors.success
      : tone === "warning"
        ? "#eab308"
        : colors.textDim;
  return (
    <View
      style={{
        paddingHorizontal: 6,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tint + "55",
        backgroundColor: tint + "11",
      }}
    >
      <Text
        style={{
          color: tint,
          fontFamily: "IosevkaAile-Bold",
          fontSize: 9,
        }}
      >
        {text}
      </Text>
    </View>
  );
}
