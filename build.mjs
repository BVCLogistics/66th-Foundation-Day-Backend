import { build } from 'esbuild';
await build({
  entryPoints: ['index.mjs'],
  outfile: 'dist/server/index.js',
  loader: { '.html': 'text' },
  target: 'es2022',
  platform: 'browser',
  format: 'esm',
  bundle: true,
  minify: true
});
