/** A run is durable on Vercel World; the database owns all business checkpoints. */
export async function comicGeneration(operationId:string):Promise<void> {
  'use workflow';
  await executeOperation(operationId);
}

async function executeOperation(operationId:string):Promise<void> {
  'use step';
  const {getConfiguredOperationRuntime}=await import('../lib/operations/hosted');
  await getConfiguredOperationRuntime().executor.execute(operationId);
}
// A lost worker is recovered by the independent database redriver, never SDK retries.
executeOperation.maxRetries=0;
