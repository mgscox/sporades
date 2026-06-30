# Hosted domains use Cloudflare wildcard TLS

MVP Hosted domains are assumed to sit behind Cloudflare wildcard SSL, with the Host server presenting a Cloudflare origin certificate rather than asking Caddy to obtain public certificates per Capsule subdomain. This keeps Capsule registration independent of ACME issuance and DNS-provider automation while accepting that Hosted domains must be configured in Cloudflare before they are suitable for the MVP Host server.
