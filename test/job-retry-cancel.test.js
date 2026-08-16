import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { cancelJob, createControllableRuntimeClock, inspectRuntimeJobs, openDevDatabase, resolveAnonymousSession, runAppMessage, runEndpoint, runMutation } from "../dist/server-runtime-source.js";
import { job, mutation } from "../dist/server.js";
import { withPostgresAdapter } from "./support/database-adapter-engines.js";
const auth = { userId: "u", displayName: "u", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
test("Jobs support delayed availability, bounded retries, and cancellation", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-retry-")); let attempts=0;
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{ flaky:job(()=>{attempts++; if(attempts<2) throw new Error("TOKEN=x"); return {ok:true};})},mutations:{enqueue:mutation((ctx,options)=>ctx.jobs.enqueue("flaky",{},options)),get:mutation((ctx,id)=>ctx.jobs.get(id)),cancel:mutation((ctx,id)=>ctx.jobs.cancel(id))}});
 try { db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous");
  const delayed=await runMutation(db,auth,"enqueue",[{availableAt:new Date(Date.now()+40).toISOString()}]); assert.equal(delayed.data.status,"delayed"); await runMutation(db,auth,"cancel",[delayed.data.id]); assert.equal((await runMutation(db,auth,"get",[delayed.data.id])).data.status,"cancelled");
  const retried=await runMutation(db,auth,"enqueue",[{retry:{maxAttempts:2,delayMs:1}}]); await new Promise(r=>setTimeout(r,40)); const state=await runMutation(db,auth,"get",[retried.data.id]); assert.equal(state.data.status,"succeeded"); assert.equal(state.data.attempts,2); assert.equal(state.data.attemptHistory.length,2);
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("delayed Jobs wake automatically and retry exhaustion retains one Job history", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-wake-")); const seen=[];
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{fail:job(()=>{throw new Error("TOKEN=hidden")}),record:job((ctx,p)=>seen.push(p.name))},mutations:{enqueue:mutation((ctx,h,o)=>ctx.jobs.enqueue(h,{},o)),get:mutation((ctx,id)=>ctx.jobs.get(id))}});
 try {db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous");
  const delayed=await runMutation(db,auth,"enqueue",["record",{availableAt:new Date(Date.now()+15).toISOString()}]); await new Promise(r=>setTimeout(r,35)); assert.equal((await runMutation(db,auth,"get",[delayed.data.id])).data.status,"succeeded");
  const failed=await runMutation(db,auth,"enqueue",["fail",{retry:{maxAttempts:2,delayMs:1}}]); await new Promise(r=>setTimeout(r,35)); const state=(await runMutation(db,auth,"get",[failed.data.id])).data; assert.equal(state.status,"failed"); assert.equal(state.attempts,2); assert.equal(state.attemptHistory.length,2); assert.equal(JSON.stringify(state.attemptHistory).includes("hidden"),false);
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("running cancellation preserves success, cancels AbortError, and retries ordinary failure", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-running-")); let started; let release; let mode="success";
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{gate:job(async(ctx)=>{started?.(); await new Promise(r=>release=r); if(mode==="abort"){const e=new Error("aborted");e.name="AbortError";throw e;} if(mode==="fail") throw new Error("ordinary"); return {ok:true};})},mutations:{enqueue:mutation((ctx,o)=>ctx.jobs.enqueue("gate",{},o)),get:mutation((ctx,id)=>ctx.jobs.get(id)),cancel:mutation((ctx,id)=>ctx.jobs.cancel(id))}});
 try {db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous");
  for(const expected of ["succeeded","cancelled","failed"]){ mode=expected==="succeeded"?"success":expected==="cancelled"?"abort":"fail"; const began=new Promise(r=>started=r); const q=await runMutation(db,auth,"enqueue",[{retry:{maxAttempts:1}}]); await began; const request=await runMutation(db,auth,"cancel",[q.data.id]); assert.equal(request.data.cancelRequestedAt !== undefined,true); release(); await new Promise(r=>setTimeout(r,15)); assert.equal((await runMutation(db,auth,"get",[q.data.id])).data.status,expected); }
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("running cancellation aborts only after its transaction commits", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-cancel-commit-"));const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");let started=()=>{};let release=()=>{};let activeSignal;let db;
 const capsule={jobs:{gate:job(async(ctx)=>{activeSignal=ctx.signal;started();await new Promise((resolve,reject)=>{release=resolve;ctx.signal.addEventListener("abort",()=>{const error=new Error("aborted");error.name="AbortError";reject(error);},{once:true});});return {ok:true};})},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("gate",{})),cancelAndFail:mutation(async(ctx,id)=>{await ctx.jobs.cancel(id);throw new Error("roll back cancellation");}),cancel:mutation((ctx,id)=>ctx.jobs.cancel(id)),get:mutation((ctx,id)=>ctx.jobs.get(id))}};
 try {
  db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},capsule,{clock});
  db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",clock.now().toISOString(),"u",null,null,0,1,"anonymous");

  let began=new Promise(resolve=>{started=resolve;});
  const rolledBackJob=await runMutation(db,auth,"enqueue",[]);
  const rolledBackDrain=clock.runDueTimers();
  await began;
  const rolledBackCancellation=await runMutation(db,auth,"cancelAndFail",[rolledBackJob.data.id]);
  assert.equal(rolledBackCancellation.ok,false);
  assert.equal(activeSignal.aborted,false,"a rolled-back cancellation must not escape its transaction");
  assert.equal((await runMutation(db,auth,"get",[rolledBackJob.data.id])).data.status,"running");
  release();release=()=>{};
  await rolledBackDrain;
  assert.equal((await runMutation(db,auth,"get",[rolledBackJob.data.id])).data.status,"succeeded");

  began=new Promise(resolve=>{started=resolve;});
  const committedJob=await runMutation(db,auth,"enqueue",[]);
  const committedDrain=clock.runDueTimers();
  await began;
  const committedCancellation=await runMutation(db,auth,"cancel",[committedJob.data.id]);
  assert.equal(committedCancellation.ok,true);
  assert.equal(activeSignal.aborted,true,"a committed cancellation must reach its running handler");
  await committedDrain;
  assert.equal((await runMutation(db,auth,"get",[committedJob.data.id])).data.status,"cancelled");
 } finally {release();await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("committed running cancellation survives context middleware replacement", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-cancel-middleware-"));const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");let started=()=>{};let activeSignal;let db;
 globalThis.__sporadesCancellationMiddlewareTarget=null;
 const capsule={jobs:{gate:job(async(ctx)=>{activeSignal=ctx.signal;started();await new Promise((resolve,reject)=>ctx.signal.addEventListener("abort",()=>{const error=new Error("aborted");error.name="AbortError";reject(error);},{once:true}));})},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("gate",{})),trigger:mutation(()=>true),get:mutation((ctx,id)=>ctx.jobs.get(id))}};
 try {
  db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},capsule,{clock});
  db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",clock.now().toISOString(),"u",null,null,0,1,"anonymous");
  db.contextMiddleware=[async context=>{
   if(context.kind!=="mutation"||!globalThis.__sporadesCancellationMiddlewareTarget) return context;
   await context.jobs.cancel(globalThis.__sporadesCancellationMiddlewareTarget);
   return {auth:context.auth,kind:context.kind};
  }];
  const began=new Promise(resolve=>{started=resolve;});
  const queued=await runMutation(db,auth,"enqueue",[]);const draining=clock.runDueTimers();await began;
  globalThis.__sporadesCancellationMiddlewareTarget=queued.data.id;
  const triggered=await runMutation(db,auth,"trigger",[]);
  assert.equal(triggered.ok,true);
  assert.equal(activeSignal.aborted,true,"transaction-owned cancellation must survive replacement middleware contexts");
  await draining;
  globalThis.__sporadesCancellationMiddlewareTarget=null;
  assert.equal((await runMutation(db,auth,"get",[queued.data.id])).data.status,"cancelled");
 } finally {globalThis.__sporadesCancellationMiddlewareTarget=null;await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("a cancellation committed after claim but before controller registration aborts before the handler", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-cancel-claim-window-"));const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");let releaseClaim=()=>{};let claimStarted;const claimBegan=new Promise(resolve=>{claimStarted=resolve;});let handlerSignalAborted=null;let db;
 try {
  db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{gate:job(ctx=>{handlerSignalAborted=ctx.signal.aborted;if(ctx.signal.aborted){const error=new Error("aborted before handler");error.name="AbortError";throw error;}return true;})},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("gate",{})),get:mutation((ctx,id)=>ctx.jobs.get(id))}},{clock});
  db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",clock.now().toISOString(),"u",null,null,0,1,"anonymous");
  const queued=await runMutation(db,auth,"enqueue",[]);
  const baseAdapter=db.adapter;db.adapter=pauseJobClaimAfterCommit(baseAdapter,()=>claimStarted(),release=>{releaseClaim=release;});
  const draining=clock.runDueTimers();await claimBegan;
  await cancelJob(db,{auth},queued.data.id);
  releaseClaim();releaseClaim=()=>{};await draining;
  db.adapter=baseAdapter;
  assert.equal(handlerSignalAborted,true,"the exact claimed token must be rechecked after controller registration");
  assert.equal((await runMutation(db,auth,"get",[queued.data.id])).data.status,"cancelled");
 } finally {releaseClaim();await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("App-message cancellation aborts on commit and stays inert on rollback", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-cancel-message-"));const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");let started=()=>{};let release=()=>{};let activeSignal;let db;
 globalThis.__sporadesMessageCancellationMiddlewareTarget=null;
 const capsule={jobs:{gate:job(async(ctx)=>{activeSignal=ctx.signal;started();await new Promise((resolve,reject)=>{release=resolve;ctx.signal.addEventListener("abort",()=>{const error=new Error("aborted");error.name="AbortError";reject(error);},{once:true});});})},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("gate",{})),get:mutation((ctx,id)=>ctx.jobs.get(id))}};
 try {
  db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},capsule,{clock});
  db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",clock.now().toISOString(),"u",null,null,0,1,"anonymous");
  db.contextMiddleware=[async context=>{
   if(context.kind!=="message"||!globalThis.__sporadesMessageCancellationMiddlewareTarget) return context;
   await context.jobs.cancel(globalThis.__sporadesMessageCancellationMiddlewareTarget);
   return {auth:context.auth,kind:context.kind};
  }];
  db.messages=[{name:"cancel",handlerSource:`async (_ctx, data) => { if (data.rollback) throw new Error("roll back message cancellation"); return true; }`}];

  let began=new Promise(resolve=>{started=resolve;});const rolledBack=await runMutation(db,auth,"enqueue",[]);const rolledBackDrain=clock.runDueTimers();await began;
  globalThis.__sporadesMessageCancellationMiddlewareTarget=rolledBack.data.id;
  const failed=await runAppMessage(db,auth,"cancel",{id:rolledBack.data.id,rollback:true});
  assert.match(failed.error.message,/roll back message cancellation/);assert.equal(activeSignal.aborted,false);
  globalThis.__sporadesMessageCancellationMiddlewareTarget=null;release();release=()=>{};await rolledBackDrain;assert.equal((await runMutation(db,auth,"get",[rolledBack.data.id])).data.status,"succeeded");

  began=new Promise(resolve=>{started=resolve;});const committed=await runMutation(db,auth,"enqueue",[]);const committedDrain=clock.runDueTimers();await began;
  globalThis.__sporadesMessageCancellationMiddlewareTarget=committed.data.id;
  assert.deepEqual(await runAppMessage(db,auth,"cancel",{id:committed.data.id,rollback:false}),{data:true,error:null});
  assert.equal(activeSignal.aborted,true);await committedDrain;globalThis.__sporadesMessageCancellationMiddlewareTarget=null;assert.equal((await runMutation(db,auth,"get",[committed.data.id])).data.status,"cancelled");
 } finally {globalThis.__sporadesMessageCancellationMiddlewareTarget=null;release();await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("Custom-endpoint cancellation aborts on commit and stays inert on rollback", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-cancel-endpoint-"));const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");let started=()=>{};let release=()=>{};let activeSignal;let db;
 globalThis.__sporadesEndpointCancellationMiddlewareTarget=null;
 const capsule={jobs:{gate:job(async(ctx)=>{activeSignal=ctx.signal;started();await new Promise((resolve,reject)=>{release=resolve;ctx.signal.addEventListener("abort",()=>{const error=new Error("aborted");error.name="AbortError";reject(error);},{once:true});});})},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("gate",{})),get:mutation((ctx,id)=>ctx.jobs.get(id))}};
 const endpoint={handlerSource:`async (ctx) => { if (ctx.request.query.rollback === "true") throw new Error("roll back endpoint cancellation"); return true; }`};
 try {
  db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},capsule,{clock});const session=await resolveAnonymousSession(db,null);
  db.contextMiddleware=[async context=>{
   if(context.kind!=="endpoint"||!globalThis.__sporadesEndpointCancellationMiddlewareTarget) return context;
   await context.jobs.cancel(globalThis.__sporadesEndpointCancellationMiddlewareTarget);
   return {auth:context.auth,kind:context.kind,request:context.request};
  }];
  const request={method:"POST",headers:{"x-sporades-session-token":session.token},async *[Symbol.asyncIterator]() {}};

  let began=new Promise(resolve=>{started=resolve;});const rolledBack=await runMutation(db,session.auth,"enqueue",[]);const rolledBackDrain=clock.runDueTimers();await began;
  globalThis.__sporadesEndpointCancellationMiddlewareTarget=rolledBack.data.id;
  await assert.rejects(runEndpoint(db,endpoint,new URL(`http://capsule.test/cancel?id=${rolledBack.data.id}&rollback=true`),request),/roll back endpoint cancellation/);
  assert.equal(activeSignal.aborted,false);globalThis.__sporadesEndpointCancellationMiddlewareTarget=null;release();release=()=>{};await rolledBackDrain;assert.equal((await runMutation(db,session.auth,"get",[rolledBack.data.id])).data.status,"succeeded");

  began=new Promise(resolve=>{started=resolve;});const committed=await runMutation(db,session.auth,"enqueue",[]);const committedDrain=clock.runDueTimers();await began;
  globalThis.__sporadesEndpointCancellationMiddlewareTarget=committed.data.id;
  assert.equal(await runEndpoint(db,endpoint,new URL(`http://capsule.test/cancel?id=${committed.data.id}&rollback=false`),request),true);
  assert.equal(activeSignal.aborted,true);await committedDrain;globalThis.__sporadesEndpointCancellationMiddlewareTarget=null;assert.equal((await runMutation(db,session.auth,"get",[committed.data.id])).data.status,"cancelled");
 } finally {globalThis.__sporadesEndpointCancellationMiddlewareTarget=null;release();await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("queued cancellation and delayed ordering are deterministic", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-order-")); const seen=[];
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{record:job((ctx,p)=>seen.push(p.id))},mutations:{enqueue:mutation((ctx,id,o)=>ctx.jobs.enqueue("record",{id},o)),cancel:mutation((ctx,id)=>ctx.jobs.cancel(id))}});
 try {db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous"); const future=new Date(Date.now()+20).toISOString(); const a=await runMutation(db,auth,"enqueue",["a",{availableAt:future}]); const b=await runMutation(db,auth,"enqueue",["b",{availableAt:future}]); const queued=await runMutation(db,auth,"enqueue",["cancel",{availableAt:new Date(Date.now()+100).toISOString()}]); await runMutation(db,auth,"cancel",[queued.data.id]); await new Promise(r=>setTimeout(r,45)); assert.deepEqual(seen, [a.data.id < b.data.id ? "a":"b",a.data.id < b.data.id ? "b":"a"]);} finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("queued cancellation prevents execution behind a running Job", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-queued-cancel-")); let release; let started; const seen=[];
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{block:job(async()=>{started();await new Promise(r=>release=r);}),record:job(()=>seen.push("ran"))},mutations:{enqueue:mutation((ctx,h)=>ctx.jobs.enqueue(h,{})),cancel:mutation((ctx,id)=>ctx.jobs.cancel(id)),get:mutation((ctx,id)=>ctx.jobs.get(id))}});
 try {db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous"); const began=new Promise(r=>started=r); await runMutation(db,auth,"enqueue",["block"]); await began; const queued=await runMutation(db,auth,"enqueue",["record"]); assert.equal(queued.data.status,"queued"); await runMutation(db,auth,"cancel",[queued.data.id]); release(); await new Promise(r=>setTimeout(r,15)); assert.equal((await runMutation(db,auth,"get",[queued.data.id])).data.status,"cancelled"); assert.deepEqual(seen,[]);} finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("closing the runtime clears a delayed Job wake timer", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-close-")); const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{noop:job(()=>null)},mutations:{enqueue:mutation((ctx)=>ctx.jobs.enqueue("noop",{},{availableAt:new Date(Date.now()+100).toISOString()}))}});
 try {db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous"); await runMutation(db,auth,"enqueue",[]); await new Promise(r=>setTimeout(r,5)); assert.ok(db.__jobWakeTimer); db.close(); assert.equal(db.__jobWakeTimer,null); await new Promise(r=>setTimeout(r,110)); } finally {await rm(dir,{recursive:true,force:true});}
});

