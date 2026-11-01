export type ComicStyle = 'clear-line-adventure' | 'ink-manga' | 'painted-storybook';
export const styles: {id: ComicStyle; name: string; description: string; color: string}[] = [
  {id: 'clear-line-adventure', name: 'Clear-line adventure', description: 'Bold outlines, flat colour, and a sense of adventure.', color: '#1849a9'},
  {id: 'ink-manga', name: 'Ink manga', description: 'Expressive black-and-white ink and crisp silhouettes.', color: '#171717'},
  {id: 'painted-storybook', name: 'Painted storybook', description: 'Soft painted texture, warm colour, and gentle shapes.', color: '#a84d30'},
];
