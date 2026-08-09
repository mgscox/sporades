import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { openDevDatabase } from "../dist/server-runtime-source.js";
import { job } from "../dist/server.js";

async function openWithJobs(jobs) {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-reserved-jobs-"));
  try {
    const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, { jobs }, {});
    await database.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("Capsules cannot declare Jobs in the runtime-reserved _sporades namespace", async () => {
  // The runtime owns Jobs it enqueues itself, such as password reset delivery.
  // A Capsule that could declare the same name would capture that work.
  await assert.rejects(
    () => openWithJobs({ _sporades_password_reset_mail: job(() => {}) }),
    (error) => error.code === "RESERVED_JOB_NAME",
    "a Capsule must not shadow a runtime-owned Job handler",
  );
  await assert.rejects(
    () => openWithJobs({ _sporadesAnything: job(() => {}) }),
    (error) => error.code === "RESERVED_JOB_NAME",
    "the whole _sporades prefix is reserved, not one exact name",
  );
});

test("ordinary Capsule Job names starting with an underscore still work", async () => {
  await assert.doesNotReject(() => openWithJobs({ _internalCleanup: job(() => {}) }));
  await assert.doesNotReject(() => openWithJobs({ sendWelcome: job(() => {}) }));
});
