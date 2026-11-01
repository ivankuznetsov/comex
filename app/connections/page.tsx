'use client';
import {useEffect,useState} from 'react';
import {ImportHandoff} from './ImportHandoff';
type Connection={id:string;name:string;createdAt:number};
export default function Connections() {
  const [items,setItems]=useState<Connection[]|null>(null),[error,setError]=useState('');
  useEffect(()=>{fetch('/api/mcp-auth/comex/connections').then(async r=>{if(!r.ok)throw new Error();setItems((await r.json()).connections);}).catch(()=>setError('Could not load your connections.'));},[]);
  async function revoke(id:string) {setError('');try{const r=await fetch('/api/mcp-auth/comex/connections',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});if(!r.ok)throw new Error();setItems(current=>current?.filter(item=>item.id!==id)??[]);}catch{setError('Could not disconnect this client.');}}
  return <main className="mx-auto max-w-xl px-5 py-12"><h1 className="font-display text-4xl uppercase">Connections</h1><p className="mt-4">Disconnecting a client leaves your drafts and other connections intact.</p>{error&&<p role="alert" className="mt-4">{error}</p>}{items===null?<p className="mt-6">Loading…</p>:items.length===0?<p className="mt-6">No connected clients in this workspace.</p>:<ul className="mt-6 divide-y divide-black">{items.map(item=><li key={item.id} className="flex flex-wrap items-center justify-between gap-3 py-4"><span><strong>{item.name}</strong><br/><small>Connected {new Date(Number(item.createdAt)).toLocaleDateString()}</small></span><button type="button" onClick={()=>revoke(item.id)} className="border-2 border-black px-4 py-2 font-bold">Disconnect</button></li>)}</ul>}<ImportHandoff/><a href="/drafts" className="mt-8 inline-block underline">Back to drafts</a></main>;
}
