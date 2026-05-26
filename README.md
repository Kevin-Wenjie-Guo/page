# Kevin's Place

Personal website built with [Quarto](https://quarto.org), hosted on GitHub Pages.

🔗 **Live site**: https://kevin-wenjie-guo.github.io/page/

Topics: Investing · Technology · Strategy · Life

---

## Repository structure

```
page/
├── _quarto.yml             # Quarto site config
├── styles.css              # Custom styles
├── _security-headers.html  # Security headers (CSP etc.)
│
├── index.qmd               # Homepage
├── about.qmd               # About page
├── mystory.qmd             # Personal story
│
├── investing/              # Investing & equity research posts
├── daily/                  # Daily writing posts
├── appdev/                 # App development posts
├── strategy/               # Strategy & management posts
├── meditation/             # Meditation & life posts
│
├── tools/
│   └── cms/                # Local web-based CMS for managing posts
│       ├── cms.js          # Single-file Node.js server (zero dependencies)
│       ├── start.bat       # Windows launcher
│       └── start.sh        # macOS / Linux launcher
│
└── _site/                  # Generated static site (Quarto output)
```

Each post lives in its own folder: `<section>/<slug>/index.qmd`. The Quarto listing pages (e.g. `investing/index.qmd`) auto-collect all posts in the section.

---

## Local CMS — visual post management & one-click publish

This repo ships with a small zero-dependency Node.js CMS at `tools/cms/`. It's a local web app that lets you create, edit, and publish posts visually instead of editing `.qmd` files by hand.

### What it does

- 📝 **Dashboard** — list all posts across all sections (investing / daily / appdev / strategy / meditation), sorted by date
- ✏️ **Editor** — form for frontmatter (title, date, categories, description) + textarea for the markdown body
- 🆕 **New post** — automatically creates `<section>/<slug>/index.qmd` matching the Quarto listing convention
- 💾 **Save** — writes directly to disk
- 📡 **Git status** — top banner shows how many uncommitted changes you have, refreshes every 30s
- ↻ **Sync** — `git pull` to grab remote updates (useful if you write from multiple machines)
- 🚀 **Publish** — one click runs `git add -A` + `git commit -m "<your message>"` + `git push`. GitHub Actions rebuilds the site in 1-2 minutes.
- 🗑 **Delete** — remove a post folder (with confirm)

### Requirements

- **Node.js 18+** ([download](https://nodejs.org)) — that's it. No `npm install`, no Python, no Quarto needed locally.
- A working git setup with push access to this repo (your usual SSH key or HTTPS credential).

### Quick start

```bash
# 1. Clone the repo
git clone https://github.com/Kevin-Wenjie-Guo/page.git
cd page

# 2. Launch the CMS
#    Windows: double-click tools/cms/start.bat
#    macOS / Linux: bash tools/cms/start.sh
#    Or manually:
node tools/cms/cms.js
```

Your browser will auto-open at http://localhost:4321.

### Workflow

1. Open the CMS (double-click `start.bat` or run `node tools/cms/cms.js`)
2. Browser shows the dashboard with all existing posts
3. Click `+ New Post` to write a new article, or click any existing card to edit it
4. Fill out the form, write markdown in the content textarea, hit `💾 Save`
5. Top banner now reads `⚠ N 处未提交改动`
6. Click `🚀 Publish`, optionally enter a commit message, hit `🚀 Publish` again
7. Wait 1-2 minutes — GitHub Actions rebuilds the site and your post is live at https://kevin-wenjie-guo.github.io/page/

### Configuration

The CMS auto-detects the repo root (it lives at `<repo>/tools/cms/cms.js` and walks up two directories). If you want to point it at a different repo:

```bash
node tools/cms/cms.js /path/to/other/repo
```

Default port is `4321`. Change `const PORT = 4321;` in `cms.js` if it clashes with something else.

### Adding images to a post

The CMS doesn't have an image uploader. Drop image files into the post's folder manually:

```
investing/my-post/
├── index.qmd
└── chart.png
```

Then reference in the markdown body: `![](chart.png)`.

### Limitations

- **No Markdown preview** in the editor — but the live site is a click away (`https://kevin-wenjie-guo.github.io/page/<section>/<slug>/`).
- **No concurrent-edit detection** — if you edit the same post on two machines, last-saved wins. Click `↻ Sync` before starting work to minimize the risk.
- **Simplified YAML parser** — handles `key: value` and `[a, b, c]` arrays. If you need nested maps or block scalars in frontmatter, extend `parseFrontmatter()` in `cms.js`.

### How it's built

- Single Node.js file (~600 lines), uses only stdlib (`http`, `fs/promises`, `child_process`)
- HTML/CSS/JS for the UI is inlined as a string at the bottom of `cms.js` — no separate template files, no build step
- Server binds to `localhost:4321` only — not reachable from the network
- Git uses your system credentials (Windows Credential Manager / SSH key / etc.)

### Troubleshooting

| Problem | Fix |
|---|---|
| `node: command not found` | Install Node.js from https://nodejs.org |
| `Port 4321 already in use` | Edit `const PORT = 4321;` in `tools/cms/cms.js` |
| `git push` fails with auth error | Run `git push` once manually in a terminal so Git can prompt for / cache credentials |
| Post saved but not visible on live site | Check the GitHub Actions tab — the build may have failed. Or it may still be running (1-2 min) |
| CMS shows old data | Click `↻ Sync` to pull the latest from GitHub |

---

## Building the site locally (optional)

If you have Quarto installed:

```bash
quarto preview      # live-reload dev server
quarto render       # build _site/ once
```

If you don't have Quarto, just `git push` and let the GitHub Action build it — that's how the live site is rebuilt anyway.

---

## License

Site content © 2026 Kevin Guo. Code (CMS, build scripts) MIT licensed.
