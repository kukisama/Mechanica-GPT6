import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    target: 'es2022',
    // The 3D engine is deliberately bundled into one offline HTML file.
    chunkSizeWarningLimit: 1000,
  },
});