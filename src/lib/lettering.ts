/** Preserve all characters while preferring word boundaries in rendered dialogue. */
export function wrapDialogue(text: string, width: number): string[] {
  if (!Number.isInteger(width) || width < 1) throw new Error('Invalid line width');
  const chars = Array.from(text);
  const lines: string[] = [];
  while (chars.length) {
    let end = Math.min(width, chars.length);
    if (end < chars.length && !/\s/u.test(chars[end])) {
      let boundary = end;
      while (boundary > 0 && !/\s/u.test(chars[boundary - 1])) boundary--;
      if (boundary > 0) end = boundary;
    }
    lines.push(chars.splice(0, end).join(''));
  }
  return lines;
}
