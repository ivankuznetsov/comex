'use client';
import Link from 'next/link';
import {useEffect,useRef,useState} from 'react';
import {ComicShell,Eyebrow,Message,button} from './ComicShell';
import {request,errorMessage} from './api';

export default function VerifySignIn() {
  const [token,setToken] = useState(''); const [email,setEmail]=useState(''); const [busy,setBusy]=useState(false); const [error,setError]=useState('');
  const consumed = useRef(false);
  useEffect(() => {if (consumed.current) return; consumed.current=true; const value=window.location.hash.slice(1); window.history.replaceState(null,'',window.location.pathname); if (/^[a-f0-9]{64}$/.test(value)) {setToken(value); request<{email:string}>('/api/auth/inspect',{method:'POST',body:JSON.stringify({token:value})}).then(data => setEmail(data.email)).catch(err => setError(errorMessage(err)));} else setError('This link is invalid. Request a new one.');},[]);
  async function verify() { setBusy(true); setError(''); try {await request('/api/auth/verify',{method:'POST',body:JSON.stringify({token})}); window.location.assign('/drafts');} catch (err) {setError(errorMessage(err)); setBusy(false);} }
  return <ComicShell><main className="mx-auto max-w-[650px] px-4 pt-10 sm:px-6"><Eyebrow>Welcome back</Eyebrow><h1 className="font-display mt-4 text-5xl uppercase">Finish signing in</h1>{email && <p className="mt-4">Confirm that you want to sign in as <strong>{email}</strong>. Existing browser drafts will be saved only if you requested this link in this browser.</p>}{error && <div className="mt-5"><Message error>{error} <Link href="/sign-in" className="underline">Request a new link</Link></Message></div>}{token && email && <button className={`${button} mt-7`} disabled={busy} onClick={verify}>{busy ? 'Signing in…' : 'Sign in →'}</button>}</main></ComicShell>;
}
