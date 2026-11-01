import {expect,test} from 'bun:test';
import {VercelPrivateObjects} from '../src/lib/storage/assets';

test('Vercel Blob uploads and reads are explicitly private and return bytes, not URLs',async()=>{
  const calls:{method:string;path:string;options?:unknown}[]=[];
  const sdk={
    put:async(path:string,_bytes:Uint8Array,options:unknown)=>{calls.push({method:'put',path,options});return {pathname:path};},
    get:async(path:string,options:unknown)=>{calls.push({method:'get',path,options});return {statusCode:200,stream:new ReadableStream({start(c){c.enqueue(new Uint8Array([1,2,3]));c.close();}})};},
    del:async(path:string)=>{calls.push({method:'del',path});},
  } as unknown as ConstructorParameters<typeof VercelPrivateObjects>[0];
  const objects=new VercelPrivateObjects(sdk);
  expect(await objects.put('drafts/example.png',new Uint8Array([1,2,3]))).toBe('drafts/example.png');
  expect(await objects.read('drafts/example.png')).toEqual(Buffer.from([1,2,3]));
  await objects.delete('drafts/example.png');
  expect(calls).toEqual([
    {method:'put',path:'drafts/example.png',options:{access:'private',contentType:'image/png'}},
    {method:'get',path:'drafts/example.png',options:{access:'private'}},
    {method:'del',path:'drafts/example.png'},
  ]);
});
