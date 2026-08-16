import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createControllableRuntimeClock, openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { job, mutation } from "../dist/server.js";
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

test("closing the runtime closes resources when the active Job worker rejects", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-rejected-close-")); const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{}); const closed={mail:0,adapter:0,storage:0};
 const originalMailClose=db.mail.close.bind(db.mail); const originalAdapterClose=db.adapter.close.bind(db.adapter); const originalStorageClose=db.fileStorage.close.bind(db.fileStorage);
 db.mail.close=()=>{closed.mail++;return originalMailClose();}; db.adapter.close=()=>{closed.adapter++;return originalAdapterClose();}; db.fileStorage.close=()=>{closed.storage++;return originalStorageClose();};
 try {let rejectWorker; const workerError=new Error("worker settlement failed"); db.__jobWorkerPromise=new Promise((resolve,reject)=>{rejectWorker=reject;}); const closing=db.close(); rejectWorker(workerError); await assert.rejects(closing,error=>error===workerError); assert.deepEqual(closed,{mail:1,adapter:1,storage:1});}
 finally {if(!closed.mail) await originalMailClose();if(!closed.storage) await originalStorageClose();if(!closed.adapter) await originalAdapterClose();await rm(dir,{recursive:true,force:true});}
});
