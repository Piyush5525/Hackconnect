// Builds the browser bundle (Yjs + Monaco + bindings) and Monaco's web workers into vendor/.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('..', import.meta.url)); const out = join(root, 'vendor');
rmSync(out, { recursive: true, force: true });
const common = { bundle: true, minify: true, logLevel: 'warning', absWorkingDir: root, define: { 'process.env.NODE_ENV': '"production"' } };
await build({ ...common, entryPoints: ['src/collab-client.js'], format: 'iife', globalName: 'HCCollab', outdir: 'vendor', publicPath: '/vendor', assetNames: 'assets/[name]-[hash]', loader: { '.ttf': 'file' }, alias: { 'monaco-editor/esm/vs/editor/editor.api.js': join(root, 'node_modules/monaco-editor/esm/vs/editor/editor.api.js') } });
const w = 'node_modules/monaco-editor/esm/vs';
await build({ ...common, entryPoints: { 'editor.worker': `${w}/editor/editor.worker.js`, 'json.worker': `${w}/language/json/json.worker.js`, 'css.worker': `${w}/language/css/css.worker.js`, 'html.worker': `${w}/language/html/html.worker.js`, 'ts.worker': `${w}/language/typescript/ts.worker.js` }, format: 'iife', outdir: 'vendor/monaco' });
console.log('client built');
