import assert from "node:assert/strict";
import { test } from "node:test";

import { validatePasswordResetConfig, validateTeamsConfig } from "../dist/cli/project-config.js";

function reject(passwordReset, label) {
  assert.throws(
    () => validatePasswordResetConfig({ email: { passwordReset } }),
    (error) => error.code === "INVALID_AUTH_CONFIG",
    label,
  );
}

test("the reset page location is accepted only as a same-origin absolute path", async () => {
  assert.doesNotThrow(() => validatePasswordResetConfig(undefined), "password reset config is optional");
  assert.doesNotThrow(() => validatePasswordResetConfig({ email: { passwordReset: { path: "/account/new-password" } } }));

  // A URL here would make the reset flow an open redirect.
  reject({ path: "https://evil.example.com/reset" }, "an absolute URL must be rejected");
  reject({ path: "//evil.example.com/reset" }, "a protocol-relative URL must be rejected");
  reject({ path: "reset-password" }, "a relative path must be rejected");
  reject({ path: "/reset/../../etc/passwd" }, "a traversal path must be rejected");
  reject({ path: "/reset?next=https://evil.example.com" }, "a path carrying a query must be rejected");
  reject({ path: 42 }, "a non-string path must be rejected");
});

test("the reset code lifetime is accepted only inside its supported bounds", async () => {
  assert.doesNotThrow(() => validatePasswordResetConfig({ email: { passwordReset: { ttlMs: 30 * 60 * 1000 } } }));

  reject({ ttlMs: 60 * 1000 }, "a lifetime under five minutes must be rejected");
  reject({ ttlMs: 48 * 60 * 60 * 1000 }, "a lifetime over twenty-four hours must be rejected");
  reject({ ttlMs: "3600000" }, "a non-numeric lifetime must be rejected");
});

test("unknown password reset keys are rejected rather than silently ignored", async () => {
  reject({ continueUrl: "https://example.com/done" }, "the reset flow has no caller-supplied continue target");
});

test("the Team Join page is accepted only as a same-origin absolute path", async () => {
  assert.doesNotThrow(() => validateTeamsConfig(undefined));
  assert.doesNotThrow(() => validateTeamsConfig({ join: { path: "/invite/join" } }));
  for (const path of ["https://evil.example/join", "//evil.example/join", "join", "/join?next=https://evil.example", "/join/../admin"]) {
    assert.throws(() => validateTeamsConfig({ join: { path } }), (error) => error.code === "INVALID_TEAMS_CONFIG", path);
  }
});
