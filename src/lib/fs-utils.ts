import { resolve, extname } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';

export function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  const stack: string[] = [dir];
  while (stack.length) {
    const current = stack.pop();
    if (!current) continue;
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
