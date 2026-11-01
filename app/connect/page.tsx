import {getMcpAuth} from '@/src/lib/auth/runtime';
import {Consent} from './Consent';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export default async function Connect({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {
  const values=await searchParams,query=new URLSearchParams();
  for(const [key,value] of Object.entries(values))for(const item of Array.isArray(value)?value:value===undefined?[]:[value])query.append(key,item);
  const server=getMcpAuth(),details=await server.describeConsent(query.toString());
  if(!details)return <main className="mx-auto max-w-xl px-5 py-12"><h1 className="font-display text-4xl">Connection expired</h1><p className="mt-4">Start the connection again from your client.</p></main>;
  return <Consent query={query.toString()} details={details}/>;
}
