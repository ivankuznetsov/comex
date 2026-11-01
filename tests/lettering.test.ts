import { expect, test } from 'bun:test';
import { wrapDialogue } from '../src/lib/lettering';

test('wraps at word boundaries without losing the original dialogue', () => {
  const original = 'Mina: That latch is too high.';
  const lines = wrapDialogue(original, 25);
  expect(lines.join('')).toBe(original);
  expect(lines).toEqual(['Mina: That latch is too ', 'high.']);
});

test('splits oversized words and preserves Unicode characters', () => {
  const original = 'Pip: 🐦abcdefghijklmnopqrstuvwxyzz';
  const lines = wrapDialogue(original, 10);
  expect(lines.join('')).toBe(original);
  expect(lines.every(line => Array.from(line).length <= 10)).toBe(true);
});
