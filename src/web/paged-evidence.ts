import { h, mount } from './dom.js';
import { fmtInt } from './format.js';

const pages = new WeakMap<object, Map<string, number>>();

/** Keep only one page in the DOM; store positions against the evidence owner. */
export function pagedEvidence<T>(owner: object, label: string, items: readonly T[], render: (page: readonly T[], start: number) => HTMLElement, pageSize = 50): HTMLElement {
  let state = pages.get(owner);
  if (!state) { state = new Map(); pages.set(owner, state); }
  const shell = h('section', { className: 'tl-evidence-section', 'aria-label': label });
  const draw = (focus?: string): void => {
    const last = Math.max(0, Math.ceil(items.length / pageSize) - 1);
    const page = Math.min(last, state.get(label) ?? 0);
    const start = page * pageSize;
    const change = (next: number, control: string): void => {
      state.set(label, Math.min(last, Math.max(0, next)));
      draw(control);
    };
    const key = (control: string): string => `evidence-${label}-${control}`;
    const controls = h('div', { className: 'tl-evidence-pages' },
      h('span', { role: 'status', tabindex: '-1', 'data-focus-key': key('range') }, `${label}: ${items.length ? `${fmtInt(start + 1)}–${fmtInt(Math.min(start + pageSize, items.length))} of ` : ''}${fmtInt(items.length)}`),
      ...(last ? [
        h('button', { className: 'tl-btn', disabled: page === 0, 'aria-label': `Previous ${label.toLowerCase()}`, 'data-focus-key': key('previous'), onClick: () => change(page - 1, 'previous') }, 'Previous'),
        h('label', {}, 'Page ', h('input', { type: 'number', min: '1', max: String(last + 1), value: String(page + 1), 'aria-label': `${label} page`, 'data-focus-key': key('page'), onChange: (event: Event) => {
          const input = event.target as HTMLInputElement;
          const next = Number(input.value);
          if (Number.isInteger(next) && next >= 1 && next <= last + 1) change(next - 1, 'page');
          else input.value = String(page + 1);
        } }), ` / ${fmtInt(last + 1)}`),
        h('button', { className: 'tl-btn', disabled: page === last, 'aria-label': `Next ${label.toLowerCase()}`, 'data-focus-key': key('next'), onClick: () => change(page + 1, 'next') }, 'Next'),
      ] : []),
    );
    mount(shell, controls, render(items.slice(start, start + pageSize), start));
    if (focus) {
      const target = [...controls.querySelectorAll<HTMLElement>('[data-focus-key]')].find((el) => el.dataset.focusKey === key(focus));
      (target?.hasAttribute('disabled') ? controls.querySelector<HTMLElement>('[role="status"]') : target)?.focus({ preventScroll: true });
    }
  };
  draw();
  return shell;
}
