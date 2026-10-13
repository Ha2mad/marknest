import './style.css';
import type { Note } from './core/types';
import { NoteStore, createNote, toBackup, parseBackup, mergeNotes, noteToMarkdown, markdownToNote, safeFilename } from './core/storage';
import { SearchIndex, snippet } from './core/search';
import { tagCounts, filterByTags, parseTagInput, noteTags } from './core/tags';
import { renderMarkdown, deriveTitle } from './core/markdown';
import { WELCOME } from './sample';

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

function renderPreview(): void { preview.innerHTML = renderMarkdown(editor.value); }

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
  saveTimer = window.setTimeout(flush, 400);
}

function flush(): void {
  clearTimeout(saveTimer);
  if (!current) return;
  const body = editor.value;
  const tags = parseTagInput(tagInput.value);
  if (body === current.body && tags.join() === current.tags.join()) return;
  Object.assign(current, { body, tags, title: deriveTitle(body), updatedAt: Date.now() });
  void persist(current).then(refresh);
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
  try {
    for (const f of Array.from(files)) {
      const text = await f.text();
      if (f.name.endsWith('.json')) incoming = incoming.concat(parseBackup(text));
      else incoming.push(markdownToNote(text, f.name.replace(/\.\w+$/, '')));
    }
  } catch (e) { alert('Import failed: ' + (e as Error).message); return; }
  const { merged, added, updated } = mergeNotes(notes, incoming);
  await store.putMany(merged);
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
  editor.addEventListener('input', () => { renderPreview(); scheduleSave(); });
  editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') { e.preventDefault(); editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end'); editor.dispatchEvent(new Event('input')); }
  });
  tagInput.addEventListener('input', scheduleSave);
  tagInput.addEventListener('change', flush);
  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => { if (e.key === 'Enter' && visible[0]) open(visible[0].id); if (e.key === 'Escape') { search.value = ''; renderList(); } });
  $('new-note').onclick = () => void newNote();
  $('delete').onclick = () => void deleteCurrent();
  $('clear-tags').onclick = () => { selectedTags = []; refresh(); };
  $('pin').onclick = () => { if (current) { current.pinned = !current.pinned; current.updatedAt = Date.now(); void persist(current).then(() => open(current!.id)); } };
  $('theme').onclick = () => applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  $('toggle-sidebar').onclick = () => $('app').classList.toggle('sidebar-open');
  $('export-md').onclick = () => { if (current) { flush(); download(safeFilename(current.title), noteToMarkdown(current), 'text/markdown'); } };
  $('export-json').onclick = () => { flush(); download(`marknest-backup-${new Date().toISOString().slice(0, 10)}.json`, toBackup(notes), 'application/json'); };
  $('import').onclick = () => $('file').click();
  $<HTMLInputElement>('file').onchange = (e) => { const f = (e.target as HTMLInputElement).files; if (f?.length) void importFiles(f); (e.target as HTMLInputElement).value = ''; };
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => (b.onclick = () => setView(b.dataset.view as View)));
  window.addEventListener('beforeunload', flush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flush(); });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (e.altKey && e.key.toLowerCase() === 'n') { e.preventDefault(); void newNote(); }
    else if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); search.focus(); search.select(); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); $('export-md').click(); }
    else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); flush(); setStatus('Saved'); }
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
  open(notes.find((n) => n.id === location.hash.slice(1))?.id ?? notes[0]?.id ?? null);
  if ('storage' in navigator && navigator.storage.persist) void navigator.storage.persist();
  if ('serviceWorker' in navigator && import.meta.env.PROD) void navigator.serviceWorker.register('./sw.js');
  addEventListener('online', () => setStatus('Online'));
  addEventListener('offline', () => setStatus('Offline — changes are saved locally'));
}

void init();
