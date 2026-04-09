import React, { useState, useCallback } from "react";
import { View, Text, TextInput, Pressable, ScrollView, Keyboard } from "react-native";
import { Sun, Moon, Monitor, ChevronRight, Hand } from "lucide-react-native";
import { useConnectionStore } from "../stores/connection-store";
import { useThemeStore, type ThemeMode } from "../stores/theme-store";
import { useColors } from "../theme";

type Props = {
  onClose: () => void;
};

const THEME_OPTIONS: { mode: ThemeMode; Icon: typeof Sun }[] = [
  { mode: "light", Icon: Sun },
  { mode: "dark", Icon: Moon },
  { mode: "system", Icon: Monitor },
];

export function SettingsPage({ onClose }: Props) {
  const colors = useColors();
  const { backendURL, setBackendURL, connectionStatus, checkHealth } = useConnectionStore();
  const { mode: themeMode, setMode: setThemeMode, hand, setHand } = useThemeStore();
  const [urlInput, setUrlInput] = useState(backendURL);

  const handleSave = useCallback(async () => {
    Keyboard.dismiss();
    await setBackendURL(urlInput);
  }, [urlInput, setBackendURL]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: 20, gap: 24 }}
      keyboardDismissMode="on-drag"
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ color: colors.text, fontSize: 22, fontFamily: "IosevkaAile-Bold" }}>
          Settings
        </Text>
        <Pressable onPress={onClose} style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={{ color: colors.textDim, fontSize: 14, fontFamily: "IosevkaAile-Regular" }}>Chat</Text>
          <ChevronRight size={16} color={colors.textDim} />
        </Pressable>
      </View>

      {/* Backend URL */}
      <View style={{ gap: 10, backgroundColor: colors.surface, borderRadius: 16, padding: 16 }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular", textTransform: "uppercase", letterSpacing: 1 }}>
          Connection
        </Text>
        <TextInput
          value={urlInput}
          onChangeText={setUrlInput}
          placeholder="http://100.x.x.x:8787"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          style={{
            backgroundColor: colors.bg, color: colors.text, fontFamily: "IosevkaAile-Regular", fontSize: 14,
            paddingHorizontal: 14, paddingVertical: 12, borderRadius: 12,
          }}
        />
        <View style={{ flexDirection: "row", gap: 10 }}>
          <Pressable
            onPress={handleSave}
            style={{ flex: 1, backgroundColor: colors.accent, paddingVertical: 12, alignItems: "center", borderRadius: 12 }}
          >
            <Text style={{ color: colors.bg, fontFamily: "IosevkaAile-Medium", fontSize: 14 }}>Save</Text>
          </Pressable>
          <Pressable
            onPress={() => checkHealth()}
            style={{ flex: 1, backgroundColor: colors.bg, paddingVertical: 12, alignItems: "center", borderRadius: 12 }}
          >
            <Text style={{ color: colors.text, fontFamily: "IosevkaAile-Regular", fontSize: 14 }}>Test</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6 }}>
          <View style={{
            width: 8, height: 8, borderRadius: 4,
            backgroundColor: connectionStatus === "connected" ? colors.success : connectionStatus === "error" ? colors.error : colors.textDim,
          }} />
          <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular" }}>
            {connectionStatus}
          </Text>
        </View>
      </View>

      {/* Theme */}
      <View style={{ gap: 10, backgroundColor: colors.surface, borderRadius: 16, padding: 16 }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular", textTransform: "uppercase", letterSpacing: 1 }}>
          Appearance
        </Text>
        <View style={{ flexDirection: "row", backgroundColor: colors.bg, borderRadius: 12, padding: 4 }}>
          {THEME_OPTIONS.map(({ mode, Icon }) => {
            const selected = themeMode === mode;
            return (
              <Pressable
                key={mode}
                onPress={() => setThemeMode(mode)}
                style={{
                  flex: 1, alignItems: "center", justifyContent: "center",
                  paddingVertical: 12, borderRadius: 8,
                  backgroundColor: selected ? colors.surfaceAlt : "transparent",
                }}
              >
                <Icon size={18} color={selected ? colors.text : colors.textFaint} />
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Hand preference */}
      <View style={{ gap: 10, backgroundColor: colors.surface, borderRadius: 16, padding: 16 }}>
        <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular", textTransform: "uppercase", letterSpacing: 1 }}>
          Mic position
        </Text>
        <View style={{ flexDirection: "row", backgroundColor: colors.bg, borderRadius: 12, padding: 4 }}>
          {(["left", "right"] as const).map((side) => {
            const selected = hand === side;
            return (
              <Pressable
                key={side}
                onPress={() => setHand(side)}
                style={{
                  flex: 1, alignItems: "center", justifyContent: "center",
                  paddingVertical: 12, borderRadius: 8,
                  backgroundColor: selected ? colors.surfaceAlt : "transparent",
                  flexDirection: "row", gap: 6,
                }}
              >
                <Hand size={16} color={selected ? colors.text : colors.textFaint} style={side === "left" ? { transform: [{ scaleX: -1 }] } : undefined} />
                <Text style={{ color: selected ? colors.text : colors.textFaint, fontSize: 13, fontFamily: "IosevkaAile-Regular" }}>
                  {side === "left" ? "Left" : "Right"}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}
