import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { PolyfillOptions, nodePolyfills } from 'vite-plugin-node-polyfills';

// Unfortunate, but needed due to https://github.com/davidmyersdev/vite-plugin-node-polyfills/issues/81
// Suspected to be because of the yarn workspace setup, but not sure
const nodePolyfillsFix = (options?: PolyfillOptions | undefined) => {
  return {
    ...nodePolyfills(options),
    resolveId(source: string) {
      const m = /^vite-plugin-node-polyfills\/shims\/(buffer|global|process)$/.exec(source);
      if (m) {
        return `./node_modules/vite-plugin-node-polyfills/shims/${m[1]}/dist/index.cjs`;
      }
    },
  };
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    define: {
      'process.env': JSON.stringify({}),
    },
    plugins: [
      react(),
      nodePolyfillsFix({ 
        include: ['buffer', 'path', 'util', 'process', 'assert'],
        globals: {
          process: true,
          Buffer: true,
          assert: true
        }
      })
    ],
    server: {
      headers: {
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
      }
    }
  };
});
