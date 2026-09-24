// The web app's "load a sample trace" buttons fetch these at runtime, so
// they need to live under public/ where Vite serves them verbatim. Keeping
// one committed copy in examples/ (the documented, pip/uv-runnable source)
// and copying it here avoids two files drifting out of sync.
import { copyFileSync, mkdirSync } from 'node:fs';

const files = ['genai-semconv-trace.json', 'openinference-trace.json'];
mkdirSync(new URL('../public/examples/', import.meta.url), { recursive: true });
for (const f of files) {
  copyFileSync(new URL(`../examples/${f}`, import.meta.url), new URL(`../public/examples/${f}`, import.meta.url));
}
console.log(`synced ${files.length} example traces into public/examples/`);
