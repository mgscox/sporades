import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { mutation } from "../dist/server.js";

const required = [
  "MJ_APIKEY_PUBLIC",
  "MJ_APIKEY_PRIVATE",
  "MAILJET_SMTP_SMOKE_FROM",
  "MAILJET_SMTP_SMOKE_TO",
];
const liveEnabled = required.every((name) => typeof process.env[name] === "string" && process.env[name].length > 0);

test("ctx.mail sends through Mailjet's generic authenticated STARTTLS endpoint", {
  skip: !liveEnabled && "Set Mailjet SMTP credentials plus MAILJET_SMTP_SMOKE_FROM and MAILJET_SMTP_SMOKE_TO to run the live smoke.",
}, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-mailjet-live-"));
  const database = await openDevDatabase(
    path.join(dir, "data.db"),
    "",
    {
      MJ_APIKEY_PUBLIC: process.env.MJ_APIKEY_PUBLIC,
      MJ_APIKEY_PRIVATE: process.env.MJ_APIKEY_PRIVATE,
    },
    {
      name: "mailjet-smtp-smoke",
      mail: {
        smtp: {
          vendor: "mailjet",
          host: "in-v3.mailjet.com",
          port: 587,
          tls: { mode: "required-starttls", rejectUnauthorized: true },
          auth: {
            method: "PLAIN",
            usernameEnv: "MJ_APIKEY_PUBLIC",
            passwordEnv: "MJ_APIKEY_PRIVATE",
          },
          defaultFrom: process.env.MAILJET_SMTP_SMOKE_FROM,
          connectionTimeoutMs: 10_000,
          socketTimeoutMs: 30_000,
        },
      },
    },
    {
      mutations: {
        smoke: mutation((ctx) => ctx.mail.send({
          to: process.env.MAILJET_SMTP_SMOKE_TO,
          subject: "Sporades generic SMTP smoke",
          textBody: "Sporades successfully delivered this message through generic authenticated STARTTLS SMTP.",
        })),
      },
    },
  );
  try {
    const result = await runMutation(database, {
      userId: "mailjet-smoke",
      displayName: "Mailjet SMTP smoke",
      email: null,
      picture: null,
      isAuthenticated: false,
      isGuest: false,
      provider: "test",
    }, "smoke", []);
    assert.equal(result.ok, true, result.error?.code ?? "SMTP smoke failed");
    assert.equal(typeof result.data.messageId, "string");
    assert.equal(result.data.messageId.length > 0, true);
    assert.equal(result.data.accepted.length > 0, true);
  } finally {
    await database.close();
    await rm(dir, { recursive: true, force: true });
  }
});
