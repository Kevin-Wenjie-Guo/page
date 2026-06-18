#!/usr/bin/env node
/**
 * Kevin's Place CMS
 * A zero-dependency mini CMS for managing the Quarto site.
 *
 * Lives at: <repo-root>/tools/cms/cms.js
 *
 * Usage:
 *   node cms.js                  # auto-detect repo root (../../ from this file)
 *   node cms.js <path-to-repo>   # explicit override
 */

const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const execP = promisify(exec);

// Default: assume cms.js lives at <repo>/tools/cms/cms.js, walk up two levels
const REPO_PATH = process.argv[2] || path.resolve(__dirname, '..', '..');
const PORT = 4321;
const SECTIONS = ['investing', 'daily', 'appdev', 'strategy', 'meditation', 'learning'];

// ─── Helpers ──────────────────────────────────────────────────────────────

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const yaml = match[1];
  const body = match[2];
  const frontmatter = {};

  // Simple YAML parser for our limited use case
  const lines = yaml.split(/\r?\n/);
  let currentKey = null;
  let arrayMode = false;

  for (const line of lines) {
    if (!line.trim()) continue;
    const kvMatch = line.match(/^([a-zA-Z_-]+):\s*(.*)$/);
    if (kvMatch) {
      currentKey = kvMatch[1];
      let value = kvMatch[2].trim();
      // Strip quotes
      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      }
      // Array detection
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      }
      frontmatter[currentKey] = value;
    }
  }
  return { frontmatter, body };
}

function serializeFrontmatter(fm, body) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fm)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map(v => v).join(', ')}]`);
    } else if (typeof value === 'string' && value.includes(':')) {
      lines.push(`${key}: "${value.replace(/"/g, '\\"')}"`);
    } else {
      lines.push(`${key}: "${value}"`);
    }
  }
  lines.push('---', '');
  return lines.join('\n') + body;
}

// ─── File operations ──────────────────────────────────────────────────────

async function listAllPosts() {
  const result = {};
  for (const section of SECTIONS) {
    const sectionDir = path.join(REPO_PATH, section);
    result[section] = [];
    try {
      const entries = await fsp.readdir(sectionDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
        const indexPath = path.join(sectionDir, entry.name, 'index.qmd');
        try {
          const content = await fsp.readFile(indexPath, 'utf8');
          const { frontmatter } = parseFrontmatter(content);
          result[section].push({
            slug: entry.name,
            title: frontmatter.title || entry.name,
            date: frontmatter.date || '',
            categories: frontmatter.categories || [],
            description: frontmatter.description || '',
          });
        } catch (e) { /* skip */ }
      }
      result[section].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    } catch (e) { /* section dir missing, skip */ }
  }
  return result;
}

async function readPost(section, slug) {
  const filePath = path.join(REPO_PATH, section, slug, 'index.qmd');
  const content = await fsp.readFile(filePath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(content);
  return { section, slug, frontmatter, body };
}

async function writePost(section, slug, frontmatter, body) {
  const dir = path.join(REPO_PATH, section, slug);
  await fsp.mkdir(dir, { recursive: true });
  const content = serializeFrontmatter(frontmatter, body);
  await fsp.writeFile(path.join(dir, 'index.qmd'), content, 'utf8');
}

async function deletePost(section, slug) {
  const dir = path.join(REPO_PATH, section, slug);
  await fsp.rm(dir, { recursive: true, force: true });
}

// ─── Markdown import (drag-and-drop) ──────────────────────────────────────

// Find all local image references in markdown.
// Returns array of { full, alt, path, basename }
// Skips http(s):// and data: URIs.
function extractImageRefs(markdown) {
  const refs = [];
  // Matches ![alt](path) and ![alt](path "title"), allowing relative paths
  const re = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const fullPath = m[2];
    if (/^(https?:|data:|\/\/)/i.test(fullPath)) continue;
    const basename = path.posix.basename(fullPath.split('?')[0].split('#')[0]);
    refs.push({ full: m[0], alt: m[1], path: fullPath, basename });
  }
  return refs;
}

