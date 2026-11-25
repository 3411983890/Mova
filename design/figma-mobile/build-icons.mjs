import { writeFile } from 'node:fs/promises';

const names = ['panel-left', 'square-pen', 'ellipsis', 'plus', 'mic', 'audio-lines', 'copy', 'thumbs-up', 'volume-2', 'share', 'chevron-down', 'chevron-right', 'search', 'library', 'brain', 'code', 'bot', 'sparkles', 'arrow-up'];
const icons = {};
for (const name of names) {
  const imported = await import(`../../node_modules/deep-agent-lucide/dist/esm/icons/${name}.mjs`);
  const __iconData = imported.__iconData ?? imported.default?.__iconData;
  icons[name] = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#F5F5F7" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${__iconData.node.map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).filter(([key]) => key !== 'key').map(([key, value]) => `${key}="${value}"`).join(' ')}/>`).join('')}</svg>`;
}
await writeFile(new URL('./icons.json', import.meta.url), JSON.stringify(icons));
