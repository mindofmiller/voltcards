const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync('index.html','utf8'),start=html.indexOf('  function fileToImg(file)'),end=html.indexOf('  let BC=',start);
const draws=[];let readFile;const original='data:image/jpeg;base64,'+Buffer.from('untouched file bytes').toString('base64');
class ImageMock{constructor(){this.width=this.naturalWidth=5712;this.height=this.naturalHeight=4284;}set src(v){this.onload();}}
class Reader{readAsDataURL(file){readFile=file;this.result=original;this.onload();}}
const ctx={Image:ImageMock,FileReader:Reader,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL:()=>{}},document:{createElement:()=>({width:0,height:0,getContext:()=>({drawImage:(...args)=>draws.push(args),translate:()=>{},rotate:()=>{}}),toDataURL:()=> 'data:image/jpeg;base64,AA'})}};
vm.createContext(ctx);vm.runInContext(html.slice(start,end)+';globalThis.prepare=preparePhoto;globalThis.crop=wholeCardCrops;',ctx);
(async()=>{
const file={type:'image/jpeg',name:'full.jpg'},p=await ctx.prepare(file);
assert.equal(p.original,original);assert.equal(readFile,file);assert.equal(p.width,5712);assert.equal(p.height,4284);assert.equal(p.details.length,30);
for(const draw of draws.slice(1)){assert.equal(draw[3],draw[7]);assert.equal(draw[4],draw[8]);assert.ok(draw[7]<=1064&&draw[8]<=1064);}
assert.ok(p.details.some(d=>d.x+d.width===5712));assert.ok(p.details.some(d=>d.y+d.height===4284));
const whole=ctx.crop(p,[{x:0,y:0,width:250,height:500,rotation:90}]);assert.equal(whole.length,1);assert.equal(whole[0].card_index,1);assert.equal(whole[0].rotation,90);assert.equal(whole[0].width,1428);assert.equal(whole[0].height,2142);
await assert.rejects(()=>ctx.prepare({type:'image/heic',name:'unsupported.heic'}),/export HEIC/);
console.log('Original file bytes preserved; 5712×4284 photo covered by 30 overlapping native-pixel crops; unsupported formats rejected');
})().catch(e=>{console.error(e);process.exitCode=1;});
