import {expect,test} from 'bun:test';
import {createBrowserOperations} from '../src/lib/operations/browser-api';
import type {Operation} from '../src/lib/operations/contracts';

test('browser operations require the current owner and keep internal credentials out of status',async()=>{
  const operation:Operation={id:'op',owner:'alice',action:'create',requestKey:'key',targetId:'',grantId:'private-grant',expectedVersions:null,input:{secret:'private-input'},status:'succeeded',result:{comic:{id:'comic',ownerId:'alice'},token:'private-token'},createdAt:'now',updatedAt:'now'};
  let enqueues=0;
  const api=createBrowserOperations({origin:'https://comex.example',owner:async cookie=>cookie==='session=alice'?'alice':null,
    enqueue:async(_cookie,owner,input)=>{enqueues++;expect(owner).toBe('alice');expect(input.requestKey).toBe('key');return {id:'op',status:'queued'};},
    get:async(owner,id)=>owner==='alice' && id==='op'?operation:null,export:async()=>null});
  const payload={action:'create',requestKey:'key',input:{title:'Story',plot:'A courier',style:'ink-manga'}};
  const post=(origin:string,cookie='session=alice')=>new Request('https://comex.example/api/operations',{method:'POST',headers:{host:'comex.example',origin,'content-type':'application/json',cookie},body:JSON.stringify(payload)});
  expect((await api.start(post('https://attacker.example'))).status).toBe(403);
  expect((await api.start(post('https://comex.example',''))).status).toBe(401);
  expect((await api.start(post('https://comex.example'))).status).toBe(202);
  expect(enqueues).toBe(1);
  const get=(cookie:string)=>new Request('https://comex.example/api/operations/op',{headers:{host:'comex.example',cookie}});
  expect((await api.get(get(''),'op')).status).toBe(404);
  const response=await api.get(get('session=alice'),'op');
  const body=await response.json();
  expect(body).toMatchObject({id:'op',status:'succeeded',comicId:'comic',result:{comic:{id:'comic'}}});
  expect(JSON.stringify(body)).not.toContain('private-grant');
  expect(JSON.stringify(body)).not.toContain('private-input');
  expect(JSON.stringify(body)).not.toContain('private-token');
  expect(JSON.stringify(body)).not.toContain('ownerId');
  expect((await api.get(get('session=alice'),'op',true)).status).toBe(404);
});
