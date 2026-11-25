import { h, mount } from './dom.js';

export interface DropzoneCallbacks {
  onFiles: (files: File[]) => void;
  onLoadExample: (path: string) => void;
  onCompareExample: () => void;
  onTimingExample: () => void;
}

const SIGNAL_SVG = `
  <svg class="tl-signal" viewBox="0 0 600 60" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 30 L70 30 L90 8 L110 52 L130 30 L200 30 L215 30 L230 15 L245 45 L260 30 L340 30 L360 30 L375 20 L390 40 L405 22 L420 30 L600 30"
      pathLength="1" fill="none" stroke="var(--accent-llm)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

export function renderDropzone(container: HTMLElement, cb: DropzoneCallbacks): void {
  const fileInput = h('input', {
    type: 'file',
    multiple: true,
    accept: '.json,.jsonl,.ndjson,.pb,.otlp,.zst,application/json,application/x-protobuf',
    className: 'visually-hidden',
    id: 'tl-file-input',
    tabindex: '-1',
    'aria-label': 'Trace file',
    onChange: (e: Event) => {
      const files = Array.from((e.target as HTMLInputElement).files ?? []);
      if (files.length) cb.onFiles(files);
    },
  }) as HTMLInputElement;

  const card = h(
    'div',
    { className: 'tl-dropzone-card' },
    buildSignalSvg(),
    h('h1', {}, 'Drop trace files to inspect them together'),
    h('p', {}, 'OTLP/JSON or Jaeger JSON, native OTLP protobuf (.traces.pb / .logs.pb), and Collector files (.traces.otlp / .logs.otlp). Zstandard .zst compression is supported. Nothing leaves this browser tab.'),
    h(
      'button',
      { className: 'tl-btn primary', 'data-focus-key': 'choose-file', onClick: () => fileInput.click() },
      'Choose trace files',
    ),
    fileInput,
    h('p', { className: 'faint' }, 'Select up to 32 related trace and log exports, 25 MB total. Parents, links and recorded log messages resolve across files; each span identity must occur once.'),
    h(
      'div',
      { className: 'tl-dropzone-examples' },
      h('p', { className: 'tl-samples-lead' }, 'Or open a sample'),
      sampleGroup('One trace in each supported convention', [
        sample('example-genai', 'GenAI semconv example', '', () => cb.onLoadExample('examples/genai-semconv-trace.json')),
        sample('example-openinference', 'OpenInference example', '', () => cb.onLoadExample('examples/openinference-trace.json')),
        sample('example-jaeger', 'Jaeger JSON example', '', () => cb.onLoadExample('examples/jaeger-genai-trace.json')),
      ]),
      sampleGroup('Investigations to follow', [
        sample('example-compare', 'Compare two runs', 'synthetic', cb.onCompareExample),
        sample('example-timing', 'Parallel vs sequential', 'local capture', cb.onTimingExample),
        sample('example-cost', 'Inspect token cost', 'recorded SDK replay', () => cb.onLoadExample('examples/cost-nano-stream.json')),
        sample('example-links', 'Follow queued jobs', 'local SDK capture', () => cb.onLoadExample('examples/queue-links.json')),
        sample('example-logs', 'Inspect messages from logs', 'local SDK capture', () => cb.onLoadExample('examples/genai-log-events.jsonl')),
        sample('example-zstd', 'Collector Zstandard', '5,001-span local SDK capture', () => cb.onLoadExample('examples/collector-digest.traces.otlp.zst')),
      ]),
    ),
  );

  card.addEventListener('dragover', (e) => {
    e.preventDefault();
    card.classList.add('drag-over');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
  card.addEventListener('drop', (e) => {
    e.preventDefault();
    card.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer?.files ?? []);
    if (files.length) cb.onFiles(files);
  });

  mount(container, h('div', { className: 'tl-dropzone' }, card));
}

// The provenance stays inside the button so its accessible name reads
// "Inspect token cost (recorded SDK replay)": where a sample came from is part
// of what the reader is choosing.
function sample(focusKey: string, name: string, provenance: string, onClick: () => void): HTMLElement {
  return h(
    'li',
    {},
    h(
      'button',
      { className: 'tl-sample', 'data-focus-key': focusKey, onClick },
      h('span', { className: 'tl-sample-name' }, name),
      provenance ? ' ' : null,
      provenance ? h('span', { className: 'tl-sample-provenance' }, `(${provenance})`) : null,
    ),
  );
}

function sampleGroup(title: string, items: HTMLElement[]): HTMLElement {
  return h('section', { className: 'tl-sample-group' }, h('h2', {}, title), h('ul', {}, ...items));
}

// SIGNAL_SVG is a static constant, never interpolated with trace data, so
// innerHTML here doesn't reopen the injection risk noted in dom.ts.
function buildSignalSvg(): HTMLElement {
  const wrap = h('div', {});
  wrap.innerHTML = SIGNAL_SVG;
  return wrap.firstElementChild as HTMLElement;
}
