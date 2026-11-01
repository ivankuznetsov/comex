/** Versioned continuity contracts shared by planning and generation. */
export type CharacterReference = {
  id: string;
  referenceRevision: number;
  approved: boolean;
};

export type SceneState = {
  location: string;
  props: Record<string, string>;
};

export type Dialogue = {
  speakerId: string;
  text: string;
  x: number;
  y: number;
};

export type PanelBeat = {
  id: string;
  page: number;
  index: number;
  characterIds: string[];
  before: SceneState;
  after: SceneState;
  dialogue: Dialogue[];
};

export type Storyboard = { characters: CharacterReference[]; panels: PanelBeat[] };

export type Finding = {
  severity: 'blocker' | 'warning' | 'uncertain';
  dimension: 'identity' | 'style' | 'story' | 'continuity' | 'lettering';
  panelId: string;
  characterId: string | null;
  referenceId: string | null;
  expected: string;
  observed: string;
  correction: string | null;
};

/** Checks deterministic constraints; a successful result does not certify narrative quality. */
export function validateStoryboard(story: Storyboard): string[] {
  const errors: string[] = [];
  const characters = new Map<string, CharacterReference>();
  for (const character of story.characters) {
    if (!character.id || characters.has(character.id)) errors.push('duplicate or empty character ID');
    characters.set(character.id, character);
  }
  const ids = new Set<string>();
  let previous: PanelBeat | undefined;
  for (const panel of story.panels) {
    if (!panel.id || ids.has(panel.id)) errors.push(`duplicate or empty panel ID: ${panel.id}`);
    ids.add(panel.id);
    if (!Number.isInteger(panel.page) || !Number.isInteger(panel.index) || panel.page < 1 || panel.index < 1 ||
        (!previous && (panel.page !== 1 || panel.index !== 1)) ||
        (previous && !((panel.page === previous.page && panel.index === previous.index + 1) ||
          (panel.page === previous.page + 1 && panel.index === 1)))) errors.push(`invalid panel ordering: ${panel.id}`);
    for (const id of panel.characterIds) {
      const character = characters.get(id);
      if (!character || !character.approved || !Number.isInteger(character.referenceRevision) || character.referenceRevision < 1) {
        errors.push(`missing approved reference for character ${id}`);
      }
    }
    if (previous) {
      const a = previous.after.props, b = panel.before.props;
      if (previous.after.location !== panel.before.location || Object.keys(a).length !== Object.keys(b).length ||
          Object.keys(a).some(key => a[key] !== b[key])) errors.push(`inconsistent incoming state: ${panel.id}`);
    }
    for (const dialogue of panel.dialogue) {
      if (!panel.characterIds.includes(dialogue.speakerId)) errors.push(`unselected dialogue speaker: ${panel.id}`);
      if (!dialogue.text.trim() || dialogue.text.length > 160 || !Number.isFinite(dialogue.x) || !Number.isFinite(dialogue.y) ||
          dialogue.x < 0 || dialogue.x > 1 || dialogue.y < 0 || dialogue.y > 1) errors.push(`invalid dialogue: ${panel.id}`);
    }
    previous = panel;
  }
  if (!story.panels.length) errors.push('storyboard has no panels');
  return errors;
}
