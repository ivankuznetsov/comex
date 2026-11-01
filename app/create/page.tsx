import StorySetup from '../../components/StorySetup';
export const dynamic='force-dynamic';
export default function CreatePage() { return <StorySetup hosted={process.env.COMEX_RUNTIME === 'hosted'} />; }
