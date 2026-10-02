// Compiles the TypeScript sources the Node tests need into CommonJS under node_modules/.homehoard-test-*/,
// keeping the folder layout so relative imports work. expo-crypto becomes node:crypto.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(new URL('../..', import.meta.url).pathname);

export function compileSources() {
  const out = mkdtempSync(path.join(ROOT, 'node_modules', '.homehoard-test-'));
  const files = [
    ...readdirSync(path.join(ROOT, 'src/db')).filter((f) => f.endsWith('.ts')).map((f) => `src/db/${f}`),
    'src/features/maintenanceCore.ts',
  ].filter((f) => !f.endsWith('/sqlite.ts') && !f.endsWith('/index.ts') && !f.endsWith('/index.web.ts'));
  for (const rel of files) {
    let source = readFileSync(path.join(ROOT, rel), 'utf8');
    source = source.replace("'expo-crypto'", "'node:crypto'");
    const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
    const dest = path.join(out, rel.replace(/\.ts$/, '.js'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, js);
  }
  const require = createRequire(import.meta.url);
  return {
    load: (rel) => require(path.join(out, rel)),
    cleanup: () => {
      if (path.resolve(out).startsWith(path.resolve(ROOT, 'node_modules') + path.sep)) rmSync(out, { recursive: true, force: true });
    },
  };
}

export const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
