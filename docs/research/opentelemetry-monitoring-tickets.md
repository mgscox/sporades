# OpenTelemetry implementation tickets

Published 2026-09-27 from the approved small-slice breakdown. Parent specification: [#107](https://github.com/mgscox/sporades/issues/107). Its body, status, labels and comments were left unchanged.

All 25 tickets are labelled `ready-for-agent`; an issue is runnable only when its native blockers are complete. The 39 native blocking relationships and published bodies were independently read back and verified. Ticket numbers below preserve the recommended shipping order; no implementation was performed.

| Order | Ticket | Blocked by |
| --- | --- | --- |
| 01 | [Telemetry 01: Run a standalone trace stack — #108](https://github.com/mgscox/sporades/issues/108) | None — can start immediately |
| 02 | [Telemetry 02: Generate the stack from installed Sporades — #109](https://github.com/mgscox/sporades/issues/109) | [#108](https://github.com/mgscox/sporades/issues/108) |
| 03 | [Telemetry 03: Trace HTTP requests in a Dev session — #110](https://github.com/mgscox/sporades/issues/110) | [#109](https://github.com/mgscox/sporades/issues/109) |
| 04 | [Telemetry 04: Trace HTTP requests in a Container session — #111](https://github.com/mgscox/sporades/issues/111) | [#110](https://github.com/mgscox/sporades/issues/110) |
| 05 | [Telemetry 05: Measure API traffic and latency — #112](https://github.com/mgscox/sporades/issues/112) | [#110](https://github.com/mgscox/sporades/issues/110) |
| 06 | [Telemetry 06: Find existing logs from a trace — #113](https://github.com/mgscox/sporades/issues/113) | [#110](https://github.com/mgscox/sporades/issues/110) |
| 07 | [Telemetry 07: See process CPU and memory usage — #114](https://github.com/mgscox/sporades/issues/114) | [#112](https://github.com/mgscox/sporades/issues/112) |
| 08 | [Telemetry 08: See GC and event-loop pressure — #115](https://github.com/mgscox/sporades/issues/115) | [#114](https://github.com/mgscox/sporades/issues/114) |
| 09 | [Telemetry 09: Connect a remote Host relay — #116](https://github.com/mgscox/sporades/issues/116) | [#111](https://github.com/mgscox/sporades/issues/111) |
| 10 | [Telemetry 10: Enable monitoring across Hosted Capsules — #117](https://github.com/mgscox/sporades/issues/117) | [#116](https://github.com/mgscox/sporades/issues/116) |
| 11 | [Telemetry 11: Synchronize lifecycle inventory automatically — #118](https://github.com/mgscox/sporades/issues/118) | [#117](https://github.com/mgscox/sporades/issues/117) |
| 12 | [Telemetry 12: See Host and container resource usage — #119](https://github.com/mgscox/sporades/issues/119) | [#112](https://github.com/mgscox/sporades/issues/112), [#116](https://github.com/mgscox/sporades/issues/116) |
| 13 | [Telemetry 13: Receive availability and missing-target alerts — #120](https://github.com/mgscox/sporades/issues/120) | [#112](https://github.com/mgscox/sporades/issues/112), [#118](https://github.com/mgscox/sporades/issues/118) |
| 14 | [Telemetry 14: Receive resource and API-performance alerts — #121](https://github.com/mgscox/sporades/issues/121) | [#119](https://github.com/mgscox/sporades/issues/119), [#120](https://github.com/mgscox/sporades/issues/120) |
| 15 | [Telemetry 15: Explain database time within requests — #122](https://github.com/mgscox/sporades/issues/122) | [#110](https://github.com/mgscox/sporades/issues/110) |
| 16 | [Telemetry 16: Explain outbound HTTP time — #123](https://github.com/mgscox/sporades/issues/123) | [#110](https://github.com/mgscox/sporades/issues/110) |
| 17 | [Telemetry 17: Explain authentication and file-operation time — #124](https://github.com/mgscox/sporades/issues/124) | [#110](https://github.com/mgscox/sporades/issues/110) |
| 18 | [Telemetry 18: Trace WebSocket operations — #125](https://github.com/mgscox/sporades/issues/125) | [#110](https://github.com/mgscox/sporades/issues/110) |
| 19 | [Telemetry 19: Trace background jobs — #126](https://github.com/mgscox/sporades/issues/126) | [#110](https://github.com/mgscox/sporades/issues/110) |
| 20 | [Telemetry 20: Rotate and revoke sender credentials — #127](https://github.com/mgscox/sporades/issues/127) | [#118](https://github.com/mgscox/sporades/issues/118) |
| 21 | [Telemetry 21: Diagnose and move monitoring connections — #128](https://github.com/mgscox/sporades/issues/128) | [#127](https://github.com/mgscox/sporades/issues/127) |
| 22 | [Telemetry 22: Recover from prolonged monitoring outages — #129](https://github.com/mgscox/sporades/issues/129) | [#112](https://github.com/mgscox/sporades/issues/112), [#118](https://github.com/mgscox/sporades/issues/118) |
| 23 | [Telemetry 23: Upgrade, restore and uninstall monitoring — #130](https://github.com/mgscox/sporades/issues/130) | [#112](https://github.com/mgscox/sporades/issues/112), [#118](https://github.com/mgscox/sporades/issues/118) |
| 24 | [Telemetry 24: Verify the complete packaged release — #131](https://github.com/mgscox/sporades/issues/131) | [#113](https://github.com/mgscox/sporades/issues/113), [#115](https://github.com/mgscox/sporades/issues/115), [#121](https://github.com/mgscox/sporades/issues/121), [#122](https://github.com/mgscox/sporades/issues/122), [#123](https://github.com/mgscox/sporades/issues/123), [#124](https://github.com/mgscox/sporades/issues/124), [#125](https://github.com/mgscox/sporades/issues/125), [#126](https://github.com/mgscox/sporades/issues/126), [#128](https://github.com/mgscox/sporades/issues/128), [#129](https://github.com/mgscox/sporades/issues/129), [#130](https://github.com/mgscox/sporades/issues/130) |
| 25 | [Telemetry 25: Run the production canary — #132](https://github.com/mgscox/sporades/issues/132) | [#131](https://github.com/mgscox/sporades/issues/131) |

Start with [#108 — Run a standalone trace stack](https://github.com/mgscox/sporades/issues/108). Work one ready ticket at a time using the implementation workflow and a fresh context; each issue owns its acceptance criteria and scope exclusions.