// Rewrite image references in markdown to use bare basenames (co-located).
function rewriteImagePaths(markdown, refs) {
  let out = markdown;
  for (const r of refs) {
    if (r.path === r.basename) continue; // already bare
    const newRef = `![${r.alt}](${r.basename})`;
    out = out.split(r.full).join(newRef);
  }
  return out;
}

// Write a post imported from drag-and-drop along with its images.
async function importPost(section, slug, frontmatter, body, images) {
  const dir = path.join(REPO_PATH, section, slug);
  await fsp.mkdir(dir, { recursive: true });
  const content = serializeFrontmatter(frontmatter, body);
  await fsp.writeFile(path.join(dir, 'index.qmd'), content, 'utf8');
  for (const img of images || []) {
    const safeName = path.basename(img.filename); // strip any path traversal
    const buf = Buffer.from(img.base64, 'base64');
    await fsp.writeFile(path.join(dir, safeName), buf);
  }
}

// ─── Git operations ───────────────────────────────────────────────────────

async function gitStatus() {
  const { stdout } = await execP('git status --porcelain', { cwd: REPO_PATH });
  const lines = stdout.split('\n').filter(l => l.trim());
  return {
    changes: lines.length,
    files: lines.map(l => ({
      status: l.substring(0, 2).trim(),
      path: l.substring(3).trim(),
    })),
  };
}

async function gitPull() {
  const { stdout, stderr } = await execP('git pull', { cwd: REPO_PATH });
  return { output: stdout + stderr };
}

// Read the title field from a .qmd file's frontmatter (best-effort).
async function readQmdTitle(relPath) {
  try {
    const abs = path.join(REPO_PATH, relPath);
    const content = await fsp.readFile(abs, 'utf8');
    const { frontmatter } = parseFrontmatter(content);
    return frontmatter.title || path.basename(path.dirname(relPath));
  } catch (e) {
    return null;
  }
}

// Build a sensible commit message from current `git status` output.
async function suggestCommitMessage() {
  const { stdout } = await execP('git status --porcelain', { cwd: REPO_PATH });
  const lines = stdout.split('\n').filter(l => l.trim());
  if (lines.length === 0) return { message: '', summary: 'nothing to commit' };

  const added = [];
  const modified = [];
  const deleted = [];
  const otherFiles = [];

  for (const line of lines) {
    const status = line.substring(0, 2).trim();
    const filePath = line.substring(3).trim();
    // Match post index.qmd files
    const postMatch = filePath.match(/^([^/]+)\/([^/]+)\/index\.qmd$/);
    if (postMatch) {
      const [, section, slug] = postMatch;
      if (status.includes('A') || status === '??') {
        const title = await readQmdTitle(filePath);
        added.push({ section, slug, title });
      } else if (status.includes('M')) {
        const title = await readQmdTitle(filePath);
        modified.push({ section, slug, title });
      } else if (status.includes('D')) {
        deleted.push({ section, slug });
      }
    } else {
      otherFiles.push({ status, filePath });
    }
  }

  // Construct message
  const parts = [];
  if (added.length === 1) {
    parts.push(`Add post: ${added[0].title}`);
  } else if (added.length > 1) {
    parts.push(`Add ${added.length} posts: ${added.map(p => p.title).join(', ')}`);
  }
  if (modified.length === 1) {
    parts.push(`Update post: ${modified[0].title}`);
  } else if (modified.length > 1) {
    parts.push(`Update ${modified.length} posts: ${modified.map(p => p.title).join(', ')}`);
  }
  if (deleted.length > 0) {
    parts.push(`Delete ${deleted.length} post(s)`);
  }
  if (parts.length === 0 && otherFiles.length > 0) {
    // Other files only (e.g. config, images, CMS code)
    parts.push(`Update site files (${otherFiles.length} change${otherFiles.length > 1 ? 's' : ''})`);
  }

  const message = parts.join('; ').slice(0, 200); // keep reasonable
  return {
    message,
    summary: `${added.length} added, ${modified.length} modified, ${deleted.length} deleted, ${otherFiles.length} other`,
    added, modified, deleted, otherFiles,
  };
}

