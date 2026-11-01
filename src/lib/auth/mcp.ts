import {betterAuth} from 'better-auth';
import {anonymous, jwt} from 'better-auth/plugins';
import {mcp} from '@better-auth/mcp';
import {cimd} from '@better-auth/cimd';
import {fetchClientMetadataResource} from '@better-auth/cimd/node';
import {verifyOAuthQueryParams} from '@better-auth/oauth-provider';
import {GrantStore, type AuthDatabase} from './grants';

export const COMEX_SCOPES = ['comex:read','comex:write','comex:generate','comex:publish'] as const;
export type ComexScope = typeof COMEX_SCOPES[number];
export type AuthenticatedActor = {ownerId:string;grantId:string;clientId:string;scopes:ComexScope[]};
export type IdentityStore = {
  authIdentity(token:string):{owner:string;email:string}|null|Promise<{owner:string;email:string}|null>;
  guestIdentity(token:string):{owner:string;email:string}|null|Promise<{owner:string;email:string}|null>;
  hasGuestToken(token:string):boolean|Promise<boolean>;
  hasLegacyOwner(owner:string):boolean|Promise<boolean>;
  createGuest(email:string):{token:string;owner:string}|Promise<{token:string;owner:string}>;
  claimLegacyOwner(token:string,email:string):{owner:string;email:string}|null|Promise<{owner:string;email:string}|null>;
};
type Options = {baseURL:string;resource:string;secret:string;database:AuthDatabase;identityStore:IdentityStore};
const cookieValue=(header:string,name:string)=>header.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${name}=`))?.slice(name.length+1);
const tokenPattern=/^[a-f0-9]{64}$/;

/** Resolve the same validated application identity used by the browser adapter. */
export async function browserOwner(cookie:string,store:IdentityStore):Promise<{owner:string;email:string}|null> {
  const session=cookieValue(cookie,'comex_auth');
  if(session && tokenPattern.test(session)) {const identity=await store.authIdentity(session);if(identity)return identity;}
  const guest=cookieValue(cookie,'comex_session');
  if(!guest || !tokenPattern.test(guest))return null;
  const identity=await store.guestIdentity(guest);if(identity)return identity;
  if(!await store.hasGuestToken(guest) && await store.hasLegacyOwner(guest))return {owner:guest,email:''};
  return null;
}

/** OAuth server and the only bearer-to-owner boundary for MCP transports. */
export function createMcpAuth({baseURL,resource,secret,database,identityStore}:Options) {
  const origin=new URL(baseURL).origin, issuer=origin+'/api/mcp-auth';
  if(baseURL!==origin || secret.length<32 || resource!==origin+'/mcp')throw new Error('Invalid MCP authentication configuration.');
  if(new URL(origin).protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname))throw new Error('MCP authentication requires HTTPS.');
  const options={baseURL:origin,basePath:'/api/mcp-auth',secret,database,session:{expiresIn:30*24*60*60},logger:{disabled:true},plugins:[
    anonymous({disableDeleteAnonymousUser:true}),
    jwt({jwt:{issuer,audience:resource}}),
    mcp({loginPage:'/connect',consentPage:'/connect/consent',resource,scopes:[...COMEX_SCOPES,'offline_access'],allowDynamicClientRegistration:true,allowUnauthenticatedClientRegistration:true,allowPublicClientPrelogin:true,refreshTokenReuseInterval:0,dpop:{signingAlgorithms:[]}}),
    cimd({fetchClientMetadataResource,metadataProfile:'mcp-2026-07-28'}),
  ]};
  const auth=betterAuth(options), grants=new GrantStore(database);
  const invoke=(path:string,init:RequestInit={})=>auth.handler(new Request(issuer+path,init));
  async function describeConsent(query:string) {
    if(!await verifyOAuthQueryParams(query,secret))return null;
    const params=new URLSearchParams(query),clientId=params.get('client_id'),scopes=params.get('scope')?.split(' ').filter(Boolean)??[];
    if(!clientId || params.get('resource')!==resource || params.get('response_type')!=='code' || params.get('code_challenge_method')!=='S256' || !params.get('code_challenge') || scopes.some(s=>s!=='offline_access' && !(COMEX_SCOPES as readonly string[]).includes(s)))return null;
    const response=await invoke('/oauth2/public-client-prelogin',{method:'POST',headers:{'content-type':'application/json',origin},body:JSON.stringify({client_id:clientId,oauth_query:query})});
    if(!response.ok)return null;
    const client=await response.json();
    return {clientId,clientName:typeof client.client_name==='string'?client.client_name:'Connected client',scopes};
  }
  async function consent(request:Request):Promise<Response> {
    if(request.method!=='POST' || request.headers.get('origin')!==origin || !request.headers.get('content-type')?.toLowerCase().startsWith('application/json'))return Response.json({error:'Invalid request.'},{status:403});
    let body:{oauth_query?:unknown;accept?:unknown;email?:unknown};
    try {const text=await request.text();if(text.length>16000)throw new Error();body=JSON.parse(text);}catch{return Response.json({error:'Invalid request.'},{status:400});}
    if(typeof body.oauth_query!=='string' || body.accept!==true)return Response.json({error:'Invalid request.'},{status:400});
    const details=await describeConsent(body.oauth_query);if(!details)return Response.json({error:'This authorization request is invalid or expired.'},{status:400});
    let owner=await browserOwner(request.headers.get('cookie')??'',identityStore),newGuest:string|undefined;
    if(!owner || !owner.email) {
      if(typeof body.email!=='string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email) || body.email.length>254)return Response.json({error:'Enter your email to continue in this browser.'},{status:400});
      const email=body.email.trim(),at=email.lastIndexOf('@'),normalized=email.slice(0,at)+'@'+email.slice(at+1).toLowerCase();
      if(owner) {
        const legacy=cookieValue(request.headers.get('cookie')??'','comex_session');
        try {owner=legacy ? await identityStore.claimLegacyOwner(legacy,normalized) : null;}catch{return Response.json({error:'Wait for your existing draft generation to finish, then try again.'},{status:409});}
        if(!owner)return Response.json({error:'This browser draft session is no longer available.'},{status:409});
      } else {const guest=await identityStore.createGuest(normalized);owner={owner:guest.owner,email:normalized};newGuest=guest.token;}
    }
    // Every grant gets a fresh, server-only anonymous session. No Better Auth
    // cookie is sent to the creator's browser or reused for a second grant.
    const signedIn=await invoke('/sign-in/anonymous',{method:'POST',headers:{'content-type':'application/json',origin},body:'{}'});
    if(!signedIn.ok)return Response.json({error:'Could not start the connection.'},{status:500});
    const sessionCookie=signedIn.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');
    const session=await auth.api.getSession({headers:new Headers({cookie:sessionCookie})});
    if(!session?.session?.id || !session.user?.id)return Response.json({error:'Could not start the connection.'},{status:500});
    const original=new URLSearchParams(body.oauth_query);
    for(const key of ['sig','exp','ba_iat','ba_param','ba_post_login']) original.delete(key);
    const authorized=await invoke('/oauth2/authorize?'+original,{headers:{cookie:sessionCookie}});
    const location=authorized.headers.get('location');
    if(authorized.status!==302 || !location)return Response.json({error:'Could not verify the authorization request.'},{status:400});
    const redirect=new URL(location,origin);
    if(redirect.origin!==origin || redirect.pathname!=='/connect/consent')return Response.json({error:'Could not verify the authorization request.'},{status:400});
    const providerConsent=await invoke('/oauth2/consent',{method:'POST',headers:{'content-type':'application/json',origin,cookie:sessionCookie},body:JSON.stringify({accept:true,oauth_query:redirect.search.slice(1)})});
    if(!providerConsent.ok)return Response.json({error:'Could not approve the connection.'},{status:400});
    const result=await providerConsent.json();
    if(typeof result.url!=='string')return Response.json({error:'Could not approve the connection.'},{status:400});
    const currentCookie=newGuest ? `comex_session=${newGuest}` : request.headers.get('cookie')??'';
    const linked=await grants.add(owner.owner,details.clientId,session.session.id,session.user.id,details.clientName,async()=> (await browserOwner(currentCookie,identityStore))?.owner===owner!.owner);
    if(!linked)return Response.json({error:'Your browser identity changed. Start the connection again.'},{status:409});
    const headers=new Headers({'cache-control':'no-store'});
    if(newGuest)headers.append('set-cookie',`comex_session=${newGuest}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${origin.startsWith('https:')?'; Secure':''}`);
    return Response.json({redirect:result.url},{headers});
  }
  async function authenticate(request:Request,requiredScopes:readonly ComexScope[]):Promise<AuthenticatedActor|null> {
    const authorization=request.headers.get('authorization'),match=authorization?.match(/^Bearer ([^\s]+)$/i);
    if(!match)return null;
    let claims:Awaited<ReturnType<typeof auth.api.verifyJWT>>['payload'];
    try {({payload:claims}=await auth.api.verifyJWT({body:{token:match[1]}}));}catch{return null;}
    if(!claims || claims.cnf!==undefined || typeof claims.exp!=='number' || claims.exp<=Date.now()/1000 || claims.azp!==claims.client_id || typeof claims.sub!=='string' || typeof claims.sid!=='string' || !claims.sid || typeof claims.client_id!=='string' || !claims.client_id || typeof claims.scope!=='string')return null;
    const scopes=claims.scope.split(' ');
    if(requiredScopes.some(scope=>!scopes.includes(scope)))return null;
    const grant=await grants.active(claims.sid,claims.sub,claims.client_id);if(!grant)return null;
    return {ownerId:grant.ownerId,grantId:grant.grantId,clientId:grant.clientId,scopes:scopes.filter((scope):scope is ComexScope=>(COMEX_SCOPES as readonly string[]).includes(scope))};
  }
  async function connections(cookie:string) {const owner=await browserOwner(cookie,identityStore);return owner?(await grants.list(owner.owner)).map(g=>({id:g.grantId,name:g.clientName,createdAt:g.createdAt})):[];}
  async function revoke(cookie:string,id:string) {const owner=await browserOwner(cookie,identityStore);return owner ? grants.revoke(owner.owner,id):false;}
  return {options,auth,consent,authenticate,isGrantActive:(actor:AuthenticatedActor)=>grants.activeId(actor.grantId,actor.ownerId),connections,revoke,describeConsent,identityStore,database};
}
