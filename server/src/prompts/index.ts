import { readFileSync } from 'node:fs';
export const SYSTEM_PROMPT = readFileSync(new URL('./system.md', import.meta.url), 'utf8');
