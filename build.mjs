import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';

await mkdir('dist/note-again', { recursive: true });
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/note-again/main.js',
  bundle: true,
  external: ['obsidian'],
  format: 'cjs',
  platform: 'browser',
  target: 'es2018',
  logLevel: 'warning',
});
for (const file of ['manifest.json', 'styles.css']) {
  await copyFile(file, `dist/note-again/${file}`);
}
console.log('Built dist/note-again (main.js, manifest.json, styles.css).');
