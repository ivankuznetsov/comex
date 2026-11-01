'use client';
import Link from 'next/link';
import {useEffect, useState} from 'react';
import {clearHostedWorkspace, hostedSession, request, subscribeHostedWorkspace} from './api';

export default function AuthMenu() {
  const [user,setUser] = useState<{email:string} | null>(null);
  const [hosted,setHosted] = useState(false);
  const [available,setAvailable] = useState(false);
  const [error,setError] = useState('');
  useEffect(() => { let active=true; hostedSession(false).then(data => {if (active) {setUser(data.user);setHosted('workspaceId' in data);setAvailable(!!(data as typeof data & {signInAvailable?:boolean}).signInAvailable);}}).catch(() => {}); return () => {active=false;}; },[]);
  useEffect(()=>subscribeHostedWorkspace(()=>setUser(null)),[]);
  async function signOut() { try {if(hosted)clearHostedWorkspace();await request('/api/auth/sign-out',{method:'POST',body:'{}'}); window.location.assign('/');} catch {if(hosted)void hostedSession().catch(()=>{});setError('Could not sign out. Try again.'); } }
  return user ? <span><button type="button" onClick={signOut} className="underline-offset-4 hover:underline" aria-label={`Sign out ${user.email}`}>Sign out</button>{error && <span role="alert" className="ml-2 text-[#9d1c1c]">{error}</span>}</span> : available ? <Link href="/sign-in" className="underline-offset-4 hover:underline">Sign in / save drafts</Link> : null;
}
