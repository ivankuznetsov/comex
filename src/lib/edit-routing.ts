export const EDIT_INTENTS = ['cosmetic','restore','story','clarify'] as const;
export type EditIntent = typeof EDIT_INTENTS[number];
export type EditSnapshot = {draftRevision:number;storyRevision:number;panelRevision:number;assetId:string};
export type EditHandoff = {intent:'story'|'clarify';reason:string;question:string|null;panelId:string;instruction:string;snapshot:EditSnapshot};
