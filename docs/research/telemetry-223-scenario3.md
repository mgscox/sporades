# Verify by hand — #223 / #128 scenario 3 (manager only)

Refs #128. This is a pending acceptance checklist, not evidence of a VM pass.
Only the manager may operate the retained disposable H/A/B/W VMs described in
#128. H is the Capsule Host, A the old Monitoring destination, B the replacement,
and W the dedicated controller. Preserve both Monitoring volumes, historical
queries, Capsule data, stopped/opted-out controls and rollback credentials.

- [ ] **Pin the installation and establish A delivery.** Install this PR's tested
  checkout/package on W and H with the supported Host helper upgrade workflow.
  Record `git rev-parse HEAD`, `sha256sum bin/sporades.js
  bin/sporades-host-helper.js dist/generated-source-manifest.json` on W, and the
  checksum of H's active payload (read its basename from
  `/srv/sporades/bin/.sporades-host-helper.active`). Compare it with the shipped
  helper checksum. Record H/A/B/W VM identities, UTC time and H's boot ID. On W,
  use dedicated `SPORADES_CONFIG_DIR="$PWD/.dev-config"` and securely load
  `OLD_OPERATOR` / `DESTINATION_OPERATOR`; never echo their values. Run:

  ```sh
  sporades host telemetry migrate --host personal --profile old --query-credential-env OLD_OPERATOR --json
  sporades host restart todo --host personal --json
  sporades host telemetry status --host personal --json
  sporades host telemetry check --host personal --query-credential-env OLD_OPERATOR --json
  ```

  Require A's current acknowledgement and `backendStorage:verified-relay-trace`.
  Send a uniquely marked authenticated Todo mutation from an independent client;
  record its exact production trace ID and retrieve it from A with operator
  credentials. Preserve a protected A inventory export and record a historical
  trace/metric window within A's configured retention. Reuse #128's original
  trace/19-sample window while retained; if it has expired, record the retention
  boundary and seed a new pre-run historical reference. Normal retention expiry
  is not migration data loss. Ensure the test binding has
  a CA bundle, so recovery tests both Collector config and CA readability.

- [ ] **Interrupt the actual activation child before descriptor publication.**
  Use H's independent console as root. The following test-only checkpoint needs
  no inspector port. Set `ROOT=/srv/sporades` (or the actual retained remote root)
  and use a new protected evidence directory. Save only checksums/modes in public
  records; the helper, journal and before-images remain protected.

  ```sh
  ROOT=/srv/sporades
  E=/root/sporades-223-scenario3
  install -d -m 700 "$E"
  export ROOT E
  UNIT=$(node -e 'const c=require("node:crypto");process.stdout.write("sporades-inventory-"+c.createHash("sha256").update(process.env.ROOT).digest("hex").slice(0,16))')
  export UNIT
  systemctl show "$UNIT.service" -p UMask
  systemctl stop "$UNIT.timer" "$UNIT.service"
  PAYLOAD=$(cat "$ROOT/bin/.sporades-host-helper.active")
  cp "$ROOT/bin/$PAYLOAD" "$E/helper-original.mjs"
  sha256sum "$E/helper-original.mjs" > "$E/helper-original.sha256"
  sha256sum "$ROOT/telemetry/connection.json" "$ROOT/telemetry/collector.yaml" "$ROOT/telemetry/credential.env" "$ROOT/telemetry/ca.pem" > "$E/before.sha256"
  stat -c '%a %U:%G %n' "$ROOT/telemetry/"{connection.json,collector.yaml,credential.env,ca.pem} > "$E/before.modes"
  python3 - <<'PY'
  import hashlib, os, pathlib, re
  root, evidence = pathlib.Path(os.environ['ROOT']), pathlib.Path(os.environ['E'])
  source = (evidence / 'helper-original.mjs').read_text()
  pattern = r'await atomicWrite\d*\(files\.descriptor, candidate, (?:384|0o600)\);'
  assert len(re.findall(pattern, source)) == 1, 'stop if shipped checkpoint changed'
  marker = str(evidence / 'checkpoint.json')
  import json
  checkpoint = ('await (await import("node:fs/promises")).writeFile(' + json.dumps(marker)
    + ', JSON.stringify({pid:process.pid,utc:new Date().toISOString(),phase:"before-descriptor"}), {mode:0o600}); '
    + 'process.kill(process.pid,"SIGSTOP"); ')
  instrumented = re.sub(pattern, lambda match: checkpoint + match.group(0), source).encode()
  checksum = hashlib.sha256(instrumented).hexdigest()
  stage = root / 'bin' / ('.sporades-host-helper-stage-' + checksum + '.mjs')
  stage.write_bytes(instrumented); stage.chmod(0o600)
  (evidence / 'checkpoint-hash').write_text(checksum + '\n')
  PY
  HASH=$(cat "$E/checkpoint-hash")
  node "$ROOT/bin/.sporades-host-helper-stage-$HASH.mjs" --install-host-helper "$ROOT/bin/sporades-host-helper" "$HASH"
  ```

  `UMask` must be `0077`. On W start (and retain exit/output from):

  ```sh
  sporades host telemetry migrate --host personal --profile replacement --query-credential-env DESTINATION_OPERATOR --json
  ```

  On H's console, wait for `$E/checkpoint.json`, read its PID without inspecting
  secrets, verify the process is stopped, and verify the saved descriptor still
  matches A while the activation journal exists:

  ```sh
  PID=$(node -e 'process.stdout.write(String(JSON.parse(require("node:fs").readFileSync(process.env.E+"/checkpoint.json")).pid))')
  ps -o pid,ppid,stat,args -p "$PID"
  test -f "$ROOT/telemetry/activation.json"
  sha256sum "$ROOT/telemetry/connection.json"
  stat -c '%a %U:%G %n' "$ROOT/telemetry/"{collector.yaml,ca.pem,credential.env,connection.json,activation.json}
  kill -KILL "$PID"
  ```

  Require child status `T`, checkpoint `before-descriptor`, candidate B, descriptor
  A, journal present, `collector.yaml`/`ca.pem` `0644` and
  `credential.env`/`connection.json`/`activation.json` `0600`. Kill only this
  child. W's migration must exit nonzero; killing W's CLI alone is not evidence.

