import {expect,test} from 'bun:test';
import {DatabaseSync} from 'node:sqlite';
import type {createComicService} from '../src/lib/application/comics';
import {createMcpReads} from '../src/lib/mcp/reads';

test('MCP reads paginate only the authenticated owner and hide other operations',async()=>{
  const db=new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE comics (id TEXT, owner TEXT, draft TEXT, edition TEXT)');
    const insert=db.prepare('INSERT INTO comics VALUES (?,?,?,?)');
    for (const [id,owner] of [['a','alice'],['b','alice'],['c','bob']]) insert.run(id,owner,JSON.stringify({title:id,plot:'story'}),null);
    const service={listStyles:()=>({styles:[]})} as unknown as ReturnType<typeof createComicService>;
    const reads=createMcpReads(db,service,{getOwned:()=>null},async()=>null);
    const identity={actor:'alice',scopes:['comex:read'] as const};
    const first=await reads.listComics(identity,{limit:1});
    expect(first).toEqual({comics:[{id:'a',title:'a',plot:'story',published:false}],nextCursor:'a'});
    expect(await reads.listComics(identity,{limit:1,cursor:first.nextCursor!})).toEqual({comics:[{id:'b',title:'b',plot:'story',published:false}],nextCursor:null});
    await expect(reads.getOperation(identity,'another-owner-operation')).rejects.toMatchObject({code:'not_found'});
    await expect(reads.getExport(identity,'another-owner-export')).rejects.toMatchObject({code:'not_found'});
  } finally {db.close();}
});
