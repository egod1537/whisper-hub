import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('static brand assets', () => {
  it('links an original SVG favicon and keeps the product title', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
    const favicon = fs.readFileSync(path.join(root, 'public/favicon.svg'), 'utf8');
    expect(html).toContain('<link rel="icon" href="/favicon.svg" type="image/svg+xml" />');
    expect(html).toContain('<title>Whisper Hub</title>');
    expect(html).not.toContain('/favicon.ico');
    expect(favicon).toContain('<svg');
    expect(favicon).toContain('viewBox="0 0 32 32"');
  });

  it('marks only the dedicated web proxy route and strips that marker from ordinary API proxying', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const nginx = fs.readFileSync(path.join(root, 'nginx.conf'), 'utf8');
    expect(nginx).toMatch(/location \/web-api\/ \{[\s\S]*X-Whisper-Hub-Web-Token "\$\{WEB_PROXY_TOKEN\}"/);
    expect(nginx).toMatch(/location \/api\/ \{[\s\S]*X-Whisper-Hub-Web-Token ""/);
  });

  it('re-resolves the API container after backend-only deployments', () => {
    const root = path.resolve(import.meta.dirname, '../..');
    const nginx = fs.readFileSync(path.join(root, 'nginx.conf'), 'utf8');
    expect(nginx).toContain('resolver 127.0.0.11 valid=10s ipv6=off;');
    expect(nginx).toMatch(/upstream api_backend \{[\s\S]*server api:3000 resolve;/);
    expect(nginx.match(/proxy_pass http:\/\/api_backend;/g)).toHaveLength(3);
  });
});
