import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// Le a versao do package.json da RAIZ do monorepo — um numero so, usado em
// todo lugar (nunca duplicar isso manualmente em outro arquivo).
const rootPkgPath = fileURLToPath(new URL('../package.json', import.meta.url));
const appVersion = JSON.parse(readFileSync(rootPkgPath, 'utf-8')).version as string;

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
