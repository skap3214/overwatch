/**
 * Hermes prompt helpers — voice tag wrapping and skill activation.
 *
 * The user's ~/.hermes/SOUL.md defines a `<voice>` convention that tells the
 * agent to respond in speakable form. We wrap the user transcript when the
 * turn originated from a voice channel.
 *
 * Hermes does not auto-activate skills based on session source for the
 * api_server adapter. We work around this by prepending a synthetic
 * activation message on the first turn of each session, mimicking what
 * agent/skill_commands.py:build_skill_invocation_message produces.
 */

export function wrapVoiceTurn(text: string): string {
  return `<voice>${text}</voice>`;
}

export function prependSkillActivation(skillName: string, userInput: string): string {
  return [
    `[SYSTEM: The "${skillName}" skill is active for this Overwatch session. Follow its instructions.]`,
    "",
    `[Skill directory: ~/.hermes/skills/${skillName}]`,
    "",
    "The user has provided the following instruction:",
    userInput,
  ].join("\n");
}