test("expired-lease recovery waits for runtime initialization and close clears its wake", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-recovery-close-"));const file=path.join(dir,"data.db");const instant="2030-01-01T00:00:00.000Z";const seedClock=createControllableRuntimeClock(instant);const seen=[];let db;
 try {
  db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{record:job(()=>null)},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("record",{},{retry:{maxAttempts:2,delayMs:0}}))}},{clock:seedClock});
  db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",seedClock.now().toISOString(),"u",null,null,0,1,"anonymous");
  const queued=await runMutation(db,auth,"enqueue",[]);
  db.adapter.prepare("UPDATE sporades_jobs SET status='running', attempts=1, leaseExpiresAt=? WHERE id=?").run("2029-12-31T23:59:59.000Z",queued.data.id);
  await db.close();db=null;
  const tracked=trackedRuntimeClock(instant);
  db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{record:job(()=>seen.push("ran"))}},{clock:tracked.clock});
  assert.equal(tracked.activeCount(),0,"opening storage must not schedule recovered Job execution before init");
  await tracked.runDueTimers();
  assert.deepEqual(seen,[]);
  await db.init();
  assert.ok(tracked.activeCount()>0,"runtime init must schedule recovered Job discovery");
  await tracked.runDueTimers();
  assert.deepEqual(seen,["ran"]);
  await db.close();db=null;
  assert.equal(tracked.activeCount(),0);
 } finally {await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("closing the runtime cancels scheduled Job work before its adapter closes", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-scheduled-close-")); const seen=[]; const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{record:job(()=>seen.push("ran"))},mutations:{enqueue:mutation((ctx)=>ctx.jobs.enqueue("record",{}))}},{clock});
 try {db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous"); await runMutation(db,auth,"enqueue",[]); assert.equal(db.__jobWorkerScheduled,true); await db.close(); await clock.runDueTimers(); assert.deepEqual(seen,[]);}
 finally {await rm(dir,{recursive:true,force:true});}
});

test("closing the runtime finishes the active Job without claiming queued work", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-active-close-")); const seen=[]; const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z"); let started; let release=()=>{}; let closed=false;
 const began=new Promise(r=>started=r); const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{block:job(async()=>{seen.push("block");started();await new Promise(r=>release=r);}),record:job(()=>seen.push("queued"))},mutations:{enqueue:mutation((ctx,handler)=>ctx.jobs.enqueue(handler,{}))}},{clock});
 try {db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous"); await runMutation(db,auth,"enqueue",["block"]); const draining=clock.runDueTimers(); await began; const queued=await runMutation(db,auth,"enqueue",["record"]); assert.equal(queued.data.status,"queued"); const closing=db.close(); release(); await Promise.all([draining,closing]); closed=true; assert.deepEqual(seen,["block"]);}
 finally {release();if(!closed) await db.close().catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("orderly close retains an aborted active Job for its remaining retry", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-active-retry-close-"));const file=path.join(dir,"data.db");const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");const seen=[];let started;let db;const began=new Promise(resolve=>{started=resolve;});
 try {
  db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{record:job(async(ctx)=>{seen.push("first");started();await new Promise((resolve,reject)=>ctx.signal.addEventListener("abort",()=>{const error=new Error("shutdown");error.name="AbortError";reject(error);},{once:true}));})},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("record",{},{retry:{maxAttempts:2,delayMs:0}})),get:mutation((ctx,id)=>ctx.jobs.get(id))}},{clock});
  db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",clock.now().toISOString(),"u",null,null,0,1,"anonymous");
  const queued=await runMutation(db,auth,"enqueue",[]);
  const draining=clock.runDueTimers();
  await began;
  const closing=db.close();
  await Promise.all([draining,closing]);
  db=null;

  db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{record:job(()=>seen.push("recovered"))},mutations:{get:mutation((ctx,id)=>ctx.jobs.get(id))}},{clock});
  const retained=(await runMutation(db,auth,"get",[queued.data.id])).data;
  assert.equal(retained.status,"delayed");
  assert.equal(retained.attempts,1);
  assert.equal(retained.cancelRequestedAt,undefined);
  await db.init();
  await clock.runDueTimers();
  const completed=(await runMutation(db,auth,"get",[queued.data.id])).data;
  assert.equal(completed.status,"succeeded");
  assert.equal(completed.attempts,2);
  assert.deepEqual(seen,["first","recovered"]);
 } finally {await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("closing the runtime relinquishes a Job whose claim settles after shutdown starts", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-claim-close-"));const file=path.join(dir,"data.db");const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");const seen=[];let releaseClaim=()=>{};let claimStarted;const claimBegan=new Promise(resolve=>claimStarted=resolve);let db;
 try {
  db=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{record:job(()=>seen.push("ran"))},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("record",{})),get:mutation((ctx,id)=>ctx.jobs.get(id))}},{clock});
  db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",clock.now().toISOString(),"u",null,null,0,1,"anonymous");
  const queued=await runMutation(db,auth,"enqueue",[]);
  const baseAdapter=db.adapter;
  db.adapter=pauseJobClaim(baseAdapter,()=>claimStarted(),release=>{releaseClaim=release;});
  const draining=clock.runDueTimers();
  await claimBegan;
  const closing=db.close();
  releaseClaim();
  releaseClaim=()=>{};
  await Promise.all([draining,closing]);
  db=null;
  assert.deepEqual(seen,[]);
  const reopened=await openDevDatabase(file,"",{},{name:"jobs"},{jobs:{record:job(()=>seen.push("recovered"))},mutations:{get:mutation((ctx,id)=>ctx.jobs.get(id))}},{clock});
  try {
   const state=(await runMutation(reopened,auth,"get",[queued.data.id])).data;
   assert.equal(state.status,"queued");
   assert.equal(state.attempts,0);
  } finally {await reopened.close();}
 } finally {releaseClaim();await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("a stale shutdown owner cannot relinquish a newer PostgreSQL Job attempt", {
 skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the PostgreSQL Job ownership race.",
}, async () => {
 await withPostgresAdapter(async()=>{});
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-owner-postgres-"));const firstClock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");const secondClock=createControllableRuntimeClock("2030-01-01T00:00:31.000Z");let first;let second;let releaseFirstClaim=()=>{};let releaseSecondHandler=()=>{};let firstClaimStarted;let secondHandlerStarted;const firstClaimBegan=new Promise(resolve=>firstClaimStarted=resolve);const secondHandlerBegan=new Promise(resolve=>secondHandlerStarted=resolve);
 const serverEnv={SPORADES_SERVICE_DATABASE_ENGINE:"postgres",SPORADES_SERVICE_DATABASE_URL:process.env.SPORADES_POSTGRES_TEST_URL};const config={name:"job-owner-postgres",services:{database:{engine:"postgres"}}};const capsule={jobs:{record:job(async()=>{secondHandlerStarted();await new Promise(resolve=>releaseSecondHandler=resolve);return {ok:true};})},mutations:{enqueue:mutation((ctx,options)=>ctx.jobs.enqueue("record",{},options)),get:mutation((ctx,id)=>ctx.jobs.get(id))}};
 try {
  first=await openDevDatabase(path.join(dir,"first.db"),"",serverEnv,config,capsule,{serviceEnv:serverEnv,clock:firstClock});
  await first.adapter.prepare(first.adapter.dialect.sql("INSERT INTO [sporades_auth_users] ([id],[createdAt],[displayName],[email],[picture],[isAuthenticated],[isGuest],[provider]) VALUES (?,?,?,?,?,?,?,?)")).run("u",firstClock.now().toISOString(),"u",null,null,0,1,"anonymous");
  const queued=await runMutation(first,auth,"enqueue",[{retry:{maxAttempts:3,delayMs:0}}]);
  const firstBase=first.adapter;first.adapter=pauseJobClaimAfterCommit(firstBase,()=>firstClaimStarted(),release=>{releaseFirstClaim=release;});
  const firstDrain=firstClock.runDueTimers();await firstClaimBegan;const firstClose=first.close();

  second=await openDevDatabase(path.join(dir,"second.db"),"",serverEnv,config,capsule,{serviceEnv:serverEnv,clock:secondClock});
  await second.init();const secondDrain=secondClock.runDueTimers();await secondHandlerBegan;
  releaseFirstClaim();releaseFirstClaim=()=>{};await Promise.all([firstDrain,firstClose]);first=null;
  const inFlight=(await runMutation(second,auth,"get",[queued.data.id])).data;
  assert.equal(inFlight.status,"running");
  assert.equal(inFlight.attempts,2);
  releaseSecondHandler();releaseSecondHandler=()=>{};await secondDrain;
  const completed=(await runMutation(second,auth,"get",[queued.data.id])).data;
  assert.equal(completed.status,"succeeded");
  assert.equal(completed.attempts,2);
  assert.equal(completed.attemptHistory.length,2);
 } finally {releaseFirstClaim();releaseSecondHandler();await Promise.resolve(first?.close()).catch(()=>{});await Promise.resolve(second?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("a stale PostgreSQL handler completion cannot overwrite a recovered attempt", {
 skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the PostgreSQL Job completion race.",
}, async () => {
 await withPostgresAdapter(async()=>{});
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-completion-postgres-"));const firstClock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");const secondClock=createControllableRuntimeClock("2030-01-01T00:00:31.000Z");let first;let second;let releaseFirst=()=>{};let releaseSecond=()=>{};let firstStarted;let secondStarted;const firstBegan=new Promise(resolve=>firstStarted=resolve);const secondBegan=new Promise(resolve=>secondStarted=resolve);
 const serverEnv={SPORADES_SERVICE_DATABASE_ENGINE:"postgres",SPORADES_SERVICE_DATABASE_URL:process.env.SPORADES_POSTGRES_TEST_URL};const config={name:"job-completion-postgres",services:{database:{engine:"postgres"}}};const mutations={enqueue:mutation((ctx,options)=>ctx.jobs.enqueue("record",{},options)),get:mutation((ctx,id)=>ctx.jobs.get(id))};
 try {
  first=await openDevDatabase(path.join(dir,"first.db"),"",serverEnv,config,{jobs:{record:job(async()=>{firstStarted();await new Promise(resolve=>releaseFirst=resolve);return {owner:"stale"};})},mutations},{serviceEnv:serverEnv,clock:firstClock});
  await first.adapter.prepare(first.adapter.dialect.sql("INSERT INTO [sporades_auth_users] ([id],[createdAt],[displayName],[email],[picture],[isAuthenticated],[isGuest],[provider]) VALUES (?,?,?,?,?,?,?,?)")).run("u",firstClock.now().toISOString(),"u",null,null,0,1,"anonymous");
  const queued=await runMutation(first,auth,"enqueue",[{retry:{maxAttempts:3,delayMs:0}}]);const firstDrain=firstClock.runDueTimers();await firstBegan;

  second=await openDevDatabase(path.join(dir,"second.db"),"",serverEnv,config,{jobs:{record:job(async()=>{secondStarted();await new Promise(resolve=>releaseSecond=resolve);return {owner:"current"};})},mutations},{serviceEnv:serverEnv,clock:secondClock});
  await second.init();const secondDrain=secondClock.runDueTimers();await secondBegan;
  releaseFirst();releaseFirst=()=>{};await firstDrain;
  const inFlight=await second.adapter.prepare(second.adapter.dialect.sql("SELECT [status], [attempts], [result] FROM [sporades_jobs] WHERE [id]=?")).get(queued.data.id);
  assert.deepEqual({status:inFlight.status,attempts:Number(inFlight.attempts),result:inFlight.result},{status:"running",attempts:2,result:null});
  releaseSecond();releaseSecond=()=>{};await secondDrain;
  const completed=await second.adapter.prepare(second.adapter.dialect.sql("SELECT [status], [attempts], [result], [attemptHistory] FROM [sporades_jobs] WHERE [id]=?")).get(queued.data.id);
  assert.equal(completed.status,"succeeded");assert.equal(Number(completed.attempts),2);assert.deepEqual(JSON.parse(completed.result),{owner:"current"});assert.equal(JSON.parse(completed.attemptHistory).length,2);
 } finally {releaseFirst();releaseSecond();await Promise.resolve(first?.close()).catch(()=>{});await Promise.resolve(second?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("PostgreSQL cancellation racing a shutdown claim consumes no unexecuted attempt", {
 skip: !process.env.SPORADES_POSTGRES_TEST_URL && "Set SPORADES_POSTGRES_TEST_URL to run the PostgreSQL Job cancellation race.",
}, async () => {
 await withPostgresAdapter(async()=>{});
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-cancel-postgres-"));const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");const seen=[];let first;let second;let releaseCancelRead=()=>{};let releaseClaim=()=>{};let cancelReadStarted;let claimStarted;const cancelReadBegan=new Promise(resolve=>cancelReadStarted=resolve);const claimBegan=new Promise(resolve=>claimStarted=resolve);
 const serverEnv={SPORADES_SERVICE_DATABASE_ENGINE:"postgres",SPORADES_SERVICE_DATABASE_URL:process.env.SPORADES_POSTGRES_TEST_URL};const config={name:"job-cancel-postgres",services:{database:{engine:"postgres"}}};const capsule={jobs:{record:job(()=>seen.push("ran"))},mutations:{enqueue:mutation(ctx=>ctx.jobs.enqueue("record",{})),get:mutation((ctx,id)=>ctx.jobs.get(id))}};
 try {
  first=await openDevDatabase(path.join(dir,"first.db"),"",serverEnv,config,capsule,{serviceEnv:serverEnv,clock});
  await first.adapter.prepare(first.adapter.dialect.sql("INSERT INTO [sporades_auth_users] ([id],[createdAt],[displayName],[email],[picture],[isAuthenticated],[isGuest],[provider]) VALUES (?,?,?,?,?,?,?,?)")).run("u",clock.now().toISOString(),"u",null,null,0,1,"anonymous");
  const queued=await runMutation(first,auth,"enqueue",[]);
  second=await openDevDatabase(path.join(dir,"second.db"),"",serverEnv,config,capsule,{serviceEnv:serverEnv,clock});
  const secondBase=second.adapter;second.adapter=pauseJobCancellationRead(secondBase,()=>cancelReadStarted(),release=>{releaseCancelRead=release;});
  const cancelling=cancelJob(second,{auth},queued.data.id);await cancelReadBegan;
  const firstBase=first.adapter;first.adapter=pauseJobClaimAfterCommit(firstBase,()=>claimStarted(),release=>{releaseClaim=release;});
  const draining=clock.runDueTimers();await claimBegan;const closing=first.close();
  releaseCancelRead();releaseCancelRead=()=>{};await cancelling;
  releaseClaim();releaseClaim=()=>{};await Promise.all([draining,closing]);first=null;
  second.adapter=secondBase;
  const state=(await runMutation(second,auth,"get",[queued.data.id])).data;
  assert.equal(state.status,"cancelled");
  assert.equal(state.attempts,0);
  const inspected=(await inspectRuntimeJobs(second.adapter)).find(jobState=>jobState.id===queued.data.id);
  assert.equal(inspected.startedAt,null);
  assert.equal(inspected.leaseExpiresAt,null);
  assert.deepEqual(seen,[]);
 } finally {releaseCancelRead();releaseClaim();await Promise.resolve(first?.close()).catch(()=>{});await Promise.resolve(second?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("runtime initialization wakes queued and delayed Jobs retained by an orderly restart", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-restart-wake-"));const file=path.join(dir,"data.db");const seen=[];const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z");const capsule={jobs:{record:job((ctx,p)=>seen.push(p.id))},mutations:{enqueue:mutation((ctx,id,options)=>ctx.jobs.enqueue("record",{id},options))}};let db;
 try {db=await openDevDatabase(file,"",{},{name:"jobs"},capsule,{clock});db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",clock.now().toISOString(),"u",null,null,0,1,"anonymous");await runMutation(db,auth,"enqueue",["queued",{}]);await runMutation(db,auth,"enqueue",["delayed",{availableAt:new Date(clock.now().getTime()+100).toISOString()}]);await db.close();db=await openDevDatabase(file,"",{},{name:"jobs"},capsule,{clock});await db.init();assert.equal(db.__jobWorkerScheduled,true);await clock.runDueTimers();assert.deepEqual(seen,["queued"]);clock.advanceBy(101);await clock.runDueTimers();assert.deepEqual(seen,["queued","delayed"]);}
 finally {await Promise.resolve(db?.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

test("closing the runtime closes resources when the active Job worker rejects", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-rejected-close-")); const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{}); const closed={mail:0,adapter:0,storage:0};
 const originalMailClose=db.mail.close.bind(db.mail); const originalAdapterClose=db.adapter.close.bind(db.adapter); const originalStorageClose=db.fileStorage.close.bind(db.fileStorage);
 db.mail.close=()=>{closed.mail++;return originalMailClose();}; db.adapter.close=()=>{closed.adapter++;return originalAdapterClose();}; db.fileStorage.close=()=>{closed.storage++;return originalStorageClose();};
 try {let rejectWorker; const workerError=new Error("worker settlement failed"); db.__jobWorkerPromise=new Promise((resolve,reject)=>{rejectWorker=reject;}); const closing=db.close(); rejectWorker(workerError); await assert.rejects(closing,error=>error===workerError); assert.deepEqual(closed,{mail:1,adapter:1,storage:1});}
 finally {if(!closed.mail) await originalMailClose();if(!closed.storage) await originalStorageClose();if(!closed.adapter) await originalAdapterClose();await rm(dir,{recursive:true,force:true});}
});

test("runtime shutdown settles the active Job before the Capsule shutdown hook", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-lifecycle-shutdown-")); const events=[]; const clock=createControllableRuntimeClock("2030-01-01T00:00:00.000Z"); let started; let release=()=>{}; let activeSignal; const began=new Promise(r=>started=r);
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{block:job(async(ctx)=>{activeSignal=ctx.signal;events.push("job-start");started();await new Promise(r=>release=r);events.push(`job-end:${ctx.signal.aborted}`);}),record:job(()=>events.push("queued"))},mutations:{enqueue:mutation((ctx,handler)=>ctx.jobs.enqueue(handler,{}))},hooks:{shutdown:()=>events.push("shutdown-hook")}},{clock}); let shutdown;
 try {await db.init();db.adapter.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous");await runMutation(db,auth,"enqueue",["block"]);const draining=clock.runDueTimers();await began;await runMutation(db,auth,"enqueue",["record"]);shutdown=db.shutdown();await new Promise(r=>setImmediate(r));assert.equal(db.__jobStopped,true);assert.equal(activeSignal.aborted,true);assert.deepEqual(events,["job-start"]);release();await Promise.all([draining,shutdown]);assert.deepEqual(events,["job-start","job-end:true","shutdown-hook"]);}
 finally {release();await shutdown?.catch(()=>{});await Promise.resolve(db.close()).catch(()=>{});await rm(dir,{recursive:true,force:true});}
});

function pauseJobClaim(adapter,onStarted,onRelease) {
 let paused=false;
 return new Proxy(adapter,{
  get(target,property,receiver) {
   const value=Reflect.get(target,property,receiver);
   if(property!=="prepare"||typeof value!=="function") return value;
   return statement=>{
    const prepared=value.call(target,statement);
    if(paused||!/SET\s+["\[]status["\]]\s*=\s*'running'/i.test(String(statement))) return prepared;
    return new Proxy(prepared,{
     get(preparedTarget,preparedProperty,preparedReceiver) {
      const method=Reflect.get(preparedTarget,preparedProperty,preparedReceiver);
      if(preparedProperty!=="run"||typeof method!=="function") return method;
      return (...args)=>{
       paused=true;onStarted();
       return new Promise((resolve,reject)=>onRelease(()=>Promise.resolve(method.apply(preparedTarget,args)).then(resolve,reject)));
      };
     },
    });
   };
  },
 });
}

function pauseJobClaimAfterCommit(adapter,onStarted,onRelease) {
 let paused=false;
 return new Proxy(adapter,{
  get(target,property,receiver) {
   const value=Reflect.get(target,property,receiver);
   if(property!=="prepare"||typeof value!=="function") return value;
   return statement=>{
    const prepared=value.call(target,statement);
    if(paused||!/SET\s+["\[]status["\]]\s*=\s*'running'/i.test(String(statement))) return prepared;
    return new Proxy(prepared,{
     get(preparedTarget,preparedProperty,preparedReceiver) {
      const method=Reflect.get(preparedTarget,preparedProperty,preparedReceiver);
      if(preparedProperty!=="run"||typeof method!=="function") return method;
      return async(...args)=>{
       const result=await method.apply(preparedTarget,args);
       paused=true;onStarted();
       await new Promise(resolve=>onRelease(resolve));
       return result;
      };
     },
    });
   };
  },
 });
}

function pauseJobCancellationRead(adapter,onStarted,onRelease) {
 let paused=false;
 return new Proxy(adapter,{
  get(target,property,receiver) {
   const value=Reflect.get(target,property,receiver);
   if(property!=="prepare"||typeof value!=="function") return value;
   return statement=>{
    const prepared=value.call(target,statement);
    if(paused||!String(statement).includes("sporades_jobs")||!String(statement).includes("actorUserId")) return prepared;
    return new Proxy(prepared,{
     get(preparedTarget,preparedProperty,preparedReceiver) {
      const method=Reflect.get(preparedTarget,preparedProperty,preparedReceiver);
      if(preparedProperty!=="get"||typeof method!=="function") return method;
      return async(...args)=>{
       const result=await method.apply(preparedTarget,args);
       paused=true;onStarted();
       await new Promise(resolve=>onRelease(resolve));
       return result;
      };
     },
    });
   };
  },
 });
}

function trackedRuntimeClock(initialInstant) {
 const base=createControllableRuntimeClock(initialInstant);const active=new Set();
 const clock={
  now:base.now,
  setTimer(callback,delayMs) {
   let id;
   id=base.setTimer(async()=>{active.delete(id);return await callback();},delayMs);
   active.add(id);
   return id;
  },
  clearTimer(id) {active.delete(id);base.clearTimer(id);},
 };
 return {clock,activeCount:()=>active.size,runDueTimers:base.runDueTimers};
}
