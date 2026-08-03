# Changes

## Unreleased - 2026-08-03

Changes since v0.6.1.

### 🚀 Features

- Add scriptable sealed env key management (742ac99).
- Add Microsoft OpenID Connect sign-in (affeed9).
- Complete SMTP runtime production parity (3237d21).
- Add Sign in with Apple (11b22ff).
- Add Facebook OAuth sign-in (3e166fc).
- Support portable SMTP relay modes (59817d3).
- Add multi-provider OAuth configuration (e9f388f).
- Add Mailgun SMTP extensions (c71314c).
- Add Postmark SMTP extensions (768b078).
- Add generic SMTP mail runtime (420d8b0).
- Add stable provider identities (2d5be36).

### 🐛 Bug Fixes

- Isolate SMTP transport error classification (279e629).
- Guard SMTP error and close traps (203724b).
- Harden SMTP failure and shutdown boundaries (2a77579).
- Preserve Facebook body timeouts (bbbb5b5).
- Harden Facebook OAuth transport (c8ddcc6).
- Harden portable SMTP configuration (edaf97e).

### 🔧 Improvements

- Complete multi-provider OAuth implementation swarm (83217df).
- Accept OAuth coexistence issue 07 (df102b9).
- Final review for OAuth coexistence issue 07 (fa1c3e0).
- Request Apple JWKS taxonomy fix for OAuth issue 07 (63328b1).
- Re-review OAuth endpoint confinement (3a5f38a).
- Request JWKS confinement rework for OAuth issue 07 (fbcc0e6).
- Re-review OAuth coexistence issue 07 (609aa56).
- Request rework for OAuth coexistence issue 07 (e03ef29).
- Review OAuth coexistence issue 07 (81b8cb2).
- Dispatch multi-provider OAuth issue 07 (2c54c36).
- Complete Microsoft OAuth issue 04 (b18dae7).
- Accept Microsoft OAuth issue 04 integration (6c6b7db).
- Record SMTP swarm final verification (291cb7c).
- Review three-provider OAuth integration (df527e8).
- Accept Microsoft OAuth issue 04 candidate (b63b4b1).
- Complete SMTP mail issue 05 (cedc452).
- Accept SMTP mail issue 05 (39684a1).
- Re-review Microsoft OAuth cache saturation (487686a).
- Re-review third replacement for SMTP mail issue 05 (6f64f23).
- Clean up Apple OAuth worktree (40ceac4).
- Request saturation rework for Microsoft OAuth cache (9fb94d5).
- Request third rework for SMTP mail issue 05 (cd611fd).
- Re-review Microsoft OAuth cache lifecycle (c2d5a95).
- Re-review second replacement for SMTP mail issue 05 (b2f455b).
- Complete Apple OAuth issue 05 (ac9eacf).
- Request second rework for SMTP mail issue 05 (f036856).
- Accept Apple OAuth issue 05 integration (06d6af7).
- Request lifecycle rework for Microsoft OAuth cache (5ec1cff).
- Re-review SMTP mail issue 05 (137d31a).
- Review Apple and Facebook OAuth integration (15408ad).
- Re-review Microsoft OAuth cache handling (a2814b4).
- Request rework for SMTP mail issue 05 (55876a9).
- Complete Facebook OAuth issue 06 (49471f2).
- Accept Facebook OAuth issue 06 (e73b98e).
- Re-review Apple OAuth callback parser (b258d8f).
- Re-review Facebook OAuth timeout handling (fc9d1e5).
- Review SMTP mail issue 05 (ebc29e8).
- Request cache rework for Microsoft OAuth issue 04 (2261ffc).
- Request parser rework for Apple OAuth issue 05 (1a4af01).
- Advance Microsoft and Facebook OAuth rework (9c488f6).
- Re-review Apple OAuth issue 05 (d2cc161).
- Re-review Facebook OAuth issue 06 (4a48c7e).
- Dispatch SMTP mail issue 05 (3675858).
- Complete SMTP mail issue 04 (630b589).
- Accept SMTP mail issue 04 (1381dbd).
- Re-review second replacement for SMTP mail issue 04 (3041f53).
- Request second rework for SMTP mail issue 04 (e94dabd).
- Request rework for Facebook OAuth issue 06 (a84fd43).
- Re-review SMTP mail issue 04 (ea9df9e).
- Request rework for Microsoft OAuth issue 04 (8a7b75e).
- Review Facebook OAuth issue 06 (af9f4e8).
- Request rework for SMTP mail issue 04 (8140e85).
- Review Microsoft OAuth issue 04 (6a02358).
- Request rework for Apple OAuth issue 05 (f60ad7b).
- Review Apple OAuth issue 05 (274f085).
- Review SMTP mail issue 04 (3d67ba2).
- Dispatch provider OAuth implementation frontier (a53d2aa).
- Complete multi-provider OAuth issue 03 (1dc0371).
- Accept multi-provider OAuth issue 03 (32e289c).
- Re-review invariant-safe OAuth issue 03 (4257dbb).
- Dispatch SMTP mail issue 04 (ff61b3e).
- Complete SMTP mail issue 03 (f7e9916).
- Accept SMTP mail issue 03 (54ab22c).
- Re-review third replacement for SMTP mail issue 03 (50495c8).
- Request invariant rework for multi-provider OAuth issue 03 (ad54e22).
- Request third rework for SMTP mail issue 03 (31da8bc).
- Re-review atomic multi-provider OAuth issue 03 (cb94846).
- Re-review second replacement for SMTP mail issue 03 (a4614cd).
- Request second rework for SMTP mail issue 03 (53b0d36).
- Re-review SMTP mail issue 03 (ec21ea5).
- Request atomic rework for multi-provider OAuth issue 03 (15a9336).
- Re-review multi-provider OAuth issue 03 (c58107a).
- Request rework for SMTP mail issue 03 (fbf0fc2).
- Review SMTP mail issue 03 (7f8623a).
- Request rework for multi-provider OAuth issue 03 (8295165).
- Dispatch SMTP mail issue 03 (239f016).
- Complete SMTP mail issue 02 (912a1ac).
- Review multi-provider OAuth issue 03 (fe44a93).
- Accept SMTP mail issue 02 (8e91a6e).
- Re-review SMTP mail issue 02 (9944346).
- Request rework for SMTP mail issue 02 (855ecbf).
- Review SMTP mail issue 02 (2708b4f).
- Dispatch SMTP mail issue 02 (9339ad0).
- Complete SMTP mail issue 01 (6b0d35f).
- Accept SMTP mail issue 01 (86c590c).
- Re-review encoded address fix for SMTP mail issue 01 (fc30f8f).
- Request third rework for SMTP mail issue 01 (8befa61).
- Re-review RFC 2047 fix for SMTP mail issue 01 (99dd6ac).
- Request second rework for SMTP mail issue 01 (f864623).
- Dispatch multi-provider OAuth issue 03 (7d345e9).
- Complete multi-provider OAuth issue 02 (c3da4ab).
- Accept multi-provider OAuth issue 02 (cc6d385).
- Re-review SMTP mail issue 01 (486fed4).
- Re-review multi-provider OAuth issue 02 (2e632ae).
- Request rework for SMTP mail issue 01 (075813f).
- Request rework for multi-provider OAuth issue 02 (dbffa22).
- Dispatch review for SMTP mail issue 01 (34d9960).
- Review SMTP mail issue 01 (4271868).
- Review multi-provider OAuth issue 02 (bb0292c).
- Dispatch SMTP mail issue 01 (a51c647).
- Initialize SMTP mail swarm ledger (ac20cf1).
- Clean up multi-provider OAuth issue 01 worktree (4297774).
- Dispatch multi-provider OAuth issue 02 (d059d44).
- Complete multi-provider OAuth issue 01 (da7602c).
- Accept multi-provider OAuth issue 01 (e925fa0).
- Re-review multi-provider OAuth issue 01 (6595fa4).
- Re-review multi-provider OAuth issue 01 (33decb6).
- Plan SMTP mail support (35e1519).
- Request rework for multi-provider OAuth issue 01 (0f08d69).
- Review multi-provider OAuth issue 01 (b4f5d58).
- Dispatch multi-provider OAuth issue 01 (ab58692).
- Initialize multi-provider OAuth swarm ledger (716075b).
- Plan multi-provider OAuth expansion (1cc5f60).

