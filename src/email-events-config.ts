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

export function validateEmailWebhooksConfig(webhooks: LooseRecord | undefined) {
  if (webhooks === undefined) return undefined;
  const webhooksData = captureMailConfigData(
    webhooks,
    ["mailjet"],
    "Invalid email webhook configuration.",
    "Configure only supported providers under `mail.webhooks`.",
  );
  const mailjetInput = webhooksData.get("mailjet");
  if (mailjetInput === undefined) return {};
  const mailjet = captureMailConfigData(
    mailjetInput,
    ["enabled", "path", "secretEnv"],
    "Invalid Mailjet webhook configuration.",
    "Configure `mail.webhooks.mailjet` with optional enabled, path, and secretEnv values.",
  );
  const enabled = mailjet.get("enabled") ?? true;
  const path = mailjet.get("path") ?? "/__sporades/mail/webhooks/mailjet";
  const secretEnv = mailjet.get("secretEnv") ?? "MAILJET_WEBHOOK_SECRET";
  if (typeof enabled !== "boolean") {
    invalidMailConfig("Invalid Mailjet webhook enabled flag.", "Set `mail.webhooks.mailjet.enabled` to true or false.");
  }
  if (!sameOriginWebhookPath(path)) {
    invalidMailConfig(
      "Invalid Mailjet webhook path.",
      "Set `mail.webhooks.mailjet.path` to a same-origin absolute path without a query or fragment.",
    );
  }
  if (!isServerEnvReference(secretEnv)) {
    invalidMailConfig(
      "Invalid Mailjet webhook Server env reference.",
      "Set `mail.webhooks.mailjet.secretEnv` to an uppercase Server env key without the reserved `SPORADES_` prefix.",
    );
  }
  return { mailjet: { enabled, path, secretEnv } };
}
