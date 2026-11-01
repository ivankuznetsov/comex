import ComicEditor from '../../../components/ComicEditor';
export default async function EditorPage({ params }: { params: Promise<{id:string}> }) { const {id} = await params; return <ComicEditor id={id} />; }
