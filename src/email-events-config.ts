import { captureMailConfigData, invalidMailConfig, isServerEnvReference } from "./mail-config-validation.js";

type LooseRecord = Record<string, any>;

function sameOriginWebhookPath(value: unknown) {
  return typeof value === "string"
    && value.startsWith("/")
    && !value.startsWith("//")
    && !value.includes("\\")
    && !value.includes("?")
    && !value.includes("#")
    && !/\s/.test(value)
    && !value.split("/").includes("..");
}

function runtimeOwnedHttpPath(value: string) {
  return /^\/__sporades\/(?:auth|debug|files|health|uploads)(?:\/|$)/.test(value);
}

export function validateEmailWebhooksConfig(webhooks: LooseRecord | undefined) {
  if (webhooks === undefined) return undefined;
  const webhooksData = captureMailConfigData(
    webhooks,
    ["mailjet", "smtp2go", "postmark", "mailgun"],
    "Invalid email webhook configuration.",
    "Configure only supported providers under `mail.webhooks`.",
  );
  const result: LooseRecord = {};
  for (const [provider, defaultPath, defaultSecretEnv] of [
    ["mailjet", "/__sporades/mail/webhooks/mailjet", "MAILJET_WEBHOOK_SECRET"],
    ["smtp2go", "/__sporades/mail/webhooks/smtp2go", "SMTP2GO_WEBHOOK_SECRET"],
    ["postmark", "/__sporades/mail/webhooks/postmark", "POSTMARK_WEBHOOK_SECRET"],
    ["mailgun", "/__sporades/mail/webhooks/mailgun", "MAILGUN_WEBHOOK_KEY"],
  ]) {
    const input = webhooksData.get(provider);
    if (input === undefined) continue;
    const data = captureMailConfigData(
      input,
      ["enabled", "path", "secretEnv"],
      `Invalid ${provider} webhook configuration.`,
      `Configure \`mail.webhooks.${provider}\` with optional enabled, path, and secretEnv values.`,
    );
    const enabled = data.get("enabled") ?? true;
    const path = data.get("path") ?? defaultPath;
    const secretEnv = data.get("secretEnv") ?? defaultSecretEnv;
    if (typeof enabled !== "boolean") {
      invalidMailConfig(`Invalid ${provider} webhook enabled flag.`, `Set \`mail.webhooks.${provider}.enabled\` to true or false.`);
    }
    if (!sameOriginWebhookPath(path) || runtimeOwnedHttpPath(path)) {
      invalidMailConfig(
        `Invalid ${provider} webhook path.`,
        `Set \`mail.webhooks.${provider}.path\` to a same-origin absolute path outside Sporades runtime-owned HTTP namespaces.`,
      );
    }
    if (!isServerEnvReference(secretEnv)) {
      invalidMailConfig(
        `Invalid ${provider} webhook Server env reference.`,
        `Set \`mail.webhooks.${provider}.secretEnv\` to an uppercase Server env key without the reserved \`SPORADES_\` prefix.`,
      );
    }
    result[provider] = { enabled, path, secretEnv };
  }
  return result;
}