async function gitPublish(message) {
  const safeMessage = (message || `Update posts ${new Date().toISOString().split('T')[0]}`).replace(/"/g, '\\"');
  const cmds = [
    'git add -A',
    `git commit -m "${safeMessage}"`,
    'git push origin master',
  ];
  let output = '';
  for (const cmd of cmds) {
    try {
      const { stdout, stderr } = await execP(cmd, { cwd: REPO_PATH });
      output += `\n$ ${cmd}\n${stdout}${stderr}`;
    } catch (e) {
      output += `\n$ ${cmd}\nERROR: ${e.message}\n${e.stdout || ''}${e.stderr || ''}`;
      // If commit fails (nothing to commit), still try push
      if (!cmd.includes('commit')) throw e;
    }
  }
  return { output };
}

// ─── HTTP routing ─────────────────────────────────────────────────────────

async function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => resolve(data));
  });
}

function jsonResponse(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function handleApi(req, res, urlPath) {
  try {
    if (urlPath === '/api/posts' && req.method === 'GET') {
      return jsonResponse(res, 200, await listAllPosts());
    }
    if (urlPath === '/api/git/status' && req.method === 'GET') {
      return jsonResponse(res, 200, await gitStatus());
    }
    if (urlPath === '/api/git/pull' && req.method === 'POST') {
      return jsonResponse(res, 200, await gitPull());
    }
    if (urlPath === '/api/git/publish' && req.method === 'POST') {
      const body = await readBody(req);
      const { message } = body ? JSON.parse(body) : {};
      return jsonResponse(res, 200, await gitPublish(message));
    }
    if (urlPath === '/api/git/suggest-message' && req.method === 'GET') {
      return jsonResponse(res, 200, await suggestCommitMessage());
    }
    if (urlPath === '/api/post/import' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { section, slug, title, date, categories, description, content, images } = body;
      const fm = {
        title, date,
        author: 'Kevin Guo',
        categories: categories || [],
        description: description || '',
      };
      // Normalize image paths in body before writing
      const refs = extractImageRefs(content);
      const rewritten = rewriteImagePaths(content, refs);
      await importPost(section, slug, fm, rewritten, images || []);
      return jsonResponse(res, 200, {
        ok: true,
        slug,
        imagesWritten: (images || []).length,
        imageRefsFound: refs.length,
      });
    }
    if (urlPath === '/api/post' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req));
      const { section, slug, title, date, categories, description, content } = body;
      const fm = {
        title, date,
        author: 'Kevin Guo',
        categories: categories || [],
        description: description || '',
      };
      await writePost(section, slug, fm, content);
      return jsonResponse(res, 200, { ok: true, slug });
    }
    const postMatch = urlPath.match(/^\/api\/post\/([^/]+)\/([^/]+)$/);
    if (postMatch) {
      const [, section, slug] = postMatch;
      if (req.method === 'GET') {
        return jsonResponse(res, 200, await readPost(section, slug));
      }
      if (req.method === 'DELETE') {
        await deletePost(section, slug);
        return jsonResponse(res, 200, { ok: true });
      }
    }
    jsonResponse(res, 404, { error: 'not found' });
  } catch (e) {
    jsonResponse(res, 500, { error: e.message });
  }
}

// ─── Server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url.pathname);
  }
  // Serve the HTML UI
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(HTML);
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log(`\n╔════════════════════════════════════════════════╗`);
  console.log(`║   Kevin's Place CMS                            ║`);
  console.log(`║   Repo: ${REPO_PATH.padEnd(40)}║`);
  console.log(`║   URL:  ${url.padEnd(40)}║`);
  console.log(`╚════════════════════════════════════════════════╝\n`);
  // Auto-open browser on Windows
  exec(`start ${url}`);
});

