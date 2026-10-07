/** Tiny DOM helpers and inline icons for the UI. */

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, unknown> & { class?: string; style?: string };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k === 'class') el.className = String(v);
      else if (k === 'html') el.innerHTML = String(v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function svg(markup: string): HTMLElement {
  const s = document.createElement('span');
  s.style.display = 'contents';
  s.innerHTML = markup;
  return s;
}

const I = (path: string, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;

export const icons = {
  shoe: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2.5c-4.6 0-8 3.4-8 8.2 0 3.6 1.6 7 3.3 9.6.3.5.9.6 1.4.3l1.2-.8c.4-.3.6-.9.3-1.3C8.9 16.4 7.9 13.8 7.9 11c0-2.7 1.8-4.6 4.1-4.6s4.1 1.9 4.1 4.6c0 2.8-1 5.4-2.3 7.5-.3.4-.1 1 .3 1.3l1.2.8c.5.3 1.1.2 1.4-.3 1.7-2.6 3.3-6 3.3-9.6 0-4.8-3.4-8.2-8-8.2z"/></svg>`,
  back: I('<path d="M15 18l-6-6 6-6"/>'),
  pause: I('<path d="M9 5v14M15 5v14"/>'),
  zoom: I('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3M11 8v6M8 11h6"/>'),
  trophy: I('<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 01-10 0V4z"/><path d="M17 5h3v2a3 3 0 01-3 3M7 5H4v2a3 3 0 003 3"/>'),
  play: I('<path d="M7 4l13 8-13 8V4z"/>'),
  target: I('<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>'),
  bag: I('<path d="M5 8h14l-1 13H6L5 8z"/><path d="M9 8V6a3 3 0 016 0v2"/>'),
  chart: I('<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>'),
  gear: I('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'),
  help: I('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01"/>'),
  camera: I('<path d="M23 7l-7 5 7 5V7z"/><rect x="1" y="5" width="15" height="14" rx="2"/>'),
};

export function seg<T extends string | number>(options: { value: T; label: string; sub?: string }[], value: T, onChange: (v: T) => void): HTMLElement {
  const wrap = h('div', { class: 'seg' });
  const render = (v: T) => {
    wrap.replaceChildren(
      ...options.map((o) =>
        h('button', { class: o.value === v ? 'on' : '', onclick: () => { onChange(o.value); render(o.value); } }, o.label, o.sub ? h('small', null, o.sub) : null),
      ),
    );
  };
  render(value);
  return wrap;
}

export function toggle(on: boolean, onChange: (v: boolean) => void): HTMLElement {
  const b = h('button', { class: `toggle${on ? ' on' : ''}`, 'aria-pressed': String(on) });
  b.addEventListener('click', () => {
    on = !on;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
    onChange(on);
  });
  return b;
}

export function meter(pct: number): HTMLElement {
  return h('div', { class: 'meter' }, h('i', { style: `width:${Math.max(0, Math.min(100, pct))}%` }));
}

export function topbar(title: string, onBack: () => void, right?: Node): HTMLElement {
  return h('div', { class: 'topbar' }, h('button', { class: 'back', onclick: onBack, 'aria-label': 'Back' }, svg(icons.back)), h('h2', null, title), right ?? null);
}

export function pctText(x: number, digits = 1): string {
  return `${x.toFixed(digits)}%`;
}
