export type ComicStyle = 'clear-line-adventure' | 'ink-manga' | 'painted-storybook';
export const styles: {id: ComicStyle; name: string; description: string; image: string}[] = [
  {id: 'clear-line-adventure', name: 'Clear-line adventure', description: 'Bold outlines, flat colour, and a sense of adventure.', image: '/styles/clear-line-adventure.webp'},
  {id: 'ink-manga', name: 'Ink manga', description: 'Expressive black-and-white ink and crisp silhouettes.', image: '/styles/ink-manga.webp'},
  {id: 'painted-storybook', name: 'Painted storybook', description: 'Soft painted texture, warm colour, and gentle shapes.', image: '/styles/painted-storybook.webp'},
];
export type PublicComic = { id: string; title: string; creator: string; pageCount: number; coverUrl?: string | null };
export type PublicEdition = { id: string; title: string; creator: string; editionId: string; pages: {id: string; imageUrl: string}[] };
export type Character = {id: string; name: string; role: string; appearance: string; outfit: string; referenceUrl?: string | null; referenceVersion?: string | null; referenceStatus?: 'ready' | 'missing' | 'running' | 'unknown_outcome'; approved: boolean; lockedByStory?:boolean};
export type CharacterSuggestion = {id:string; name:string; role:string; appearance:string; outfit:string};
export type Question = {id: string; question: string; suggestedAnswer?: string};
export type ReviewFinding = {severity: string; dimension: string; expected: string; observed: string};
export type Panel = {id: string; imageUrl?: string | null; reviewVersion?: {assetId:string; storyRevision:number; panelRevision:number} | null; description?: string; status?: string; evaluation?: 'pending' | 'pass' | 'warning' | 'uncertain' | 'blocker'; reviewOutcome?: 'pass' | 'findings' | 'inconclusive' | 'failed' | null; findings?: ReviewFinding[]; ready?: boolean; reviewed?: boolean; accepted?: boolean};
export type Page = {id: string; index: number; status: string; panels: Panel[]};
export type DraftComic = {id: string; revision:number; title: string; plot: string; style: ComicStyle; pages: Page[]; activePageJob?: {id:string;pageId:string;state:'running'|'unknown';message:string|null}|null; pendingRevision?: import('./RevisionPreview').RevisionProposal | null; panelsPerPage?: number; pageLayout?: 'stack' | 'grid'; characters?: Character[]; characterSuggestions?: CharacterSuggestion[]; initialSuggestions?: 'idle' | 'pending' | 'running' | 'complete' | 'failed' | 'unknown'; questions?: Question[]; initialQuestions?: 'pending' | 'running' | 'complete' | 'failed' | 'unknown'; answers?: Record<string,string>; storyReview?: {outcome:string; findings:ReviewFinding[]; fingerprint:string | null; accepted:boolean}; published?: boolean; publication?: {title:string; creator:string} | null; unpublishedChanges?: boolean};
