import {
  api,
  ApiError,
  getToken,
  setToken,
  type Attempt,
  type Discipline,
  type Gym,
  type LogEntry,
  type RouteImage,
  type RouteMarker,
  type RoutePhoto,
  type RouteWithGym,
  type Route,
} from './api';

const GYM_KEY = 'sendit_gym';

let gyms: Gym[] = [];
let activeGymId: string | null = localStorage.getItem(GYM_KEY);

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

// Key order drives select-option order; top rope is the default discipline.
const DISCIPLINE_LABELS: Record<Discipline, string> = {
  top_rope: 'Top rope',
  boulder: 'Boulder',
  lead: 'Lead',
  autobelay: 'Auto belay',
};

const BOULDER_GRADES = ['VB', 'V0', 'V1', 'V2', 'V3', 'V4', 'V5', 'V6', 'V7', 'V8'];
const ROPE_GRADES = [
  '5.8',
  '5.9',
  '5.10a',
  '5.10b',
  '5.10c',
  '5.10d',
  '5.11a',
  '5.11b',
  '5.11c',
  '5.11d',
  '5.12a',
  '5.12b',
  '5.12c',
  '5.12d',
];

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

type RouteState = 'sent' | 'project' | 'new';

const STATE_LABELS: Record<RouteState, string> = {
  sent: 'sent',
  project: 'in progress',
  new: 'not tried',
};

function routeState(r: { send_count: number; attempt_count: number }): RouteState {
  if (r.send_count > 0) return 'sent';
  if (r.attempt_count > 0) return 'project';
  return 'new';
}

function routeTitle(r: { name: string; color: string; grade: string }): string {
  if (r.name) return r.name;
  const bits = [r.color, r.grade].filter(Boolean).join(' ');
  return bits || 'Unnamed route';
}

// Rank grades so mixed freetext sorts sensibly: V-scale together, YDS
// together, anything unparseable at the easy end.
function gradeRank(grade: string): number {
  const g = grade.trim().toUpperCase();
  const v = g.match(/^V(B|\d+)/);
  if (v) return 100 + (v[1] === 'B' ? -1 : Number(v[1]));
  const yds = g.match(/^5\.(\d+)([A-D])?/);
  if (yds) return 200 + Number(yds[1]) * 5 + (yds[2] ? yds[2].charCodeAt(0) - 64 : 0);
  return -1;
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

// ---------- photos ----------

// Photo bytes require the Bearer token, so <img src> can't point at the API
// directly. Fetch blobs once per session and hand out object URLs.
const photoUrls = new Map<string, string>();

async function photoUrl(photoId: string): Promise<string> {
  const cached = photoUrls.get(photoId);
  if (cached) return cached;
  const blob = await api.fetchPhotoBlob(photoId);
  const url = URL.createObjectURL(blob);
  photoUrls.set(photoId, url);
  return url;
}

function hydratePhotos(scope: ParentNode = document): void {
  scope.querySelectorAll<HTMLImageElement>('img[data-photo]').forEach((img) => {
    void photoUrl(img.dataset.photo!)
      .then((url) => {
        img.src = url;
        img.classList.add('loaded');
      })
      .catch(() => img.remove());
  });
}

const MAX_PHOTO_EDGE = 1600;

// Downscale on-device so a 12MB phone photo becomes a ~300KB JPEG. Safari
// decodes HEIC here too, which conveniently converts it to JPEG for upload.
async function preparePhoto(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (blob) return blob;
  } catch {
    // Couldn't decode locally — send the original and let the server judge it.
  }
  return file;
}

