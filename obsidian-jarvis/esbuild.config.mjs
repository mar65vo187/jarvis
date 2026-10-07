import esbuild from 'esbuild';
import process from 'node:process';

const banner = `/*
Jarvis AI fuer Obsidian - lokal (Ollama) + Top-Cloud-Modelle.
Quellcode: https://github.com/mar65vo187/jarvis/tree/main/obsidian-jarvis
*/
`;

const prod = process.argv[2] === 'production';

const ctx = await esbuild.context({
  banner: { js: banner },
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: ['obsidian', 'electron', '@codemirror/*', '@lezer/*'],
  format: 'cjs',
  target: 'es2022',
  logLevel: 'info',
  sourcemap: prod ? false : 'inline',
  treeShaking: true,
  outfile: 'main.js',
  minify: prod,
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
