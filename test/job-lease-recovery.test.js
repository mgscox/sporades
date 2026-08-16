import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createControllableRuntimeClock, openDevDatabase } from "../dist/server-runtime-source.js";
import { job, mutation } from "../dist/server.js";
import { runMutation } from "../dist/server-runtime-source.js";
import { POSTGRES_SKIP_REASON, withPostgresAdapter } from "./support/database-adapter-engines.js";
import { withFakeLibsqlService } from "./support/libsql-http-service.js";

async function assertFutureLeaseRecoveryAcrossRestart({ databasePath, config, serverEnv = {}, options }) {
  const clock = options.clock;
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return null; }) } };
  let database;
  try {
    database = await openDevDatabase(databasePath, "", serverEnv, config, capsule, options);
    const sql = database.adapter.dialect.sql;
    const now = clock.now().toISOString();
    await database.adapter.prepare(sql("INSERT INTO [sporades_auth_users] ([id],[createdAt],[displayName],[email],[picture],[isAuthenticated],[isGuest],[provider]) VALUES (?,?,?,?,?,?,?,?)"))
      .run("future-lease-user", now, "user", null, null, 0, 1, "anonymous");
    await database.adapter.prepare(sql("INSERT INTO [sporades_jobs] ([id],[handler],[enqueuedByUserId],[actorUserId],[payload],[status],[availableAt],[attempts],[createdAt],[retryJson],[attemptHistory],[leaseExpiresAt],[claimToken]) VALUES (?,?,?,?,?,'running',?,1,?,?,?,?,?)"))
      .run("future-lease", "work", "future-lease-user", "future-lease-user", "null", now, now, '{"maxAttempts":2,"delayMs":0}', "[]", "2030-01-01T00:00:10.000Z", "claim-before-restart");
    await database.close();

    database = await openDevDatabase(databasePath, "", serverEnv, config, capsule, options);
    await database.init();
    clock.advanceBy(10_001);
    await clock.runDueTimers();
    assert.equal(executions, 1);
    const row = await database.adapter.prepare(sql("SELECT [status], [attempts] FROM [sporades_jobs] WHERE [id]=?")).get("future-lease");
    assert.equal(row.status, "succeeded");
    assert.equal(Number(row.attempts), 2);
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
  }
}
test("startup recovers an expired running lease as a consumed delayed retry", async()=>{const dir=await mkdtemp(path.join(tmpdir(),"sporades-lease-"));const file=path.join(dir,"data.db");let ran=0;let db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{work:job(()=>{ran++;return null})}});try{const now=new Date().toISOString();db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",now,"u",null,null,0,1,"anonymous");db.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory,leaseExpiresAt) VALUES (?,?,?,?,?,'running',?,1,?,?,?,?)").run("expired","work","u","u","{}",now,now,'{"maxAttempts":2,"delayMs":10}',"[]",new Date(Date.now()-1).toISOString());db.close();db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{work:job(()=>{ran++;return null})}});assert.equal(db.adapter.prepare("SELECT status FROM sporades_jobs WHERE id='expired'").get().status,"delayed");await db.init();await new Promise(r=>setTimeout(r,30));assert.equal(ran,1);assert.equal(db.adapter.prepare("SELECT attempts,status FROM sporades_jobs WHERE id='expired'").get().attempts,2);}finally{db.close();await rm(dir,{recursive:true,force:true});}});

