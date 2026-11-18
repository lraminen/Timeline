import { describe, it, expect } from 'vitest';
import { loadConfig } from '../config.js';

describe('loadConfig', () => {
  it('has safe development defaults', () => {
    const c = loadConfig({});
    expect(c.isProduction).toBe(false);
    expect(c.publicUrl).toBe('http://127.0.0.1:3000');
    expect(c.EMBED_ORIGINS).toEqual(['*']);
    expect(c.CORS_ORIGINS).toEqual([]);
  });

  it('refuses to start in production without a strong secret and public URL', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/JWT_SECRET[\s\S]*PUBLIC_URL/);
    expect(() =>
      loadConfig({ NODE_ENV: 'production', JWT_SECRET: 'short', PUBLIC_URL: 'https://x.example' }),
    ).toThrow(/JWT_SECRET/);
    const ok = loadConfig({
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(48),
      PUBLIC_URL: 'https://timelines.example/',
      CORS_ORIGINS: 'https://editor.example, https://admin.example',
    });
    expect(ok.publicUrl).toBe('https://timelines.example');
    expect(ok.CORS_ORIGINS).toEqual(['https://editor.example', 'https://admin.example']);
  });

  it('requires a bucket for S3 storage', () => {
    expect(() => loadConfig({ STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
  });
});
