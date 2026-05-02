# Agent Supervision Plan

**Date:** 2026-04-08
**Status:** Deferred
**Related Docs:** [../insights.md](../insights.md), [../architecture/007-post-overhaul-architecture.md](../architecture/007-post-overhaul-architecture.md)

The earlier supervision-tracker direction has been deferred.

Current policy:

- inspect live tmux state first for session-summary or session-status requests
- use persistent memory only as supplemental context
- keep scheduler support available, but do not treat supervision logs as the source of truth

If supervision returns later, it should not degrade live tmux inspection behavior.
