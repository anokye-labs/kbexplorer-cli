import { resolve, extname } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export function listMarkdownFiles(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        out.push(full);
      }
    }
  }
  return out;
}
