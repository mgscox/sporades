import { CLIENT_FRAMEWORKS, CLIENT_TEMPLATES, CLIENT_TOOLCHAINS } from "../client-capabilities.js";

const frameworkHelp = [...CLIENT_FRAMEWORKS.filter((framework) => framework !== "vanilla"), "vanilla"].join(", ").replace(/, ([^,]+)$/, ", or $1");
const toolchainHelp = CLIENT_TOOLCHAINS.map((toolchain) => toolchain === "vite" ? "Vite" : toolchain).join(" or ");
const templateHelp = CLIENT_TEMPLATES.join(", ").replace(/, ([^,]+)$/, ", or $1");

const HELP_TEXT = {
  create: `Usage: sporades create <name> [options]

Scaffold a new Capsule.

Options:
  --framework <name>  Client framework: ${frameworkHelp}
  --toolchain <name>  Client toolchain: ${toolchainHelp} (framework-dependent)
  --template <name>   Template: ${templateHelp}
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
  --json              Write JSON output
  --help, -h          Show this help
`,
  auth: `Usage: sporades auth <command> [options]

Manage local auth configuration and identity simulation.

Commands:
  status              Print auth provider status
  clients             List connected Dev session clients
  set google          Configure Google OAuth credentials
  as email            Simulate a local email identity

Options:
  --client-id <id>        Google OAuth client ID
  --client-secret <secret> Google OAuth client secret
  --client-json <path>    Read Google OAuth credentials JSON
  --email <address>       Simulated email identity
  --display-name <name>   Simulated display name
  --picture <url>         Simulated profile picture URL
  --port <number>         Target Dev session port
  --client <target>       Delivery target: current, all, or a client ID
  --json                  Write JSON output
  --help, -h              Show this help
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
  init                Create local Sealed Server env key material
  import              Import Server env values from a file
  status              Print Sealed Server env status
  export              Export Sealed Server env for a Host profile
  reencrypt           Re-encrypt local Sealed Server env material

Options:
  --file <path>       Input file for import or export
  --host <alias>      Host profile alias
  --subname <name>    Hosted Capsule subname
  --output <path>     Export output path
  --sealed            Treat input as an already sealed export
  --json              Write JSON output
  --help, -h          Show this help
`,
  deploy: `Usage: sporades deploy [status|stop|restart|remove|reset|ssh] [options]

Start and manage a local Container session.

Commands:
  deploy              Start a local Container session
  deploy status       Print Container session status
  deploy stop         Stop the running Container session
  deploy restart      Restart the running Container session
  deploy ssh          Inspect effective Container SSH access
  deploy remove       Remove the Container session
  deploy reset        Remove the Container session and local container state

Options:
  --port <number>     Published local port when starting
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

Capsule commands:
  bind <subname>      Bind this project to a Hosted Capsule
  register <subname>  Register a Hosted Capsule
  push                Push and install a Hosted Capsule release
  start <subname>     Start a Hosted Capsule
  stop <subname>      Stop a Hosted Capsule
  restart <subname>   Restart a Hosted Capsule
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
  --server <target>   SSH target for host add
  --domain <domain>   Hosted domain for host add
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
      security       Inspect effective Capsule security policy
      doctor         Run read-only Sporades diagnostics
      env            Manage Sealed Server env
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
} as const;

export type CliHelpCommand = keyof Omit<typeof HELP_TEXT, "default">;

export function renderCliHelp(command?: string) {
  return HELP_TEXT[command as CliHelpCommand] ?? HELP_TEXT.default;
}