### 📝 Documentation

- Contract provider-neutral OAuth runtime (df4901f).
- Fail closed on Microsoft OIDC cache saturation (5889257).
- Bound Microsoft OIDC cache lifecycle (9e3aeff).
- Coalesce Microsoft OIDC cache refreshes (7b54d69).
- Harden Microsoft OIDC network and token parsing (13774fe).
- Reject malformed OAuth form callbacks (1817519).
- Harden Sign in with Apple boundaries (301ff15).
- Reject duplicate file transaction targets (3cabaf0).
- Make OAuth configuration updates failure-atomic (b94bb52).
- Harden multi-provider OAuth configuration (56a1f14).
- Make Mailgun header boundaries exact (378ca69).
- Validate Mailgun headers before delivery (66080b0).
- Harden Mailgun SMTP header encoding (9436714).
- Update generated SMTP API docs (0cf6139).
- Harden SMTP MIME and TLS errors (89536c1).
- Harden OAuth state and identity validation (6ef5d6a).
- Deepen runtime OAuth provider seam (210aeb2).
- Harden legacy provider identity claims (39e9e7a).

### 🧪 Tests

- Integrate Microsoft OAuth with sibling providers (11bf24e).
- Prove implicit TLS fails closed (24f10b2).
- Define portable SMTP security contract (81698b3).
- Harden Postmark provider data objects (3940fd5).
- Fold encoded address headers at 76 columns (ab731ed).
- Bound MIME encoded-word lines (b78ca71).

### 📦 Packaging

- Release v0.6.2 (3d21e1a).
- Align esbuild script approval version (613f597).
