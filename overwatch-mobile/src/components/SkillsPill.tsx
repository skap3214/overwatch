import React, { useState } from "react";
import {
  Modal,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { ArrowLeft, Sparkles } from "lucide-react-native";
import { useColors } from "../theme";
import { useSkillsStore } from "../stores/skills-store";
import { useHarnessStore } from "../stores/harness-store";

/**
 * SkillsPill — small status indicator for the active harness's installed skills.
 *
 * Only visible when the harness has `hasNativeSkills: true` (currently:
 * `hermes` and `claude-code-cli`). Tapping opens a modal with the full list
 * (read-only). The pill itself shows e.g. "Hermes • 72 skills".
 */

export function SkillsPill() {
  const colors = useColors();
  const provider = useHarnessStore((s) => s.active);
  const capabilities = useHarnessStore((s) => s.capabilities);
  const skills = useSkillsStore((s) => s.skills);
  const [open, setOpen] = useState(false);

  if (!capabilities.hasNativeSkills || skills.length === 0) return null;

  const label = provider === "hermes" ? "Hermes" : provider;

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          paddingHorizontal: 8,
          paddingVertical: 4,
          borderRadius: 999,
          backgroundColor: colors.surface,
          borderWidth: 1,
          borderColor: colors.border,
          opacity: pressed ? 0.5 : 1,
        })}
        hitSlop={6}
      >
        <Sparkles size={11} color={colors.textDim} />
        <Text
          style={{
            color: colors.textDim,
            fontSize: 10,
            fontFamily: "IosevkaAile-Bold",
          }}
        >
          {label} · {skills.length}
        </Text>
      </Pressable>

      <Modal
        visible={open}
        animationType="slide"
        presentationStyle="formSheet"
        onRequestClose={() => setOpen(false)}
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
            <Pressable onPress={() => setOpen(false)} hitSlop={8}>
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
              {label} skills
            </Text>
            <Text
              style={{
                color: colors.textDim,
                fontSize: 12,
                fontFamily: "IosevkaAile-Regular",
              }}
            >
              {skills.length}
            </Text>
          </View>

          <ScrollView contentContainerStyle={{ padding: 16, gap: 8 }}>
            <Text
              style={{
                color: colors.textDim,
                fontFamily: "IosevkaAile-Regular",
                fontSize: 11,
                lineHeight: 16,
                marginBottom: 8,
              }}
            >
              Skills are installed and managed by {label}. Edit them via the{" "}
              {label} CLI or dashboard — Overwatch only reads the list.
            </Text>
            {groupByCategory(skills).map(([category, list]) => (
              <View key={category} style={{ marginTop: 12 }}>
                <Text
                  style={{
                    color: colors.textDim,
                    fontFamily: "IosevkaAile-Bold",
                    fontSize: 10,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    marginBottom: 8,
                  }}
                >
                  {category}
                </Text>
                {list.map((skill) => (
                  <View
                    key={`${category}/${skill.name}`}
                    style={{
                      backgroundColor: colors.surface,
                      borderRadius: 10,
                      padding: 12,
                      marginBottom: 6,
                      gap: 4,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: 8,
                      }}
                    >
                      <Text
                        style={{
                          flex: 1,
                          color: colors.text,
                          fontFamily: "IosevkaAile-Bold",
                          fontSize: 13,
                        }}
                      >
                        {skill.name}
                      </Text>
                      {skill.version && (
                        <Text
                          style={{
                            color: colors.textFaint,
                            fontFamily: "IosevkaAile-Regular",
                            fontSize: 10,
                          }}
                        >
                          v{skill.version}
                        </Text>
                      )}
                    </View>
                    {skill.description && (
                      <Text
                        style={{
                          color: colors.textDim,
                          fontFamily: "IosevkaAile-Regular",
                          fontSize: 11,
                          lineHeight: 16,
                        }}
                      >
                        {skill.description}
                      </Text>
                    )}
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </>
  );
}

function groupByCategory(skills: { name: string; category: string; description: string; version?: string }[]) {
  const map = new Map<string, typeof skills>();
  for (const skill of skills) {
    const list = map.get(skill.category) ?? [];
    list.push(skill);
    map.set(skill.category, list);
  }
  return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
}