test("restart before a running lease expires recovers the Job when the lease becomes due", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-future-lease-recovery-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return null; }) } };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const now = clock.now().toISOString();
    database.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)")
      .run("u", now, "u", null, null, 0, 1, "anonymous");
    const leaseExpiresAt = "2030-03-01T00:00:00.000Z";
    database.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory,leaseExpiresAt,claimToken) VALUES (?,?,?,?,?,'running',?,1,?,?,?,?,?)")
      .run("future-lease", "work", "u", "u", "null", now, now, '{"maxAttempts":2,"delayMs":0}', "[]", leaseExpiresAt, "claim-before-restart");
    await database.close();

    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    await database.init();
    clock.advanceBy(2_147_483_647);
    await clock.runDueTimers();
    assert.equal(executions, 0);
    assert.equal(database.adapter.prepare("SELECT status FROM sporades_jobs WHERE id=?").get("future-lease").status, "running");
    clock.advanceBy(Date.parse(leaseExpiresAt) - clock.now().getTime() + 1);
    await clock.runDueTimers();

    assert.equal(executions, 1);
    const row = database.adapter.prepare("SELECT status, attempts FROM sporades_jobs WHERE id=?").get("future-lease");
    assert.equal(row.status, "succeeded");
    assert.equal(row.attempts, 2);
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("libSQL restart before lease expiry recovers the Job when the lease becomes due", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-future-lease-libsql-"));
  try {
    await withFakeLibsqlService(path.join(dir, "libsql.db"), async ({ url }) => {
      const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
      const serverEnv = { SPORADES_SERVICE_DATABASE_ENGINE: "libsql", SPORADES_SERVICE_DATABASE_URL: url };
      await assertFutureLeaseRecoveryAcrossRestart({
        databasePath: path.join(dir, "unused.db"),
        config: { name: "future-lease-libsql", services: { database: { engine: "libsql" } } },
        serverEnv,
        options: { clock, serviceEnv: serverEnv },
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Postgres restart before lease expiry recovers the Job when the lease becomes due", {
  skip: POSTGRES_SKIP_REASON,
}, async () => {
  await withPostgresAdapter(async () => {});
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  const serverEnv = {
    SPORADES_SERVICE_DATABASE_ENGINE: "postgres",
    SPORADES_SERVICE_DATABASE_URL: process.env.SPORADES_POSTGRES_TEST_URL,
  };
  await assertFutureLeaseRecoveryAcrossRestart({
    databasePath: "unused.db",
    config: { name: "future-lease-postgres", services: { database: { engine: "postgres" } } },
    serverEnv,
    options: { clock, serviceEnv: serverEnv },
  });
});

test("startup fails running Jobs with missing or noncanonical leases without executing them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-invalid-running-lease-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return null; }) } };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const now = clock.now().toISOString();
    database.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)")
      .run("u", now, "u", null, null, 0, 1, "anonymous");
    const insert = database.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory,leaseExpiresAt,claimToken) VALUES (?,?,?,?,?,'running',?,1,?,?,?,?,?)");
    insert.run("missing-lease", "work", "u", "u", "null", now, now, '{"maxAttempts":2,"delayMs":0}', "[]", null, "missing-claim");
    insert.run("invalid-lease", "work", "u", "u", "null", now, now, '{"maxAttempts":2,"delayMs":0}', "[]", "not-a-timestamp", "invalid-claim");
    await database.close();

    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const rows = database.adapter.prepare("SELECT id, status, failure FROM sporades_jobs ORDER BY id").all();
    assert.deepEqual(rows.map((row) => ({ id: row.id, status: row.status, code: JSON.parse(row.failure).code })), [
      { id: "invalid-lease", status: "failed", code: "JOB_LEASE_INVALID" },
      { id: "missing-lease", status: "failed", code: "JOB_LEASE_INVALID" },
    ]);
    await database.init();
    await clock.runDueTimers();
    assert.equal(executions, 0);
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("close clears a future running-lease recovery wake", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-close-future-lease-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return null; }) } };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const now = clock.now().toISOString();
    database.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)")
      .run("u", now, "u", null, null, 0, 1, "anonymous");
    database.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory,leaseExpiresAt,claimToken) VALUES (?,?,?,?,?,'running',?,1,?,?,?,?,?)")
      .run("future-lease", "work", "u", "u", "null", now, now, '{"maxAttempts":2,"delayMs":0}', "[]", "2030-01-01T00:00:10.000Z", "claim-before-close");
    await database.init();
    await database.close();
    database = undefined;

    clock.advanceBy(10_001);
    await clock.runDueTimers();
    assert.equal(executions, 0);
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("a transient due-lease recovery failure is logged and retried", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-retry-future-lease-recovery-"));
  const file = path.join(dir, "data.db");
  const clock = createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
  let executions = 0;
  const capsule = { jobs: { work: job(() => { executions += 1; return null; }) } };
  let database;
  try {
    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    const now = clock.now().toISOString();
    database.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)")
      .run("u", now, "u", null, null, 0, 1, "anonymous");
    database.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory,leaseExpiresAt,claimToken) VALUES (?,?,?,?,?,'running',?,1,?,?,?,?,?)")
      .run("future-lease", "work", "u", "u", "null", now, now, '{"maxAttempts":2,"delayMs":0}', "[]", "2030-01-01T00:00:10.000Z", "claim-before-restart");
    await database.close();

    database = await openDevDatabase(file, "", {}, { name: "jobs" }, capsule, { clock });
    await database.init();
    const originalPrepare = database.adapter.prepare.bind(database.adapter);
    let failScan = true;
    database.adapter.prepare = (sql) => {
      if (failScan && String(sql).includes("sporades_jobs") && String(sql).includes("status") && String(sql).includes("running") && String(sql).includes("ORDER BY")) {
        return { all: async () => { failScan = false; throw new Error("transient lease scan failure"); } };
      }
      return originalPrepare(sql);
    };

    clock.advanceBy(10_001);
    await clock.runDueTimers();
    assert.equal(executions, 0);
    clock.advanceBy(1_000);
    await clock.runDueTimers();
    assert.equal(executions, 1);
    const logs = await database.adapter.readRecentLogEvents(20);
    assert.equal(logs.some((event) => event.event === "job.lease_recovery.failed"), true);
  } finally {
    await Promise.resolve().then(() => database?.close()).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

test("expired exhausted leases fail safely and retained idempotency survives restart", async()=>{const dir=await mkdtemp(path.join(tmpdir(),"sporades-lease-exhausted-"));const file=path.join(dir,"data.db");let db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{}});try{const now=new Date().toISOString();db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",now,"u",null,null,0,1,"anonymous");db.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory,leaseExpiresAt,idempotencyKey) VALUES (?,?,?,?,?,'running',?,1,?,?,?,?,'once')").run("exhausted","missing","u","u","{}",now,now,'{"maxAttempts":1,"delayMs":0}',"[]",new Date(Date.now()-1).toISOString());db.close();db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{}});const row=db.adapter.prepare("SELECT status,failure FROM sporades_jobs WHERE id='exhausted'").get();assert.equal(row.status,"failed");assert.equal(JSON.parse(row.failure).code,"JOB_LEASE_EXPIRED");}finally{db.close();await rm(dir,{recursive:true,force:true});}});

