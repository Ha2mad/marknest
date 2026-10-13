import './style.css';
import type { Note, Snapshot } from './core/types';
import { NoteStore, createNote, toBackup, parseBackupFull, mergeNotes, noteToMarkdown, markdownToNote, safeFilename } from './core/storage';
import { SearchIndex, snippet } from './core/search';
import { tagCounts, filterByTags, parseTagInput, noteTags } from './core/tags';
import { renderMarkdown, deriveTitle } from './core/markdown';
import { WELCOME } from './sample';
import { backlinks, extractLinks, normTitle, renameLinks, autocompleteQuery, suggestTitles } from './core/wikilinks';
import { diffLines, diffStats } from './core/diff';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const editor = $<HTMLTextAreaElement>('editor');
const preview = $('preview');
const list = $<HTMLUListElement>('note-list');
const search = $<HTMLInputElement>('search');
const tagsEl = $('tags');
const tagInput = $<HTMLInputElement>('tag-input');
const status = $('status');
const workspace = $('workspace');

let store: NoteStore;
let notes: Note[] = [];
let index = new SearchIndex();
let current: Note | null = null;
let selectedTags: string[] = [];
let saveTimer: number | undefined;
let visible: Note[] = [];

type View = 'edit' | 'split' | 'preview';
const VIEWS: View[] = ['edit', 'split', 'preview'];

function setStatus(msg: string): void { status.textContent = msg; }

function applyTheme(t: string): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem('marknest-theme', t);
}

function setView(v: View): void {
  workspace.className = `workspace ${v}`;
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === v)));
  localStorage.setItem('marknest-view', v);
}

const findByTitle = (t: string): Note | undefined => notes.find((n) => normTitle(n.title) === normTitle(t));

function renderPreview(): void {
  preview.innerHTML = renderMarkdown(editor.value, { noteExists: (t) => !!findByTitle(t) });
}

// ---------- side panel: backlinks + history ----------
const panel = $('panel');
let history: Snapshot[] = [];
let viewing: Snapshot | null = null;
let hvMode: 'diff' | 'preview' = 'diff';

function linkItem(label: string, onClick: () => void, cls = ''): HTMLLIElement {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.className = 'link ' + cls; b.textContent = label; b.onclick = onClick;
  li.append(b);
  return li;
}

function renderLinks(): void {
  if (!current) return;
  const back = backlinks(notes, current.title, current.id);
  $('backlink-count').textContent = String(back.length);
  $('backlinks').replaceChildren(...(back.length ? back.map((n) => linkItem(n.title, () => open(n.id))) : [emptyLi('No notes link here yet')]));
  const outs = [...new Map(extractLinks(current.body).map((l) => [normTitle(l.target), l.target])).values()];
  $('outlinks').replaceChildren(...(outs.length ? outs.map((t) => linkItem(t, () => void followLink(t), findByTitle(t) ? '' : 'missing')) : [emptyLi('Type [[ to link a note')]));
}

function emptyLi(text: string): HTMLLIElement {
  const li = document.createElement('li'); li.className = 'muted'; li.textContent = text; return li;
}

async function renderHistory(): Promise<void> {
  if (!current || panel.hidden) return;
  history = await store.history(current.id);
  $('history').replaceChildren(...(history.length ? history.map((s) => {
    const { added, removed } = diffStats(diffLines(s.body, current!.body));
    const li = linkItem(new Date(s.savedAt).toLocaleString(), () => showSnapshot(s), viewing?.id === s.id ? 'active' : '');
    const meta = document.createElement('span'); meta.className = 'muted';
    meta.textContent = added || removed ? ` +${added} −${removed}` : ' (current)';
    li.append(meta);
    return li;
  }) : [emptyLi('Snapshots appear as you edit')]));
}

function showSnapshot(s: Snapshot): void {
  viewing = s;
  $('history-view').hidden = false;
  $('hv-title').textContent = new Date(s.savedAt).toLocaleString();
  $('hv-diff').setAttribute('aria-pressed', String(hvMode === 'diff'));
  $('hv-preview').setAttribute('aria-pressed', String(hvMode === 'preview'));
  const body = $('hv-body');
  if (hvMode === 'preview') { body.className = 'hv-body markdown-body'; body.innerHTML = renderMarkdown(s.body); }
  else {
    body.className = 'hv-body diff';
    body.replaceChildren(...diffLines(s.body, current?.body ?? '').map((op) => {
      const d = document.createElement('div');
      d.className = 'd-' + op.type;
      d.textContent = (op.type === 'add' ? '+ ' : op.type === 'del' ? '− ' : '  ') + op.text;
      return d;
    }));
  }
  void renderHistory();
}