- [ ] **Restore shipped code before autonomous recovery.** After W's command has
  settled, on H install the saved, byte-identical original using the same installer:

  ```sh
  HASH=$(sha256sum "$E/helper-original.mjs" | cut -d ' ' -f 1)
  install -m 600 "$E/helper-original.mjs" "$ROOT/bin/.sporades-host-helper-stage-$HASH.mjs"
  node "$ROOT/bin/.sporades-host-helper-stage-$HASH.mjs" --install-host-helper "$ROOT/bin/sporades-host-helper" "$HASH"
  PAYLOAD=$(cat "$ROOT/bin/.sporades-host-helper.active")
  sha256sum "$ROOT/bin/$PAYLOAD"
  ```

  Require the original shipped checksum, journal still present, and no checkpoint
  code active. Power W off using the manager's provider controls and record
  provider-confirmed off state. Only then, on H's independent console:

  ```sh
  date -u +%FT%TZ
  systemctl start "$UNIT.timer" "$UNIT.service"
  # Keep W off for at least two 60-second timer cycles; do not reconcile manually.
  systemctl show "$UNIT.service" -p UMask -p Result -p ExecMainStatus
  journalctl -u "$UNIT.service" --since '3 minutes ago' --no-pager
  test ! -e "$ROOT/telemetry/activation.json"
  sha256sum --check "$E/before.sha256"
  stat -c '%a %U:%G %n' "$ROOT/telemetry/"{connection.json,collector.yaml,credential.env,ca.pem}
  docker inspect --format '{{.State.Running}} {{.RestartCount}}' sporades-telemetry-relay
  docker logs --since 3m sporades-telemetry-relay
  ```

  Keep logs protected and redact before attaching. Require restored exact bytes,
  root-owned `collector.yaml`/`ca.pem` `0644`, descriptor/credential `0600`, consumed
  journal, successful timer runs, running relay and no permission-denied crash.

- [ ] **Prove independent production delivery while W remains off.** From the
  independent application client send a new authenticated mutation; record UTC,
  marker, preserved Todo data and exact production trace ID. With A's operator
  credentials retrieve `/api/traces/<traceId>` and query these selectors through
  Grafana's Prometheus datasource proxy (substitute the retained Host identity):

  ```promql
  process_memory_rss_bytes{service_name="128.140.91.80.sslip.io/todo",deployment_environment_name="hosted"}
  node_memory_MemTotal_bytes{sporades_host="128.140.91.80.sslip.io"}
  process_resident_memory_bytes{sporades_host="128.140.91.80.sslip.io",telemetry_source="caddy"}
  up{sporades_host="128.140.91.80.sslip.io",telemetry_source=~"node|caddy"}
  ```

  Also query `time() - timestamp(<selector>)` for each metric stream. Require the
  exact stored production trace (HTTP 200), samples newer than recovery and less
  than 45 seconds old, both scrape targets up, and a current A inventory revision
  with acknowledgement/no pending failure. Re-query A's original historical
  trace and metric window. Record early 404/stale attempts separately; credit only
  subsequent independently stored/fresh observations. Inventory success alone
  fails this criterion.

- [ ] **Reconciliation and applied rollback.** Only after the independent evidence
  power W on. Run on W:

  ```sh
  sporades host telemetry reconcile --host personal --json
  sporades host telemetry reconcile --host personal --json
  sporades host telemetry status --host personal --json
  sporades host telemetry check --host personal --query-credential-env OLD_OPERATOR --json
  sporades host telemetry migrate --host personal --profile replacement --query-credential-env DESTINATION_OPERATOR --json
  sporades host restart todo --host personal --json
  sporades host telemetry check --host personal --query-credential-env DESTINATION_OPERATOR --json
  sporades host telemetry migrate --host personal --profile old --query-credential-env OLD_OPERATOR --json
  sporades host restart todo --host personal --json
  sporades host telemetry check --host personal --query-credential-env OLD_OPERATOR --json
  ```

  Restart any other reported pending test Capsules. Require idempotent retries,
  successful applied migration and applied rollback, exact relay probe storage
  and independent new production trace/metric evidence on the active destination.
  From A/B's generated stack directories preserve/export their inventory:

  ```sh
  node inventory.mjs export <A-or-B-https-url> <inventoryHost> <protected-snapshot-file>
  node inventory.mjs import <A-or-B-https-url> <inventoryHost> <protected-revised-snapshot-file>
  node inventory.mjs export <A-or-B-https-url> <inventoryHost> <protected-confirmation-file>
  ```

  Use revisions newer than the retained retirement/current revisions and canonical
  UTC timestamps. Restore A's running/stopped/opted-out expectations and retire B
  with all migrated identities opted-out/empty targets. Confirm with exports;
  preserve history/data/credentials. Attach the redacted record to #128 with
  commit/artifact hashes, command exits, checkpoint PID/UTC, W off interval,
  timer logs, modes, trace IDs, metric sample timestamps/ranges and inventory
  revisions/acknowledgements. #128 stays open until the manager signs off this
  real separate-VM evidence.
