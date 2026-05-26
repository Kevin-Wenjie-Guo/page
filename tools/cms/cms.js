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
const SECTIONS = ['investing', 'daily', 'appdev', 'strategy', 'meditation'];

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

function openPublishModal() {
  document.getElementById('commit-msg').value = '';
  document.getElementById('publish-output').style.display = 'none';
  document.getElementById('publish-modal').classList.add('open');
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

// Init
loadPosts();
loadGitStatus();
setInterval(loadGitStatus, 30000); // refresh git status every 30s
</script>
</body>
</html>`;