// ─── Inline HTML/CSS/JS ───────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>Kevin's Place CMS</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: #0f172a;
  --bg2: #1e293b;
  --bg3: #334155;
  --fg: #e2e8f0;
  --fg-dim: #94a3b8;
  --accent: #38bdf8;
  --accent2: #fbbf24;
  --good: #4ade80;
  --bad: #f87171;
  --border: #334155;
}
body { font: 14px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: var(--bg); color: var(--fg); padding: 24px; }
header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; padding-bottom: 16px; border-bottom: 1px solid var(--border); }
h1 { font-size: 22px; background: linear-gradient(135deg, var(--accent), var(--accent2)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
h2 { font-size: 16px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 1.5px; margin: 24px 0 12px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
button { background: var(--bg2); color: var(--fg); border: 1px solid var(--border); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; transition: all 0.15s; }
button:hover { background: var(--bg3); border-color: var(--accent); }
button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }
button.primary:hover { background: var(--accent2); border-color: var(--accent2); }
button.danger { background: transparent; color: var(--bad); border-color: var(--bad); }
button.danger:hover { background: var(--bad); color: var(--bg); }
input, select, textarea { background: var(--bg2); color: var(--fg); border: 1px solid var(--border); padding: 8px 12px; border-radius: 6px; font: inherit; width: 100%; }
input:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent); }
textarea { font-family: "Consolas", "Monaco", monospace; min-height: 500px; resize: vertical; }
.row { display: flex; gap: 12px; align-items: center; }
.row > * { flex: 1; }
.row.compact > * { flex: 0; }
label { display: block; font-size: 12px; color: var(--fg-dim); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 4px; margin-top: 12px; }
.post-card { background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; margin-bottom: 8px; cursor: pointer; transition: all 0.15s; }
.post-card:hover { border-color: var(--accent); transform: translateX(4px); }
.post-card .title { font-weight: 600; color: var(--fg); margin-bottom: 4px; }
.post-card .meta { font-size: 12px; color: var(--fg-dim); }
.tag { display: inline-block; background: var(--bg3); color: var(--accent); padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-right: 4px; }
.empty { color: var(--fg-dim); font-style: italic; padding: 12px 16px; }
.git-status { background: var(--bg2); border-left: 4px solid var(--accent); padding: 12px 16px; border-radius: 6px; margin: 24px 0; font-family: "Consolas", monospace; font-size: 13px; white-space: pre-wrap; }
.git-status.dirty { border-color: var(--accent2); }
.git-status.error { border-color: var(--bad); color: var(--bad); }
.actions { display: flex; gap: 8px; margin: 16px 0; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: none; align-items: center; justify-content: center; z-index: 100; }
.modal.open { display: flex; }
.modal-content { background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 24px; max-width: 1000px; width: 90vw; max-height: 90vh; overflow-y: auto; }
.toast { position: fixed; bottom: 24px; right: 24px; background: var(--bg2); border: 1px solid var(--accent); padding: 12px 20px; border-radius: 6px; opacity: 0; transition: opacity 0.3s; z-index: 200; }
.toast.show { opacity: 1; }
.toast.error { border-color: var(--bad); }
.toast.success { border-color: var(--good); }
.section-pill { display: inline-block; background: var(--bg3); padding: 2px 8px; border-radius: 4px; font-size: 11px; color: var(--accent); margin-right: 8px; }
.muted { color: var(--fg-dim); }
hr { border: none; border-top: 1px solid var(--border); margin: 16px 0; }
.dropzone { border: 2px dashed var(--border); border-radius: 8px; padding: 24px; text-align: center; color: var(--fg-dim); margin-bottom: 16px; transition: all 0.15s; cursor: pointer; }
.dropzone:hover, .dropzone.drag-over { border-color: var(--accent); background: rgba(56, 189, 248, 0.05); color: var(--fg); }
.dropzone .hint { font-size: 12px; margin-top: 6px; }
.dropzone strong { color: var(--accent); }
.import-summary { background: var(--bg2); border: 1px solid var(--accent); border-radius: 6px; padding: 12px 16px; margin: 12px 0; font-size: 13px; }
.import-summary .file-row { padding: 4px 0; color: var(--fg-dim); }
.import-summary .file-row.image::before { content: "🖼 "; }
.import-summary .file-row.markdown::before { content: "📄 "; color: var(--accent); }
.import-summary .file-row.warn::before { content: "⚠ "; color: var(--accent2); }
</style>
</head>
<body>

