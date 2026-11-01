import {after} from 'next/server';
import {browserOwner, COMEX_SCOPES} from './auth/mcp';
import {browserOwnerMatches} from './auth/browser-transaction';
import {getHostedApp} from './hosted-runtime';
import {createBrowserOperations} from './operations/browser-api';

export function getHostedBrowserOperations() {
  const app=getHostedApp();
  return createBrowserOperations({
    origin:app.origin,
    owner:async cookie=>(await browserOwner(cookie,app.auth.identityStore))?.owner ?? null,
    workspaceId:app.backend.workspaceId,
    async enqueue(cookie,owner,input) {
      const coordinator=app.runtime.coordinatorForBrowser((client,identity)=>browserOwnerMatches(client,cookie,identity.actor));
      const ticket=await coordinator.enqueue({identity:{actor:owner,scopes:COMEX_SCOPES},...input});
      after(async()=>{try{await app.runtime.redeliver();}catch{/* The independent scheduler retries the committed intent. */}});
      return ticket;
    },
    get:async(owner,id)=>await app.runtime.operations.getOwned(owner,id),
    find:async(owner,action,key)=>await app.runtime.operations.findOwned(owner,action,key),
    list:async(owner,id)=>await app.runtime.operations.listActiveOwned(owner,id),
    export:(owner,id)=>app.runtime.readOwnedExport(owner,id),
  });
}
