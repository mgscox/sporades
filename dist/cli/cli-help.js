import { CLIENT_FRAMEWORKS, CLIENT_TEMPLATES, CLIENT_TOOLCHAINS } from "../client-capabilities.js";
const frameworkHelp = [...CLIENT_FRAMEWORKS.filter((framework) => framework !== "vanilla"), "vanilla"].join(", ").replace(/, ([^,]+)$/, ", or $1");
const toolchainHelp = CLIENT_TOOLCHAINS.map((toolchain) => toolchain === "vite" ? "Vite" : toolchain).join(" or ");
const templateHelp = CLIENT_TEMPLATES.join(", ").replace(/, ([^,]+)$/, ", or $1");
const HELP_TEXT = {
    create: `Usage: sporades create <name> [options]

Scaffold a new Capsule.

The blank template includes a dormant, credential-free Stripe payment foundation;
activation remains explicit and server-only.

Options:
  --framework <name>  Client framework: ${frameworkHelp}
  --toolchain <name>  Client toolchain: ${toolchainHelp} (framework-dependent)
  --template <name>   Template: ${templateHelp}, or a local directory path
  --no-install        Skip npm install
  --no-git            Skip git initialization
  --json              Write JSON output
  --help, -h          Show this help
`,
    dev: `Usage: sporades dev [status|stop|reset] [options]

Start and manage a local Dev session.

Commands:
  dev                 Start a Dev session
  dev status          Print Dev session status
  dev stop            Stop the running Dev session
  dev reset           Stop the Dev session and remove local Dev state

Options:
  --port <number>     Dev session port when starting
  --public            Allow non-localhost access when starting
  --telemetry <name>  Export HTTP traces using a registered Telemetry profile
  --json              Write JSON output
  --help, -h          Show this help
`,
    auth: `Usage: sporades auth <command> [options]

Manage local auth configuration and identity simulation.

Commands:
  status              Print auth provider status
  clients             List connected Dev session clients
  set <provider>      Configure or disable anonymous, email, Google, Microsoft, Apple, or Facebook
  as email            Simulate a local email identity

Options:
  --client-id <id>        OAuth client/app ID (Apple Services ID)
  --client-secret <secret> OAuth client/app secret
  --client-json <path>    Read provider-specific credentials JSON
  --tenant <tenant>       Microsoft tenant (default: common)
  --team-id <id>          Apple Developer Team ID
  --key-id <id>           Apple Sign in key ID
  --private-key <pem>     Apple private key (stored only in Server env)
  --graph-version <name>  Facebook Graph API version
  --disable               Disable the selected provider without changing siblings
  --email <address>       Simulated email identity
  --display-name <name>   Simulated display name
  --picture <url>         Simulated profile picture URL
  --port <number>         Target Dev session port
  --client <target>       Delivery target: current, all, or a client ID
  --json                  Write JSON output
  --help, -h              Show this help
`,
    "access-keys": `Usage: sporades access-keys <command> [options]

Inspect and retire Access keys through a running Capsule.

Commands:
  list --user-id <id>       List one owner's Access-key metadata
  inspect <key-id>          Inspect one Access key
  revoke <key-id>           Revoke one Access key
  revoke-all --user-id <id> Revoke one owner's current Access keys
  delete <key-id>           Delete revoked Access-key history

Options:
  --session <name>    Session: dev, container, or hosted (default: dev)
  --host <alias>      Host profile alias for a Hosted Capsule
  --subname <name>    Hosted Capsule subname
  --cursor <cursor>   Opaque list cursor
  --limit <n>         List page size from 1 through 100
  --status <status>   List active, expired, or revoked keys
  --yes               Explicitly approve a destructive operation
  --json              Write structured JSON; does not imply consent
  --help, -h          Show this help
`,
    security: `Usage: sporades security [options]

Inspect effective Capsule security policy.

Options:
  --session <name>    Session: dev, public-dev, container, or hosted
  --json              Write JSON output
  --help, -h          Show this help
`,
    doctor: `Usage: sporades doctor [options]

Run read-only Sporades diagnostics.

Options:
  --session <name>    Session: dev, public-dev, container, or hosted
  --host <alias>      Host profile alias for Hosted Capsule checks
  --subname <name>    Hosted Capsule subname
  --strict            Exit non-zero on warnings as well as failures
  --json              Write structured JSON output
  --help, -h          Show this help
`,
    env: `Usage: sporades env <command> [options]

Manage Sealed Server env.

Commands:
  set <name>          Read one value from stdin and seal it
  has <name>          Test whether a Server env key is defined
  init                Create local Sealed Server env key material
  import              Import Server env values from a file
  status              Print Sealed Server env status
  export              Export Sealed Server env for a Host profile
  reencrypt           Re-encrypt local Sealed Server env material

Options:
  --stdin             Read the value for env set from stdin
  --file <path>       Input file for import or export
  --host <alias>      Host profile alias
  --subname <name>    Hosted Capsule subname
  --output <path>     Export output path
  --sealed            Treat input as an already sealed export
  --json              Write JSON output
  --help, -h          Show this help
`,
    monitoring: `Usage: sporades monitoring stack <init|validate> [options]
       sporades monitoring sender <issue|rotate|commit|cancel|revoke|export|status|legacy-revoke> [options]

Generate or inspect the versioned trace stack from an installed Sporades package.
Initialization creates a reviewable directory; it does not start services.
Sender operations run locally on the Monitoring server; results contain no secrets.
Rotation stages a second generation; commit retires the old one after sender verification.

Options:
  --dir <path>        Target stack directory (default: current directory)
  --sender <name>     Named sender for lifecycle operations (optional for status)
  --host <identity>   Exact inventory Host scope (issue or legacy-revoke only)
  --out <path>        New mode-0600 credential handoff file (export only)
  --generation <n>    Verified pending generation to activate (commit only)
  --ingest            Disable shared legacy ingestion (legacy-revoke only)
  --json              Write { ok, data, error } JSON output
  --help, -h          Show this help
`,
    telemetry: `Usage: sporades telemetry profile <add|list|show|remove> [name] [options]

Register and inspect operator-owned OTLP/HTTP Telemetry profiles. Descriptors store only
credential environment and private CA file references; they never store secret values.
Dev sessions use --telemetry <name> first, then sporades.json telemetry.profile, then no export.

Options for profile add:
  --endpoint <url>        OTLP/HTTP base origin (HTTPS, or HTTP loopback with --loopback)
  --dashboard <url>       Optional dashboard HTTPS URL
  --credential-env <KEY>  Environment variable containing the ingestion bearer token
  --inventory-credential-env <KEY>  Exact Host-scoped lifecycle inventory token
  --inventory-host <id>   Stable inventory identity (default: first connected domain)
  --metrics-interval-ms <N>  Metrics export period, 5000-300000 ms (default 15000)
  --trace-propagation-origin <origin>  Approve exact fetch origin (repeatable, max 32)
  --event-loop-delay-resolution-ms <N>  Delay timer precision, 10-1000 ms (default 20)
  --ca-file <path>        Absolute private CA certificate path for verified TLS
  --loopback              Permit a local HTTP collector for development
  --json                  Write { ok, data, error } JSON output
  --help, -h              Show this help
`,
    deploy: `Usage: sporades deploy [status|stop|restart|reconcile|remove|reset|ssh] [options]

Start and manage a local Container session.

Commands:
  deploy              Start a local Container session
  deploy status       Print Container session status
  deploy stop         Stop the running Container session
  deploy restart      Restart the running Container session
  deploy policy publish <file>|remove
                      Publish or remove the declared admission policy
  deploy reconcile    Settle an interrupted deployment-file attempt
  deploy ssh          Inspect effective Container SSH access
  deploy remove       Remove the Container session
  deploy reset        Remove the Container session and local container state

Options:
  --port <number>     Published local port when starting
  --telemetry <name>  Export HTTP traces using a registered Telemetry profile
  --no-telemetry      Disable export for this Container session
  --force             Replace stale or conflicting container state when starting
  --json              Write JSON output
  --help, -h          Show this help
`,
    host: `Usage: sporades host <command> [options]

Manage Host profiles and Hosted Capsules.

Profile commands:
  add <alias>         Add a Host profile
  use <alias>         Set the default Host profile
  current             Print the selected Host profile
  bootstrap           Provision the remote Host server
  upgrade             Copy the local Host helper to the Host server
  health [subname]    Check Host server or Hosted Capsule health
  telemetry connect|reconcile|status|check
  telemetry inventory-export|inventory-reconcile
                      Manage the shared Host Telemetry relay
  telemetry resources-enable|resources-disable|resources-remove
                     Manage Host OS and Caddy collection independently of Capsules
  telemetry enable|disable <subname>
                      Change a Hosted Capsule's Telemetry opt-out

Capsule commands:
  bind <subname>      Bind this project to a Hosted Capsule
  register <subname>  Register a Hosted Capsule
  push                Push and install a Hosted Capsule release
  start <subname>     Start a Hosted Capsule
  stop <subname>      Stop a Hosted Capsule
  restart <subname>   Restart a Hosted Capsule
  policy publish <file>|remove --host <alias> --subname <name>
                      Publish or remove the recorded admission policy
  reconcile <subname> Settle an interrupted deployment-file attempt
  ssh [subname]       Inspect effective Hosted Capsule SSH access
  stats [subname]     Print Host server or Hosted Capsule stats
  logs [source]       Print Hosted Capsule logs
  releases <subname>  List Hosted Capsule releases
  rollback <subname> <release-id>
                      Roll back to a previous release
  rotate-key <subname>
                      Rotate Hosted Capsule Sealed Server env keys
  unregister <subname>
                      Unregister a Hosted Capsule
  delete <subname>    Delete Hosted Capsule storage

Other commands:
  list                List Hosted Capsules
  github workflow write
                      Write a GitHub Actions deploy workflow
  invoke <action>     Invoke a low-level remote Host helper action

Options:
  --host <alias>      Host profile alias
  --profile <name>    Verified HTTPS Telemetry profile for host telemetry connect
  --server <target>   SSH target for host add
  --domain <domain>   Hosted domain for host add
  --alias-domain <hostname>
                      Custom HTTPS domain for register (repeatable)
  --remote-root <path>
                      Remote root path for host add
  --tls <mode>        TLS mode: automatic or cloudflare-origin
  --subname <name>    Hosted Capsule subname
  --lines <n>, -n <n> Log line count
  --restart           Restart after host push
  --verify            Verify release health after host push
  --fallback-to-previous-release
                      Roll back when verified push fails
  --branch <name>     GitHub workflow branch
  --file <path>       GitHub workflow output path
  --dry-run           Print workflow without writing it
  --force             Overwrite workflow output when writing it
  --json              Write JSON output
  --help, -h          Show this help
`,
    logs: `Usage: sporades logs [tail] [options]

Print Dev session logs.

Commands:
  logs                Print recent Dev session logs
  logs tail           Follow Dev session logs

Options:
  --port <number>     Target Dev session or local Container port
  --json              Write JSON output
  --help, -h          Show this help
`,
    db: `Usage: sporades db <command> [options]

Inspect the Dev session database.

Commands:
  list                List database tables
  dump                Dump database contents
  query <sql>         Run a read-only SQL query

Options:
  --port <number>     Target Dev session or local Container port
  --json              Write JSON output
  --help, -h          Show this help
`,
    default: `Usage: sporades <command> [options]
    
    Commands:
      create <name>  Scaffold a new Capsule
      dev            Start a local Dev session
      auth           Manage local auth configuration and simulation
      access-keys    Inspect and retire Access keys through a running Capsule
      security       Inspect effective Capsule security policy
      doctor         Run read-only Sporades diagnostics
      env            Manage Sealed Server env
      monitoring     Generate and validate a monitoring stack
      telemetry      Register operator Telemetry profiles
      deploy         Start a local Container session
      host           Manage Host profiles and Hosted Capsules
      logs           Print Dev session logs
      db             Inspect the Dev session database
    
    Options:
      --help, -h     Show help for command
      --version, -v  Show CLI version
      --host <alias> Show Host server CLI version with --version
      --json         Write JSON output when supported by the command
    `,
};
export function renderCliHelp(command) {
    return HELP_TEXT[command] ?? HELP_TEXT.default;
}
//# sourceMappingURL=cli-help.js.map