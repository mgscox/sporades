export type GithubAutodeployWorkflowOptions = {
  hostAlias: string;
  subname: string;
  branch: string;
};

export function createGithubAutodeployWorkflow({ hostAlias, subname, branch }: GithubAutodeployWorkflowOptions) {
  return `name: Sporades Autodeploy

on:
  push:
    branches: [${JSON.stringify(branch)}]
  pull_request:
    branches: [${JSON.stringify(branch)}]
  workflow_dispatch:

permissions:
  contents: read
  pull-requests: write

env:
  SPORADES_HOST_ALIAS: ${hostAlias}
  SPORADES_HOST_SUBNAME: ${subname}
  SPORADES_HOST_SERVER: \${{ vars.SPORADES_HOST_SERVER }}
  SPORADES_HOST_DOMAIN: \${{ vars.SPORADES_HOST_DOMAIN }}
  SPORADES_HOST_REMOTE_ROOT: \${{ vars.SPORADES_HOST_REMOTE_ROOT }}
  SPORADES_AUTODEPLOY_SUMMARY: \${{ runner.temp }}/sporades-autodeploy-summary.md

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Check out repository
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: |
          if [ -f package-lock.json ]; then
            npm ci
          else
            npm install
          fi

      - name: Run project tests
        run: |
          if node -e "const p = require('./package.json'); process.exit(p.scripts && p.scripts.test ? 0 : 1)"; then
            npm test
          else
            echo "No npm test script declared; skipping project tests."
          fi

      - name: Configure Host SSH key
        run: |
          mkdir -p ~/.ssh
          printf '%s\\n' "\${{ secrets.SPORADES_HOST_SSH_PRIVATE_KEY }}" > ~/.ssh/sporades_host_key
          chmod 600 ~/.ssh/sporades_host_key
          cat >> ~/.ssh/config <<'SSH_CONFIG'
          Host *
            IdentityFile ~/.ssh/sporades_host_key
            IdentitiesOnly yes
            StrictHostKeyChecking accept-new
          SSH_CONFIG

      - name: Configure Sporades Host profile
        run: |
          npx sporades host add "$SPORADES_HOST_ALIAS" \\
            --server "$SPORADES_HOST_SERVER" \\
            --domain "$SPORADES_HOST_DOMAIN" \\
            --remote-root "$SPORADES_HOST_REMOTE_ROOT" \\
            --json

      - name: Sporades release preflight
        run: |
          npx sporades host current --host "$SPORADES_HOST_ALIAS" --json
          npx sporades host health --host "$SPORADES_HOST_ALIAS" --json

      - name: Push verified Hosted Capsule release
        id: sporades_deploy
        shell: bash
        run: |
          set +e
          npx sporades host push --host "$SPORADES_HOST_ALIAS" --subname "$SPORADES_HOST_SUBNAME" --verify --json > "$RUNNER_TEMP/sporades-host-push.json"
          deploy_exit=$?
          set -e
          node <<'NODE'
          const fs = require("node:fs");

          const outputPath = process.env.RUNNER_TEMP + "/sporades-host-push.json";
          const raw = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, "utf8") : "";
          let envelope = null;
          try {
            envelope = JSON.parse(raw);
          } catch {
            envelope = null;
          }

          const data = envelope?.data ?? {};
          const verification = data.verification ?? {};
          const hostedUrl =
            data.capsule?.hostedUrl ??
            data.release?.hostedUrl ??
            "https://" + process.env.SPORADES_HOST_SUBNAME + "." + process.env.SPORADES_HOST_DOMAIN;
          const releaseId = data.release?.id ?? data.currentAttemptedRelease?.id ?? "unknown";
          const verificationState =
            verification?.state ??
            (data.verified === true ? "verified" : data.verified === false ? "failed" : envelope?.ok ? "not reported" : "command failed");
          const resultLabel = verificationState === "failed" ? "Verification failed" : envelope?.ok ? "Successful deploy" : "Command failed";
          const previousReleaseId = data.previousCurrentRelease?.id ?? data.rollbackGuidance?.previousReleaseId ?? null;
          const rollbackCommand =
            data.rollbackGuidance?.command ??
            (verificationState === "failed" && previousReleaseId
              ? "sporades host rollback " + process.env.SPORADES_HOST_SUBNAME + " " + previousReleaseId + " --host " + process.env.SPORADES_HOST_ALIAS
              : null);

          function escapeCell(value) {
            return String(value ?? "unknown").replace(/\\|/g, "\\\\|").replace(/\\r?\\n/g, " ");
          }

          function hostedCell(url) {
            if (/^https?:\\/\\//.test(url)) {
              return "[" + escapeCell(url) + "](" + url + ")";
            }
            return escapeCell(url);
          }

          const lines = [
            "## Sporades autodeploy result",
            "",
            "| Field | Value |",
            "| --- | --- |",
            "| Result | " + escapeCell(resultLabel) + " |",
            "| Hosted Capsule | " + hostedCell(hostedUrl) + " |",
            "| Release ID | " + escapeCell(releaseId) + " |",
            "| Verification | " + escapeCell(verificationState) + " |",
          ];

          if (!envelope) {
            lines.push("", "No structured Sporades deploy output was available.");
          } else if (!envelope.ok && envelope.error?.message) {
            lines.push("", "Failure: " + envelope.error.message);
          }

          if (rollbackCommand) {
            lines.push(
              "",
              "### Rollback guidance",
              "",
              "Sporades did not roll back automatically. To roll back manually, run:",
              "",
              "    " + rollbackCommand,
            );
          } else if (verificationState === "failed") {
            lines.push(
              "",
              "### Rollback guidance",
              "",
              "No previous release was reported, so no rollback command is available.",
            );
          }

          const summary = lines.join("\\n") + "\\n";
          fs.writeFileSync(process.env.SPORADES_AUTODEPLOY_SUMMARY, summary);
          fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
          NODE
          exit "$deploy_exit"

      - name: Publish pull request deploy result
        if: always() && github.event_name == 'pull_request'
        uses: actions/github-script@v7
        with:
          script: |
            const fs = require('node:fs');
            const summaryPath = process.env.SPORADES_AUTODEPLOY_SUMMARY;
            const body = fs.existsSync(summaryPath)
              ? fs.readFileSync(summaryPath, 'utf8')
              : '## Sporades autodeploy result\\n\\nDeploy result summary was unavailable.\\n';
            await github.rest.pulls.createReview({
              owner: context.repo.owner,
              repo: context.repo.repo,
              pull_number: context.payload.pull_request.number,
              event: 'COMMENT',
              body
            });
`;
}
