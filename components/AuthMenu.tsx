'use client';
import Link from 'next/link';
import {useEffect, useState} from 'react';
import {request} from './api';

export default function AuthMenu() {
  const [user,setUser] = useState<{email:string} | null>(null);
  const [error,setError] = useState('');
  useEffect(() => { let active=true; request<{user:{email:string}|null}>('/api/auth/session').then(data => {if (active) setUser(data.user);}).catch(() => {}); return () => {active=false;}; },[]);
  async function signOut() { try {await request('/api/auth/sign-out',{method:'POST',body:'{}'}); window.location.assign('/');} catch { setError('Could not sign out. Try again.'); } }
  return user ? <span><button type="button" onClick={signOut} className="underline-offset-4 hover:underline" aria-label={`Sign out ${user.email}`}>Sign out</button>{error && <span role="alert" className="ml-2 text-[#9d1c1c]">{error}</span>}</span> : <Link href="/sign-in" className="underline-offset-4 hover:underline">Sign in / save drafts</Link>;
}