function openLightbox(photo: RoutePhoto, onDelete: () => void): void {
  const overlay = document.createElement('div');
  overlay.className = 'lightbox';

  const img = document.createElement('img');
  img.dataset.photo = photo.id;
  img.alt = 'Route photo';

  const actions = document.createElement('div');
  actions.className = 'lightbox-actions';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn ghost';
  closeBtn.textContent = 'Close';
  const deleteBtn = document.createElement('button');
  deleteBtn.className = 'linkish danger';
  deleteBtn.textContent = 'Delete photo';
  actions.append(closeBtn, deleteBtn);

  overlay.append(img, actions);
  document.body.appendChild(overlay);
  hydratePhotos(overlay);

  closeBtn.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  deleteBtn.addEventListener('click', async () => {
    if (!confirm('Delete this photo?')) return;
    try {
      await api.deletePhoto(photo.id);
      const url = photoUrls.get(photo.id);
      if (url) {
        URL.revokeObjectURL(url);
        photoUrls.delete(photo.id);
      }
      overlay.remove();
      onDelete();
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- route image (annotated topo) ----------

const DEFAULT_MARKER_R = 0.02;
const SVG_NS = 'http://www.w3.org/2000/svg';

function drawMarkers(svg: SVGSVGElement, markers: RouteMarker[], w: number, h: number, color: string): void {
  svg.textContent = '';
  for (const m of markers) {
    const r = m.r * w;
    for (const [stroke, width] of [
      ['rgba(255,255,255,0.9)', r * 0.45],
      [color, r * 0.22],
    ] as const) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(m.x * w));
      circle.setAttribute('cy', String(m.y * h));
      circle.setAttribute('r', String(r));
      circle.setAttribute('fill', 'none');
      circle.setAttribute('stroke', stroke);
      circle.setAttribute('stroke-width', String(width));
      svg.appendChild(circle);
    }
  }
}

// Photo + marker overlay. Markers are normalized; the SVG viewBox uses the
// image's natural pixel size so circles stay circular at any display size.
function annotatedImage(photoId: string, markers: () => RouteMarker[], color: string): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.className = 'annot-wrap';
  const img = document.createElement('img');
  img.dataset.photo = photoId;
  img.alt = 'Route image';
  const svg = document.createElementNS(SVG_NS, 'svg') as SVGSVGElement;
  wrap.append(img, svg);
  img.addEventListener('load', () => {
    svg.setAttribute('viewBox', `0 0 ${img.naturalWidth} ${img.naturalHeight}`);
    drawMarkers(svg, markers(), img.naturalWidth, img.naturalHeight, colorHex(color));
  });
  return wrap;
}

function annotOverlay(title: string): { overlay: HTMLDivElement; head: HTMLDivElement; body: HTMLDivElement; foot: HTMLDivElement } {
  const overlay = document.createElement('div');
  overlay.className = 'annot-editor';
  const head = document.createElement('div');
  head.className = 'annot-editor-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'annot-title';
  titleEl.textContent = title;
  head.appendChild(titleEl);
  const body = document.createElement('div');
  body.className = 'annot-editor-body';
  const foot = document.createElement('div');
  foot.className = 'annot-editor-foot';
  overlay.append(head, body, foot);
  document.body.appendChild(overlay);
  return { overlay, head, body, foot };
}

function openRouteImageViewer(image: RouteImage, color: string): void {
  const { overlay, head, body } = annotOverlay('Route image');
  const closeBtn = document.createElement('button');
  closeBtn.className = 'btn ghost';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', () => overlay.remove());
  head.prepend(closeBtn);
  body.appendChild(annotatedImage(image.photo_id, () => image.markers, color));
  hydratePhotos(overlay);
}

function openRouteImageEditor(
  routeId: string,
  photoId: string,
  initial: RouteMarker[],
  color: string,
  onSaved: () => void
): void {
  const markers: RouteMarker[] = initial.map((m) => ({ ...m }));

  const { overlay, head, body, foot } = annotOverlay('Mark the holds');
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Cancel';
  const saveBtn = document.createElement('button');
  saveBtn.className = 'btn primary';
  head.prepend(cancelBtn);
  head.appendChild(saveBtn);
  foot.textContent = 'Tap a hold to mark it. Tap a circle to remove it.';

  const wrap = annotatedImage(photoId, () => markers, color);
  body.appendChild(wrap);
  hydratePhotos(overlay);
  const img = wrap.querySelector('img')!;
  const svg = wrap.querySelector('svg')!;

  function sync(): void {
    saveBtn.textContent = `Save (${markers.length})`;
    saveBtn.disabled = markers.length === 0;
    if (img.naturalWidth) {
      drawMarkers(svg, markers, img.naturalWidth, img.naturalHeight, colorHex(color));
    }
  }
  sync();
  img.addEventListener('load', sync);

  svg.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const nx = (e.clientX - rect.left) / rect.width;
    const ny = (e.clientY - rect.top) / rect.height;
    // Hit-test in screen pixels (with finger-sized slop) so removal works at
    // any zoom; newest markers win ties.
    for (let i = markers.length - 1; i >= 0; i--) {
      const m = markers[i];
      const dx = (m.x - nx) * rect.width;
      const dy = (m.y - ny) * rect.height;
      const hitRadius = m.r * rect.width + 8;
      if (dx * dx + dy * dy <= hitRadius * hitRadius) {
        markers.splice(i, 1);
        sync();
        return;
      }
    }
    markers.push({ x: Math.min(1, Math.max(0, nx)), y: Math.min(1, Math.max(0, ny)), r: DEFAULT_MARKER_R });
    sync();
  });

  cancelBtn.addEventListener('click', () => overlay.remove());
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api.setRouteImage(routeId, photoId, markers);
      overlay.remove();
      toast('Route image saved.');
      onSaved();
    } catch (err) {
      saveBtn.disabled = false;
      fail(err);
    }
  });
}

