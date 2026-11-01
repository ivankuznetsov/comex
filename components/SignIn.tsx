'use client';
import {useState, type FormEvent} from 'react';
import {ComicShell, Eyebrow, Message, button, field} from './ComicShell';
import {request,errorMessage} from './api';

export default function SignIn() {
  const [email,setEmail]=useState(''); const [busy,setBusy]=useState(false); const [sent,setSent]=useState(false); const [error,setError]=useState('');
  async function submit(event:FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {await request('/api/auth/request',{method:'POST',body:JSON.stringify({email})}); setSent(true);} catch (err) {setError(errorMessage(err));} finally {setBusy(false);}
  }
  return <ComicShell><main className="mx-auto max-w-[650px] px-4 pt-10 sm:px-6"><Eyebrow>Your creator account</Eyebrow><h1 className="font-display mt-4 text-5xl uppercase">Sign in to Comex</h1><p className="mt-4">We’ll email you a sign-in link that expires in 15 minutes. To save any existing browser drafts to your account, open the link in this same browser.</p>{sent ? <div className="mt-6"><Message>Check your inbox for your sign-in link.</Message></div> : <form onSubmit={submit} className="mt-8 space-y-5"><label className="block font-bold" htmlFor="email">Email address</label><input className={field} id="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} />{error && <Message error>{error}</Message>}<button className={button} disabled={busy} type="submit">{busy ? 'Sending…' : 'Email me a sign-in link →'}</button></form>}</main></ComicShell>;
}
