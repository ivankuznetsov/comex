import type {OperationRepository} from './contracts';

/** Called by an independent scheduler; an unacknowledged start remains redeliverable. */
export async function redeliverPending<Tx>(repository:OperationRepository<Tx>,start:(operationId:string)=>Promise<string>,options:{limit:number;leaseMs:number}):Promise<{started:number;failed:number;requeued:number;unknown:number}> {
  const recovered=await repository.recoverStalled(options.limit);
  let started=0,failed=0;
  for(let i=0;i<options.limit;i++) {
    const lease=await repository.claimIntent(options.leaseMs);if(!lease)break;
    try {const runId=await start(lease.operationId);if(await repository.ackIntent(lease,runId))started++;}
    catch {await repository.releaseIntent(lease);failed++;break;}
  }
  return {started,failed,...recovered};
}
