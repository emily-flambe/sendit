import {
  api,
  ApiError,
  getToken,
  setToken,
  type Attempt,
  type Discipline,
  type Gym,
  type RouteWithStats,
  type Route,
} from './api';

const GYM_KEY = 'sendit_gym';

type Filter = 'all' | 'new' | 'project' | 'sent' | 'archived';

let gyms: Gym[] = [];
let activeGymId: string | null = localStorage.getItem(GYM_KEY);
let filter: Filter = 'all';

const appEl = document.getElementById('app')!;

// ---------- helpers ----------

// Every dynamic value interpolated into view templates is passed through esc()
// (or comes from a validated allowlist, e.g. colorHex) before rendering.
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const NAMED_COLORS: Record<string, string> = {
  red: '#d94f3d',
  orange: '#e8853c',
  yellow: '#e3c145',
  green: '#5da35c',
  blue: '#4a8bc9',
  purple: '#9268bd',
  pink: '#d9749f',
  teal: '#4aa8a0',
  white: '#e8e4da',
  black: '#3a3835',
  gray: '#8b8680',
};

function colorHex(color: string): string {
  const key = color.trim().toLowerCase();
  if (NAMED_COLORS[key]) return NAMED_COLORS[key];
  if (/^#[0-9a-f]{3,8}$/i.test(key)) return key;
  return '#6b665f';
}

const DISCIPLINE_LABELS: Record<Discipline, string> = {
  boulder: 'Boulder',
  top_rope: 'Top rope',
  lead: 'Lead',
  autobelay: 'Auto belay',
};

const BOULDER_GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'];
const ROPE_GRADES = ['5.8', '5.9', '5.10', '5.10+', '5.11', '5.11+', '5.12', '5.12+'];

function todayStr(): string {
  const d = new Date();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function recency(dateStr: string | null): string {
  if (!dateStr) return '';
  const then = new Date(`${dateStr}T12:00:00`);
  const days = Math.floor((Date.now() - then.getTime()) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function routeState(r: RouteWithStats): 'sent' | 'project' | 'new' {
  if (r.send_count > 0) return 'sent';
  if (r.attempt_count > 0) return 'project';
  return 'new';
}

function routeTitle(r: Route): string {
  if (r.name) return r.name;
  const bits = [r.color, r.grade].filter(Boolean).join(' ');
  return bits || 'Unnamed route';
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(message: string): void {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3200);
}

function fail(err: unknown): void {
  toast(err instanceof ApiError ? err.message : 'Network error');
}

function activeGym(): Gym | null {
  return gyms.find((g) => g.id === activeGymId) ?? null;
}

function setActiveGym(id: string | null): void {
  activeGymId = id;
  if (id) {
    localStorage.setItem(GYM_KEY, id);
  } else {
    localStorage.removeItem(GYM_KEY);
  }
}

async function loadGyms(): Promise<void> {
  gyms = (await api.listGyms()).gyms;
  if (!activeGym() && gyms.length > 0) {
    setActiveGym(gyms[0].id);
  }
}

// ---------- chrome ----------

function shell(content: string, nav: 'routes' | 'gyms' | null): void {
  const navHtml =
    nav === null
      ? ''
      : `<nav class="bottomnav">
          <a href="#/" class="${nav === 'routes' ? 'active' : ''}">
            <svg viewBox="0 0 24 24"><path d="M5 20 L12 4 L19 20" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Routes
          </a>
          <a href="#/gyms" class="${nav === 'gyms' ? 'active' : ''}">
            <svg viewBox="0 0 24 24"><path d="M4 20 V10 L12 4 L20 10 V20 M4 14 H20" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Gyms
          </a>
        </nav>`;
  appEl.innerHTML = `${content}${navHtml}`;
}

function header(sub: string): string {
  return `<header class="masthead">
    <h1>send<span>it</span></h1>
    <p class="masthead-sub">${esc(sub)}</p>
  </header>`;
}

// ---------- login ----------

function renderLogin(): void {
  shell(
    `<main class="auth">
      <div class="auth-mark">
        <h1>send<span>it</span></h1>
        <p>route tracking for people<br/>with unfinished business</p>
      </div>
      <form id="auth-form" autocomplete="on">
        <label>Username
          <input name="username" required minlength="3" autocapitalize="none" autocomplete="username" />
        </label>
        <label>Password
          <input name="password" type="password" required minlength="8" autocomplete="current-password" />
        </label>
        <div class="auth-actions">
          <button type="submit" class="btn primary" data-mode="login">Log in</button>
          <button type="submit" class="btn ghost" data-mode="register">Create account</button>
        </div>
      </form>
    </main>`,
    null
  );

  const form = document.getElementById('auth-form') as HTMLFormElement;
  let mode: 'login' | 'register' = 'login';
  form.querySelectorAll('button').forEach((btn) =>
    btn.addEventListener('click', () => {
      mode = btn.dataset.mode as typeof mode;
    })
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const username = String(data.get('username') ?? '');
    const password = String(data.get('password') ?? '');
    try {
      const result = mode === 'login' ? await api.login(username, password) : await api.register(username, password);
      setToken(result.token);
      await loadGyms();
      window.location.hash = gyms.length === 0 ? '#/gyms' : '#/';
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- routes list ----------

async function renderRoutes(): Promise<void> {
  const gym = activeGym();
  if (!gym) {
    window.location.hash = '#/gyms';
    return;
  }

  let routes: RouteWithStats[];
  try {
    routes = (await api.listRoutes(gym.id, filter === 'archived')).routes;
  } catch (err) {
    fail(err);
    return;
  }

  const visible = routes.filter((r) => {
    if (filter === 'archived') return r.archived === 1;
    if (r.archived === 1) return false;
    if (filter === 'all') return true;
    return routeState(r) === filter;
  });

  const filters: [Filter, string][] = [
    ['all', 'All'],
    ['project', 'Projects'],
    ['new', 'New'],
    ['sent', 'Sent'],
    ['archived', 'Archived'],
  ];

  const cards = visible
    .map((r) => {
      const state = routeState(r);
      const meta = [r.wall, DISCIPLINE_LABELS[r.discipline]].filter(Boolean).join(' · ');
      const last = r.last_attempted_on
        ? `${r.attempt_count} ${r.attempt_count === 1 ? 'try' : 'tries'} · last ${recency(r.last_attempted_on)}`
        : 'not tried yet';
      return `<a class="route-card" href="#/route/${esc(r.id)}">
        <span class="tape" style="background:${colorHex(r.color)}"></span>
        <span class="route-card-body">
          <span class="route-card-top">
            <strong>${esc(routeTitle(r))}</strong>
            <span class="state state-${state}">${state}</span>
          </span>
          <span class="route-card-meta">${esc(meta)}</span>
          <span class="route-card-meta dim">${esc(last)}</span>
        </span>
        <span class="route-card-grade">${esc(r.grade)}</span>
      </a>`;
    })
    .join('');

  const emptyCopy =
    filter === 'archived'
      ? 'Nothing archived at this gym.'
      : filter === 'sent'
        ? 'No sends logged yet. Get after it.'
        : filter === 'project'
          ? 'No open projects. Go fall off something.'
          : 'No routes yet. Add what the setters put up.';

  shell(
    `${header(gym.name)}
    <div class="filters">
      ${filters
        .map(([key, label]) => `<button class="chip ${filter === key ? 'active' : ''}" data-filter="${key}">${label}</button>`)
        .join('')}
    </div>
    <main class="list">
      ${cards || `<p class="empty">${emptyCopy}</p>`}
    </main>
    <a class="fab" href="#/new" aria-label="Add route">+</a>`,
    'routes'
  );

  document.querySelectorAll<HTMLButtonElement>('[data-filter]').forEach((btn) =>
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter as Filter;
      void renderRoutes();
    })
  );
}

// ---------- route form ----------

async function renderRouteForm(routeId: string | null): Promise<void> {
  const gym = activeGym();
  if (!gym) {
    window.location.hash = '#/gyms';
    return;
  }

  let route: Route | null = null;
  if (routeId) {
    try {
      route = (await api.getRoute(routeId)).route;
    } catch (err) {
      fail(err);
      return;
    }
  }

  const colorChips = Object.keys(NAMED_COLORS)
    .map(
      (name) =>
        `<button type="button" class="swatch ${route?.color === name ? 'active' : ''}" data-color="${name}"
          style="background:${NAMED_COLORS[name]}" aria-label="${name}"></button>`
    )
    .join('');

  shell(
    `<header class="masthead compact">
      <a class="back" href="${routeId ? `#/route/${esc(routeId)}` : '#/'}">&larr;</a>
      <h2>${routeId ? 'Edit route' : 'New route'}</h2>
    </header>
    <main class="form-page">
      <form id="route-form">
        <label>Color
          <div class="swatches">${colorChips}</div>
          <input name="color" placeholder="or type one" value="${esc(route?.color ?? '')}" />
        </label>
        <label>Grade
          <div class="chips" id="grade-chips"></div>
          <input name="grade" placeholder="V4, 5.11, comp tag…" value="${esc(route?.grade ?? '')}" />
        </label>
        <label>Discipline
          <select name="discipline">
            ${(Object.keys(DISCIPLINE_LABELS) as Discipline[])
              .map(
                (d) =>
                  `<option value="${d}" ${route?.discipline === d ? 'selected' : ''}>${DISCIPLINE_LABELS[d]}</option>`
              )
              .join('')}
          </select>
        </label>
        <label>Wall / area
          <input name="wall" placeholder="Overhang, slab wall, cave…" value="${esc(route?.wall ?? '')}" />
        </label>
        <label>Name <span class="hint">(optional — setters rarely bother, you don't have to either)</span>
          <input name="name" value="${esc(route?.name ?? '')}" />
        </label>
        <label>Notes
          <textarea name="notes" rows="3" placeholder="Beta, crux, fear level…">${esc(route?.notes ?? '')}</textarea>
        </label>
        <button type="submit" class="btn primary wide">${routeId ? 'Save changes' : 'Add route'}</button>
      </form>
    </main>`,
    'routes'
  );

  const form = document.getElementById('route-form') as HTMLFormElement;
  const colorInput = form.querySelector<HTMLInputElement>('input[name=color]')!;
  const gradeInput = form.querySelector<HTMLInputElement>('input[name=grade]')!;
  const disciplineSelect = form.querySelector<HTMLSelectElement>('select[name=discipline]')!;

  form.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) =>
    btn.addEventListener('click', () => {
      colorInput.value = btn.dataset.color ?? '';
      form.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      btn.classList.add('active');
    })
  );

  function renderGradeChips(): void {
    const grades = disciplineSelect.value === 'boulder' ? BOULDER_GRADES : ROPE_GRADES;
    const container = document.getElementById('grade-chips')!;
    container.textContent = '';
    for (const g of grades) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.textContent = g;
      chip.addEventListener('click', () => {
        gradeInput.value = g;
      });
      container.appendChild(chip);
    }
  }
  renderGradeChips();
  disciplineSelect.addEventListener('change', renderGradeChips);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const fields = {
      name: String(data.get('name') ?? ''),
      grade: String(data.get('grade') ?? ''),
      color: String(data.get('color') ?? ''),
      wall: String(data.get('wall') ?? ''),
      discipline: String(data.get('discipline')) as Discipline,
      notes: String(data.get('notes') ?? ''),
    };
    try {
      if (routeId) {
        await api.updateRoute(routeId, fields);
        window.location.hash = `#/route/${routeId}`;
      } else {
        const created = await api.createRoute(gym.id, fields);
        window.location.hash = `#/route/${created.route.id}`;
      }
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- route detail ----------

async function renderRouteDetail(routeId: string): Promise<void> {
  let route: Route;
  let attempts: Attempt[];
  try {
    ({ route, attempts } = await api.getRoute(routeId));
  } catch (err) {
    fail(err);
    window.location.hash = '#/';
    return;
  }

  const sent = attempts.some((a) => a.result === 'send');
  const flashed = attempts.length > 0 && attempts[attempts.length - 1].result === 'send';
  const stateLabel = sent ? (flashed ? 'flashed' : 'sent') : attempts.length > 0 ? 'project' : 'new';

  const history = attempts
    .map((a) => {
      const detail = [a.high_point, a.notes].filter(Boolean).join(' — ');
      return `<li class="attempt ${a.result}">
        <div class="attempt-line">
          <span class="attempt-result">${a.result === 'send' ? 'SENT' : 'attempt'}</span>
          <span class="attempt-date">${esc(a.attempted_on)}</span>
          <button class="linkish" data-del-attempt="${esc(a.id)}" aria-label="Delete entry">&times;</button>
        </div>
        ${detail ? `<p class="attempt-detail">${esc(detail)}</p>` : ''}
      </li>`;
    })
    .join('');

  const meta = [route.wall, DISCIPLINE_LABELS[route.discipline]].filter(Boolean).join(' · ');

  shell(
    `<header class="masthead compact">
      <a class="back" href="#/">&larr;</a>
      <h2>${esc(routeTitle(route))}</h2>
      <a class="edit-link" href="#/route/${esc(route.id)}/edit">Edit</a>
    </header>
    <main class="detail">
      <section class="route-hero" style="--route-color:${colorHex(route.color)}">
        <span class="tape tall"></span>
        <div>
          <div class="route-hero-grade">${esc(route.grade || '—')}</div>
          <div class="route-hero-meta">${esc(meta)}</div>
          <span class="state state-${sent ? 'sent' : attempts.length ? 'project' : 'new'}">${stateLabel}</span>
          ${route.archived ? '<span class="state state-archived">archived</span>' : ''}
        </div>
      </section>
      ${route.notes ? `<section class="route-notes"><h3>Notes</h3><p>${esc(route.notes)}</p></section>` : ''}
      <section class="log-actions" style="--route-color:${colorHex(route.color)}">
        <button class="btn send-btn" id="sent-btn">Sent it</button>
        <button class="btn ghost" id="attempt-btn">Log attempt</button>
      </section>
      <form id="attempt-form" class="attempt-form hidden">
        <div class="seg">
          <label><input type="radio" name="result" value="attempt" checked /><span>Didn't send</span></label>
          <label><input type="radio" name="result" value="send" /><span>Sent</span></label>
        </div>
        <label>Date <input type="date" name="attempted_on" value="${todayStr()}" required /></label>
        <label>How far? <input name="high_point" placeholder="past the crux, 3rd clip, off the ground…" /></label>
        <label>Notes <textarea name="notes" rows="2" placeholder="what happened"></textarea></label>
        <button type="submit" class="btn primary wide">Log it</button>
      </form>
      <section class="history">
        <h3>History</h3>
        ${history ? `<ul>${history}</ul>` : '<p class="empty">Nothing logged yet.</p>'}
      </section>
      <section class="danger-zone">
        <button class="linkish" id="archive-btn">${route.archived ? 'Unarchive route' : 'Archive route (wall got reset)'}</button>
        <button class="linkish danger" id="delete-btn">Delete route and history</button>
      </section>
    </main>`,
    'routes'
  );

  document.getElementById('sent-btn')!.addEventListener('click', async () => {
    try {
      await api.createAttempt(route.id, { attempted_on: todayStr(), result: 'send' });
      toast('Nice. Logged the send.');
      void renderRouteDetail(route.id);
    } catch (err) {
      fail(err);
    }
  });

  const attemptForm = document.getElementById('attempt-form') as HTMLFormElement;
  document.getElementById('attempt-btn')!.addEventListener('click', () => {
    attemptForm.classList.toggle('hidden');
  });

  attemptForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(attemptForm);
    try {
      await api.createAttempt(route.id, {
        attempted_on: String(data.get('attempted_on')),
        result: String(data.get('result')) as 'send' | 'attempt',
        high_point: String(data.get('high_point') ?? ''),
        notes: String(data.get('notes') ?? ''),
      });
      void renderRouteDetail(route.id);
    } catch (err) {
      fail(err);
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-del-attempt]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this log entry?')) return;
      try {
        await api.deleteAttempt(btn.dataset.delAttempt!);
        void renderRouteDetail(route.id);
      } catch (err) {
        fail(err);
      }
    })
  );

  document.getElementById('archive-btn')!.addEventListener('click', async () => {
    try {
      await api.updateRoute(route.id, { archived: route.archived ? 0 : 1 });
      window.location.hash = '#/';
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById('delete-btn')!.addEventListener('click', async () => {
    if (!confirm('Delete this route and all its history? Archiving is usually what you want.')) return;
    try {
      await api.deleteRoute(route.id);
      window.location.hash = '#/';
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- gyms ----------

async function renderGyms(): Promise<void> {
  try {
    gyms = (await api.listGyms()).gyms;
  } catch (err) {
    fail(err);
    return;
  }

  const items = gyms
    .map(
      (g) => `<li class="gym ${g.id === activeGymId ? 'active' : ''}">
        <button class="gym-pick" data-gym="${esc(g.id)}">
          <strong>${esc(g.name)}</strong>
          ${g.id === activeGymId ? '<span class="state state-sent">current</span>' : ''}
        </button>
        <button class="linkish" data-rename="${esc(g.id)}">rename</button>
      </li>`
    )
    .join('');

  shell(
    `${header('gyms')}
    <main class="list">
      ${gyms.length === 0 ? '<p class="empty">Add your gym to start tracking routes.</p>' : `<ul class="gyms">${items}</ul>`}
      <form id="gym-form" class="inline-form">
        <input name="name" placeholder="Gym name" required maxlength="120" />
        <button type="submit" class="btn primary">Add</button>
      </form>
      <button class="linkish logout" id="logout">Log out</button>
    </main>`,
    'gyms'
  );

  document.querySelectorAll<HTMLButtonElement>('[data-gym]').forEach((btn) =>
    btn.addEventListener('click', () => {
      setActiveGym(btn.dataset.gym!);
      window.location.hash = '#/';
    })
  );

  document.querySelectorAll<HTMLButtonElement>('[data-rename]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      const gym = gyms.find((g) => g.id === btn.dataset.rename);
      const name = prompt('Rename gym', gym?.name ?? '');
      if (!name?.trim()) return;
      try {
        await api.updateGym(btn.dataset.rename!, { name: name.trim() });
        void renderGyms();
      } catch (err) {
        fail(err);
      }
    })
  );

  (document.getElementById('gym-form') as HTMLFormElement).addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.querySelector<HTMLInputElement>('#gym-form input[name=name]')!;
    try {
      const created = await api.createGym(input.value.trim());
      setActiveGym(created.gym.id);
      window.location.hash = '#/';
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById('logout')!.addEventListener('click', () => {
    setToken(null);
    setActiveGym(null);
    window.location.hash = '#/login';
  });
}

// ---------- router ----------

async function route(): Promise<void> {
  const hash = window.location.hash || '#/';

  if (!getToken()) {
    if (hash !== '#/login') {
      window.location.hash = '#/login';
      return;
    }
    renderLogin();
    return;
  }

  if (hash === '#/login') {
    window.location.hash = '#/';
    return;
  }

  if (gyms.length === 0) {
    try {
      await loadGyms();
    } catch {
      // token was stale; the 401 handler already redirected to #/login
      return;
    }
  }

  const detailMatch = hash.match(/^#\/route\/([\w-]+)$/);
  const editMatch = hash.match(/^#\/route\/([\w-]+)\/edit$/);

  if (hash === '#/') {
    await renderRoutes();
  } else if (hash === '#/new') {
    await renderRouteForm(null);
  } else if (editMatch) {
    await renderRouteForm(editMatch[1]);
  } else if (detailMatch) {
    await renderRouteDetail(detailMatch[1]);
  } else if (hash === '#/gyms') {
    await renderGyms();
  } else {
    window.location.hash = '#/';
  }
}

window.addEventListener('hashchange', () => void route());
void route();
