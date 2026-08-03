import { el } from '../ui.js';
import { icon } from '../icons.js';

/**
 * A reorderable list for a modal. `items` = [{ id, label, sub? }]. Each row has
 * a grab handle (pointer drag — works with mouse AND touch) and up/down arrows,
 * so it's slick on desktop and dependable on a phone. Reordering happens in the
 * DOM; `getOrder()` reads the current order back as an array of ids (as passed
 * in — number ids stay numbers).
 */
export function sortableList(items) {
  const list = el('div', { class: 'space-y-1.5 select-none' });
  const idType = new Map(items.map((it) => [String(it.id), it.id]));

  // grey out the up arrow on the first row and the down arrow on the last
  const refreshArrows = () => {
    const rows = [...list.children];
    rows.forEach((r, i) => {
      r._up.classList.toggle('opacity-30', i === 0);
      r._up.classList.toggle('pointer-events-none', i === 0);
      r._down.classList.toggle('opacity-30', i === rows.length - 1);
      r._down.classList.toggle('pointer-events-none', i === rows.length - 1);
    });
  };

  const makeRow = (it) => {
    const up = el('button', {
      class: 'icon-btn !w-8 !h-8 text-stone-500', title: 'Move up',
      onclick: () => { const p = row.previousElementSibling; if (p) { list.insertBefore(row, p); refreshArrows(); } },
    }, icon('chevronUp', 'w-4 h-4'));
    const down = el('button', {
      class: 'icon-btn !w-8 !h-8 text-stone-500', title: 'Move down',
      onclick: () => { const n = row.nextElementSibling; if (n) { list.insertBefore(n, row); refreshArrows(); } },
    }, icon('chevronDown', 'w-4 h-4'));
    // touch-none: the handle owns the gesture so a drag doesn't scroll the modal
    const handle = el('button', {
      class: 'icon-btn !w-9 !h-9 shrink-0 cursor-grab touch-none text-stone-400', title: 'Drag to reorder',
    }, icon('grip', 'w-5 h-5'));

    const row = el('div', {
      class: 'flex items-center gap-1 rounded-xl border border-stone-200 dark:border-stone-700 '
        + 'bg-white dark:bg-stone-900 pl-1 pr-1.5 py-1.5',
      'data-id': String(it.id),
    },
      handle,
      el('div', { class: 'flex-1 min-w-0 py-0.5' },
        el('div', { class: 'font-medium text-[15px] truncate' }, it.label),
        it.sub && el('div', { class: 'text-xs text-stone-400 dark:text-stone-500 truncate' }, it.sub)),
      el('div', { class: 'flex items-center shrink-0' }, up, down));
    row._up = up; row._down = down;

    // Proper drag: the row "pops out" (fixed, following the pointer) and a
    // dashed placeholder holds the drop slot, showing exactly where it'll land —
    // the familiar lift-and-drop feel. Document-level move/up listeners keep
    // tracking even though the row leaves normal flow.
    handle.addEventListener('pointerdown', (e) => {
      if (e.button != null && e.button > 0) return; // primary button / touch only
      e.preventDefault();
      handle.classList.add('cursor-grabbing');
      const rect = row.getBoundingClientRect();
      const grabDy = e.clientY - rect.top;
      const ph = el('div', { class: 'rounded-xl border-2 border-dashed border-accent-400/70 dark:border-accent-500/60 bg-accent-100/30 dark:bg-accent-500/10' });
      ph.style.height = `${rect.height}px`;
      row.before(ph);
      Object.assign(row.style, {
        position: 'fixed', left: `${rect.left}px`, width: `${rect.width}px`, top: `${rect.top}px`,
        margin: '0', zIndex: '50', pointerEvents: 'none', transform: 'scale(1.02)', opacity: '0.97',
      });
      row.classList.add('shadow-2xl');
      const onMove = (ev) => {
        ev.preventDefault();
        row.style.top = `${ev.clientY - grabDy}px`;
        const ref = [...list.children].find((sib) => {
          if (sib === row || sib === ph) return false;
          const r = sib.getBoundingClientRect();
          return ev.clientY < r.top + r.height / 2;
        });
        if (ref) list.insertBefore(ph, ref); else list.appendChild(ph);
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        handle.classList.remove('cursor-grabbing');
        for (const k of ['position', 'left', 'width', 'top', 'margin', 'zIndex', 'pointerEvents', 'transform', 'opacity']) row.style[k] = '';
        row.classList.remove('shadow-2xl');
        ph.replaceWith(row);
        refreshArrows();
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp, { once: true });
      document.addEventListener('pointercancel', onUp, { once: true });
    });
    return row;
  };

  for (const it of items) list.appendChild(makeRow(it));
  refreshArrows();

  return {
    node: list,
    getOrder: () => [...list.children].map((r) => idType.get(r.getAttribute('data-id'))),
  };
}
