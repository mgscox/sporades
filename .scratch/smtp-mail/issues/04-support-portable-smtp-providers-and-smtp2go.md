# 04 — Support portable SMTP providers and SMTP2GO

**What to build:** Let Capsules use SMTP2GO and other standards-compatible SMTP providers without waiting for a dedicated Sporades codec. Generic provider extensions use explicitly supplied safe custom headers, while transport configuration supports the common secure connection and relay modes needed by hosted and trusted-LAN SMTP servers.

**Blocked by:** 01 — Send mail through generic SMTP.

**Status:** ready-for-agent

- [ ] A generic or SMTP2GO SMTP declaration sends the common mail shape without a provider SDK or provider-specific runtime dependency.
- [ ] `provider.headers` accepts validated custom `X-*` headers with string or repeated string values.
- [ ] Generic headers reject CR/LF characters, invalid header names, protected standard headers, and attempts to alter addressing, MIME bodies, authentication, or transport behavior.
- [ ] The transport supports implicit TLS, required STARTTLS, opportunistic STARTTLS, and explicitly configured plaintext delivery with certificate verification enabled by default.
- [ ] Authentication may be omitted only through an explicit unauthenticated-relay configuration suitable for a trusted relay.
- [ ] TLS server name configuration supports certificate validation when the configured SMTP host is an IP address.
- [ ] Tests prove SMTP2GO-shaped host, port, TLS, and authentication configuration reaches the same generic SMTP transport.
- [ ] Tests cover implicit TLS and an explicitly configured unauthenticated local relay in addition to the required STARTTLS path established by ticket 01.
- [ ] Documentation provides portable SMTP and SMTP2GO examples, calls out the security implications of plaintext and unauthenticated modes, and keeps all credentials in Server env.
