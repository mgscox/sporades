# Sporades Hub: Abacus.AI SuperComputer review and concept evaluation

Vendor sources last checked: 2026-08-02

Scope: Abacus.AI and OpenAI facts use their official sources; implementation claims cite first-party project documentation. Product and security statements are vendor claims, not independently verified. The Sporades evaluation is explicitly separated from those facts.

## Abacus.AI SuperComputer

### Product and user experience

- Abacus describes SuperComputer as a personal, persistent cloud environment for building, deploying, and hosting software: “the Agent is the brain; SuperComputer is the infra.” It combines an Ubuntu server with the Abacus AI Agent and CLI. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer)
- Users can operate it through natural-language prompts or directly through a browser shell/SSH. Abacus claims root access, a persistent filesystem, arbitrary Linux software installation, Docker and Docker Compose, public hosting, full networking, and multiple simultaneous services. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer)
- Platform conveniences include managed or self-hosted databases, S3-compatible storage, domains/public URLs, nginx configuration, GitHub connection, file management, and Abacus Agent/CLI access to a claimed 100+ models. The documented prompt-to-deploy flow lets the agent build code, provision dependencies, start the service, and expose a public URL. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer)
- The VM can auto-shut down when Abacus decides no task or service is active; an **Always On** toggle keeps it running. The shutdown-detection rules are not documented. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer)
- Abacus advertises one-click persistent agents including Hermes (persistent memory, reusable skills, continuous operation) and Claw/OpenClaw (messaging-platform orchestration). These are Abacus product claims; the reviewed pages do not publish independent benchmarks or reliability data. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer)

### Published architecture and capacity

