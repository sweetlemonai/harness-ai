import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: false,
  shims: false,
  splitting: false,
  minify: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
