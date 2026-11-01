import {after} from 'next/server';
import {browserOwner, COMEX_SCOPES} from './auth/mcp';
import {browserOwnerMatches} from './auth/browser-transaction';
import {getHostedApp} from './hosted-runtime';
import {createBrowserOperations} from './operations/browser-api';

export function getHostedBrowserOperations() {
  const app=getHostedApp();
  const retryPending=()=>after(async()=>{try{await app.runtime.redeliver();}catch{/* The scheduled recovery can retry later. */}});
  return createBrowserOperations({
    origin:app.origin,
    owner:async cookie=>(await browserOwner(cookie,app.auth.identityStore))?.owner ?? null,
    workspaceId:app.backend.workspaceId,
    async enqueue(cookie,owner,input) {
      const coordinator=app.runtime.coordinatorForBrowser((client,identity)=>browserOwnerMatches(client,cookie,identity.actor));
      const ticket=await coordinator.enqueue({identity:{actor:owner,scopes:COMEX_SCOPES},...input});
      retryPending();
      return ticket;
    },
    get:async(owner,id)=>{const operation=await app.runtime.operations.getOwned(owner,id);if(operation && ['queued','running'].includes(operation.status))retryPending();return operation;},
    find:async(owner,action,key)=>{const operation=await app.runtime.operations.findOwned(owner,action,key);if(operation && ['queued','running'].includes(operation.status))retryPending();return operation;},
    list:async(owner,id)=>{const operations=await app.runtime.operations.listActiveOwned(owner,id);if(operations.some(operation=>['queued','running'].includes(operation.status)))retryPending();return operations;},
    export:(owner,id)=>app.runtime.readOwnedExport(owner,id),
  });
}