- The public FAQ specifies a dedicated instance with Ubuntu, **2 vCPU, 8 GB RAM, persistent disk**, root access, terminal and browser shell. [SuperComputer FAQ](https://supercomputer.abacus.ai/supercomputer_faq)
- The FAQ calls each environment a “dedicated, isolated instance” that is not shared with other users. It does not say that a customer receives a dedicated physical host; elsewhere, Abacus describes logical data separation as its general default. [SuperComputer FAQ](https://supercomputer.abacus.ai/supercomputer_faq), [Abacus.AI Security Policy](https://abacus.ai/security)
- Each VM receives an Abacus-provisioned `ABACUS_API_KEY` for RouteLLM. Model/API calls using it consume subscription credits separately from VM runtime. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer)
- Abacus mentions optional GPU access and its wider platform for GPU-intensive work, but the reviewed sources do not publish a GPU SKU, VRAM, availability, or tariff. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer), [SuperComputer FAQ](https://supercomputer.abacus.ai/supercomputer_faq)

### Pricing and limits

- Detailed billing documentation says SuperComputer requires Pro: **$20/month total** and **30,000 credits**; Basic does not include it. Max is **$100/user/month** with **120,000 credits**. [Billing FAQ](https://abacus.ai/help/chatllm-ai-super-assistant/faqs/billing)
- VM runtime costs **1 credit per 5 minutes** while running. That derives to 12 credits/hour, 288 credits/day, or 8,640 credits for 30 continuously running days. Agent, CLI, and model/API consumption is separate. [Billing FAQ](https://abacus.ai/help/chatllm-ai-super-assistant/faqs/billing)
- Monthly plan credits reset at renewal; the billing FAQ says unused *purchased* credits roll over. Exact per-model credit rates are not fixed or published there. [Billing FAQ](https://abacus.ai/help/chatllm-ai-super-assistant/faqs/billing)
- The public landing page advertises “$10/month” (and a first-month promotion), while detailed help says the required Pro plan totals $20/month. The official pages therefore conflict; checkout or Abacus support would need to establish the effective price. [SuperComputer landing page](https://supercomputer.abacus.ai/), [Billing FAQ](https://abacus.ai/help/chatllm-ai-super-assistant/faqs/billing)

### Security and privacy positioning

- The SuperComputer FAQ claims SOC 2 coverage, a dedicated isolated instance, encryption at rest and in transit, and private databases/files/storage/project resources. [SuperComputer FAQ](https://supercomputer.abacus.ai/supercomputer_faq)
- Abacus’s broader security page claims SOC 2 Type II, ISO/IEC 27001, HIPAA, GDPR and CCPA alignment; AES-256 encryption at rest; TLS 1.2+ in transit; AWS KMS; least-privilege/JIT employee access; and audit logging. It states that customers own inputs and outputs and that prompts/responses are not used to train shared models. It also says service data is retained for up to 30 days after termination. [Abacus.AI Security Policy](https://abacus.ai/security)
- The ChatLLM privacy FAQ says Abacus does not train on customer data and has enterprise agreements intended to prevent OpenAI, Anthropic and Google from using that data for training. [Data Security and Privacy](https://abacus.ai/help/chatllm-ai-super-assistant/faqs/data-security)

### Material gaps in official documentation

- “SuperComputer” is product branding; the published base machine is a 2-vCPU/8-GB VM. Disk size/type, CPU generation, network/egress limits, regions, SLA, scaling and concurrency are not published. Abacus describes general platform backups, but no SuperComputer-specific backup/restore contract is published. [Abacus.AI Security Policy](https://abacus.ai/security)
- “Dedicated, isolated instance” may mean a dedicated VM rather than dedicated hardware. The reviewed sources do not settle this.
- Search finding: the reviewed SuperComputer help, FAQ, security, and billing pages do not publish a SuperComputer-specific threat model, root/public-port responsibility split, secret-vault or key-rotation workflow, base-image provenance, patching responsibility, audit export, or disaster-recovery contract. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer), [SuperComputer FAQ](https://supercomputer.abacus.ai/supercomputer_faq), [Abacus.AI Security Policy](https://abacus.ai/security), [Billing FAQ](https://abacus.ai/help/chatllm-ai-super-assistant/faqs/billing)
- Abacus billing marketing says “bring your own model,” but the concrete setup documents an Abacus-issued API key. No procedure for supplying an OpenAI or Anthropic key to SuperComputer appears in the reviewed official pages, so external-provider BYOK should not be assumed. [Billing FAQ](https://abacus.ai/help/chatllm-ai-super-assistant/faqs/billing), [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer)
- Search finding: the reviewed SuperComputer help and FAQ pages do not publish a control-plane API for external automation of VM lifecycle, deployment, domains, storage, or agent execution. [Abacus AI SuperComputer](https://abacus.ai/help/chatllm-ai-super-assistant/supercomputer), [SuperComputer FAQ](https://supercomputer.abacus.ai/supercomputer_faq)

## OpenAI Codex on a remote VPS

### Two supported OpenAI authentication modes

- OpenAI documents two authentication methods for local Codex clients: **Sign in with ChatGPT** for subscription access, and **API key** for usage-based access. The Codex CLI, IDE extension, and ChatGPT desktop app support both; Codex cloud requires ChatGPT sign-in. [Codex authentication](https://developers.openai.com/codex/auth)
- ChatGPT authentication inherits ChatGPT workspace permissions, RBAC, retention and residency controls. API-key authentication instead inherits the API organization’s retention and data-sharing settings. [Codex authentication](https://developers.openai.com/codex/auth)
- With ChatGPT authentication, `codex login` opens a browser flow and caches credentials locally. On a headless VPS, OpenAI recommends the beta device-code flow, `codex login --device-auth`; the user opens a link elsewhere and enters a one-time code. A documented fallback is to authenticate locally and securely copy `~/.codex/auth.json` to the headless machine. [Codex authentication](https://developers.openai.com/codex/auth)
- Login credentials may be stored in plaintext at `~/.codex/auth.json` or in an OS credential store. The storage policy is configurable (`file`, `keyring`, or `auto`); OpenAI says to treat `auth.json` like a password. ChatGPT tokens refresh automatically during active use. [Codex authentication](https://developers.openai.com/codex/auth)
- API-key login is non-interactive: pipe `OPENAI_API_KEY` into `codex login --with-api-key`. API usage is billed to the OpenAI Platform account at standard model rates rather than consuming included ChatGPT usage. [Codex authentication](https://developers.openai.com/codex/auth)
- OpenAI recommends API keys as the default for programmatic workflows such as CI/CD and warns not to expose Codex execution to untrusted or public environments. Some ChatGPT-workspace/cloud features are unavailable with API-key auth. [Codex authentication](https://developers.openai.com/codex/auth)
- ChatGPT Enterprise additionally supports Codex access tokens for trusted, non-interactive local workflows, schedulers and private CI runners. These preserve ChatGPT-managed entitlements and workspace controls without browser sign-in. This is not documented as a personal Plus/Pro feature. [Codex authentication](https://developers.openai.com/codex/auth)

### Headless execution and automation surfaces

- The CLI runs on macOS and Linux and works against the repository and tools installed on that host. It supports interactive operation and `codex exec` for scripts and pipelines. [Codex CLI](https://developers.openai.com/codex/cli)
- `codex exec` is the official non-interactive mode for CI, scheduled jobs and shell pipelines. It streams progress to `stderr`, returns the final answer on `stdout`, supports ephemeral runs, resumable sessions, JSONL event output, JSON Schema-constrained output, and explicit sandbox settings. [Non-interactive mode](https://developers.openai.com/codex/noninteractive)
- Non-interactive runs default to a read-only sandbox; `--sandbox workspace-write` enables repository edits. OpenAI says `danger-full-access` should be used only in a controlled environment such as an isolated runner/container. [Non-interactive mode](https://developers.openai.com/codex/noninteractive)
- For a one-off automated API-key run, `CODEX_API_KEY` can be scoped to a single `codex exec` invocation. OpenAI warns not to put API keys in a job-wide environment alongside repository-controlled code and recommends its GitHub Action for GitHub CI. [Non-interactive mode](https://developers.openai.com/codex/noninteractive)
- The Codex SDK controls local agents programmatically. The official TypeScript SDK (`@openai/codex-sdk`, Node 18+) documents starting, continuing, and resuming threads. The Python SDK (`openai-codex`, Python 3.10+) documents starting and running threads and drives the local app-server over JSON-RPC. Codex can also run as an MCP server when embedded as a specialist in a broader Agents SDK workflow. [Codex SDK](https://developers.openai.com/codex/sdk)

### Subscription usage versus API/BYOK billing

- Codex is included across ChatGPT plans. The current pricing page lists Plus at **$20/month** and describes it as suited to a few focused coding sessions per week; exact consumption varies with model, context, task complexity, tools, caching, and whether work is local or cloud. Limits may include rolling five-hour and weekly windows. [Codex pricing](https://developers.openai.com/codex/pricing)
- Plus and Pro users who exhaust included usage may purchase ChatGPT credits where available, upgrade, switch models, or wait for reset. Credits are token-based and shared with certain other agentic ChatGPT features. [Codex pricing](https://developers.openai.com/codex/pricing), [Using Codex with your ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- API-key use supports the CLI, SDK and IDE extension but not Codex cloud or cloud integrations such as GitHub code review and Slack. It is metered per token at API rates and constrained by the API organization/project’s model-specific rate and usage limits; usage tiers usually advance as API spend increases. [Codex pricing](https://developers.openai.com/codex/pricing), [OpenAI API rate limits](https://developers.openai.com/api/docs/guides/rate-limits)
- OpenAI’s official material treats ChatGPT subscription auth and Platform API-key billing as alternatives, not as a single pool: API-key runs do not draw from included ChatGPT usage. “BYOK” here can accurately mean the VPS operator supplies its own OpenAI Platform API key; the sources do not establish a supported way for a third-party hosted service to pool, resell, or silently reuse end users’ personal ChatGPT subscription credentials.

## Source caution

- A private VPS controlled by one user can run the Codex CLI under either that user’s ChatGPT login or an API key. For unattended service operation, OpenAI explicitly favors API keys; ChatGPT-managed automation is documented as an advanced trusted-runner path, with Enterprise access tokens as the managed option.
- A multi-user hosted product is a different security and identity problem from a single-user remote workstation. The reviewed OpenAI sources warn against public/untrusted Codex execution and do not establish personal ChatGPT subscriptions as a general-purpose service credential for hosting arbitrary third-party users.
- Product limits, model availability and prices are dynamic. Recheck the linked pricing, authentication and rate-limit pages before implementation or commercial commitments.

## Evaluation

### Verdict

**Proceed with Sporades Hub as a universal desktop GUI alternative to the Sporades CLI.** It is not a remote development box, VPS product, web IDE, model router, or new hosting control plane. The desktop and CLI are sibling adapters over one shared operations module; neither adapter owns lifecycle truth.

This changes the delivery surface without changing the hosting model. Sporades already defines deterministic, scriptable CLI operations and one normalized release across Dev, Container, and Hosted Capsule modes ([PRD](../PRD.md#product-principles)). Hub makes those same capabilities visual and discoverable while the CLI remains the automation-grade interface.

### Product and authority boundaries

| Component | Responsibility | Explicit non-responsibility |
| --- | --- | --- |
| **Operations module** | One deep, UI-independent API for template instantiation, Host operations, Hosted Capsule lifecycle, verification, progress events, cancellation, and recovery | Rendering terminal text, parsing CLI flags, owning Electron windows, or becoming a second registry |
| **CLI adapter** | Convert arguments/stdin into operation requests and render structured results for humans or automation | Reimplement Host logic or retain state needed by another client |
| **Desktop adapter** | Convert GUI actions into the same operation requests and render state/progress | Shell out to the CLI as its architectural API or invent desktop-only lifecycle semantics |
| **Host server registry** | Authoritative Hosted Capsule registration, release pointers, route state, and lifecycle metadata | Mirroring itself into desktop-local state as another source of truth |

The Host registry remains authoritative exactly as the current architecture requires; project bindings are convenience pointers, and lifecycle commands must work from any machine with the relevant Host profile ([ADR 0016](../adr/0016-host-server-registry-authoritative.md)). The desktop may cache presentation data, but every consequential refresh or mutation must reconcile through operations with the Host-owned state. The existing Hosted Capsule contract already places registry, release installation, Caddy routes, Docker lifecycle, logs, stats, SSH inspection, and persistent storage behind the Host helper ([PRD](../PRD.md#hosted-capsule)).

### Initial desktop surfaces

The first release should expose four connected surfaces—no decorative dashboard confetti required:

1. **Templates** — browse the real Sporades template/framework/toolchain matrix, choose a target Host and Capsule identity, instantiate the project, and drive it through registration, release push, restart, verification, and health. The current catalog includes `blank`, `todo`, `guestbook`, `photo-library`, and `campfire` across the supported framework matrix ([project reference](../guide/reference.md#create-a-capsule)).
2. **Hosts** — add, select, bootstrap, inspect, and health-check Host profiles using the same operation contracts as `sporades host ...`. A Host profile still names the SSH target, Hosted domain, scheme, remote root, and TLS mode ([PRD](../PRD.md#hosted-capsule)).
3. **Capsules** — list authoritative Hosted Capsules and expose lifecycle, stats, logs, release and open-in-browser actions. It is a view over Host state, not a desktop-owned deployment database.
4. **Tiled Terminals** — create, split, focus, rename, reconnect, and close multiple terminal sessions alongside the visual workflows. Terminals are a universal escape hatch for Sporades, Git, Codex, Claude, shell tools, or SSH—not a bespoke Codex chat client and not a public browser terminal served from a VPS.

### Template-to-Ready contract

A template card is useful only if it produces a real Hosted Capsule. The canonical operation should:

1. validate template, framework, toolchain, Host profile, Capsule subname, and destination;
2. instantiate the same scaffold used by `sporades create`;
3. register the Capsule in the authoritative Host registry;
4. build and push the normalized release with restart and verification enabled;
5. observe structured Host progress and surface actionable recovery; and
6. check the routed public URL before reporting success.

**Ready means the routed Hosted Capsule URL passes health verification.** A generated directory, successful upload, running container, or green Host daemon alone is not Ready. This matches the existing provisioning checklist, which requires Host health after DNS and requires a deployed public URL to resolve to the Hosted Capsule or a structured Sporades response ([host provisioning](../agents/host-provisioning.md#verification-checklist)); Hosted Capsule release verification and failure behavior are already defined in the reference ([Hosted Capsule reference](../guide/reference.md#hosted-capsules)).

The GUI should expose the difference between `creating`, `registered`, `pushing`, `starting`, `verifying`, `ready`, and `failed`. Retry must resume or repeat an idempotent operation rather than manufacture a second Capsule because someone enthusiastically double-clicked.

### Architecture: one deep module, two adapters

The main design requirement is extraction, not duplication. Move orchestration currently coupled to CLI entrypoints behind typed operations with stable request/result envelopes and structured events. Both adapters call that module in-process:

```text
CLI adapter ─────┐
                 ├── operations ── SSH / Host helper ── authoritative Host registry
Desktop adapter ─┘
```

Operations should own validation, idempotency keys, cancellation, timeouts, progress cursors, safe redaction, and mapping Host-helper responses into domain results. Adapters should own only interaction concerns. This preserves the existing requirement that machine-consumed commands use a standard structured envelope ([PRD](../PRD.md#cli-commands)) and the product goal that agents never need to scrape output ([CONTEXT](../../CONTEXT.md)).

The desktop must not invoke human-formatted CLI output and scrape it. A transitional CLI subprocess tracer is acceptable only while extracting the first operation; it is not the target seam. Otherwise the GUI becomes an ornate parser for its own software, which is certainly one way to create employment.

### Electron shell and security boundary

Electron is the pragmatic first shell because the product needs local filesystem access, PTYs, SSH integration, window management, and a web-technology UI. It is intentionally replaceable: the operations module must not import Electron, renderer types, or IPC concepts.

The Electron renderer must be sandboxed, use context isolation, disable Node integration, load packaged local content, and receive only a small allow-listed preload API. IPC messages must be typed, schema-validated, permission-checked, and sender-validated; arbitrary command execution, raw filesystem access, credentials, and Host-helper primitives stay in the main process/operations boundary. These choices follow Electron’s official security guidance to enable context isolation and process sandboxing, avoid Node integration for remote content, and validate IPC senders ([Electron security](https://www.electronjs.org/docs/latest/tutorial/security)).

Tiled terminals require a deliberately narrow PTY API—create, write, resize, signal, observe, dispose—rather than a generic renderer-to-shell bridge. Capsule URLs open through an allow-listed HTTPS action; they are not rendered inside a privileged Electron view.

### Incremental repository conversion

The repository is currently one npm package named `sporades`; its root [`package.json`](../../package.json) has no `workspaces` field. It is therefore **not currently an npm workspace monorepo**, regardless of how many directories look ambitious in Finder. npm workspaces are explicitly declared from the top-level package configuration ([npm workspaces](https://docs.npmjs.com/cli/v11/using-npm/workspaces)).

Convert incrementally, adding only the two new workspace units needed for this design:

```text
packages/operations   shared deep operations module
apps/desktop          Electron desktop adapter and renderer
```

Keep the existing root `sporades` package and CLI intact while it is migrated to consume `packages/operations`. Do not simultaneously split runtime, templates, server, client, adapters, docs, and utilities into a grand ceremonial monorepo. First prove one vertical operation—template to verified Hosted Capsule—through both CLI and desktop, then move the next command family behind the same seam.

### Abacus comparison after the design correction

| Abacus SuperComputer idea | Sporades Hub decision |
| --- | --- |
| Persistent vendor cloud computer | No equivalent; Hub runs on the user’s desktop |
| Natural-language agent plus browser shell | Tiled local terminals that can run any chosen CLI or SSH workflow |
| Generic databases, storage, public services and model routing | Existing Sporades Host and Hosted Capsule capabilities only |
| One-click application creation/deployment | Template-to-real-Hosted-Capsule operation with an externally verified Ready state |
| Hermes and OpenClaw persistent agents | Red herrings for the core product; at most later constrained OCI tool recipes with explicit mounts, network, secrets and lifecycle policy |
| SuperComputer control plane | No new control plane; Desktop and CLI share operations and the Host registry stays authoritative |

Hermes/OpenClaw should not shape the Hub architecture. If users later want them, treat each as an untrusted third-party OCI workload admitted through a constrained recipe—not as a privileged Hub agent, default capability, or reason to expose Docker/Host internals.

### First implementation slice and acceptance

Implement one tracer end to end:

1. create `packages/operations` and `apps/desktop` as the only new workspaces;
2. extract the minimum template, Host, push, verification, logs, and open operations required by the tracer;
3. update the existing CLI path to use those operations without changing its contract;
4. implement the sandboxed Electron shell with Templates, Hosts, Capsules, and tiled Terminals;
5. instantiate one supported template onto a configured Host as a real Hosted Capsule;
6. show structured progress and recovery through the desktop;
7. withhold **Ready** until the routed URL passes health; and
8. prove CLI and desktop observe and mutate the same authoritative Host state.

Acceptance requires automated tests around operation contracts and renderer IPC, plus one real Host tracer using the public routed URL. Screenshots of a lovely template card do not establish that an application exists. Pixels are notorious optimists.

### Final recommendation

Build **Sporades Hub Preview** as a replaceable Electron desktop adapter over a shared deep operations module. Preserve the CLI as its sibling, preserve the Host registry as truth, and make the first promise brutally concrete: choose a template, choose a Host, create a real Hosted Capsule, watch it deploy, and see **Ready** only after its routed URL passes health.

Do not build a remote devbox, VPS workshop, bespoke Codex UI, new Host control plane, generic cloud marketplace, or privileged Hermes/OpenClaw runtime. The product is the visual Sporades workflow; everything else is cape-related scope creep.