async function restoreSnapshot(): Promise<void> {
  if (!current || !viewing) return;
  flush();
  await store.snapshot(current, { force: true }); // keep the pre-restore state
  editor.value = viewing.body;
  tagInput.value = viewing.tags.join(', ');
  viewing = null;
  $('history-view').hidden = true;
  flush(true);
  renderPreview();
  setStatus('Version restored');
}

function togglePanel(force?: boolean): void {
  panel.hidden = force === undefined ? !panel.hidden : !force;
  $('panel-toggle').setAttribute('aria-pressed', String(!panel.hidden));
  localStorage.setItem('marknest-panel', panel.hidden ? '0' : '1');
  void renderHistory();
}

/** Open a linked note, creating it if it doesn't exist. */
async function followLink(title: string): Promise<void> {
  const n = findByTitle(title);
  if (n) open(n.id);
  else { await newNote(`# ${title.trim()}\n\n`); setStatus(`Created “${title.trim()}”`); }
}

// ---------- [[ autocomplete ----------
const ac = $<HTMLUListElement>('autocomplete');
let acItems: string[] = [];
let acIndex = 0;
let acStart = 0;

function updateAutocomplete(): void {
  const q = autocompleteQuery(editor.value.slice(0, editor.selectionStart));
  if (!q || editor.selectionStart !== editor.selectionEnd) { ac.hidden = true; return; }
  acStart = q.start;
  acItems = suggestTitles(notes.filter((n) => n.id !== current?.id).map((n) => n.title), q.query);
  if (q.query.trim() && !acItems.some((t) => normTitle(t) === normTitle(q.query))) acItems.push(q.query.trim());
  if (!acItems.length) { ac.hidden = true; return; }
  acIndex = Math.min(acIndex, acItems.length - 1);
  ac.replaceChildren(...acItems.map((t, i) => {
    const li = document.createElement('li');
    li.role = 'option'; li.ariaSelected = String(i === acIndex);
    li.textContent = findByTitle(t) ? t : `＋ Create “${t}”`;
    li.onmousedown = (e) => { e.preventDefault(); acceptAutocomplete(i); };
    return li;
  }));
  ac.hidden = false;
}

function acceptAutocomplete(i = acIndex): void {
  const t = acItems[i];
  if (!t) return;
  const end = editor.selectionStart;
  const closeAfter = editor.value.slice(end, end + 2) === ']]' ? 2 : 0;
  editor.setRangeText(t + ']]', acStart, end + closeAfter, 'end');
  ac.hidden = true;
  editor.dispatchEvent(new Event('input'));
}

function renderTags(): void {
  tagsEl.replaceChildren(...tagCounts(notes).map(({ tag, count }) => {
    const b = document.createElement('button');
    b.className = 'tag' + (selectedTags.includes(tag) ? ' active' : '');
    b.textContent = `#${tag}`;
    const c = document.createElement('span'); c.textContent = String(count); b.append(c);
    b.onclick = () => { selectedTags = selectedTags.includes(tag) ? selectedTags.filter((t) => t !== tag) : [...selectedTags, tag]; refresh(); };
    return b;
  }));
  $('clear-tags').hidden = !selectedTags.length;
}

function renderList(): void {
  const q = search.value.trim();
  const base = q ? index.search(q).map((h) => h.note) : [...notes].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.updatedAt - a.updatedAt);
  visible = filterByTags(base, selectedTags);
  $('count').textContent = `${visible.length}`;
  list.replaceChildren(...visible.map((n) => {
    const li = document.createElement('li');
    li.role = 'option';
    li.tabIndex = 0;
    li.ariaSelected = String(n.id === current?.id);
    li.className = n.id === current?.id ? 'active' : '';
    const h = document.createElement('div'); h.className = 'title'; h.textContent = (n.pinned ? '📌 ' : '') + n.title;
    const p = document.createElement('div'); p.className = 'snippet'; p.textContent = snippet(n.body, q, 90);
    const m = document.createElement('div'); m.className = 'meta';
    m.textContent = new Date(n.updatedAt).toLocaleString() + (noteTags(n).length ? ' · ' + noteTags(n).map((t) => '#' + t).join(' ') : '');
    li.append(h, p, m);
    li.onclick = () => open(n.id);
    li.onkeydown = (e) => { if (e.key === 'Enter') open(n.id); };
    return li;
  }));
}

function refresh(): void { renderTags(); renderList(); }

