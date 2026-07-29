import { register } from 'node:module';

// Loaded via `node --import` so the hook is in place before anything else runs.
register('./ts-resolve-hook.mjs', import.meta.url);
