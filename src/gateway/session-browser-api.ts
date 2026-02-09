/**
 * Session browser API — serves session log files over HTTP.
 *
 * Endpoints:
 *   GET /api/sessions          — list available session log files
 *   GET /api/sessions/:file    — get content of a specific session log
 *   GET /api/sessions?q=term   — search across session logs
 *   GET /sessions              — serve the session browser HTML page
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function sendHtml(res: ServerResponse, html: string) {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(html);
}

async function listSessionFiles(sessionsDir: string): Promise<
  Array<{
    name: string;
    size: number;
    modified: string;
  }>
> {
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) {
        continue;
      }
      const stat = await fs.stat(path.join(sessionsDir, entry.name));
      files.push({
        name: entry.name,
        size: stat.size,
        modified: stat.mtime.toISOString(),
      });
    }
    // Sort by modified date descending (most recent first)
    files.sort((a, b) => b.modified.localeCompare(a.modified));
    return files;
  } catch {
    return [];
  }
}

async function readSessionFile(sessionsDir: string, filename: string): Promise<string | null> {
  // Prevent directory traversal
  const safe = path.basename(filename);
  if (safe !== filename || !filename.endsWith(".md")) {
    return null;
  }
  try {
    return await fs.readFile(path.join(sessionsDir, safe), "utf-8");
  } catch {
    return null;
  }
}

async function searchSessions(
  sessionsDir: string,
  query: string,
): Promise<Array<{ file: string; matches: string[] }>> {
  const files = await listSessionFiles(sessionsDir);
  const results: Array<{ file: string; matches: string[] }> = [];
  const lowerQuery = query.toLowerCase();

  for (const file of files) {
    const content = await readSessionFile(sessionsDir, file.name);
    if (!content) {
      continue;
    }
    const lines = content.split("\n");
    const matches: string[] = [];
    for (const line of lines) {
      if (line.toLowerCase().includes(lowerQuery)) {
        matches.push(line.trim());
      }
    }
    if (matches.length > 0) {
      results.push({ file: file.name, matches: matches.slice(0, 10) });
    }
  }
  return results;
}

function buildSessionBrowserHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session Browser</title>
<style>
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --border: #1e1e2e;
    --text: #c8c8d4;
    --text-dim: #6e6e82;
    --accent: #cc9933;
    --accent-dim: #aa7722;
    --user: #5599cc;
    --assistant: #77bb77;
    --heading: #e0c080;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
    background: var(--bg);
    color: var(--text);
    padding: 1.5rem;
    line-height: 1.6;
  }
  h1 {
    color: var(--accent);
    font-size: 1.4rem;
    margin-bottom: 0.5rem;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .subtitle {
    color: var(--text-dim);
    font-size: 0.8rem;
    margin-bottom: 1.5rem;
  }
  .search-bar {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }
  .search-bar input {
    flex: 1;
    background: var(--surface);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 0.5rem 0.75rem;
    font-family: inherit;
    font-size: 0.85rem;
    border-radius: 4px;
  }
  .search-bar input::placeholder { color: var(--text-dim); }
  .search-bar input:focus { outline: none; border-color: var(--accent-dim); }
  .search-bar button {
    background: var(--accent-dim);
    border: none;
    color: var(--bg);
    padding: 0.5rem 1rem;
    font-family: inherit;
    font-weight: bold;
    cursor: pointer;
    border-radius: 4px;
  }
  .search-bar button:hover { background: var(--accent); }
  .file-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1.5rem;
  }
  .file-item {
    background: var(--surface);
    border: 1px solid var(--border);
    padding: 0.6rem 0.9rem;
    cursor: pointer;
    border-radius: 4px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    transition: border-color 0.15s;
  }
  .file-item:hover { border-color: var(--accent-dim); }
  .file-item.active { border-color: var(--accent); }
  .file-name { color: var(--heading); font-size: 0.85rem; }
  .file-meta { color: var(--text-dim); font-size: 0.7rem; }
  .content-area {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 1.2rem;
    min-height: 200px;
    white-space: pre-wrap;
    font-size: 0.82rem;
    overflow-x: auto;
  }
  .content-area h1, .content-area h2 {
    color: var(--heading);
    font-size: 1rem;
    margin: 0.8rem 0 0.4rem;
  }
  .content-area h1:first-child, .content-area h2:first-child { margin-top: 0; }
  .content-area strong { color: var(--user); }
  .content-area hr {
    border: none;
    border-top: 1px solid var(--border);
    margin: 0.8rem 0;
  }
  .empty { color: var(--text-dim); font-style: italic; }
  .search-results .match-file { color: var(--heading); margin: 0.5rem 0 0.2rem; }
  .search-results .match-line {
    color: var(--text);
    padding-left: 1rem;
    font-size: 0.8rem;
    border-left: 2px solid var(--accent-dim);
    margin: 0.2rem 0;
  }
  @media (min-width: 800px) {
    .layout { display: flex; gap: 1rem; }
    .sidebar { width: 300px; flex-shrink: 0; }
    .main { flex: 1; min-width: 0; }
  }
</style>
</head>
<body>
<h1>Session Browser</h1>
<p class="subtitle">View and search past session transcripts</p>
<div class="search-bar">
  <input id="search" type="text" placeholder="Search sessions...">
  <button onclick="doSearch()">Search</button>
</div>
<div class="layout">
  <div class="sidebar">
    <div id="files" class="file-list"><span class="empty">Loading...</span></div>
  </div>
  <div class="main">
    <div id="content" class="content-area"><span class="empty">Select a session to view</span></div>
  </div>
</div>
<script>
const base = window.location.pathname.replace(/\\/sessions\\/?$/, '');
async function loadFiles() {
  try {
    const res = await fetch(base + '/api/sessions');
    const files = await res.json();
    const el = document.getElementById('files');
    if (!files.length) {
      el.innerHTML = '<span class="empty">No session logs yet</span>';
      return;
    }
    el.innerHTML = files.map(f => {
      const sz = f.size > 1024 ? (f.size/1024).toFixed(1)+'K' : f.size+'B';
      const date = new Date(f.modified).toLocaleString();
      return '<div class="file-item" onclick="loadFile(\\''+f.name+'\\',this)">' +
        '<span class="file-name">'+f.name+'</span>' +
        '<span class="file-meta">'+sz+' · '+date+'</span></div>';
    }).join('');
  } catch(e) {
    document.getElementById('files').innerHTML = '<span class="empty">Failed to load sessions</span>';
  }
}
async function loadFile(name, el) {
  document.querySelectorAll('.file-item').forEach(e => e.classList.remove('active'));
  if (el) el.classList.add('active');
  try {
    const res = await fetch(base + '/api/sessions/' + encodeURIComponent(name));
    const text = await res.text();
    const content = document.getElementById('content');
    content.innerHTML = renderMarkdown(text);
  } catch(e) {
    document.getElementById('content').innerHTML = '<span class="empty">Failed to load file</span>';
  }
}
async function doSearch() {
  const q = document.getElementById('search').value.trim();
  if (!q) { loadFiles(); return; }
  try {
    const res = await fetch(base + '/api/sessions?q=' + encodeURIComponent(q));
    const results = await res.json();
    const content = document.getElementById('content');
    if (!results.length) {
      content.innerHTML = '<span class="empty">No matches found</span>';
      return;
    }
    content.innerHTML = '<div class="search-results">' + results.map(r =>
      '<div class="match-file">' + r.file + '</div>' +
      r.matches.map(m => '<div class="match-line">' + escapeHtml(m) + '</div>').join('')
    ).join('') + '</div>';
  } catch(e) {
    document.getElementById('content').innerHTML = '<span class="empty">Search failed</span>';
  }
}
function escapeHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function renderMarkdown(md) {
  return md.split('\\n').map(line => {
    if (line.startsWith('# ')) return '<h1>'+escapeHtml(line.slice(2))+'</h1>';
    if (line.startsWith('## ')) return '<h2>'+escapeHtml(line.slice(3))+'</h2>';
    if (line === '---') return '<hr>';
    if (line.startsWith('**User:**')) return '<div><strong>User:</strong> '+escapeHtml(line.slice(9))+'</div>';
    if (line.startsWith('**Assistant:**')) return '<div><strong style="color:var(--assistant)">Assistant:</strong> '+escapeHtml(line.slice(14))+'</div>';
    if (line.startsWith('- **')) {
      const m = line.match(/^- \\*\\*(.+?)\\*\\*:?\\s*(.*)/);
      if (m) return '<div><strong>'+escapeHtml(m[1])+'</strong>: '+escapeHtml(m[2])+'</div>';
    }
    return '<div>'+escapeHtml(line)+'</div>';
  }).join('');
}
document.getElementById('search').addEventListener('keydown', e => { if(e.key==='Enter') doSearch(); });
loadFiles();
</script>
</body>
</html>`;
}

export function handleSessionBrowserRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { workspaceDir: string; basePath?: string },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw || (req.method !== "GET" && req.method !== "HEAD")) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const pathname = url.pathname;
  const basePath = opts.basePath ?? "";
  const sessionsDir = path.join(opts.workspaceDir, "memory", "sessions");

  // Serve the session browser HTML page
  if (pathname === `${basePath}/sessions` || pathname === `${basePath}/sessions/`) {
    sendHtml(res, buildSessionBrowserHtml());
    return true;
  }

  // API: list or search sessions
  if (pathname === `${basePath}/api/sessions`) {
    const query = url.searchParams.get("q");
    if (query) {
      void searchSessions(sessionsDir, query).then(
        (results) => sendJson(res, 200, results),
        () => sendJson(res, 500, { error: "search failed" }),
      );
    } else {
      void listSessionFiles(sessionsDir).then(
        (files) => sendJson(res, 200, files),
        () => sendJson(res, 500, { error: "list failed" }),
      );
    }
    return true;
  }

  // API: get a specific session log file
  const filePrefix = `${basePath}/api/sessions/`;
  if (pathname.startsWith(filePrefix)) {
    const filename = decodeURIComponent(pathname.slice(filePrefix.length));
    void readSessionFile(sessionsDir, filename).then(
      (content) => {
        if (content === null) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        } else {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/markdown; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(content);
        }
      },
      () => sendJson(res, 500, { error: "read failed" }),
    );
    return true;
  }

  return false;
}
