const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{stripTypeScriptTypes}=require('node:module');
let src=fs.readFileSync('supabase/functions/batch-checkin/index.ts','utf8').replace(/^import .*;$/gm,'');
let handler,calls=0,responses=[];
const ctx={Response,Request,console,atob,Uint8Array,createClient:()=>({auth:{getUser:async()=>({data:{user:{id:'a4eecaeb-bfaf-4dd2-9dfb-31e4c28ca395'}}})}}),Deno:{env:{get:()=> 'test'},serve:h=>handler=h},fetch:async()=>{calls++;return {ok:true,json:async()=>({content:[{type:'text',text:responses.shift()}]})}}};
vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(src),ctx);
const run=async()=>{calls=0;return handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({action:'locate-photo',image:'data:image/jpeg;base64,'+Buffer.from([255,216,255,192,0,17,8,3,232,3,232,3,1,17,0,2,17,0,3,17,0,255,217]).toString('base64')})}));};
(async()=>{
responses=['{"cards":[{"x":900,"y":0,"width":300,"height":300}]}','{"cards":[{"x":"750","y":0,"width":255,"height":300,"rotation":90}]}'];
let r=await run(),data=await r.json();assert.equal(r.status,200);assert.equal(calls,2);assert.equal(data.cards.length,1);assert.equal(data.cards[0].width,250);
responses=['bad','bad','bad'];r=await run();assert.equal(r.status,500);assert.equal(calls,3);assert.match((await r.json()).error,/No cards were checked in/);
responses=['{"cards":[]}'];r=await run();assert.equal(r.status,200);assert.equal(calls,1);
responses=[JSON.stringify({packages:[],inventory:[{card_index:1,name:'Lugia V',number:'220',name_confident:true,number_confident:true}]}),JSON.stringify({inventory:[{card_index:1,name:'Lugia V',number:'220',hp:'220',name_confident:true,number_confident:true}]})];
const verified=await handler(new Request('https://example.com',{method:'POST',headers:{Authorization:'Bearer test','content-type':'application/json'},body:JSON.stringify({action:'read-photo',original:'data:image/jpeg;base64,AA==',width:1000,height:1000,details:[{card_index:1,image:'data:image/jpeg;base64,AA=='}],card_indices:[1]})}));
const verifiedBody=await verified.json();assert.equal(verified.status,200);assert.equal(verifiedBody.extracted.inventory[0].number,null);assert.equal(verifiedBody.extracted.inventory[0].name,'Lugia V');assert.equal(verifiedBody.extracted.inventory[0].confident,false);
console.log('Endpoint retries invalid model layouts, accepts corrected layout, caps retries, and handles packages without writes');
})().catch(e=>{console.error(e);process.exitCode=1;});
