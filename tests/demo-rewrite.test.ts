import {afterEach, describe, expect, test} from 'bun:test';
import config from '../next.config';

const original = process.env.COMEX_DEMO_BACKEND_URL;
afterEach(() => {
  if (original === undefined) delete process.env.COMEX_DEMO_BACKEND_URL;
  else process.env.COMEX_DEMO_BACKEND_URL = original;
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
});
