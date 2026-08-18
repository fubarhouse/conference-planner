import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { REGISTRY } from '../resourceRegistry.js';

// Guards against the hand-maintained API docs silently drifting from the
// registry: every collection the engine actually serves must be documented.
const _dir = dirname(fileURLToPath(import.meta.url));
const apiMd = readFileSync(join(_dir, '../../docs/api.md'), 'utf8');
const openapi = readFileSync(join(_dir, '../../app/openapi.yaml'), 'utf8');

describe('API docs stay in sync with the resource registry', () => {
  it('docs/api.md mentions every registered collection (by key or leaf segment)', () => {
    const missing = REGISTRY.filter((r) => {
      const leaf = r.key.split('/').pop() ?? r.key;
      return !apiMd.includes(r.key) && !apiMd.includes(leaf);
    }).map((r) => `${r.domain}:${r.key}`);
    expect(missing).toEqual([]);
  });

  it('openapi.yaml documents both domains and the nested-collection paths', () => {
    expect(openapi).toContain('/datasets');
    expect(openapi).toContain('/planners');
    expect(openapi).toContain('/sponsors');
    expect(openapi).toContain('{collection}');
  });
});
