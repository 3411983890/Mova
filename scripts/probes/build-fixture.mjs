import { build } from 'esbuild';

// 只用于本机验证记忆页排版：把组件夹具打成一个可离线打开的包。
await build({
  entryPoints: ['qa/memory-fixture.jsx'],
  bundle: true,
  format: 'iife',
  outfile: 'qa/memory-fixture.js',
  jsx: 'automatic',
  loader: { '.jsx': 'jsx' },
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
});
console.log('fixture built');