<header>
  <h1>📝 Kevin's Place CMS</h1>
  <div class="row compact">
    <button onclick="newPost()">+ New Post</button>
    <button onclick="syncPull()">↻ Sync</button>
    <button class="primary" onclick="openPublishModal()">🚀 Publish</button>
  </div>
</header>

<div id="git-status" class="git-status">Loading git status...</div>

<div id="dropzone" class="dropzone">
  📥 <strong>拖拽 Markdown 文件 + 图片</strong> 到这里直接导入
  <div class="hint">把 .md / .qmd 文件和它引用的所有图片（PNG / JPG / SVG / GIF）一起选中，拖进来。系统会自动转换为 Quarto post，图片随之入库。</div>
</div>

<div id="posts-container"></div>

<!-- Editor modal -->
<div id="editor-modal" class="modal">
  <div class="modal-content">
    <div class="row" style="align-items: center; margin-bottom: 16px;">
      <h2 id="editor-title" style="border: none; margin: 0;">New Post</h2>
      <div class="row compact">
        <button onclick="closeEditor()">Cancel</button>
        <button class="danger" id="delete-btn" onclick="deletePostHandler()" style="display: none;">🗑 Delete</button>
        <button class="primary" onclick="savePost()">💾 Save</button>
      </div>
    </div>

    <div class="row">
      <div>
        <label>Title</label>
        <input id="f-title" placeholder="文章标题">
      </div>
      <div style="max-width: 200px;">
        <label>Section</label>
        <select id="f-section">
          <option value="investing">investing</option>
          <option value="daily">daily</option>
          <option value="appdev">appdev</option>
          <option value="strategy">strategy</option>
          <option value="meditation">meditation</option>
        </select>
      </div>
      <div style="max-width: 160px;">
        <label>Date</label>
        <input id="f-date" type="date">
      </div>
    </div>

    <div class="row">
      <div>
        <label>Slug (URL 路径，留空自动生成)</label>
        <input id="f-slug" placeholder="auto-generated-from-title">
      </div>
      <div>
        <label>Categories (逗号分隔)</label>
        <input id="f-categories" placeholder="SpaceX, IPO, US Equity">
      </div>
    </div>

    <label>Description</label>
    <input id="f-description" placeholder="一句话描述，会显示在 listing 页">

    <label>Content (Markdown / Quarto)</label>
    <textarea id="f-content" placeholder="# 写正文..."></textarea>
  </div>
</div>

<!-- Publish modal -->
<div id="publish-modal" class="modal">
  <div class="modal-content" style="max-width: 600px;">
    <h2 style="border: none; margin-bottom: 16px;">🚀 Publish to GitHub</h2>
    <p class="muted" style="margin-bottom: 16px;">将自动执行 git add + commit + push。GitHub Actions 会在 1-2 分钟内 rebuild 站点。</p>
    <label>Commit Message (可空，自动生成)</label>
    <input id="commit-msg" placeholder="Update posts">
    <div class="row" style="margin-top: 16px; justify-content: flex-end;">
      <button onclick="closePublish()">Cancel</button>
      <button class="primary" onclick="publishNow()">🚀 Publish</button>
    </div>
    <pre id="publish-output" style="margin-top: 16px; background: var(--bg2); padding: 12px; border-radius: 6px; max-height: 300px; overflow: auto; font-size: 12px; display: none;"></pre>
  </div>
</div>

<div id="toast" class="toast"></div>

<script>
let currentEditing = null;

async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

function toast(msg, kind = 'success') {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast ' + kind + ' show';
  setTimeout(() => t.classList.remove('show'), 3000);
}

