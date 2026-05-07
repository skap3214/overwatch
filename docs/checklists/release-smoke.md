# Release Smoke Checklist

Run this on a real device for iOS/platform changes. The local regression
harness deliberately does not claim to cover native audio-session behavior,
AirPods routing, Daily WebRTC quirks, or native-module crashes.

- [ ] Fresh launch joins a Pipecat room and shows connected state.
- [ ] Push-to-talk starts and stops recording without leaving the orange mic dot stuck on.
- [ ] Barge-in while the bot is speaking stops stale audio immediately.
- [ ] AirPods and built-in speaker/mic routing behave as expected across one reconnect.
- [ ] A typed turn and a spoken turn both reach the same active harness session.
