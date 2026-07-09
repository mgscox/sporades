import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { job, mutation } from "../dist/server.js";

const auth = (userId) => ({ userId, displayName: userId, email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" });

test("privileged runs enqueue, execute, inspect, and audit system-owned jobs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "sporades-privileged-jobs-"));
  const seen = [];
  let leakedJobs;
  const database = await openDevDatabase(path.join(dir, "data.db"), "", {}, { name: "jobs" }, {
    jobs: { maintain: job((ctx, payload) => { seen.push(ctx.auth.userId); return payload; }) },
    mutations: {
      enqueue: mutation((ctx) => ctx.privileged.run({ operation: "jobs.enqueue", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs.enqueue("maintain", { ok: true }))),
      enqueueTwice: mutation((ctx) => ctx.privileged.run({ operation: "jobs.enqueue-twice", targetResourceKind: "job-queue" }, async (privilegedCtx) => {
        const first = await privilegedCtx.jobs.enqueue("maintain", { ok: "once" }, { idempotencyKey: "privileged-once" });
        const second = await privilegedCtx.jobs.enqueue("maintain", { ok: "ignored" }, { idempotencyKey: "privileged-once" });
        return { first, second };
      })),
      get: mutation((ctx, id) => ctx.privileged.run({ operation: "jobs.get", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs.get(id))),
      list: mutation((ctx) => ctx.privileged.run({ operation: "jobs.list", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs.list())),
      leak: mutation(async (ctx) => { leakedJobs = await ctx.privileged.run({ operation: "jobs.leak", targetResourceKind: "job-queue" }, (privilegedCtx) => privilegedCtx.jobs); return true; }),
      useLeak: mutation(() => leakedJobs.enqueue("maintain", { no: "leak" })),
    },
  });
  try {
    const queued = await runMutation(database, auth("user-a"), "enqueue", []);
    assert.equal(queued.ok, true);
    assert.deepEqual(queued.data.actor, { mode: "privileged-server-role" });
    const repeated = await runMutation(database, auth("user-a"), "enqueueTwice", []);
    assert.equal(repeated.ok, true);
    assert.equal(repeated.data.first.id, repeated.data.second.id);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(seen.every((userId) => userId === "__privileged__"), true);
    assert.equal(seen.length, 2);
    assert.equal((await runMutation(database, auth("user-a"), "get", [queued.data.id])).data.id, queued.data.id);
    assert.equal((await runMutation(database, auth("user-a"), "list", [])).data.jobs.some((entry) => entry.id === queued.data.id), true);
    assert.equal((await runMutation(database, auth("user-a"), "list", [])).data.jobs.filter((entry) => entry.id === repeated.data.first.id).length, 1);
    assert.equal((await runMutation(database, auth("user-a"), "leak", [])).ok, true);
    const leaked = await runMutation(database, auth("user-a"), "useLeak", []);
    assert.equal(leaked.ok, false);
    assert.equal(leaked.error.code, "PRIVILEGED_JOB_ACCESS_INACTIVE");
    const audit = await database.sqlite.readRecentLogEvents(20);
    assert.equal(audit.some((event) => event.event === "privileged.started" && JSON.stringify(event).includes(queued.data.id)), true);
  } finally { database.close(); await rm(dir, { recursive: true, force: true }); }
});

test("privileged Job cancellation propagates its signal", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-privileged-cancel-")); let started; let release;
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{wait:job(async(ctx)=>{started(); await new Promise(r=>release=r); assert.equal(ctx.signal.aborted,true); const e=new Error("abort");e.name="AbortError";throw e;})},mutations:{enqueue:mutation((ctx)=>ctx.privileged.run({operation:"jobs.enqueue",targetResourceKind:"job-queue"},p=>p.jobs.enqueue("wait",{}))),cancel:mutation((ctx,id)=>ctx.privileged.run({operation:"jobs.cancel",targetResourceKind:"job-queue"},p=>p.jobs.cancel(id))),get:mutation((ctx,id)=>ctx.privileged.run({operation:"jobs.get",targetResourceKind:"job-queue"},p=>p.jobs.get(id)))}});
 try {const began=new Promise(r=>started=r); const q=await runMutation(db,auth("u"),"enqueue",[]); await began; await runMutation(db,auth("u"),"cancel",[q.data.id]); release(); await new Promise(r=>setTimeout(r,15)); assert.equal((await runMutation(db,auth("u"),"get",[q.data.id])).data.status,"cancelled");} finally {db.close();await rm(dir,{recursive:true,force:true});}
});