function openRouteImagePicker(photos: RoutePhoto[], onPick: (photo: RoutePhoto) => void): void {
  const { overlay, head, body } = annotOverlay('Pick a photo to annotate');
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn ghost';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => overlay.remove());
  head.prepend(cancelBtn);

  const grid = document.createElement('div');
  grid.className = 'annot-picker-grid';
  for (const photo of photos) {
    const btn = document.createElement('button');
    btn.className = 'photo-thumb';
    const img = document.createElement('img');
    img.dataset.photo = photo.id;
    img.alt = 'Route photo';
    btn.appendChild(img);
    btn.addEventListener('click', () => {
      overlay.remove();
      onPick(photo);
    });
    grid.appendChild(btn);
  }
  body.appendChild(grid);
  hydratePhotos(overlay);
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
  if (!gyms.some((g) => g.id === activeGymId) && gyms.length > 0) {
    setActiveGym(gyms[0].id);
  }
}

// ---------- filters ----------

interface ListFilters {
  gym: string;
  discipline: string;
  status: string;
  sort: string;
}

const logFilters: ListFilters = { gym: 'all', discipline: 'all', status: 'all', sort: 'newest' };
const routeFilters: ListFilters = { gym: 'all', discipline: 'all', status: 'active', sort: 'recent' };

type Options = [string, string][];

function filterBar(f: ListFilters, statusOptions: Options, sortOptions: Options): string {
  const selects: [keyof ListFilters, Options][] = [
    ['gym', [['all', 'All gyms'], ...gyms.map((g): [string, string] => [g.id, g.name])]],
    ['discipline', [['all', 'All types'], ...(Object.entries(DISCIPLINE_LABELS) as Options)]],
    ['status', statusOptions],
    ['sort', sortOptions],
  ];
  return `<div class="filter-bar">
    ${selects
      .map(
        ([key, options]) => `<select data-f="${key}" aria-label="${key}">
          ${options
            .map(([value, label]) => `<option value="${esc(value)}" ${f[key] === value ? 'selected' : ''}>${esc(label)}</option>`)
            .join('')}
        </select>`
      )
      .join('')}
  </div>`;
}

function wireFilterBar(f: ListFilters, rerender: () => void): void {
  document.querySelectorAll<HTMLSelectElement>('.filter-bar select').forEach((sel) =>
    sel.addEventListener('change', () => {
      f[sel.dataset.f as keyof ListFilters] = sel.value;
      rerender();
    })
  );
}

// ---------- chrome ----------

