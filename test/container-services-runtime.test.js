import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { capsule,query,mutation,job,endpoint,message,table,String as Text } from '../dist/server.js';
import { openDevDatabase,resolveAnonymousSession,runQuery,runMutation,runAppMessage,routeEndpoint,inspectRuntimeJobs } from '../dist/server-runtime-source.js';
const secret='e'.repeat(64);
const service={kind:'container',image:'example:v1',command:[],port:8080,health:{tcp:true},env:{API_KEY:{generated:'key'}}};
const config={name:'service-runtime',services:{embeddings:service},__sporadesSession:'dev'};
const serviceEnv={SPORADES_CONTAINER_SERVICES:JSON.stringify({embeddings:{url:'http://127.0.0.1:5204',secrets:{key:secret}}})};

test('trusted contexts keep frozen connections through middleware, hooks, messages, endpoints and Jobs; ACL and inspection omit them',async()=>{
 const dir=await mkdtemp(path.resolve('.sporades-service-runtime-'));
 const observations=[],acl=[];
 let db;
 const probe=(ctx,kind)=>{
   assert.equal(ctx.services.embeddings.secrets.key,secret);
   assert.equal(ctx.services.embeddings.url,'http://127.0.0.1:5204');
   assert(Object.isFrozen(ctx.services.embeddings.secrets));
   assert.equal(ctx.env.SPORADES_CONTAINER_SERVICES,undefined);
   assert.equal(Reflect.set(ctx,'services',{}),false);
   observations.push(kind);
   return {ok:true};
 };
 globalThis.__containerServiceProbe=probe;
 try {
   const definition=capsule({name:config.name,
     schema:{notes:table({text:Text()}).acl({read:({ctx})=>{acl.push(ctx.services);return false;},write:({ctx})=>{acl.push(ctx.services);return true;}})},
     middleware:[ctx=>{globalThis.__containerServiceProbe(ctx,'middleware');return {...ctx,extra:true};}],
     hooks:{beforeMutation:({ctx})=>probe(ctx,'hook')},
     queries:{probe:query(ctx=>probe(ctx,'query')),notes:query(ctx=>ctx.db.notes.all())},
     mutations:{probe:mutation(async ctx=>{probe(ctx,'mutation');await ctx.db.notes.insert({text:'safe'});await ctx.jobs.enqueue('work',{});return {ok:true};})},
     jobs:{work:job(ctx=>{probe(ctx,'job');return {ok:true};})},
     messages:{probe:message(ctx=>probe(ctx,'message'))},
     endpoints:{probe:endpoint({method:'GET',path:'/probe'},ctx=>({body:probe(ctx,'endpoint')}))},
   });
   db=await openDevDatabase(path.join(dir,'data.db'),'',{},config,definition,{serviceEnv});
   db.mutationHooks.beforeMutation=[`({ctx})=>globalThis.__containerServiceProbe(ctx,'hook')`];
   await db.init();
   const session=await resolveAnonymousSession(db,null);
   assert.equal((await runQuery(db,session.auth,'probe')).error,null);
   assert.equal((await runMutation(db,session.auth,'probe',[])).error,null);
   assert.equal((await runAppMessage(db,session.auth,'probe',{})).error,null);
   const request={url:'/probe',method:'GET',headers:{cookie:`sporades_session=${session.token}`},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){}};
   const response={setHeader(){},writeHead(status){this.status=status;},end(body){this.body=body;}};
   assert.equal(await routeEndpoint(db,request,response),true);
   assert.equal(response.status,200,response.body);
   assert.equal((await runQuery(db,session.auth,'notes')).error,null);
   const deadline=Date.now()+3000;
   while(!observations.includes('job')&&Date.now()<deadline) await new Promise(r=>setTimeout(r,10));
   for(const kind of ['query','mutation','message','endpoint','job','middleware','hook']) assert(observations.includes(kind),kind);
   assert(acl.length>0);assert(acl.every(value=>value===undefined));
   assert(!JSON.stringify(await inspectRuntimeJobs(db.adapter)).includes(secret));
   assert.equal((await runQuery(db,session.auth,'ctx.services')).data??null,null);
   db.log.emit({category:'app',event:'service.probe',message:`value ${secret}`,data:{connection:db.services.embeddings,copy:secret,nested:`prefix ${secret}`}});
   const logs=await readFile(db.log.path,'utf8');
   assert(!logs.includes(secret));assert(!logs.includes('http://127.0.0.1:5204'));
 } finally {delete globalThis.__containerServiceProbe;await db?.close();await rm(dir,{recursive:true,force:true});}
});
