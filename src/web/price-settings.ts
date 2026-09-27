import type { PriceEntry } from '../core/index.js';
import { DEFAULT_PRICE_TABLE, isPriceEntry } from '../core/index.js';
import { h, mount } from './dom.js';

const STORAGE_KEY = 'tracelens.priceTable.v1';

export function loadPriceTable(): PriceEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PRICE_TABLE;
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(isPriceEntry) ? parsed : DEFAULT_PRICE_TABLE;
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

function numberInput(label: string, value: number | undefined, onInput: (n: number | undefined) => void): HTMLElement {
  return h('input', {
    'aria-label': label,
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
  const error = h('p', { role: 'alert', className: 'tl-load-error', hidden: true });
  body.addEventListener('input', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLTableRowElement>('tr[data-price-index]');
    if (!row) return;
    const entry = working[Number(row.dataset.priceIndex)]!;
    // An edited rate no longer has the vendor citation's provenance.
    entry.sourceUrl = '';
    entry.sourceDate = new Date().toISOString().slice(0, 10);
    row.querySelector('.tl-price-source')!.textContent = `${entry.sourceDate} (edited)`;
  });

  function renderRows(): void {
    const rows = working.map((entry, i) =>
      h(
        'tr',
        { 'data-price-index': i },
        h('td', {}, h('input', { 'aria-label': `Row ${i + 1} model match`, value: entry.matchModel, onInput: (e: Event) => (entry.matchModel = (e.target as HTMLInputElement).value) })),
        h('td', {}, h('input', { 'aria-label': `Row ${i + 1} provider`, value: entry.provider, onInput: (e: Event) => (entry.provider = (e.target as HTMLInputElement).value) })),
        h('td', {}, numberInput(`Row ${i + 1} input rate`, entry.inputPerMTok, (n) => (entry.inputPerMTok = n ?? NaN))),
        h('td', {}, numberInput(`Row ${i + 1} output rate`, entry.outputPerMTok, (n) => (entry.outputPerMTok = n ?? NaN))),
        h(
          'td',
          {},
          numberInput(`Row ${i + 1} cache read rate`, entry.cacheReadPerMTok, (n) => {
            if (n === undefined) delete entry.cacheReadPerMTok;
            else entry.cacheReadPerMTok = n;
          }),
        ),
        h('td', {}, numberInput(`Row ${i + 1} cache write rate`, entry.cacheWritePerMTok, (n) => {
          if (n === undefined) delete entry.cacheWritePerMTok;
          else entry.cacheWritePerMTok = n;
        })),
        h('td', { className: 'tl-price-source' }, `${entry.sourceDate}${entry.sourceUrl ? '' : ' (edited)'}`),
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
        'Matched against the response model (or request model) as a case-insensitive substring; the longest match wins. Rates must be nonnegative numbers. Blank cache rates use the input rate. Edits persist to this browser only when storage is available.',
      ),
      h(
        'table',
        { className: 'tl-price-table' },
        h(
          'thead',
          {},
          h('tr', {}, h('th', {}, 'model match'), h('th', {}, 'provider'), h('th', {}, '$/MTok in'), h('th', {}, '$/MTok out'), h('th', {}, '$/MTok cache read'), h('th', {}, '$/MTok cache write'), h('th', {}, 'source date'), h('th', {})),
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
          const invalidIndex = working.findIndex((entry) => !isPriceEntry(entry));
          if (invalidIndex !== -1) {
            error.textContent = working[invalidIndex]!.matchModel.trim() === ''
              ? `Row ${invalidIndex + 1}: enter a model match. A blank name would match every model.`
              : `Row ${invalidIndex + 1}: input/output rates must be finite, nonnegative numbers. Cache rates may be blank.`;
            error.hidden = false;
            body.querySelectorAll('tbody tr')[invalidIndex]?.scrollIntoView({ block: 'center' });
            return;
          }
          working = working.map((entry) => ({ ...entry, matchModel: entry.matchModel.trim() }));
          savePriceTable(working);
          onSave(working);
          dialog.close();
        },
      },
      'Save',
    ),
  );

  mount(dialog, header, body, error, footer);
  document.body.appendChild(dialog);
  dialog.addEventListener('close', () => dialog.remove());
  dialog.showModal();
}
