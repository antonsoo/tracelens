import type { PriceEntry } from '../core/index.js';
import { DEFAULT_PRICE_TABLE } from '../core/index.js';
import { h, mount } from './dom.js';

const STORAGE_KEY = 'tracelens.priceTable.v1';

export function loadPriceTable(): PriceEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRICE_TABLE;
    const parsed = JSON.parse(raw) as PriceEntry[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : DEFAULT_PRICE_TABLE;
  } catch {
    return DEFAULT_PRICE_TABLE;
  }
}

function savePriceTable(table: PriceEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(table));
  } catch {
    // localStorage can throw in private-browsing/blocked-storage contexts;
    // the table still works for this session, it just won't persist.
  }
}

function numberInput(value: number | undefined, onInput: (n: number | undefined) => void): HTMLElement {
  return h('input', {
    type: 'text',
    inputmode: 'decimal',
    value: value === undefined ? '' : String(value),
    onInput: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value.trim();
      onInput(raw === '' ? undefined : Number(raw));
    },
  });
}

export function openPriceDialog(table: PriceEntry[], onSave: (table: PriceEntry[]) => void): void {
  let working = table.map((e) => ({ ...e }));

  const dialog = h('dialog', { className: 'tl-dialog' }) as HTMLDialogElement;
  const body = h('div', { className: 'tl-dialog-body' });

  function renderRows(): void {
    const rows = working.map((entry, i) =>
      h(
        'tr',
        {},
        h('td', {}, h('input', { value: entry.matchModel, onInput: (e: Event) => (entry.matchModel = (e.target as HTMLInputElement).value) })),
        h('td', {}, h('input', { value: entry.provider, onInput: (e: Event) => (entry.provider = (e.target as HTMLInputElement).value) })),
        h('td', {}, numberInput(entry.inputPerMTok, (n) => (entry.inputPerMTok = n ?? 0))),
        h('td', {}, numberInput(entry.outputPerMTok, (n) => (entry.outputPerMTok = n ?? 0))),
        h(
          'td',
          {},
          numberInput(entry.cacheReadPerMTok, (n) => {
            if (n === undefined) delete entry.cacheReadPerMTok;
            else entry.cacheReadPerMTok = n;
          }),
        ),
        h('td', { className: 'tl-price-source' }, `${entry.sourceDate}`),
        h(
          'td',
          {},
          h(
            'button',
            {
              className: 'tl-btn',
              'aria-label': `Remove ${entry.matchModel}`,
              onClick: () => {
                working = working.filter((_, j) => j !== i);
                renderRows();
              },
            },
            '✕',
          ),
        ),
      ),
    );

    mount(
      body,
      h(
        'p',
        { className: 'faint', style: 'margin-top:0' },
        'Matched against the response model (or request model) as a case-insensitive substring; the longest match wins. Edits persist to this browser only.',
      ),
      h(
        'table',
        { className: 'tl-price-table' },
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, 'model match'), h('th', {}, 'provider'), h('th', {}, '$/MTok in'), h('th', {}, '$/MTok out'), h('th', {}, '$/MTok cache read'), h('th', {}, 'source date'), h('th', {})),
        ),
        h('tbody', {}, ...rows),
      ),
      h(
        'div',
        { style: 'margin-top:10px;display:flex;gap:8px' },
        h(
          'button',
          {
            className: 'tl-btn',
            onClick: () => {
              working.push({ id: `custom-${Date.now()}`, matchModel: '', provider: '', inputPerMTok: 0, outputPerMTok: 0, sourceUrl: '', sourceDate: new Date().toISOString().slice(0, 10) });
              renderRows();
            },
          },
          '+ Add row',
        ),
        h(
          'button',
          {
            className: 'tl-btn',
            onClick: () => {
              working = DEFAULT_PRICE_TABLE.map((e) => ({ ...e }));
              renderRows();
            },
          },
          'Reset to defaults',
        ),
      ),
    );
  }

  renderRows();

  const header = h(
    'div',
    { className: 'tl-dialog-header' },
    h('h2', {}, 'Price table'),
    h('button', { className: 'tl-btn', 'aria-label': 'Close', onClick: () => dialog.close() }, '✕'),
  );
  const footer = h(
    'div',
    { style: 'display:flex;justify-content:flex-end;gap:8px;padding:10px 16px;border-top:1px solid var(--border)' },
    h('button', { className: 'tl-btn', onClick: () => dialog.close() }, 'Cancel'),
    h(
      'button',
      {
        className: 'tl-btn primary',
        onClick: () => {
          savePriceTable(working);
          onSave(working);
          dialog.close();
        },
      },
      'Save',
    ),
  );

  mount(dialog, header, body, footer);
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
