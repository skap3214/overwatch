import React, { useRef, useState } from "react";
import { View, ActivityIndicator } from "react-native";
import { useConversationStore } from "../stores/conversation";
import { useColors } from "../theme";
import { GlassSurface } from "./GlassSurface";
import * as Haptics from "expo-haptics";
import { Mic, Square, Trash2, ChevronLeft, ChevronRight } from "lucide-react-native";

type Props = {
  onStartRecording: () => void;
  onStopRecording: () => void;
  onCancelRecording: () => void;
  amplitude: number;
  hand: "left" | "right";
};

const BTN = 46;
const CANCEL_THRESHOLD = 80;
const TRASH_SIZE = 32;
const ARROW_REST = 30;
const TRASH_REST = CANCEL_THRESHOLD + 12;

function blend(a: string, b: string, t: number): string {
  const parse = (h: string) => {
    const n = parseInt(h.slice(1), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  };
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const mix = (x: number, y: number) => Math.round(x + (y - x) * t);
  const out = (mix(ar, br) << 16) | (mix(ag, bg) << 8) | mix(ab, bb);
  return `#${out.toString(16).padStart(6, "0")}`;
}

export function PTTButton({
  onStartRecording,
  onStopRecording,
  onCancelRecording,
  amplitude,
  hand,
}: Props) {
  const colors = useColors();
  const turnState = useConversationStore((s) => s.turnState);
  const isRemoteMuted = useConversationStore((s) => s.isRemoteMuted);

  const isPreparing = turnState === "preparing";
  const isRecording = turnState === "recording";
  const isActive = isPreparing || isRecording;

  const cancelDir = hand === "right" ? -1 : 1;
  const Arrow = cancelDir === -1 ? ChevronLeft : ChevronRight;

  const startXRef = useRef(0);
  const willCancelRef = useRef(false);
  const [dragX, setDragX] = useState(0);
  const [willCancel, setWillCancel] = useState(false);

  const cancelDx = Math.max(0, dragX * cancelDir);
  const progress = Math.min(cancelDx / CANCEL_THRESHOLD, 1);

  const handleGrant = (e: { nativeEvent: { pageX: number } }) => {
    startXRef.current = e.nativeEvent.pageX;
    willCancelRef.current = false;
    setWillCancel(false);
    setDragX(0);
    if (isActive) return;
    if (isRemoteMuted) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    onStartRecording();
  };

  const handleMove = (e: { nativeEvent: { pageX: number } }) => {
    const dx = e.nativeEvent.pageX - startXRef.current;
    setDragX(dx);
    const next = dx * cancelDir > CANCEL_THRESHOLD;
    if (next !== willCancelRef.current) {
      willCancelRef.current = next;
      setWillCancel(next);
      Haptics.selectionAsync();
    }
  };

  const handleRelease = () => {
    if (!isRecording && !isPreparing) return;
    if (willCancelRef.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      onCancelRecording();
    } else {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onStopRecording();
    }
    willCancelRef.current = false;
    setWillCancel(false);
    setDragX(0);
  };

  const handleTerminate = () => {
    if (isRecording || isPreparing) onCancelRecording();
    willCancelRef.current = false;
    setWillCancel(false);
    setDragX(0);
  };

  const responderProps = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderGrant: handleGrant,
    onResponderMove: handleMove,
    onResponderRelease: handleRelease,
    onResponderTerminate: handleTerminate,
  };

  if (isActive) {
    const scale = isRecording ? 1 + amplitude * 0.15 : 1;
    const recordingBg = isRecording
      ? blend(colors.accent, colors.error, progress)
      : colors.surface;

    const arrowTranslate = cancelDir * ARROW_REST + dragX * 0.25;
    const arrowOpacity = Math.max(0, 0.55 - progress * 0.55);

    const trashTranslate = cancelDir * TRASH_REST;
    const trashOpacity = 0.4 + progress * 0.6;
    const trashIconColor = willCancel
      ? colors.bg
      : blend(colors.textDim, colors.error, progress);
    const trashBg = willCancel ? colors.error : "transparent";
    const trashBorder = willCancel ? "transparent" : colors.border;

    return (
      <View
        style={{
          width: BTN,
          height: BTN,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Trash target at the end of the swipe */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            alignItems: "center",
            justifyContent: "center",
            opacity: trashOpacity,
            transform: [
              { translateX: trashTranslate },
              { scale: willCancel ? 1.12 : 1 },
            ],
          }}
        >
          <View
            style={{
              width: TRASH_SIZE,
              height: TRASH_SIZE,
              borderRadius: TRASH_SIZE / 2,
              backgroundColor: trashBg,
              borderWidth: 1,
              borderColor: trashBorder,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Trash2 size={16} color={trashIconColor} />
          </View>
        </View>

        {/* Faint directional arrow */}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            left: 0,
            right: 0,
            alignItems: "center",
            justifyContent: "center",
            opacity: arrowOpacity,
            transform: [{ translateX: arrowTranslate }],
          }}
        >
          <Arrow size={20} color={colors.textDim} />
        </View>

        {/* Button */}
        {isRecording ? (
          <View
            {...responderProps}
            style={{
              width: BTN,
              height: BTN,
              borderRadius: BTN / 2,
              backgroundColor: recordingBg,
              alignItems: "center",
              justifyContent: "center",
              transform: [{ scale }],
            }}
          >
            <Square size={14} color={colors.bg} fill={colors.bg} />
          </View>
        ) : (
          <View {...responderProps}>
            <GlassSurface
              isInteractive
              style={{
                width: BTN,
                height: BTN,
                borderRadius: BTN / 2,
                alignItems: "center",
                justifyContent: "center",
              }}
              fallbackStyle={{ backgroundColor: colors.surface }}
              tintColor={colors.surface}
            >
              <ActivityIndicator size="small" color={colors.textDim} />
            </GlassSurface>
          </View>
        )}
      </View>
    );
  }

  return (
    <View {...responderProps}>
      <GlassSurface
        isInteractive
        style={{
          width: BTN,
          height: BTN,
          borderRadius: BTN / 2,
          alignItems: "center",
          justifyContent: "center",
        }}
        fallbackStyle={{ backgroundColor: colors.surface }}
        tintColor={colors.surface}
      >
        <Mic size={20} color={colors.text} />
      </GlassSurface>
    </View>
  );
}
