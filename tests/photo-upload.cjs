
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),{webcrypto}=require('node:crypto');
const scripts=[...fs.readFileSync('index.html','utf8').matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
let source=scripts.at(-1)[1].replace('  let BC={worker:', '  decodeFile=async()=>[]; preparePhoto=async()=>({original:"data:image/jpeg;base64,T1JJR0lOQUw=",overview:"data:image/jpeg;base64,AA",width:5712,height:4284,details:Array.from({length:30},(_,i)=>({x:i,y:0,width:1000,height:1000,image:"data:image/jpeg;base64,AA"}))});\n  let BC={worker:');
const elements=new Map();
const el=id=>elements.get(id)||elements.set(id,{id,style:{},classList:{add(){},remove(){}},disabled:false,value:'',innerHTML:'',textContent:''}).get(id);
const calls=[];let response={ok:true,committed:2,matched:1,inventory_added:1,recon:[{card:'Lugia V',number:'138',present:2,matched:1,inventory_added:1,already_received:0}]};
const ctx={document:{readyState:'complete',getElementById:el},window:{},crypto:webcrypto,SESSION:{user:{id:'test'}},sb:{functions:{invoke:async(name,args)=>{calls.push(args.body);return response instanceof Error?{error:response}:args.body.action==="locate-photo"?{data:{cards:[]}}:args.body.action==="read-photo"?{data:{extracted:{inventory:[],packages:[]}}}:{data:response};}}},Image:class{},URL,alert:()=>{},console};
vm.createContext(ctx);vm.runInContext(source,ctx);
(async()=>{
ctx.window.openBatch();assert.match(el('bcBody').innerHTML,/Upload & check in/);assert.doesNotMatch(el('bcBody').innerHTML,/Card name|Confirm/);
el('bcWorker').onchange({target:{value:'connor'}});
const photo={type:'image/jpeg',name:'test.jpg',arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer};

el('bcFiles').files=[photo,photo];await el('bcFiles').onchange();
assert.equal(calls.length,4);assert.equal(calls.shift().action,'locate-photo');assert.equal(calls[0].action,'read-photo');assert.equal(calls[0].original,'data:image/jpeg;base64,T1JJR0lOQUw=');assert.equal(calls[0].details.length,16);assert.equal(calls[1].details.length,14);assert.equal(calls[2].action,'auto');assert.equal(calls[2].worker,'connor');assert.equal(calls[2].images.length,1);assert.equal(calls[2].photo_reads[0].reads.length,2);
assert.match(el('bcBody').innerHTML,/Checked in: 2/);assert.match(el('bcBody').innerHTML,/Conor/);assert.equal(el('bcConfirm').textContent,'Done');
el('bcAnother').onclick();response=new Error('test failure');el('bcFiles').files=[photo];await el('bcFiles').onchange();
assert.match(el('bcStatus').textContent,/retry the same photos safely/);assert.equal(el('bcWorker').disabled,false);
console.log('Upload automatically commits, deduplicates photos, credits selected worker, renders receipt, and recovers from errors');

})().catch(e=>{console.error(e);process.exitCode=1;});
