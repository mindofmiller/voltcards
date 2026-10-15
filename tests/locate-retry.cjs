const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
let src=fs.readFileSync('supabase/functions/batch-checkin/index.ts','utf8').replace(/^import .*;$/gm,'');
let handler,calls=0,responses=[];
const ctx={Response,Request,console,createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'a4eecaeb-bfaf-4dd2-9dfb-31e4c28ca395'}}})}}),Deno:{env:{get:()=> 'test'},serve:h=>handler=h},fetch:async()=>{calls++;return {ok:true,json:async()=>({content:[{type:'text',text:responses.shift()}]})}}};
vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(src),ctx);
const run=async()=>{calls=0;return handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({action:'locate-photo',image:'data:image/jpeg;base64,AA'})}));};
(async()=>{
responses=['{"cards":[{"x":900,"y":0,"width":300,"height":300}]}','{"cards":[{"x":"750","y":0,"width":255,"height":300,"rotation":90}]}'];
let r=await run(),data=await r.json();assert.equal(r.status,200);assert.equal(calls,2);assert.equal(data.cards.length,1);assert.equal(data.cards[0].width,250);
responses=['bad','bad','bad'];r=await run();assert.equal(r.status,500);assert.equal(calls,3);assert.match((await r.json()).error,/No cards were checked in/);
responses=['{"cards":[]}'];r=await run();assert.equal(r.status,200);assert.equal(calls,1);
console.log('Endpoint retries invalid model layouts, accepts corrected layout, caps retries, and handles packages without writes');
})().catch(e=>{console.error(e);process.exitCode=1;});