test("retained idempotency resolves one Job after runtime restart",async()=>{const dir=await mkdtemp(path.join(tmpdir(),"sporades-idempotency-restart-"));const file=path.join(dir,"data.db");const capsule={jobs:{noop:job(()=>null)},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("noop",{},{idempotencyKey:"same"}))}};let db=await openDevDatabase(file,"",{},{name:"jobs"},capsule);const auth={userId:"u",displayName:"u",email:null,picture:null,isAuthenticated:false,isGuest:true,provider:"anonymous"};try{db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous");const first=await runMutation(db,auth,"enqueue",[]);await new Promise(r=>setTimeout(r,10));db.close();db=await openDevDatabase(file,"",{},{name:"jobs"},capsule);const second=await runMutation(db,auth,"enqueue",[]);assert.equal(first.data.id,second.data.id);assert.equal(db.adapter.prepare("SELECT count(*) AS count FROM sporades_jobs").get().count,1);await new Promise(r=>setTimeout(r,10));}finally{db.close();await rm(dir,{recursive:true,force:true});}});

test("conditional lease claim has one winner and expired side effects may run again",async()=>{const dir=await mkdtemp(path.join(tmpdir(),"sporades-claim-race-"));const file=path.join(dir,"data.db");let effects=0;let db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{work:job(()=>{effects++;return null})}});try{const now=new Date().toISOString();db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",now,"u",null,null,0,1,"anonymous");db.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory) VALUES (?,?,?,?,?,'queued',?,0,?,?,?)").run("claim","work","u","u","{}",now,now,'{"maxAttempts":2,"delayMs":0}',"[]");const a=db.adapter.prepare("UPDATE sporades_jobs SET status='running' WHERE id=? AND status='queued'").run("claim");const b=db.adapter.prepare("UPDATE sporades_jobs SET status='running' WHERE id=? AND status='queued'").run("claim");assert.equal(a.changes+b.changes,1);db.adapter.prepare("UPDATE sporades_jobs SET leaseExpiresAt=?, status='running', attempts=1 WHERE id=?").run(new Date(Date.now()-1).toISOString(),"claim");db.close();db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{work:job(()=>{effects++;return null})}});await db.init();await new Promise(r=>setTimeout(r,20));assert.equal(effects,1);}finally{db.close();await rm(dir,{recursive:true,force:true});}});

test("expired leases recover in availableAt then Job ID order",async()=>{const dir=await mkdtemp(path.join(tmpdir(),"sporades-lease-order-"));const file=path.join(dir,"data.db");const seen=[];let db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{work:job((ctx,p)=>seen.push(p.id))}});try{const now=new Date().toISOString();db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",now,"u",null,null,0,1,"anonymous");for(const id of ["b","a"])db.adapter.prepare("INSERT INTO sporades_jobs (id,handler,enqueuedByUserId,actorUserId,payload,status,availableAt,attempts,createdAt,retryJson,attemptHistory,leaseExpiresAt) VALUES (?,?,?,?,?,'running',?,1,?,?,?,?)").run(id,"work","u","u",JSON.stringify({id}),now,now,'{"maxAttempts":2,"delayMs":0}',"[]",new Date(Date.now()-1).toISOString());db.close();db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{work:job((ctx,p)=>seen.push(p.id))}});await db.init();await new Promise(r=>setTimeout(r,25));assert.deepEqual(seen,["a","b"]);}finally{db.close();await rm(dir,{recursive:true,force:true});}});
