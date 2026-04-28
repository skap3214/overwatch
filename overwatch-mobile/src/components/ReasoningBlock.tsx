import React, { useEffect, useRef, useState } from "react";
import { Animated, Pressable, Text, View } from "react-native";
import { ChevronRight, ChevronDown, Brain } from "lucide-react-native";
import type { Colors } from "../theme";

/**
 * ReasoningBlock — renders the agent's internal "thinking" trace.
 *
 * Two states:
 *  - LIVE (no final message text yet): a dim "thinking…" affordance with the
 *    latest reasoning line, subtly pulsing. Anchors the bubble during the
 *    silent gap before the final answer arrives.
 *  - COLLAPSED (final message exists): a small "▸ Show thinking" caret on
 *    the assistant bubble. Tapping expands the full reasoning text below.
 *
 * The text inside this block is NEVER fed to TTS (the TurnCoordinator routes
 * reasoning_delta to socket-only). It's purely visual.
 */

export function ReasoningBlock({
  reasoning,
  hasFinalText,
  colors,
}: {
  reasoning: string;
  hasFinalText: boolean;
  colors: Colors;
}) {
  const [expanded, setExpanded] = useState(false);
  const pulse = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (hasFinalText) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0.5, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [hasFinalText, pulse]);

  if (!reasoning) return null;

  // LIVE state — agent is still reasoning.
  if (!hasFinalText) {
    const lastLine = lastNonEmptyLine(reasoning);
    return (
      <Animated.View
        style={{
          opacity: pulse,
          flexDirection: "row",
          alignItems: "center",
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 8,
        }}
      >
        <Brain size={14} color={colors.textDim} />
        <Text
          style={{
            color: colors.textDim,
            fontSize: 12,
            fontFamily: "IosevkaAile-Italic",
            fontStyle: "italic",
            flex: 1,
          }}
          numberOfLines={1}
        >
          thinking… {lastLine}
        </Text>
      </Animated.View>
    );
  }

  // COLLAPSED state — final text exists, reasoning is hidden behind a caret.
  return (
    <View>
      <Pressable
        onPress={() => setExpanded((e) => !e)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 16,
          paddingTop: 4,
          paddingBottom: expanded ? 4 : 6,
          alignSelf: "flex-start",
        }}
        hitSlop={6}
      >
        {expanded ? (
          <ChevronDown size={12} color={colors.textFaint} />
        ) : (
          <ChevronRight size={12} color={colors.textFaint} />
        )}
        <Text
          style={{
            color: colors.textFaint,
            fontSize: 11,
            fontFamily: "IosevkaAile-Regular",
          }}
        >
          {expanded ? "Hide thinking" : "Show thinking"}
        </Text>
      </Pressable>
      {expanded && (
        <View
          style={{
            paddingHorizontal: 22,
            paddingBottom: 8,
            borderLeftWidth: 1,
            borderLeftColor: colors.border,
            marginLeft: 18,
          }}
        >
          <Text
            style={{
              color: colors.textDim,
              fontSize: 12,
              fontFamily: "IosevkaAile-Italic",
              fontStyle: "italic",
              lineHeight: 18,
            }}
            selectable
          >
            {reasoning}
          </Text>
        </View>
      )}
    </View>
  );
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]!.trim();
    if (trimmed) return trimmed.length > 80 ? trimmed.slice(0, 79) + "…" : trimmed;
  }
  return text.slice(0, 80);
}
