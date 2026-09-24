import { h, mount } from './dom.js';

export interface DropzoneCallbacks {
  onFile: (file: File) => void;
  onLoadExample: (path: string) => void;
}

const SIGNAL_SVG = `
  <svg class="tl-signal" viewBox="0 0 600 60" preserveAspectRatio="none" aria-hidden="true">
    <path d="M0 30 L70 30 L90 8 L110 52 L130 30 L200 30 L215 30 L230 15 L245 45 L260 30 L340 30 L360 30 L375 20 L390 40 L405 22 L420 30 L600 30"
      fill="none" stroke="var(--accent-llm)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`;

export function renderDropzone(container: HTMLElement, cb: DropzoneCallbacks): void {
  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    className: 'visually-hidden',
    id: 'tl-file-input',
    onChange: (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) cb.onFile(file);
    },
  }) as HTMLInputElement;

  const card = h(
    'div',
    { className: 'tl-dropzone-card' },
    buildSignalSvg(),
    h('h1', {}, 'Drop a trace to inspect it'),
    h('p', {}, 'OTLP/JSON export from a collector, or a file written by the OpenTelemetry SDK. Nothing leaves this browser tab.'),
    h(
      'label',
      { className: 'tl-btn primary', for: 'tl-file-input', style: 'cursor:pointer' },
      'Choose a trace.json file',
    ),
    fileInput,
    h(
      'div',
      { className: 'tl-dropzone-examples' },
      h('span', { className: 'faint', style: 'align-self:center' }, 'or load a sample:'),
      h('button', { className: 'tl-btn', onClick: () => cb.onLoadExample('examples/genai-semconv-trace.json') }, 'GenAI semconv example'),
      h('button', { className: 'tl-btn', onClick: () => cb.onLoadExample('examples/openinference-trace.json') }, 'OpenInference example'),
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
    const file = e.dataTransfer?.files?.[0];
    if (file) cb.onFile(file);
  });

  mount(container, h('div', { className: 'tl-dropzone' }, card));
}

// SIGNAL_SVG is a static constant, never interpolated with trace data, so
// innerHTML here doesn't reopen the injection risk noted in dom.ts.
function buildSignalSvg(): HTMLElement {
  const wrap = h('div', {});
  wrap.innerHTML = SIGNAL_SVG;
  return wrap.firstElementChild as HTMLElement;
}
