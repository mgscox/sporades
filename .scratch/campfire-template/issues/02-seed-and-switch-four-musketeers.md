# 02 — Seed and switch between the four Musketeers

**What to build:** Make Campfire immediately demonstrable without real people or real email delivery. An explicit development-data flow creates four deterministic Musketeer identities, channels, and starter conversation exactly once, while the UI lets isolated browser sessions switch identities through ordinary Sporades email-auth transitions.

**Blocked by:** 01 — Scaffold a runnable Campfire Capsule.

**Status:** ready-for-agent

- [ ] An explicit documented development seed flow creates Athos, Porthos, Aramis, and d'Artagnan through supported Sporades auth behavior.
- [ ] Fixture emails are `athos@campfire.example`, `porthos@campfire.example`, `aramis@campfire.example`, and `dartagnan@campfire.example`.
- [ ] Fixture credentials are clearly marked as development-only and no real email delivery is required.
- [ ] Seeding creates or verifies the four fixed channels and deterministic starter conversation, including the crown-protection prompt.
- [ ] Repeating the seed flow does not duplicate identities, channels, messages, or other seed records.
- [ ] Seed results distinguish newly created, already present, and failed fixture records clearly enough for an AFK agent to diagnose setup.
- [ ] Starting, building, deploying, or hosting Campfire does not silently create fixture identities or known credentials.
- [ ] The generated project warns against enabling demo fixtures for a public Container session or Hosted Capsule.
- [ ] Each Musketeer has a stable display name, colour, and monogram avatar, with identity remaining legible without colour alone.
- [ ] A visible Musketeer switcher signs out the current identity and signs into the selected fixture identity through public email-auth behavior.
- [ ] Switching identity retires any state owned by the prior auth identity according to existing auth and Journey boundaries.
- [ ] An authenticated identity outside the four fixtures remains representable without crashing or leaking raw auth records.
- [ ] Tests exercise the seed flow through its public entry and the switcher through observable auth state rather than private auth-table manipulation.
