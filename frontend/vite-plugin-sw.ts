import { build, type Plugin } from 'vite';
import path from 'node:path';

const SW_FILE = 'clipnest-sw.js';

/**
 * Bundles `src/sw/clipnest-sw.ts` into ONE classic script (an IIFE, no `import`):
 * Firefox does not run module service workers. Dev serves it fresh on every request;
 * a build emits it at the dist root, where `/clipnest-sw.js` is registered from.
 */
async function bundleWorker(root: string): Promise<string> {
  const out = await build({
    configFile: false,
    root,
    logLevel: 'warn',
    build: {
      write: false,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      lib: { entry: path.resolve(root, 'src/sw/clipnest-sw.ts'), formats: ['iife'], name: 'ClipnestSW', fileName: () => SW_FILE },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  for (const o of outputs) {
    if (!('output' in o)) continue;
    for (const chunk of o.output) if (chunk.type === 'chunk') return chunk.code;
  }
  throw new Error('clipnest-sw: bundle produced no chunk');
}

export function swBundle(): Plugin {
  let root = process.cwd();
  return {
    name: 'clipnest-sw-bundle',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if ((req.url ?? '').split('?')[0] !== `/${SW_FILE}`) return next();
        bundleWorker(root).then((code) => {
          res.setHeader('Content-Type', 'text/javascript');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(code);
        }, next);
      });
    },
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: SW_FILE, source: await bundleWorker(root) });
    },
  };
}