function open(id: string | null): void {
  flush();
  current = notes.find((n) => n.id === id) ?? null;
  $('empty').hidden = !!current;
  workspace.hidden = !current;
  if (current) {
    editor.value = current.body;
    tagInput.value = current.tags.join(', ');
    $('pin').setAttribute('aria-pressed', String(!!current.pinned));
    renderPreview();
    location.hash = current.id;
    viewing = null;
    $('history-view').hidden = true;
    ac.hidden = true;
    renderLinks();
    void renderHistory();
  }
  renderList();
}

async function persist(n: Note): Promise<void> {
  await store.put(n);
  index.add(n);
  setStatus('Saved ' + new Date().toLocaleTimeString());
}

function scheduleSave(): void {
  setStatus('Editing…');
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => flush(), 400);
}

function flush(forceSnapshot = false): void {
  clearTimeout(saveTimer);
  if (!current) return;
  const note = current;
  const body = editor.value;
  const tags = parseTagInput(tagInput.value);
  if (body === note.body && tags.join() === note.tags.join()) {
    if (forceSnapshot) void store.snapshot(note, { force: true }).then(renderHistory);
    return;
  }
  const oldTitle = note.title;
  Object.assign(note, { body, tags, title: deriveTitle(body), updatedAt: Date.now() });
  const renamed = updateLinksOnRename(oldTitle, note);
  void persist(note)
    .then(() => Promise.all(renamed.map((n) => persist(n))))
    .then(() => store.snapshot(note, { force: forceSnapshot }))
    .then(() => { refresh(); renderLinks(); void renderHistory(); });
}

/** When a note's title changes, rewrite [[Old Title]] links in other notes (only if no other note still has the old title). */
function updateLinksOnRename(oldTitle: string, note: Note): Note[] {
  if (normTitle(oldTitle) === normTitle(note.title) || findByTitle(oldTitle)) return [];
  const changed: Note[] = [];
  for (const n of notes) {
    if (n.id === note.id) continue;
    const body = renameLinks(n.body, oldTitle, note.title);
    if (body !== n.body) { n.body = body; n.updatedAt = Date.now(); changed.push(n); }
  }
  if (changed.length) setStatus(`Updated links in ${changed.length} note${changed.length > 1 ? 's' : ''}`);
  return changed;
}

async function newNote(body = ''): Promise<void> {
  flush();
  const n = createNote(body, selectedTags);
  notes.unshift(n);
  await persist(n);
  search.value = '';
  open(n.id);
  refresh();
  setView(localStorage.getItem('marknest-view') === 'preview' ? 'split' : (localStorage.getItem('marknest-view') as View) || 'split');
  editor.focus();
}

async function deleteCurrent(): Promise<void> {
  if (!current || !confirm(`Delete “${current.title}”? This cannot be undone.`)) return;
  const id = current.id;
  current = null;
  await store.delete(id);
  index.remove(id);
  notes = notes.filter((n) => n.id !== id);
  open(visible.find((n) => n.id !== id)?.id ?? notes[0]?.id ?? null);
  refresh();
  setStatus('Deleted');
}

function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importFiles(files: FileList): Promise<void> {
  let incoming: Note[] = [];
  let snaps: Snapshot[] = [];
  try {
    for (const f of Array.from(files)) {
      const text = await f.text();
      if (f.name.endsWith('.json')) { const b = parseBackupFull(text); incoming = incoming.concat(b.notes); snaps = snaps.concat(b.history); }
      else incoming.push(markdownToNote(text, f.name.replace(/\.\w+$/, '')));
    }
  } catch (e) { alert('Import failed: ' + (e as Error).message); return; }
  const { merged, added, updated } = mergeNotes(notes, incoming);
  await store.putMany(merged, snaps);
  notes = merged;
  index = new SearchIndex(notes);
  refresh();
  setStatus(`Imported: ${added} new, ${updated} updated`);
}

function wrapSelection(mark: string): void {
  const { selectionStart: s, selectionEnd: e, value } = editor;
  editor.setRangeText(mark + value.slice(s, e) + mark, s, e, 'select');
  if (s === e) editor.setSelectionRange(s + mark.length, s + mark.length);
  editor.dispatchEvent(new Event('input'));
}

function move(delta: number): void {
  const i = visible.findIndex((n) => n.id === current?.id);
  const next = visible[Math.min(visible.length - 1, Math.max(0, i + delta))];
  if (next) open(next.id);
}

