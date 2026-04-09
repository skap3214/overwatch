import React, { useState, useCallback, useMemo } from "react";
import { View, Text, Pressable } from "react-native";
import BottomSheet, { BottomSheetView, BottomSheetTextInput } from "@gorhom/bottom-sheet";
import { Sun, Moon, Monitor } from "lucide-react-native";
import { useConnectionStore } from "../stores/connection-store";
import { useThemeStore, type ThemeMode } from "../stores/theme-store";
import { useColors } from "../theme";

type Props = {
  sheetRef: React.RefObject<BottomSheet | null>;
};

const THEME_OPTIONS: { mode: ThemeMode; Icon: typeof Sun }[] = [
  { mode: "light", Icon: Sun },
  { mode: "dark", Icon: Moon },
  { mode: "system", Icon: Monitor },
];

export function SettingsSheet({ sheetRef }: Props) {
  const colors = useColors();
  const { backendURL, setBackendURL, connectionStatus, checkHealth } = useConnectionStore();
  const { mode: themeMode, setMode: setThemeMode } = useThemeStore();
  const [urlInput, setUrlInput] = useState(backendURL);
  const snapPoints = useMemo(() => ["50%"], []);

  const handleSave = useCallback(async () => {
    await setBackendURL(urlInput);
    sheetRef.current?.close();
  }, [urlInput, setBackendURL, sheetRef]);

  const handleChange = useCallback((_index: number) => {
    setUrlInput(useConnectionStore.getState().backendURL);
  }, []);

  return (
    <BottomSheet
      ref={sheetRef}
      index={-1}
      snapPoints={snapPoints}
      enablePanDownToClose
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      onChange={handleChange}
      backgroundStyle={{ backgroundColor: colors.surface, borderRadius: 20 }}
      handleIndicatorStyle={{ backgroundColor: colors.textFaint }}
    >
      <BottomSheetView style={{ padding: 20, gap: 20 }}>
        <Text style={{ color: colors.text, fontSize: 16, fontFamily: "IosevkaAile-Regular", fontWeight: "600" }}>
          Settings
        </Text>

        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular" }}>Backend URL</Text>
          <BottomSheetTextInput
            value={urlInput}
            onChangeText={setUrlInput}
            placeholder="http://100.x.x.x:8787"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            style={{
              backgroundColor: colors.bg, color: colors.text, fontFamily: "IosevkaAile-Regular", fontSize: 14,
              paddingHorizontal: 14, paddingVertical: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12,
            }}
          />
          <View style={{ flexDirection: "row", gap: 10 }}>
            <Pressable
              onPress={handleSave}
              style={{ flex: 1, backgroundColor: colors.accent, paddingVertical: 12, alignItems: "center", borderRadius: 12 }}
            >
              <Text style={{ color: colors.bg, fontFamily: "IosevkaAile-Regular", fontSize: 13, fontWeight: "600" }}>Save</Text>
            </Pressable>
            <Pressable
              onPress={() => checkHealth()}
              style={{ flex: 1, backgroundColor: colors.border, paddingVertical: 12, alignItems: "center", borderRadius: 12 }}
            >
              <Text style={{ color: colors.text, fontFamily: "IosevkaAile-Regular", fontSize: 13 }}>Test</Text>
            </Pressable>
          </View>
          <Text
            style={{
              color: connectionStatus === "connected" ? colors.success : connectionStatus === "error" ? colors.error : colors.textDim,
              fontSize: 11, fontFamily: "IosevkaAile-Regular", textAlign: "center",
            }}
          >
            {connectionStatus}
          </Text>
        </View>

        <View style={{ gap: 8 }}>
          <Text style={{ color: colors.textDim, fontSize: 12, fontFamily: "IosevkaAile-Regular" }}>Theme</Text>
          <View
            style={{
              flexDirection: "row", backgroundColor: colors.bg, borderRadius: 12,
              borderWidth: 1, borderColor: colors.border, padding: 4,
            }}
          >
            {THEME_OPTIONS.map(({ mode, Icon }) => {
              const selected = themeMode === mode;
              return (
                <Pressable
                  key={mode}
                  onPress={() => setThemeMode(mode)}
                  style={{
                    flex: 1, alignItems: "center", justifyContent: "center",
                    paddingVertical: 10, borderRadius: 8,
                    backgroundColor: selected ? colors.border : "transparent",
                  }}
                >
                  <Icon size={16} color={selected ? colors.text : colors.textFaint} />
                </Pressable>
              );
            })}
          </View>
        </View>
      </BottomSheetView>
    </BottomSheet>
  );
}
