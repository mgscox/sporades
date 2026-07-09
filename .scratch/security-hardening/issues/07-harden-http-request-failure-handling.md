Status: done

# Harden HTTP Request Failure Handling

## What to build

Harden HTTP request handling so oversized JSON or Custom endpoint bodies are rejected before they exhaust runtime memory, and unexpected server errors do not return raw internal messages to clients. Detailed diagnostics should remain available through redacted server-side logging and protected inspection surfaces.

## Acceptance criteria

- [ ] JSON request parsing enforces a configurable maximum body size and returns a structured `413 Payload Too Large` style failure when exceeded.
- [ ] Custom endpoint body parsing enforces the same size limit for JSON and text bodies.
- [ ] Unexpected HTTP handler failures return a generic client-facing `500` response without internal paths, SQL details, stack traces, or adapter messages.
- [ ] Detailed error context is logged server-side through existing redaction behavior.
- [ ] Tests cover oversized debug/custom endpoint bodies and generic client-facing errors with preserved redacted diagnostics.

## Blocked by

None - can start immediately
