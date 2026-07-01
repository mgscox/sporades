# Caddy automatic HTTPS is the default Host TLS mode

Caddy automatic HTTPS is the default TLS mode for Hosted domains. Host profiles
may opt into Cloudflare origin certificates with `--tls cloudflare-origin`, but
server installation no longer requires preinstalled Cloudflare certificate
material.

This keeps the simplest Host server setup aligned with Caddy's default behavior:
when a generated route names a public hostname, Caddy obtains and renews the
certificate. Cloudflare origin certificates remain useful for domains that are
strictly intended to sit behind Cloudflare Edge TLS, but they are no longer a
baseline prerequisite.
