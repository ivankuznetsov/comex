import sharp from 'sharp';
import {ApplicationError, type Draft} from './application/contracts';
import {renderCaption, type CaptionLine} from './caption';

export async function composePages(draft: Draft, asset: (id:string) => Promise<Buffer>): Promise<{
    id: string;
    image: Buffer;
}[]> {
    if (!draft.storyboard)
        throw new ApplicationError('conflict', 'The storyboard is missing.');
    const grid = draft.pageLayout === 'grid';
    const panelWidth = grid ? 480 : 980;
    const panelHeight = grid ? 260 : 420;
    const orderedSpecs = new Map(draft.storyboard.pages.flatMap(p => p.panels).map(p => [p.id, p]));
    const result: {
        id: string;
        image: Buffer;
    }[] = [];
    for (const page of draft.pages) {
        const sections: {
            image: Buffer;
            caption: {image:Buffer;height:number} | null;
        }[] = [];
        for (const panel of page.panels) {
            const spec = orderedSpecs.get(panel.id);
            if (!panel.assetId || !spec)
                throw new ApplicationError('conflict', 'A page is missing its current panel.');
            const image = await sharp(await asset(panel.assetId)).resize(panelWidth, panelHeight, { fit: 'contain', background: '#fffef8' }).png().toBuffer();
            const dialogue: CaptionLine[] = [];
            for (const entry of spec.dialogue) {
                const name = draft.characters.find(c => c.id === entry.speaker_id)?.name ?? entry.speaker_id;
                dialogue.push({speaker:name,text:entry.text});
            }
            sections.push({ image, caption: await renderCaption(dialogue, panelWidth) });
        }
        const rows = grid ? Array.from({ length: Math.ceil(sections.length / 2) }, (_, i) => sections.slice(i * 2, i * 2 + 2)) : sections.map(section => [section]);
        const height = 20 + rows.reduce((sum, row) => sum + Math.max(...row.map(s => panelHeight + (s.caption?.height ?? 0))) + 20, 0);
        if (height > 12000)
            throw new ApplicationError('invalid_input', 'The page has too much dialogue to compose.');
        const composites: {
            input: Buffer;
            top: number;
            left: number;
        }[] = [];
        let y = 20;
        for (const row of rows) {
            let rowHeight = panelHeight;
            row.forEach((section, column) => {
                const x = grid && row.length === 1 ? (1020 - panelWidth) / 2 : 20 + column * (panelWidth + 20);
                // Ink frame lives entirely in the gutter: not one artwork pixel is covered.
                const framedHeight=panelHeight+(section.caption?.height??0);
                const frame=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth+8}" height="${framedHeight+8}"><rect x="2" y="2" width="${panelWidth+4}" height="${framedHeight+4}" fill="none" stroke="#211d19" stroke-width="4"/></svg>`);
                composites.push({input:frame,top:y-4,left:x-4});
                composites.push({ input: section.image, top: y, left: x });
                if (section.caption) {
                    const h = section.caption.height;
                    composites.push({ input: section.caption.image, top: y + panelHeight, left: x });
                    rowHeight = Math.max(rowHeight, panelHeight + h);
                }
            });
            y += rowHeight + 20;
        }
        const image = await sharp({ create: { width: 1020, height, channels: 4, background: '#fff8e8' } }).composite(composites).png().toBuffer();
        result.push({ id: page.id, image });
    }
    return result;
}
