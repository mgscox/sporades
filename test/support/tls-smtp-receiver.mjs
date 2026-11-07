// Synthetic SMTP acceptance receiver: TLS from the first byte; no network publication.
import tls from 'node:tls';
import { readFileSync, appendFileSync } from 'node:fs';
const dir=process.argv[2];
const credentials=JSON.parse(readFileSync(`${dir}/receiver.json`,'utf8'));
const server=tls.createServer({key:readFileSync(`${dir}/key.pem`),cert:readFileSync(`${dir}/cert.pem`)},socket=>{
 let buffer='',authenticated=false,data=false,message='',login=0,user='';
 const reply=line=>socket.write(line+'\r\n');
 const auth=(u,p)=>{const credentials=JSON.parse(readFileSync(`${dir}/receiver.json`,'utf8'));authenticated=u===credentials.username&&p===credentials.password;reply(authenticated?'235 authenticated':'535 rejected');};
 reply('220 isolated receiver');socket.setEncoding('utf8');socket.setTimeout(30000,()=>socket.destroy());socket.on('error',()=>{});
 socket.on('data',chunk=>{
  buffer+=chunk;
  if(buffer.length>1024*1024)return socket.destroy();
  for(let end;(end=buffer.indexOf('\r\n'))!==-1;){
   const line=buffer.slice(0,end);buffer=buffer.slice(end+2);
   if(data){
    if(line==='.'){
     data=false;
     appendFileSync(`${dir}/accepted.jsonl`,JSON.stringify({sender:credentials.from,body:message})+'\n',{mode:0o600});
     message='';reply('250 accepted');
    }else message+=line+'\n';
    continue;
   }
   if(login===1){user=Buffer.from(line,'base64').toString();login=2;reply('334 UGFzc3dvcmQ6');continue;}
   if(login===2){login=0;auth(user,Buffer.from(line,'base64').toString());continue;}
   const [command,...rest]=line.split(' '),verb=command.toUpperCase(),arg=rest.join(' ');
   if(verb==='HELO')reply('250 isolated');
   else if(verb==='EHLO')reply('250-isolated\r\n250 AUTH PLAIN LOGIN');
   else if(verb==='AUTH'&&arg.startsWith('PLAIN ')){const [,u,p]=Buffer.from(arg.slice(6),'base64').toString().split('\0');auth(u,p);}
   else if(verb==='AUTH'&&arg==='LOGIN'){login=1;reply('334 VXNlcm5hbWU6');}
   else if(verb==='MAIL')reply(authenticated&&arg.toLowerCase().startsWith(`from:<${credentials.from}>`)?'250 sender':'550 rejected');
   else if(verb==='RCPT')reply(authenticated?'250 recipient':'530 auth required');
   else if(verb==='DATA'&&authenticated){data=true;reply('354 send');}
   else if(verb==='QUIT'){reply('221 bye');socket.end();}
   else if(verb==='RSET'||verb==='NOOP')reply('250 ok');
   else reply('500 unsupported');
  }
 });
});
server.on('tlsClientError',()=>{});
server.listen(465,'0.0.0.0',()=>process.stdout.write('ready\n'));
