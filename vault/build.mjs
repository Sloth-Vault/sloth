import { build } from 'esbuild';

await build({
  entryPoints: ['app.js'],
  outfile: '../site/app/app.js',
  bundle: true,
  minify: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2021',
  inject: ['shim.js'],
  define: { global: 'globalThis', 'process.env.NODE_ENV': '"production"' },
});