function bind(): void {
  editor.addEventListener('input', () => { renderPreview(); scheduleSave(); updateAutocomplete(); });
  editor.addEventListener('click', updateAutocomplete);
  editor.addEventListener('blur', () => setTimeout(() => (ac.hidden = true), 100));
  editor.addEventListener('keydown', (e) => {
    if (!ac.hidden) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); acIndex = (acIndex + (e.key === 'ArrowDown' ? 1 : acItems.length - 1)) % acItems.length; updateAutocomplete(); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); acceptAutocomplete(); return; }
      if (e.key === 'Escape') { e.preventDefault(); ac.hidden = true; return; }
    }
    if (e.key === 'Tab') { e.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input')); }
  });
  tagInput.addEventListener('input', scheduleSave);
  tagInput.addEventListener('change', () => flush());
  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && visible[0]) open(visible[0].id); if (e.key === 'Escape') { search.value = ''; renderList(); } });
  $('new-note').onclick = () => void newNote();
  preview.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a.wikilink');
    if (!a) return;
    e.preventDefault();
    void followLink(decodeURIComponent(a.getAttribute('href')!.slice('#wiki:'.length)));
  });
  $('panel-toggle').onclick = () => togglePanel();
  $('snapshot-now').onclick = () => flush(true);
  $('hv-close').onclick = () => { viewing = null; $('history-view').hidden = true; void renderHistory(); };
  $('hv-restore').onclick = () => void restoreSnapshot();
  $('hv-diff').onclick = () => { hvMode = 'diff'; if (viewing) showSnapshot(viewing); };
  $('hv-preview').onclick = () => { hvMode = 'preview'; if (viewing) showSnapshot(viewing); };
  $('delete').onclick = () => void deleteCurrent();
  $('clear-tags').onclick = () => { selectedTags = []; refresh(); };
  $('pin').onclick = () => { if (current) { current.pinned = !current.pinned; current.updatedAt = Date.now(); void persist(current).then(() => open(current!.id)); } };
  $('theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('toggle-sidebar').onclick = () => $('app').classList.toggle('sidebar-open');
  $('export-md').onclick = () => { if (current) { flush(); download(safeFilename(current.title), noteToMarkdown(current), 'text/markdown'); } };
  $('export-json').onclick = async () => { flush(); download(`marknest-backup-${new Date().toISOString().slice(0, 10)}.json`, toBackup(notes, await store.allHistory()), 'application/json'); };
  $('import').onclick = () => $('file').click();
  $<HTMLInputElement>('file').onchange = (e) => { const f = (e.target as HTMLInputElement).files; if (f?.length) void importFiles(f); (e.target as HTMLInputElement).value = ''; };
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view as View)));
  window.addEventListener('beforeunload', () => flush());
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); void newNote(); }
    else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); search.focus(); search.select(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); $('export-md').click(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flush(true); setStatus('Saved + snapshot'); }
    else if (e.altKey && e.key.toLowerCase() === 'h') { e.preventDefault(); togglePanel(); }
    else if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); const cur = workspace.classList[1] as View; setView(VIEWS[(VIEWS.indexOf(cur) + 1) % 3]); }
    else if (mod && e.target === editor && e.key.toLowerCase() === 'b') { e.preventDefault(); wrapSelection('**'); }
    else if (mod && e.target === editor && e.key.toLowerCase() === 'i') { e.preventDefault(); wrapSelection('_'); }
    else if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.altKey && e.key.toLowerCase() === 't') { e.preventDefault(); $('theme').click(); }
    else if (e.key === '?' && !inField) { e.preventDefault(); $<HTMLDialogElement>('help').showModal(); }
  });
}

async function init(): Promise<void> {
  applyTheme(localStorage.getItem('marknest-theme') ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  setView((localStorage.getItem('marknest-view') as View) || (innerWidth < 800 ? 'edit' : 'split'));
  bind();
  try { store = await NoteStore.open(); } catch (e) { setStatus('Storage unavailable: ' + (e as Error).message); return; }
  notes = await store.all();
  if (!notes.length && !localStorage.getItem('marknest-seeded')) {
    const n = createNote(WELCOME, ['welcome']);
    await store.put(n); notes = [n];
    localStorage.setItem('marknest-seeded', '1');
  }
  index = new SearchIndex(notes);
  refresh();
  if (localStorage.getItem('marknest-panel') === '1' || (localStorage.getItem('marknest-panel') === null && innerWidth > 1300)) togglePanel(true);
  open(notes.find((n) => n.id === location.hash.slice(1))?.id ?? notes[0]?.id ?? null);
  if ('storage' in navigator && navigator.storage.persist) void navigator.storage.persist();
  if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('./sw.js');
  addEventListener('online', () => setStatus('Online'));
  addEventListener('offline', () => setStatus('Offline — changes are saved locally'));
}

void init();
