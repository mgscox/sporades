# Process restart for dev rebuilds, structured for future hot reload

Dev rebuilds do a full process restart by stopping the Node process, starting
a fresh one, and re-importing the bundle. The server runtime has `init()` and
`shutdown()` lifecycle hooks so a future implementation can reload the bundle
inside the same process.

The browser keeps reconnecting for as long as the page is active. The client
checks the closed socket's token through the protected no-store token route. A
valid token keeps its original TTL, and an expired or evicted token is replaced.
A failed check falls back to the existing token. HTTP upgrade rejection does
not supply a browser-visible auth close code.

The retry delay uses exponential backoff with jitter and caps at 30 seconds.
A stalled upgrade times out after ten seconds. Only five continuous healthy
minutes reset the backoff. After four attempts without a sustained connection,
the client reports the outage to live-query subscribers and offers a manual
retry that skips the delay. The client keeps trying automatically and
restores live subscriptions once the connection opens.
