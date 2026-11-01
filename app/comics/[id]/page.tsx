import ComicEditor from '../../../components/ComicEditor';
export const dynamic='force-dynamic';
export default async function EditorPage({ params }: { params: Promise<{id:string}> }) { const {id} = await params; return <ComicEditor id={id} hosted={process.env.COMEX_RUNTIME === 'hosted'} />; }