function shell(content: string, nav: 'log' | 'routes' | 'gyms' | null): void {
  const navHtml =
    nav === null
      ? ''
      : `<nav class="bottomnav">
          <a href="#/" class="${nav === 'log' ? 'active' : ''}">
            <svg viewBox="0 0 24 24"><path d="M5 6 H19 M5 12 H19 M5 18 H12" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Log
          </a>
          <a href="#/routes" class="${nav === 'routes' ? 'active' : ''}">
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

// ---------- log (landing page) ----------

async function renderLog(): Promise<void> {
  let entries: LogEntry[];
  try {
    entries = (await api.listLog()).entries;
  } catch (err) {
    fail(err);
    return;
  }

  const f = logFilters;
  const visible = entries.filter((e) => {
    if (f.gym !== 'all' && e.gym_id !== f.gym) return false;
    if (f.discipline !== 'all' && e.route_discipline !== f.discipline) return false;
    if (f.status !== 'all' && e.result !== f.status) return false;
    return true;
  });

  if (f.sort === 'oldest') visible.reverse();
  if (f.sort === 'grade') visible.sort((a, b) => gradeRank(b.route_grade) - gradeRank(a.route_grade));

  const items = visible
    .map((e) => {
      const meta = [e.gym_name, DISCIPLINE_LABELS[e.route_discipline]].filter(Boolean).join(' · ');
      const detail = [e.high_point, e.notes].filter(Boolean).join(' — ');
      return `<a class="route-card log-entry" href="#/route/${esc(e.route_id)}">
        <span class="tape" style="background:${colorHex(e.route_color)}"></span>
        <span class="route-card-body">
          <span class="route-card-top">
            <strong>${esc(routeTitle({ name: e.route_name, color: e.route_color, grade: e.route_grade }))}</strong>
            <span class="attempt-result ${e.result === 'send' ? 'is-send' : ''}">${e.result === 'send' ? 'SENT' : 'attempt'}</span>
          </span>
          <span class="route-card-meta">${esc(meta)}</span>
          <span class="route-card-meta dim">${esc(e.attempted_on)} · ${esc(recency(e.attempted_on))}</span>
          ${detail ? `<span class="route-card-meta">${esc(detail)}</span>` : ''}
        </span>
        <span class="route-card-grade">${esc(e.route_grade)}</span>
      </a>`;
    })
    .join('');

  shell(
    `${header('climb log')}
    <main class="list">
      <a class="btn primary wide big-log" href="#/log/new">+ Log a climb</a>
      ${filterBar(
        f,
        [
          ['all', 'All results'],
          ['send', 'Sends'],
          ['attempt', 'Attempts'],
        ],
        [
          ['newest', 'Newest first'],
          ['oldest', 'Oldest first'],
          ['grade', 'By grade'],
        ]
      )}
      ${items || '<p class="empty">Nothing logged yet. Go climb something and brag about it here.</p>'}
    </main>`,
    'log'
  );

  wireFilterBar(f, () => void renderLog());
}

// ---------- log a climb ----------

// The flash checkbox only applies to sends; hide it when "Didn't send" is picked.
function wireFlashToggle(form: HTMLFormElement): void {
  const toggle = form.querySelector<HTMLElement>('.flash-toggle')!;
  const sync = () => {
    const sent = form.querySelector<HTMLInputElement>('input[name=result]:checked')?.value === 'send';
    toggle.classList.toggle('hidden', !sent);
  };
  form.querySelectorAll<HTMLInputElement>('input[name=result]').forEach((r) => r.addEventListener('change', sync));
  sync();
}

function flashedFromForm(data: FormData): number {
  return String(data.get('result')) === 'send' && data.get('flashed') !== null ? 1 : 0;
}

async function renderLogNew(): Promise<void> {
  if (gyms.length === 0) {
    window.location.hash = '#/gyms';
    return;
  }

  const NEW_ROUTE = '__new';
  let selectedGymId = gyms.some((g) => g.id === activeGymId) ? activeGymId! : gyms[0].id;

  const colorChips = Object.keys(NAMED_COLORS)
    .map(
      (name) =>
        `<button type="button" class="swatch" data-color="${name}"
          style="background:${NAMED_COLORS[name]}" aria-label="${name}"></button>`
    )
    .join('');

  shell(
    `<header class="masthead compact">
      <a class="back" href="#/">&larr;</a>
      <h2>Log a climb</h2>
    </header>
    <main class="form-page">
      <form id="log-form">
        <label>Gym
          <select name="gym">
            ${gyms
              .map((g) => `<option value="${esc(g.id)}" ${g.id === selectedGymId ? 'selected' : ''}>${esc(g.name)}</option>`)
              .join('')}
          </select>
        </label>
        <label>Route
          <select name="route"></select>
        </label>
        <div id="new-route-fields" class="hidden">
          <label>Discipline
            <select name="discipline">
              ${(Object.keys(DISCIPLINE_LABELS) as Discipline[])
                .map((d) => `<option value="${d}">${DISCIPLINE_LABELS[d]}</option>`)
                .join('')}
            </select>
          </label>
          <label>Color
            <div class="swatches">${colorChips}</div>
            <input type="hidden" name="color" />
          </label>
          <label>Grade
            <div class="chips" id="grade-chips"></div>
            <input name="grade" placeholder="V4, 5.11, comp tag…" />
          </label>
          <label>Wall / area
            <input name="wall" placeholder="Overhang, slab wall, cave…" />
          </label>
        </div>
        <div class="seg">
          <label><input type="radio" name="result" value="send" checked /><span>Sent</span></label>
          <label><input type="radio" name="result" value="attempt" /><span>Didn't send</span></label>
        </div>
        <label class="flash-toggle"><input type="checkbox" name="flashed" /><span>Flash <span class="hint">(sent it on the very first try)</span></span></label>
        <label>Date <input type="date" name="attempted_on" value="${todayStr()}" required /></label>
        <label>How far? <span class="hint">(if you didn't send)</span>
          <input name="high_point" placeholder="past the crux, 3rd clip, off the ground…" />
        </label>
        <label>Notes <textarea name="notes" rows="2" placeholder="what happened"></textarea></label>
        <button type="submit" class="btn primary wide">Log it</button>
      </form>
    </main>`,
    'log'
  );

  const form = document.getElementById('log-form') as HTMLFormElement;
  const gymSelect = form.querySelector<HTMLSelectElement>('select[name=gym]')!;
  const routeSelect = form.querySelector<HTMLSelectElement>('select[name=route]')!;
  const newRouteFields = document.getElementById('new-route-fields')!;
  const colorInput = form.querySelector<HTMLInputElement>('input[name=color]')!;
  const gradeInput = form.querySelector<HTMLInputElement>('input[name=grade]')!;
  const disciplineSelect = form.querySelector<HTMLSelectElement>('select[name=discipline]')!;

  form.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) =>
    btn.addEventListener('click', () => {
      const wasActive = btn.classList.contains('active');
      form.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      colorInput.value = wasActive ? '' : (btn.dataset.color ?? '');
      if (!wasActive) btn.classList.add('active');
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

  function syncNewRouteFields(): void {
    newRouteFields.classList.toggle('hidden', routeSelect.value !== NEW_ROUTE);
  }

  async function loadRouteOptions(): Promise<void> {
    let routes: { id: string; name: string; color: string; grade: string; last_attempted_on: string | null }[] = [];
    try {
      routes = (await api.listRoutes(selectedGymId)).routes;
    } catch (err) {
      fail(err);
    }
    routes.sort((a, b) => (b.last_attempted_on ?? '').localeCompare(a.last_attempted_on ?? ''));
    routeSelect.textContent = '';
    for (const r of routes) {
      const opt = document.createElement('option');
      opt.value = r.id;
      opt.textContent = `${routeTitle(r)}${r.grade ? ` (${r.grade})` : ''}`;
      routeSelect.appendChild(opt);
    }
    const newOpt = document.createElement('option');
    newOpt.value = NEW_ROUTE;
    newOpt.textContent = '+ New route…';
    routeSelect.appendChild(newOpt);
    if (routes.length === 0) routeSelect.value = NEW_ROUTE;
    syncNewRouteFields();
  }

  gymSelect.addEventListener('change', () => {
    selectedGymId = gymSelect.value;
    setActiveGym(selectedGymId);
    void loadRouteOptions();
  });
  routeSelect.addEventListener('change', syncNewRouteFields);
  await loadRouteOptions();

  wireFlashToggle(form);

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    try {
      let routeId = String(data.get('route'));
      if (routeId === NEW_ROUTE) {
        const created = await api.createRoute(selectedGymId, {
          name: '',
          grade: String(data.get('grade') ?? ''),
          color: String(data.get('color') ?? ''),
          wall: String(data.get('wall') ?? ''),
          discipline: String(data.get('discipline')) as Discipline,
          notes: '',
        });
        routeId = created.route.id;
      }
      await api.createAttempt(routeId, {
        attempted_on: String(data.get('attempted_on')),
        result: String(data.get('result')) as 'send' | 'attempt',
        flashed: flashedFromForm(data),
        high_point: String(data.get('high_point') ?? ''),
        notes: String(data.get('notes') ?? ''),
      });
      toast(String(data.get('result')) === 'send' ? 'Nice. Logged the send.' : 'Logged. Next time.');
      window.location.hash = '#/';
    } catch (err) {
      fail(err);
    }
  });
}

// ---------- routes list ----------

async function renderRoutes(): Promise<void> {
  let routes: RouteWithGym[];
  try {
    routes = (await api.listAllRoutes(true)).routes;
  } catch (err) {
    fail(err);
    return;
  }

  const f = routeFilters;
  const visible = routes.filter((r) => {
    if (f.gym !== 'all' && r.gym_id !== f.gym) return false;
    if (f.discipline !== 'all' && r.discipline !== f.discipline) return false;
    if (f.status === 'archived') return r.archived === 1;
    if (r.archived === 1) return false;
    if (f.status === 'active') return true;
    return routeState(r) === f.status;
  });

  if (f.sort === 'recent') {
    visible.sort((a, b) => (b.last_attempted_on ?? '').localeCompare(a.last_attempted_on ?? ''));
  } else if (f.sort === 'grade') {
    visible.sort((a, b) => gradeRank(b.grade) - gradeRank(a.grade));
  }
  // 'newest' keeps the server's created_at DESC order.

  const cards = visible
    .map((r) => {
      const state = routeState(r);
      const meta = [r.gym_name, r.wall, DISCIPLINE_LABELS[r.discipline]].filter(Boolean).join(' · ');
      const last = r.last_attempted_on
        ? `${r.attempt_count} ${r.attempt_count === 1 ? 'try' : 'tries'} · last ${recency(r.last_attempted_on)}`
        : 'not tried yet';
      const thumb = r.first_photo_id
        ? `<span class="card-thumb"><img data-photo="${esc(r.first_photo_id)}" alt="" /></span>`
        : '';
      return `<a class="route-card" href="#/route/${esc(r.id)}">
        <span class="tape" style="background:${colorHex(r.color)}"></span>
        <span class="route-card-body">
          <span class="route-card-top">
            <strong>${esc(routeTitle(r))}</strong>
            <span class="state state-${state}">${STATE_LABELS[state]}</span>
          </span>
          <span class="route-card-meta">${esc(meta)}</span>
          <span class="route-card-meta dim">${esc(last)}</span>
        </span>
        ${thumb}
        <span class="route-card-grade">${esc(r.grade)}</span>
      </a>`;
    })
    .join('');

  const emptyCopy =
    f.status === 'archived'
      ? 'Nothing archived here.'
      : f.status === 'sent'
        ? 'No sends match. Get after it.'
        : f.status === 'project'
          ? 'Nothing in progress. Go fall off something.'
          : 'No routes match. Add what the setters put up.';

  shell(
    `${header('routes')}
    <main class="list">
      ${filterBar(
        f,
        [
          ['active', 'All active'],
          ['project', 'In progress'],
          ['new', 'Not tried'],
          ['sent', 'Sent'],
          ['archived', 'Archived'],
        ],
        [
          ['recent', 'Recent activity'],
          ['grade', 'By grade'],
          ['newest', 'Newest first'],
        ]
      )}
      ${cards || `<p class="empty">${emptyCopy}</p>`}
    </main>
    <a class="fab" href="#/new" aria-label="Add route">+</a>`,
    'routes'
  );

  hydratePhotos();
  wireFilterBar(f, () => void renderRoutes());
}

// ---------- route form ----------

async function renderRouteForm(routeId: string | null): Promise<void> {
  if (gyms.length === 0) {
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

  const selectedGymId = route?.gym_id ?? (gyms.some((g) => g.id === activeGymId) ? activeGymId! : gyms[0].id);

  const colorChips = Object.keys(NAMED_COLORS)
    .map(
      (name) =>
        `<button type="button" class="swatch ${route?.color === name ? 'active' : ''}" data-color="${name}"
          style="background:${NAMED_COLORS[name]}" aria-label="${name}"></button>`
    )
    .join('');

  shell(
    `<header class="masthead compact">
      <a class="back" href="${routeId ? `#/route/${esc(routeId)}` : '#/routes'}">&larr;</a>
      <h2>${routeId ? 'Edit route' : 'New route'}</h2>
    </header>
    <main class="form-page">
      <form id="route-form">
        <label>Gym
          <select name="gym_id">
            ${gyms
              .map((g) => `<option value="${esc(g.id)}" ${g.id === selectedGymId ? 'selected' : ''}>${esc(g.name)}</option>`)
              .join('')}
          </select>
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
        <label>Color
          <div class="swatches">${colorChips}</div>
          <input type="hidden" name="color" value="${esc(route?.color ?? '')}" />
        </label>
        <label>Grade
          <div class="chips" id="grade-chips"></div>
          <input name="grade" placeholder="V4, 5.11, comp tag…" value="${esc(route?.grade ?? '')}" />
        </label>
        <label>Wall / area
          <input name="wall" placeholder="Overhang, slab wall, cave…" value="${esc(route?.wall ?? '')}" />
        </label>
        <label>Name <span class="hint">(optional — we'll make one up if you don't)</span>
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

  form.querySelectorAll<HTMLButtonElement>('.swatch').forEach((btn) =>
    btn.addEventListener('click', () => {
      const wasActive = btn.classList.contains('active');
      form.querySelectorAll('.swatch').forEach((s) => s.classList.remove('active'));
      colorInput.value = wasActive ? '' : (btn.dataset.color ?? '');
      if (!wasActive) btn.classList.add('active');
    })
  );

  const disciplineSelect = form.querySelector<HTMLSelectElement>('select[name=discipline]')!;

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
    const gymId = String(data.get('gym_id'));
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
        await api.updateRoute(routeId, { ...fields, gym_id: gymId });
        window.location.hash = `#/route/${routeId}`;
      } else {
        const created = await api.createRoute(gymId, fields);
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
  let photos: RoutePhoto[];
  let routeImage: RouteImage | null;
  try {
    ({ route, attempts, photos, route_image: routeImage } = await api.getRoute(routeId));
  } catch (err) {
    fail(err);
    window.location.hash = '#/routes';
    return;
  }

  const sent = attempts.some((a) => a.result === 'send');
  // The flashed flag only counts on the chronologically first attempt (the list is newest-first).
  const firstAttempt = attempts[attempts.length - 1];
  const flashed = attempts.length > 0 && firstAttempt.result === 'send' && firstAttempt.flashed === 1;
  const stateLabel = sent ? (flashed ? 'flashed' : 'sent') : attempts.length > 0 ? 'in progress' : 'not tried';
  const gymName = gyms.find((g) => g.id === route.gym_id)?.name ?? '';

  const history = attempts
    .map((a, i) => {
      const canFlash = i === attempts.length - 1 && a.result === 'send';
      const isFlash = canFlash && a.flashed === 1;
      const detail = [a.high_point, a.notes].filter(Boolean).join(' — ');
      return `<li class="attempt ${a.result}">
        <div class="attempt-line">
          <span class="attempt-result">${isFlash ? 'FLASH' : a.result === 'send' ? 'SENT' : 'attempt'}</span>
          <span class="attempt-date">${esc(a.attempted_on)}</span>
          ${
            canFlash
              ? `<button class="linkish flash-chip ${isFlash ? 'on' : ''}" data-flash-attempt="${esc(a.id)}"
                  data-flashed="${a.flashed}" aria-pressed="${isFlash}">flash</button>`
              : ''
          }
          <button class="linkish" data-del-attempt="${esc(a.id)}" aria-label="Delete entry">&times;</button>
        </div>
        ${detail ? `<p class="attempt-detail">${esc(detail)}</p>` : ''}
      </li>`;
    })
    .join('');

  const meta = [gymName, route.wall, DISCIPLINE_LABELS[route.discipline]].filter(Boolean).join(' · ');

  shell(
    `<header class="masthead compact">
      <a class="back" href="#/routes">&larr;</a>
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
      <section class="photos">
        <div class="photo-strip">
          ${photos
            .map(
              (p) =>
                `<button type="button" class="photo-thumb" data-photo-open="${esc(p.id)}">
                  <img data-photo="${esc(p.id)}" alt="Route photo" />
                </button>`
            )
            .join('')}
          <label class="photo-add" aria-label="Add photo">
            <input type="file" accept="image/*" capture="environment" hidden />
            <span class="photo-add-plus">+</span>
            <span class="photo-add-label">photo</span>
          </label>
        </div>
      </section>
      <section class="route-image">
        <div class="section-head">
          <h3>Route image</h3>
          ${
            routeImage
              ? `<span class="section-actions">
                  <button class="linkish" id="ri-edit">Edit</button>
                  <button class="linkish danger" id="ri-remove">Remove</button>
                </span>`
              : ''
          }
        </div>
        ${routeImage ? '<div id="ri-view"></div>' : '<button class="annot-create" id="ri-create">Create route image</button>'}
      </section>
      ${route.notes ? `<section class="route-notes"><h3>Notes</h3><p>${esc(route.notes)}</p></section>` : ''}
      <section class="log-actions" style="--route-color:${colorHex(route.color)}">
        <button class="btn send-btn" id="attempt-btn">Log attempt</button>
      </section>
      <form id="attempt-form" class="attempt-form hidden">
        <div class="seg">
          <label><input type="radio" name="result" value="attempt" checked /><span>Didn't send</span></label>
          <label><input type="radio" name="result" value="send" /><span>Sent</span></label>
        </div>
        <label class="flash-toggle hidden"><input type="checkbox" name="flashed" /><span>Flash <span class="hint">(sent it on the very first try)</span></span></label>
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

  const rerender = () => void renderRouteDetail(route.id);
  const editImage = (photoId: string, initial: RouteMarker[]) =>
    openRouteImageEditor(route.id, photoId, initial, route.color, rerender);

  if (routeImage) {
    const image = routeImage;
    const view = document.getElementById('ri-view')!;
    const wrap = annotatedImage(image.photo_id, () => image.markers, route.color);
    wrap.addEventListener('click', () => openRouteImageViewer(image, route.color));
    view.appendChild(wrap);
    document.getElementById('ri-edit')!.addEventListener('click', () => editImage(image.photo_id, image.markers));
    document.getElementById('ri-remove')!.addEventListener('click', async () => {
      if (!confirm('Remove the route image? The photo itself stays.')) return;
      try {
        await api.deleteRouteImage(route.id);
        rerender();
      } catch (err) {
        fail(err);
      }
    });
  } else {
    document.getElementById('ri-create')!.addEventListener('click', () => {
      if (photos.length === 0) {
        toast('Add a photo first, then mark the holds.');
      } else if (photos.length === 1) {
        editImage(photos[0].id, []);
      } else {
        openRouteImagePicker(photos, (photo) => editImage(photo.id, []));
      }
    });
  }

  hydratePhotos();

  document.querySelectorAll<HTMLButtonElement>('[data-photo-open]').forEach((btn) =>
    btn.addEventListener('click', () => {
      const photo = photos.find((p) => p.id === btn.dataset.photoOpen);
      if (photo) openLightbox(photo, () => void renderRouteDetail(route.id));
    })
  );

  const photoInput = document.querySelector<HTMLInputElement>('.photo-add input')!;
  photoInput.addEventListener('change', async () => {
    const file = photoInput.files?.[0];
    if (!file) return;
    photoInput.disabled = true;
    toast('Uploading photo…');
    try {
      const blob = await preparePhoto(file);
      await api.uploadRoutePhoto(route.id, blob);
      void renderRouteDetail(route.id);
    } catch (err) {
      photoInput.disabled = false;
      photoInput.value = '';
      fail(err);
    }
  });

  const attemptForm = document.getElementById('attempt-form') as HTMLFormElement;
  document.getElementById('attempt-btn')!.addEventListener('click', () => {
    attemptForm.classList.toggle('hidden');
  });

  wireFlashToggle(attemptForm);

  attemptForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = new FormData(attemptForm);
    try {
      await api.createAttempt(route.id, {
        attempted_on: String(data.get('attempted_on')),
        result: String(data.get('result')) as 'send' | 'attempt',
        flashed: flashedFromForm(data),
        high_point: String(data.get('high_point') ?? ''),
        notes: String(data.get('notes') ?? ''),
      });
      void renderRouteDetail(route.id);
    } catch (err) {
      fail(err);
    }
  });

  document.querySelectorAll<HTMLButtonElement>('[data-flash-attempt]').forEach((btn) =>
    btn.addEventListener('click', async () => {
      try {
        await api.updateAttempt(btn.dataset.flashAttempt!, { flashed: btn.dataset.flashed === '1' ? 0 : 1 });
        void renderRouteDetail(route.id);
      } catch (err) {
        fail(err);
      }
    })
  );

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
      window.location.hash = '#/routes';
    } catch (err) {
      fail(err);
    }
  });

  document.getElementById('delete-btn')!.addEventListener('click', async () => {
    if (!confirm('Delete this route and all its history? Archiving is usually what you want.')) return;
    try {
      await api.deleteRoute(route.id);
      window.location.hash = '#/routes';
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
          ${g.id === activeGymId ? '<span class="state state-sent">default</span>' : ''}
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
      routeFilters.gym = btn.dataset.gym!;
      window.location.hash = '#/routes';
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
      await loadGyms();
      window.location.hash = '#/routes';
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
    await renderLog();
  } else if (hash === '#/log/new') {
    await renderLogNew();
  } else if (hash === '#/routes') {
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
