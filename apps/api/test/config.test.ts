import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
describe('deployment configuration', () => {
  const env = { DATABASE_URL: 'postgres://local/test', MEDIA_OWNER_TOKEN: 'a'.repeat(32) };
  it('requires explicit database and owner authentication without reflecting secrets', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL');
    expect(() => loadConfig({ ...env, MEDIA_OWNER_TOKEN: 'secret' })).toThrow('MEDIA_OWNER_TOKEN');
    expect(loadConfig(env).MEDIA_PORT).toBe(4000);
  });
  it('accepts HTTPS origin and rejects insecure or ambiguous deployment addresses', () => {
    expect(
      loadConfig({ ...env, MEDIA_PUBLIC_URL: 'https://media.example/' }).MEDIA_PUBLIC_URL,
    ).toBe('https://media.example');
    for (const url of [
      'http://example.com',
      'https://example.com/path',
      'https://user:password@example.com',
      'https://example.com?x=1',
    ])
      expect(() => loadConfig({ ...env, MEDIA_PUBLIC_URL: url })).toThrow();
  });
  it('validates source registry and per-site credential paths without reflecting values', () => {
    const auth = { instagram: { cookiesPath: '/cookies/instagram.txt' } };
    const sites = [{ id: 'example', hosts: ['video.example.com'], extractors: ['Example'] }];
    const config = loadConfig({
      ...env,
      YT_DLP_AUTH_JSON: JSON.stringify(auth),
      YT_DLP_SITES_JSON: JSON.stringify(sites),
    });
    expect(config.YT_DLP_AUTH_JSON).toEqual(auth);
    expect(config.YT_DLP_SITES_JSON).toEqual(sites);
    for (const value of ['private-invalid-json', '{"instagram":{"token":"private-token"}}']) {
      expect(() => loadConfig({ ...env, YT_DLP_AUTH_JSON: value })).toThrow(
        'Invalid server configuration: YT_DLP_AUTH_JSON',
      );
      expect(() => loadConfig({ ...env, YT_DLP_AUTH_JSON: value })).not.toThrow('private-');
    }
    expect(() =>
      loadConfig({ ...env, YT_DLP_SITES_JSON: '[{"id":"example","hosts":["example.com"]}]' }),
    ).toThrow('YT_DLP_SITES_JSON');
  });
});
