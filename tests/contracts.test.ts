import { describe, expect, test } from 'bun:test';
import { validateStoryboard } from '../src/lib/contracts';

const makeStory = () => ({
  characters: [{ id: 'mina', referenceRevision: 1, approved: true }],
  panels: [
    { id: 'p1', page: 1, index: 1, characterIds: ['mina'], before: { location: 'station', props: { key: 'mina' } }, after: { location: 'station', props: { key: 'mina' } }, dialogue: [] },
    { id: 'p2', page: 1, index: 2, characterIds: ['mina'], before: { location: 'station', props: { key: 'mina' } }, after: { location: 'station', props: { key: 'pip' } }, dialogue: [{ speakerId: 'mina', text: 'Here.', x: 0.4, y: 0.1 }] },
  ],
});

describe('storyboard contract', () => {
  test('accepts a coherent storyboard with approved references', () => {
    expect(validateStoryboard(makeStory())).toEqual([]);
  });
  test('rejects a missing approved character reference', () => {
    const story = makeStory(); story.characters[0].approved = false;
    expect(validateStoryboard(story).some(e => e.includes('approved reference'))).toBe(true);
  });
  test('rejects contradictory incoming prop ownership and invalid dialogue position', () => {
    const story = makeStory(); story.panels[1].before.props.key = 'pip'; story.panels[1].dialogue[0].x = 1.2;
    const errors = validateStoryboard(story);
    expect(errors.some(e => e.includes('state'))).toBe(true);
    expect(errors.some(e => e.includes('dialogue'))).toBe(true);
  });
  test('rejects a duplicate panel ID and unselected speaker', () => {
    const story = makeStory(); story.panels[1].id = 'p1'; story.panels[1].dialogue[0].speakerId = 'stranger';
    const errors = validateStoryboard(story);
    expect(errors.some(e => e.includes('duplicate'))).toBe(true);
    expect(errors.some(e => e.includes('speaker'))).toBe(true);
  });
});
