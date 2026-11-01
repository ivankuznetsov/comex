'use client';
import {useEffect,useState} from 'react';

type Details={clientName:string;scopes:string[]};
export function Consent({query,details}:{query:string;details:Details}) {
  const [email,setEmail]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [workspace,setWorkspace]=useState<{hasOwner:boolean;needsEmail:boolean}|null>(null);
  // The initial cross-site OAuth navigation may omit SameSite=Strict guest
  // cookies. A same-origin request after navigation sees the actual workspace.
  useEffect(()=>{fetch('/api/mcp-auth/comex/browser').then(async r=>{if(!r.ok)throw new Error();setWorkspace(await r.json());}).catch(()=>setError('Could not check this browser workspace.'));},[]);
  const hasOwner=workspace?.hasOwner??false,needsEmail=workspace?.needsEmail??true;
  async function approve(event:React.FormEvent) {
    event.preventDefault();setBusy(true);setError('');
    try {
      const response=await fetch('/api/mcp-auth/comex/consent',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({oauth_query:query,accept:true,...(needsEmail?{email}: {})})});
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Could not connect.');window.location.assign(result.redirect);
    } catch(e){setError(e instanceof Error?e.message:'Could not connect.');setBusy(false);}
  }
  const labels:Record<string,string>={'comex:read':'Read your drafts','comex:write':'Create and edit drafts','comex:generate':'Generate artwork and text using your configured budget','comex:publish':'Publish and withdraw editions','offline_access':'Keep this connection active'};
  if(!workspace)return <main className="mx-auto max-w-xl px-5 py-12"><p role="status">{error||'Checking your browser workspace…'}</p></main>;
  return <main className="mx-auto max-w-xl px-5 py-12"><h1 className="font-display text-4xl uppercase">Connect {details.clientName}</h1><p className="mt-4">This client is asking to access the Comex drafts in this browser.</p>{!hasOwner&&<p className="mt-4">This browser has no workspace yet. Continuing creates a new, empty workspace; existing drafts in another browser will not be included.</p>}<ul className="my-6 list-disc pl-6">{details.scopes.map(scope=><li key={scope}>{labels[scope]??scope}</li>)}</ul><form onSubmit={approve} className="space-y-4">{needsEmail&&<label className="block">Your email address<input type="email" required maxLength={254} value={email} onChange={e=>setEmail(e.target.value)} className="mt-2 block w-full border-2 border-black p-3"/></label>}{error&&<p role="alert">{error}</p>}<button type="submit" disabled={busy} className="border-2 border-black bg-black px-5 py-3 font-bold text-white">{busy?'Connecting…':'Allow connection'}</button> <a className="ml-3 underline" href="/">Cancel</a></form></main>;
}
