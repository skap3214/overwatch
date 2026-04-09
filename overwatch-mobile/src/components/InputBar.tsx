import React, { useState, useRef } from "react";
import { TextInput, Pressable, Keyboard } from "react-native";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";
import { ArrowUp } from "lucide-react-native";

type Props = {
  onSubmit: (text: string) => void;
};

const BTN = 36;

export function InputBar({ onSubmit }: Props) {
  const colors = useColors();
  const [text, setText] = useState("");
  const hasText = text.trim().length > 0;
  const startY = useRef(0);

  const handleSubmit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    setText("");
  };

  return (
    <GlassSurface
      isInteractive
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        borderRadius: 22,
        paddingLeft: 16,
        paddingRight: 6,
        paddingVertical: 5,
      }}
      fallbackStyle={{
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
      }}
      tintColor={colors.surface}
    >
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={handleSubmit}
        placeholder="Message..."
        placeholderTextColor={colors.textFaint}
        returnKeyType="send"
        onTouchStart={(e) => { startY.current = e.nativeEvent.pageY; }}
        onTouchEnd={(e) => {
          const dy = e.nativeEvent.pageY - startY.current;
          if (dy > 30) Keyboard.dismiss();
        }}
        style={{ flex: 1, color: colors.text, fontFamily: "IosevkaAile-Regular", fontSize: 15, paddingVertical: 4 }}
      />
      <Pressable
        onPress={handleSubmit}
        disabled={!hasText}
        style={{
          width: BTN,
          height: BTN,
          borderRadius: BTN / 2,
          backgroundColor: hasText ? colors.accent : "transparent",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <ArrowUp size={18} color={hasText ? colors.bg : colors.textFaint} strokeWidth={2.5} />
      </Pressable>
    </GlassSurface>
  );
}
