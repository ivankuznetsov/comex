import ComicReader from '../../../components/ComicReader';
export default async function ReaderPage({ params }: { params: Promise<{id:string}> }) { const {id} = await params; return <ComicReader id={id} />; }
