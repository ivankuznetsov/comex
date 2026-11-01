/** JSON object key order is not significant and may change in Postgres jsonb. */
export function canonicalJson(value:unknown):string | undefined {
  return JSON.stringify(value,(_key,item)=>{
    if(!item || typeof item!=='object' || Array.isArray(item))return item;
    return Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]]));
  });
}
export function sameJson(left:unknown,right:unknown):boolean {
  return canonicalJson(left)===canonicalJson(right);
}
