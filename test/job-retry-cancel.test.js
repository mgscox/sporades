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
