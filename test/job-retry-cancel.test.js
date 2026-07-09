import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openDevDatabase, runMutation } from "../dist/server-runtime-source.js";
import { job, mutation } from "../dist/server.js";
const auth = { userId: "u", displayName: "u", email: null, picture: null, isAuthenticated: false, isGuest: true, provider: "anonymous" };
test("Jobs support delayed availability, bounded retries, and cancellation", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-retry-")); let attempts=0;
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{ flaky:job(()=>{attempts++; if(attempts<2) throw new Error("TOKEN=x"); return {ok:true};})},mutations:{enqueue:mutation((ctx,options)=>ctx.jobs.enqueue("flaky",{},options)),get:mutation((ctx,id)=>ctx.jobs.get(id)),cancel:mutation((ctx,id)=>ctx.jobs.cancel(id))}});
 try { db.sqlite.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous");
  const delayed=await runMutation(db,auth,"enqueue",[{availableAt:new Date(Date.now()+40).toISOString()}]); assert.equal(delayed.data.status,"delayed"); await runMutation(db,auth,"cancel",[delayed.data.id]); assert.equal((await runMutation(db,auth,"get",[delayed.data.id])).data.status,"cancelled");
  const retried=await runMutation(db,auth,"enqueue",[{retry:{maxAttempts:2,delayMs:1}}]); await new Promise(r=>setTimeout(r,40)); const state=await runMutation(db,auth,"get",[retried.data.id]); assert.equal(state.data.status,"succeeded"); assert.equal(state.data.attempts,2); assert.equal(state.data.attemptHistory.length,2);
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("delayed Jobs wake automatically and retry exhaustion retains one Job history", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-wake-")); const seen=[];
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{fail:job(()=>{throw new Error("TOKEN=hidden")}),record:job((ctx,p)=>seen.push(p.name))},mutations:{enqueue:mutation((ctx,h,o)=>ctx.jobs.enqueue(h,{},o)),get:mutation((ctx,id)=>ctx.jobs.get(id))}});
 try {db.sqlite.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous");
  const delayed=await runMutation(db,auth,"enqueue",["record",{availableAt:new Date(Date.now()+15).toISOString()}]); await new Promise(r=>setTimeout(r,35)); assert.equal((await runMutation(db,auth,"get",[delayed.data.id])).data.status,"succeeded");
  const failed=await runMutation(db,auth,"enqueue",["fail",{retry:{maxAttempts:2,delayMs:1}}]); await new Promise(r=>setTimeout(r,35)); const state=(await runMutation(db,auth,"get",[failed.data.id])).data; assert.equal(state.status,"failed"); assert.equal(state.attempts,2); assert.equal(state.attemptHistory.length,2); assert.equal(JSON.stringify(state.attemptHistory).includes("hidden"),false);
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("running cancellation preserves success, cancels AbortError, and retries ordinary failure", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-running-")); let started; let release; let mode="success";
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{gate:job(async(ctx)=>{started?.(); await new Promise(r=>release=r); if(mode==="abort"){const e=new Error("aborted");e.name="AbortError";throw e;} if(mode==="fail") throw new Error("ordinary"); return {ok:true};})},mutations:{enqueue:mutation((ctx,o)=>ctx.jobs.enqueue("gate",{},o)),get:mutation((ctx,id)=>ctx.jobs.get(id)),cancel:mutation((ctx,id)=>ctx.jobs.cancel(id))}});
 try {db.sqlite.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous");
  for(const expected of ["succeeded","cancelled","failed"]){ mode=expected==="succeeded"?"success":expected==="cancelled"?"abort":"fail"; const began=new Promise(r=>started=r); const q=await runMutation(db,auth,"enqueue",[{retry:{maxAttempts:1}}]); await began; const request=await runMutation(db,auth,"cancel",[q.data.id]); assert.equal(request.data.cancelRequestedAt !== undefined,true); release(); await new Promise(r=>setTimeout(r,15)); assert.equal((await runMutation(db,auth,"get",[q.data.id])).data.status,expected); }
 } finally {db.close();await rm(dir,{recursive:true,force:true});}
});

test("queued cancellation and delayed ordering are deterministic", async () => {
 const dir=await mkdtemp(path.join(tmpdir(),"sporades-job-order-")); const seen=[];
 const db=await openDevDatabase(path.join(dir,"data.db"),"",{},{name:"jobs"},{jobs:{record:job((ctx,p)=>seen.push(p.id))},mutations:{enqueue:mutation((ctx,id,o)=>ctx.jobs.enqueue("record",{id},o)),cancel:mutation((ctx,id)=>ctx.jobs.cancel(id))}});
 try {db.sqlite.prepare("INSERT INTO sporades_auth_users (id,createdAt,displayName,email,picture,isAuthenticated,isGuest,provider) VALUES (?,?,?,?,?,?,?,?)").run("u",new Date().toISOString(),"u",null,null,0,1,"anonymous"); const future=new Date(Date.now()+20).toISOString(); const a=await runMutation(db,auth,"enqueue",["a",{availableAt:future}]); const b=await runMutation(db,auth,"enqueue",["b",{availableAt:future}]); const queued=await runMutation(db,auth,"enqueue",["cancel",{availableAt:new Date(Date.now()+100).toISOString()}]); await runMutation(db,auth,"cancel",[queued.data.id]); await new Promise(r=>setTimeout(r,45)); assert.deepEqual(seen, [a.data.id < b.data.id ? "a":"b",a.data.id < b.data.id ? "b":"a"]);} finally {db.close();await rm(dir,{recursive:true,force:true});}
});
