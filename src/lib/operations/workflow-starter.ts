import {start} from 'workflow/api';
import {comicGeneration} from '../../workflows/comic-generation';

export async function startComicWorkflow(operationId:string):Promise<string> {
  const run=await start(comicGeneration,[operationId]);
  return run.runId;
}
