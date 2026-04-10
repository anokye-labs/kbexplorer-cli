import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Smoke test — verify the module imports and exports correctly
const linksModule = await import('../../src/commands/links.js');

describe('links command', () => {
  it('exports a default function', () => {
    assert.strictEqual(typeof linksModule.default, 'function');
  });
});
