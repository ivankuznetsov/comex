import {afterEach, describe, expect, test} from 'bun:test';
import {nextConfig as config} from '../next.config';

const original = process.env.COMEX_DEMO_BACKEND_URL;
const originalRuntime = process.env.COMEX_RUNTIME;
afterEach(() => {
  if (original === undefined) delete process.env.COMEX_DEMO_BACKEND_URL;
  else process.env.COMEX_DEMO_BACKEND_URL = original;
  if (originalRuntime === undefined) delete process.env.COMEX_RUNTIME;
  else process.env.COMEX_RUNTIME = originalRuntime;
});

describe('demo backend routing', () => {
  test('does not change local API routing unless configured', async () => {
    delete process.env.COMEX_DEMO_BACKEND_URL;
    expect(await config.rewrites!()).toEqual({beforeFiles: [], afterFiles: [], fallback: []});
  });

  test('routes API requests to the configured tunnel before local routes', async () => {
    process.env.COMEX_DEMO_BACKEND_URL = 'https://example.trycloudflare.com';
    expect(await config.rewrites!()).toEqual({
      beforeFiles: [{source: '/api/:path*', destination: 'https://example.trycloudflare.com/api/:path*'}],
      afterFiles: [], fallback: [],
    });
  });

  test('rejects malformed or non-HTTPS backend URLs', async () => {
    for (const url of ['http://example.com', 'https://user:pass@example.com', 'https://example.com/path']) {
      process.env.COMEX_DEMO_BACKEND_URL = url;
      await expect(Promise.resolve().then(() => config.rewrites!())).rejects.toThrow();
    }
  });

  test('does not route hosted operations through the demo gateway', async () => {
    process.env.COMEX_DEMO_BACKEND_URL = 'https://example.trycloudflare.com';
    process.env.COMEX_RUNTIME = 'hosted';
    await expect(Promise.resolve().then(() => config.rewrites!())).rejects.toThrow();
  });
});
