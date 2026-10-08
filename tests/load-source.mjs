import {readFile} from 'node:fs/promises';

const MODULES = ['reports.js', 'hudView.js', 'extension.js'];

export async function loadSource() {
    const sources = await Promise.all(MODULES.map(name =>
        readFile(new URL(`../${name}`, import.meta.url), 'utf8')));
    return sources.map(source => source
        .replace(/^import[\s\S]*?;\n/gm, '')
        .replace(/\nexport \{[\s\S]*?\n\};/g, '')
        .replace(/^export default class/gm, 'class')
        .replace(/^export const /gm, 'const ')
        .replace(/^export /gm, '')).join('\n');
}