async function loadPosts() {
  const data = await api('/api/posts');
  const container = document.getElementById('posts-container');
  container.innerHTML = '';
  for (const [section, posts] of Object.entries(data)) {
    const h2 = document.createElement('h2');
    h2.textContent = section + '  (' + posts.length + ')';
    container.appendChild(h2);
    if (posts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '— 这个版块还没有文章 —';
      container.appendChild(empty);
      continue;
    }
    for (const p of posts) {
      const card = document.createElement('div');
      card.className = 'post-card';
      const cats = (Array.isArray(p.categories) ? p.categories : [])
        .map(c => '<span class="tag">' + c + '</span>').join('');
      card.innerHTML =
        '<div class="title">' + escapeHtml(p.title) + '</div>' +
        '<div class="meta">' +
          '<span class="section-pill">' + section + '</span>' +
          '<span>📅 ' + (p.date || 'no date') + '</span>' +
          '&nbsp;&nbsp;' + cats +
        '</div>';
      card.onclick = () => openEditor(section, p.slug);
      container.appendChild(card);
    }
  }
}

async function loadGitStatus() {
  try {
    const data = await api('/api/git/status');
    const el = document.getElementById('git-status');
    if (data.changes === 0) {
      el.className = 'git-status';
      el.textContent = '✓ 工作树干净，所有改动已发布';
    } else {
      el.className = 'git-status dirty';
      el.textContent = '⚠ ' + data.changes + ' 处未提交改动:\\n\\n' +
        data.files.map(f => '  [' + f.status + '] ' + f.path).join('\\n');
    }
  } catch (e) {
    document.getElementById('git-status').className = 'git-status error';
    document.getElementById('git-status').textContent = '✗ ' + e.message;
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function newPost() {
  currentEditing = null;
  document.getElementById('editor-title').textContent = '+ New Post';
  document.getElementById('f-title').value = '';
  document.getElementById('f-section').value = 'investing';
  document.getElementById('f-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('f-slug').value = '';
  document.getElementById('f-categories').value = '';
  document.getElementById('f-description').value = '';
  document.getElementById('f-content').value = '';
  document.getElementById('delete-btn').style.display = 'none';
  document.getElementById('editor-modal').classList.add('open');
}

async function openEditor(section, slug) {
  const data = await api('/api/post/' + section + '/' + slug);
  currentEditing = { section, slug };
  document.getElementById('editor-title').textContent = 'Editing: ' + data.frontmatter.title;
  document.getElementById('f-title').value = data.frontmatter.title || '';
  document.getElementById('f-section').value = section;
  document.getElementById('f-date').value = (data.frontmatter.date || '').slice(0,10);
  document.getElementById('f-slug').value = slug;
  const cats = data.frontmatter.categories;
  document.getElementById('f-categories').value = Array.isArray(cats) ? cats.join(', ') : (cats || '');
  document.getElementById('f-description').value = data.frontmatter.description || '';
  document.getElementById('f-content').value = data.body || '';
  document.getElementById('delete-btn').style.display = 'inline-block';
  document.getElementById('editor-modal').classList.add('open');
}

function closeEditor() {
  document.getElementById('editor-modal').classList.remove('open');
}

function slugify(t) {
  return t.toLowerCase().replace(/[^a-z0-9\\s-]/g, '').replace(/\\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

async function savePost() {
  const title = document.getElementById('f-title').value.trim();
  if (!title) return toast('标题不能为空', 'error');
  const section = document.getElementById('f-section').value;
  const date = document.getElementById('f-date').value;
  let slug = document.getElementById('f-slug').value.trim();
  if (!slug) slug = slugify(title);
  const categories = document.getElementById('f-categories').value
    .split(',').map(s => s.trim()).filter(Boolean);
  const description = document.getElementById('f-description').value;
  const content = document.getElementById('f-content').value;

  try {
    const r = await api('/api/post', 'POST', {
      section, slug, title, date, categories, description, content
    });
    if (r.error) throw new Error(r.error);
    toast('已保存: ' + section + '/' + slug);
    closeEditor();
    loadPosts();
    loadGitStatus();
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
}

async function deletePostHandler() {
  if (!currentEditing) return;
  if (!confirm('确认删除 ' + currentEditing.section + '/' + currentEditing.slug + ' 吗？此操作不可逆。')) return;
  try {
    await api('/api/post/' + currentEditing.section + '/' + currentEditing.slug, 'DELETE');
    toast('已删除');
    closeEditor();
    loadPosts();
    loadGitStatus();
  } catch (e) {
    toast('删除失败: ' + e.message, 'error');
  }
}

async function syncPull() {
  toast('正在拉取远程更新...');
  try {
    const r = await api('/api/git/pull', 'POST');
    toast('同步完成');
    loadPosts();
    loadGitStatus();
  } catch (e) {
    toast('同步失败: ' + e.message, 'error');
  }
}

async function openPublishModal() {
  const msgInput = document.getElementById('commit-msg');
  msgInput.value = '';
  msgInput.placeholder = '正在生成建议...';
  document.getElementById('publish-output').style.display = 'none';
  document.getElementById('publish-modal').classList.add('open');
  try {
    const r = await api('/api/git/suggest-message');
    msgInput.value = r.message || '';
    msgInput.placeholder = r.summary || '可空，自动生成';
  } catch (e) {
    msgInput.placeholder = '可空，自动生成';
  }
}

function closePublish() {
  document.getElementById('publish-modal').classList.remove('open');
}

async function publishNow() {
  const message = document.getElementById('commit-msg').value;
  const out = document.getElementById('publish-output');
  out.style.display = 'block';
  out.textContent = '正在发布...';
  try {
    const r = await api('/api/git/publish', 'POST', { message });
    out.textContent = r.output || JSON.stringify(r);
    toast('发布完成 ✓ GitHub Actions 1-2 分钟后会重建站点', 'success');
    loadGitStatus();
  } catch (e) {
    out.textContent = 'ERROR: ' + e.message;
    toast('发布失败', 'error');
  }
}

// ─── Markdown drag-and-drop import ─────────────────────────────────────

const MD_EXTS = ['.md', '.qmd', '.markdown'];
const IMG_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp'];

const dropzone = document.getElementById('dropzone');
let importBuffer = null; // { markdown, images, refs, missing }

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('drag-over');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag-over'));
dropzone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files);
  await handleDroppedFiles(files);
});

function fileExt(name) {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i).toLowerCase() : '';
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsText(file, 'utf-8');
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = r.result;
      const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      resolve(base64);
    };
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

// Parse YAML frontmatter from a markdown text (simple version, matches server)
function parseFrontmatterClient(content) {
  const m = content.match(/^---\\r?\\n([\\s\\S]*?)\\r?\\n---\\r?\\n([\\s\\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const yaml = m[1];
  const body = m[2];
  const fm = {};
  for (const line of yaml.split(/\\r?\\n/)) {
    if (!line.trim()) continue;
    const kv = line.match(/^([a-zA-Z_-]+):\\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    }
    fm[kv[1]] = v;
  }
  return { frontmatter: fm, body };
}

// Find image references in markdown (basenames only)
function findImageRefs(markdown) {
  const refs = [];
  const re = /!\\[([^\\]]*)\\]\\(([^)\\s]+)(?:\\s+"[^"]*")?\\)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const p = m[2];
    if (/^(https?:|data:|\\/\\/)/i.test(p)) continue;
    const basename = p.split('/').pop().split('\\\\').pop().split('?')[0].split('#')[0];
    refs.push({ alt: m[1], path: p, basename });
  }
  return refs;
}

async function handleDroppedFiles(files) {
  const mdFiles = files.filter(f => MD_EXTS.includes(fileExt(f.name)));
  const imgFiles = files.filter(f => IMG_EXTS.includes(fileExt(f.name)));

  if (mdFiles.length === 0) {
    toast('没找到 Markdown 文件 (.md / .qmd)', 'error');
    return;
  }
  if (mdFiles.length > 1) {
    toast('一次只能拖一个 Markdown 文件 (拖了 ' + mdFiles.length + ' 个)', 'error');
    return;
  }

  const mdFile = mdFiles[0];
  const mdText = await readFileAsText(mdFile);
  const { frontmatter, body } = parseFrontmatterClient(mdText);
  const refs = findImageRefs(body);

  // Match images by basename
  const imgByBasename = {};
  for (const f of imgFiles) imgByBasename[f.name.toLowerCase()] = f;
  const matched = [];
  const missing = [];
  for (const r of refs) {
    const f = imgByBasename[r.basename.toLowerCase()];
    if (f) matched.push({ ref: r, file: f });
    else missing.push(r);
  }

  // Read matched images as base64
  const images = [];
  for (const m of matched) {
    images.push({
      filename: m.ref.basename,
      base64: await readFileAsBase64(m.file),
    });
  }

  importBuffer = {
    markdown: body,
    frontmatter,
    images,
    refsFound: refs.length,
    missingImages: missing.map(r => r.basename),
  };

  // Open editor pre-filled
  newPost();
  if (frontmatter.title) document.getElementById('f-title').value = frontmatter.title;
  else {
    // Fallback: derive from first H1 or filename
    const h1 = body.match(/^#\\s+(.+)$/m);
    document.getElementById('f-title').value = h1 ? h1[1].trim() : mdFile.name.replace(/\\.(md|qmd|markdown)$/i, '');
  }
  if (frontmatter.date) document.getElementById('f-date').value = String(frontmatter.date).slice(0, 10);
  if (frontmatter.categories) {
    const cats = Array.isArray(frontmatter.categories) ? frontmatter.categories : [frontmatter.categories];
    document.getElementById('f-categories').value = cats.join(', ');
  }
  if (frontmatter.description) document.getElementById('f-description').value = frontmatter.description;
  document.getElementById('f-content').value = body;

  // Show import summary at top of editor
  const editorHeader = document.getElementById('editor-title');
  editorHeader.textContent = '📥 Importing: ' + mdFile.name;
  let summaryHtml = '<div class="import-summary">' +
    '<div class="file-row markdown">' + escapeHtml(mdFile.name) + ' (' + (mdText.length / 1024).toFixed(1) + ' KB)</div>';
  for (const m of matched) {
    summaryHtml += '<div class="file-row image">' + escapeHtml(m.ref.basename) + ' → 将随 post 入库</div>';
  }
  for (const b of missing) {
    summaryHtml += '<div class="file-row warn">引用了 ' + escapeHtml(b) + ' 但没拖进来——保存后该图片会显示为破损链接</div>';
  }
  summaryHtml += '</div>';

  // Inject summary
  let existing = document.getElementById('import-summary');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'import-summary';
  div.innerHTML = summaryHtml;
  editorHeader.parentNode.parentNode.insertBefore(div, editorHeader.parentNode.nextSibling);

  toast('已导入 ' + mdFile.name + '，匹配 ' + matched.length + ' / ' + refs.length + ' 张图');
}

// Override savePost to also send images when importing
const _origSavePost = savePost;
savePost = async function() {
  if (!importBuffer || !importBuffer.images.length) {
    return _origSavePost();
  }
  // Build payload with images
  const title = document.getElementById('f-title').value.trim();
  if (!title) return toast('标题不能为空', 'error');
  const section = document.getElementById('f-section').value;
  const date = document.getElementById('f-date').value;
  let slug = document.getElementById('f-slug').value.trim();
  if (!slug) slug = slugify(title);
  const categories = document.getElementById('f-categories').value
    .split(',').map(s => s.trim()).filter(Boolean);
  const description = document.getElementById('f-description').value;
  const content = document.getElementById('f-content').value;
  try {
    const r = await api('/api/post/import', 'POST', {
      section, slug, title, date, categories, description, content,
      images: importBuffer.images,
    });
    if (r.error) throw new Error(r.error);
    toast('已保存 ' + section + '/' + slug + '，' + r.imagesWritten + ' 张图入库');
    importBuffer = null;
    const sum = document.getElementById('import-summary');
    if (sum) sum.remove();
    closeEditor();
    loadPosts();
    loadGitStatus();
  } catch (e) {
    toast('保存失败: ' + e.message, 'error');
  }
};

// Init
loadPosts();
loadGitStatus();
setInterval(loadGitStatus, 30000); // refresh git status every 30s
</script>
</body>
</html>`;
