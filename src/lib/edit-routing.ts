export type EditIntent = 'cosmetic' | 'restore' | 'story' | 'clarify';
export type EditSnapshot = {draftRevision:number;storyRevision:number;panelRevision:number;assetId:string};
export type EditHandoff = {intent:'story'|'clarify';reason:string;question:string|null;panelId:string;instruction:string;snapshot:EditSnapshot};
