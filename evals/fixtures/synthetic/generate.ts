// Repository-owned diagrams and candidate metadata. No comic artwork or private story data.
import sharp from 'sharp';
import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';

const dir='evals/fixtures/synthetic';
const frame=(body:string)=>`<svg xmlns="http://www.w3.org/2000/svg" width="400" height="240" viewBox="0 0 400 240"><rect width="400" height="240" fill="#f8f4e9"/>${body}</svg>`;
const lighthouse=frame('<path d="M145 220L165 85H235L255 220Z" fill="#e4e1dc" stroke="#24313b" stroke-width="6"/><rect x="172" y="44" width="56" height="40" fill="#ffd449" stroke="#24313b" stroke-width="6"/><path d="M165 44L200 20L235 44M130 220H270" fill="none" stroke="#24313b" stroke-width="7"/><path d="M115 55L155 64M245 64L285 55" stroke="#f0ad00" stroke-width="7"/>');
const tower=frame('<rect x="90" y="48" width="220" height="172" fill="#b6c9d2" stroke="#25303d" stroke-width="6"/><path d="M80 48L200 8L320 48" fill="#5c7183" stroke="#25303d" stroke-width="6"/><rect x="174" y="100" width="52" height="70" fill="#f8c637" stroke="#25303d" stroke-width="6"/><circle cx="200" cy="135" r="10" fill="#f2ad19"/>');
const latch=(state:'match'|'mismatch'|'occluded')=>frame(`<rect x="255" y="55" width="92" height="145" rx="7" fill="#bbb9aa" stroke="#30343a" stroke-width="6"/><circle cx="282" cy="128" r="12" fill="#222"/><circle cx="${state==='mismatch'?90:172}" cy="128" r="23" fill="none" stroke="#b38319" stroke-width="10"/><path d="M${state==='mismatch'?113:195} 128H${state==='mismatch'?195:282}m-13 0v17m-14-17v14" stroke="#b38319" stroke-width="9"/>${state==='occluded'?'<rect x="235" y="94" width="95" height="70" rx="20" fill="#75879a" stroke="#30343a" stroke-width="5"/>':''}`);
const coat=(color:string, bg:string)=>frame(`<rect x="0" y="182" width="400" height="58" fill="${bg}"/><circle cx="200" cy="63" r="30" fill="#e8be9e" stroke="#28333c" stroke-width="5"/><path d="M151 205L160 103L200 92L240 103L249 205Z" fill="${color}" stroke="#28333c" stroke-width="6"/><path d="M200 98V201M180 130H220" stroke="#28333c" stroke-width="5"/>`);
const art:Record<string,string>={'lighthouse-lit':lighthouse,'tower-lit':tower,'latch-match':latch('match'),'latch-mismatch':latch('mismatch'),'latch-occluded':latch('occluded'),'coat-red':coat('#bb4a4a','#c4d3c6'),'coat-blue':coat('#4777b0','#c4d3c6'),'coat-mono':coat('#666666','#c7c7c7')};
const hashes:Record<string,string>={};
for (const [name,svg] of Object.entries(art)) {
  const bytes=await sharp(Buffer.from(svg)).png().toBuffer();
  await writeFile(`${dir}/${name}.png`,bytes);
  hashes[name]=createHash('sha256').update(bytes).digest('hex');
}
const image=(name:string,role:string,id:string)=>({file:`${dir}/${name}.png`,sha256:hashes[name],role,id});
const cases:unknown[]=[];
const routing=(id:string,split:'calibration'|'holdout',family:string,art:string,instruction:string,action:string,label:string)=>cases.push({id,kind:'routing',split,family,reviewed:false,rationale:'Synthetic candidate; the image and proposed label require independent human review.',images:[image(art,'target panel','panel-1')],evidence:{instruction,panel:{action},bible:{rules:[]},characters:[],styleRules:'Simple flat-color diagram'},checks:[{name:'route',question:'Which edit route fits the creator request and intended panel?',dimension:'story',label}]});
routing('light-restore','calibration','lighthouse','lighthouse-lit','Turn the light off.','The lighthouse light is off.','restore');
routing('light-story','calibration','lighthouse','lighthouse-lit','Turn the light off.','The lighthouse light is on.','story');
routing('light-cosmetic','calibration','lighthouse','lighthouse-lit','Make the tower outline thicker.','The lighthouse light is on.','cosmetic');
routing('light-ambiguous','calibration','lighthouse','lighthouse-lit','Fix the light.','The lighthouse light is on.','clarify');
routing('tower-restore','holdout','tower','tower-lit','Make the window dark.','The window is dark.','restore');
routing('tower-story','holdout','tower','tower-lit','Make the window dark.','The window is lit.','story');
const visual=(id:string,split:'calibration'|'holdout',family:string,art:string,action:string,question:string,label:string,references:string[]=[])=>cases.push({id,kind:'visual',split,family,reviewed:false,rationale:'Synthetic candidate; the image and proposed label require independent human review.',images:[image(art,'generated panel','panel-1'),...references.map(name=>image(name,'approved character','character-1'))],evidence:{panel:{action},bible:{rules:[]},characters:references.length?[{id:'character-1',name:'Figure',role:'figure',appearance:'round head',outfit:'as specified in the panel'}]:[],styleRules:'Simple diagram'},checks:[{name:'detail',question,dimension:'story',label}]});
visual('latch-match','calibration','latch','latch-match','The key is inserted into the lock.','Is the key inserted into the lock?','match');
visual('latch-mismatch','calibration','latch','latch-mismatch','The key is inserted into the lock.','Is the key inserted into the lock?','mismatch');
visual('latch-occluded','calibration','latch','latch-occluded','The key is inserted into the lock.','Is the key inserted into the lock?','cannot_determine');
visual('outfit-change','holdout','outfit','coat-blue','The figure changed from the red coat in the reference to a blue coat.','Does the panel show the intended blue coat?','match',['coat-red']);
visual('monochrome','holdout','monochrome','coat-mono','The figure wears the same coat shown in the reference, rendered in monochrome.','Does the coat shape match the reference without requiring the same color?','match',['coat-red']);
await writeFile(`${dir}/manifest.json`,JSON.stringify({version:1,cases},null,2)+'\n');
