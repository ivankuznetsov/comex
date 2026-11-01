import {readFile,realpath} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {z} from 'zod';

const image = z.object({file:z.string().min(1),sha256:z.string().regex(/^[a-f0-9]{64}$/),role:z.string().min(1),id:z.string().min(1)}).strict();
const check = z.object({name:z.string().min(1),question:z.string().min(1),dimension:z.string().min(1),label:z.string().min(1)}).strict();
const fixture = z.object({
  id:z.string().min(1),kind:z.enum(['routing','visual']),split:z.enum(['calibration','holdout']),family:z.string().min(1),reviewed:z.boolean(),rationale:z.string().min(1),
  images:z.array(image).min(1).max(10),
  evidence:z.object({instruction:z.string().optional(),panel:z.json(),bible:z.json(),characters:z.array(z.object({id:z.string(),name:z.string(),role:z.string(),appearance:z.string(),outfit:z.string()}).strict()),styleRules:z.string()}).strict(),
  checks:z.array(check).min(1),
}).strict();
const schema = z.object({version:z.literal(1),cases:z.array(fixture).min(1)}).strict();
export type TrialCase = z.infer<typeof fixture>;
export type TrialManifest = z.infer<typeof schema>;
export function sha256(bytes:Uint8Array|string):string {return createHash('sha256').update(bytes).digest('hex');}

export async function readFixtureImage(asset:z.infer<typeof image>,imageRoot:string):Promise<Buffer> {
  const root=await realpath(imageRoot);
  if (isAbsolute(asset.file) || !/\.(png|jpe?g|webp)$/i.test(asset.file)) throw new Error(`Invalid image path: ${asset.file}`);
  const actual=await realpath(resolve(root,asset.file)); const rel=relative(root,actual);
  if (!rel || rel==='..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Image escapes the selected root: ${asset.file}`);
  const bytes=await readFile(actual);
  if (sha256(bytes)!==asset.sha256) throw new Error(`Image hash mismatch: ${asset.file}`);
  return bytes;
}

export async function loadManifest(path:string,imageRoot:string):Promise<TrialManifest> {
  const parsed=schema.safeParse(JSON.parse(await readFile(path,'utf8')));
  if (!parsed.success) throw new Error(`Invalid evaluation manifest: ${parsed.error.message}`);
  const ids=new Set<string>(),families=new Map<string,string>(),targetSplits=new Map<string,string>();
  for (const item of parsed.data.cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate case: ${item.id}`);
    ids.add(item.id);
    const prior=families.get(item.family);
    if (prior && prior!==item.split) throw new Error(`Scene family crosses calibration and holdout: ${item.family}`);
    families.set(item.family,item.split);
    const targetRole=item.kind==='routing'?'target panel':'generated panel';
    if (item.images[0].role!==targetRole || item.images.filter(image=>image.role===targetRole).length!==1) throw new Error(`Expected one first target image: ${item.id}`);
    const targetHash=item.images[0].sha256,priorSplit=targetSplits.get(targetHash);
    if (priorSplit && priorSplit!==item.split) throw new Error(`Target image crosses calibration and holdout: ${item.id}`);
    targetSplits.set(targetHash,item.split);
    if (item.kind==='routing' && (!item.evidence.instruction || item.checks.length!==1 || item.images[0].role!=='target panel')) throw new Error(`Invalid routing case: ${item.id}`);
    const containsLabel = (value:unknown):boolean => {
      if (!value || typeof value !== 'object') return false;
      if (Array.isArray(value)) return value.some(containsLabel);
      return Object.entries(value).some(([key,child]) => ['label','labels','expectedlabel','groundtruth'].includes(key.replace(/[_-]/g,'').toLowerCase()) || containsLabel(child));
    };
    if (containsLabel(item.evidence)) throw new Error(`Evaluation label cannot be supplied as evidence: ${item.id}`);
    const valid=item.kind==='routing'?['cosmetic','restore','story','clarify']:['match','mismatch','cannot_determine'];
    if (item.checks.some(c=>!valid.includes(c.label)) || new Set(item.checks.map(c=>c.name)).size!==item.checks.length) throw new Error(`Invalid labels or duplicate check names: ${item.id}`);
    for (const asset of item.images) await readFixtureImage(asset,imageRoot);
  }
  return parsed.data;
}
