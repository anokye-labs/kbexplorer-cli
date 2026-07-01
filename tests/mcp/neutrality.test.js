import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', '..', 'src');

/** Collect `import ... from '<spec>'` / bare `import '<spec>'` STATIC specifiers. */
function staticImportSpecifiers(source) {
  const specs = [];
  // Static import forms only. Dynamic `import('x')` (a CallExpression) is
  // deliberately NOT matched — it is the sanctioned lazy SDK-load seam.
  const re = /(?:^|\n)\s*import\b(?:[^;'"\n]*?\bfrom\s*)?['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

const MCP_SDK = /@modelcontextprotocol|StdioServerTransport|server\/mcp|server\/stdio/i;
const ANY_MCP = /modelcontextprotocol|json-?rpc|StdioServerTransport|server\/mcp|server\/stdio/i;

describe('neutrality — the MCP SDK stays out of the static module graph', () => {
  it('no src/mcp module statically imports the MCP SDK (only dynamic import in main)', () => {
    const dir = join(SRC, 'mcp');
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.js')) continue;
      const src = readFileSync(join(dir, entry), 'utf-8');
      for (const spec of staticImportSpecifiers(src)) {
        assert.doesNotMatch(
          spec,
          MCP_SDK,
          `src/mcp/${entry} statically imports the SDK ("${spec}") — it must be dynamic-imported only in index.js main()`
        );
      }
    }
  });

  it('src/mcp/index.js loads the SDK via dynamic import()', () => {
    const src = readFileSync(join(SRC, 'mcp', 'index.js'), 'utf-8');
    assert.match(src, /import\(\s*['"]@modelcontextprotocol/, 'main() must dynamic-import the SDK');
  });
});

describe('neutrality — the affordance contract imports no MCP', () => {
  it('src/affordances/** never imports any MCP/transport (the arrow is affordances → adapters)', () => {
    const dir = join(SRC, 'affordances');
    /** @param {string} d */
    const walk = (d) => {
      for (const entry of readdirSync(d, { withFileTypes: true })) {
        const full = join(d, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith('.js')) continue;
        const src = readFileSync(full, 'utf-8');
        // Catch both static AND dynamic imports here: the contract must never
        // reach for a transport by any means.
        const re =
          /(?:^|\n)\s*(?:import\b[^\n]*?from\s*|import\s*\(|(?:const|let|var)\s+[^\n=]*=\s*require\()\s*['"]([^'"]+)['"]/g;
        let m;
        while ((m = re.exec(src)) !== null) {
          assert.doesNotMatch(m[1], ANY_MCP, `${full} imports a transport: ${m[1]}`);
        }
      }
    };
    walk(dir);
  });
});
