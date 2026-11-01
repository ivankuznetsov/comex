import {createHmac} from 'node:crypto';

/** Stable browser-visible namespace, never an owner ID or authentication credential. */
export function workspaceId(owner:string,secret:string):string {
  if(secret.length<32)throw new Error('Workspace identity is not configured.');
  return createHmac('sha256',secret).update('comex-browser-workspace\0').update(owner).digest('hex');
}
