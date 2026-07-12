/**
 * GARASTOR Local Admin Server
 *
 * A lightweight Node.js server that:
 * 1. Serves the static site (dist/) for preview — http://localhost:3456
 * 2. Provides REST APIs for the admin dashboard to CRUD products/vlog
 * 3. Directly reads/writes local files (products-data.json, journal.html, images, etc.)
 *
 * Usage: node server.js
 * Then open http://localhost:3456/admin/ to use the dashboard
 * The live preview is at http://localhost:3456/
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 3456;
const ROOT = __dirname;          // source files
const DIST = path.join(ROOT, 'dist');  // served as public root

// ── Auth ──────────────────────────────────────────────────────────
const ADMIN_PASSWORD = 'garastro2024';  // change this
const SESSION_TOKENS = new Map();

function requireAuth(req, res) {
  const token = (req.headers.cookie || '').match(/garastro_session=([^;]+)/);
  if (!token || !SESSION_TOKENS.has(token[1])) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return false;
  }
  return true;
}

// ── MIME ──────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Content-Length': data.length });
    res.end(data);
  } catch (e) {
    if (e.code === 'ENOENT') {
      // Try fallback to ROOT if not in DIST
      const altPath = filePath.replace(DIST, ROOT);
      try {
        const altData = fs.readFileSync(altPath);
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': altData.length });
        res.end(altData);
      } catch {
        res.writeHead(404);
        res.end('Not Found');
      }
    } else {
      res.writeHead(500);
      res.end('Internal Error');
    }
  }
}

// ── JSON helpers ──────────────────────────────────────────────────
function readJSON(filename) {
  const p = path.join(ROOT, filename);
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJSON(filename, data) {
  const p = path.join(ROOT, filename);
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf-8');
  // Also sync to dist/
  const dp = path.join(DIST, filename);
  try { fs.writeFileSync(dp, JSON.stringify(data, null, 2), 'utf-8'); } catch {}
}

function readFileText(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf-8');
}

function writeFileText(filename, content) {
  const p = path.join(ROOT, filename);
  fs.writeFileSync(p, content, 'utf-8');
  const dp = path.join(DIST, filename);
  try { fs.writeFileSync(dp, content, 'utf-8'); } catch {}
}

// ── Sync image dir helper ─────────────────────────────────────────
function syncDir(relDir) {
  const src = path.join(ROOT, relDir);
  const dst = path.join(DIST, relDir);
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  fs.readdirSync(src).forEach(f => {
    const sf = path.join(src, f);
    const df = path.join(dst, f);
    if (fs.statSync(sf).isDirectory()) {
      syncDir(path.join(relDir, f));
    } else {
      fs.copyFileSync(sf, df);
    }
  });
}

// ── API: List products ────────────────────────────────────────────
function apiListProducts(res) {
  const data = readJSON('products-data.json');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── API: Add product ─────────────────────────────────────────────
function apiAddProduct(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { category, code, nameCn, images } = JSON.parse(body);
      if (!category || !code) throw new Error('Missing category/code');

      const data = readJSON('products-data.json');
      let cat = data.categories.find(c => c.slug === category);
      if (!cat) {
        cat = { slug: category, nameEn: category, nameZh: category, products: [] };
        data.categories.push(cat);
      }
      if (!cat.products) cat.products = [];
      if (cat.products.find(p => p.code === code)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Product already exists' }));
      }
      cat.products.push({
        code,
        nameCn: nameCn || '',
        images: images || 0,
        firstImg: 1,
        relativePath: category + '/' + code
      });

      // Recompute counts
      recompute(data);
      writeJSON('products-data.json', data);

      // Rebuild products.html
      rebuildAndSaveProductsHtml(data);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── API: Edit product ────────────────────────────────────────────
function apiEditProduct(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { category, code, nameCn } = JSON.parse(body);
      const data = readJSON('products-data.json');
      const cat = data.categories.find(c => c.slug === category);
      if (!cat) throw new Error('Category not found');
      const prod = cat.products.find(p => p.code === code);
      if (!prod) throw new Error('Product not found');
      prod.nameCn = nameCn || '';
      recompute(data);
      writeJSON('products-data.json', data);
      rebuildAndSaveProductsHtml(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── API: Delete product (soft) ───────────────────────────────────
function apiDeleteProduct(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { category, code } = JSON.parse(body);
      const data = readJSON('products-data.json');
      const cat = data.categories.find(c => c.slug === category);
      if (!cat) throw new Error('Category not found');
      const idx = cat.products.findIndex(p => p.code === code);
      if (idx === -1) throw new Error('Product not found');
      const removed = cat.products.splice(idx, 1)[0];

      // Trash
      let trash = { products: [], vlogs: [] };
      try { trash = readJSON('admin-trash.json'); } catch {}
      trash.products.push({ cat: category, code: removed.code, nameCn: removed.nameCn, images: removed.images, relativePath: removed.relativePath, deletedAt: new Date().toISOString() });
      writeJSON('admin-trash.json', trash);

      recompute(data);
      writeJSON('products-data.json', data);
      rebuildAndSaveProductsHtml(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── API: Restore product ─────────────────────────────────────────
function apiRestoreProduct(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { category, code } = JSON.parse(body);
      const data = readJSON('products-data.json');
      let trash = { products: [], vlogs: [] };
      try { trash = readJSON('admin-trash.json'); } catch {}
      const idx = trash.products.findIndex(p => p.cat === category && p.code === code);
      if (idx === -1) throw new Error('Not in trash');
      const item = trash.products.splice(idx, 1)[0];
      writeJSON('admin-trash.json', trash);

      let cat = data.categories.find(c => c.slug === category);
      if (!cat) { cat = { slug: category, nameEn: category, nameZh: category, products: [] }; data.categories.push(cat); }
      if (!cat.products) cat.products = [];
      cat.products.push({ code: item.code, nameCn: item.nameCn || '', images: item.images, firstImg: 1, relativePath: item.relativePath || (category + '/' + item.code) });
      recompute(data);
      writeJSON('products-data.json', data);
      rebuildAndSaveProductsHtml(data);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

function recompute(data) {
  let tP = 0, tI = 0;
  data.categories.forEach(c => {
    c.productCount = (c.products || []).length;
    c.imageCount = (c.products || []).reduce((s, p) => s + (p.images || 0), 0);
    tP += c.productCount;
    tI += c.imageCount;
  });
  data.totalProducts = tP;
  data.totalImages = tI;
}

// ── Rebuild products.html ────────────────────────────────────────
function rebuildAndSaveProductsHtml(data) {
  const html = readFileText('products.html');

  function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr(s) { return escHtml(s).replace(/"/g, '&quot;'); }

  function findGridRange(html, slug) {
    const secStart = html.indexOf('id="' + slug + '"');
    if (secStart === -1) return null;
    const gridClassIdx = html.indexOf('class="prod-thumb-grid"', secStart);
    if (gridClassIdx === -1) return null;
    const divStart = html.lastIndexOf('<div', gridClassIdx);
    const openTagEnd = html.indexOf('>', divStart) + 1;
    let depth = 1, pos = openTagEnd;
    while (depth > 0 && pos < html.length) {
      const nextOpen = html.indexOf('<div', pos);
      const nextClose = html.indexOf('</div>', pos);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) { depth++; pos = nextOpen + 4; }
      else { depth--; if (depth === 0) return { gridOpenEnd: openTagEnd, gridClose: nextClose }; pos = nextClose + 6; }
    }
    return null;
  }

  let out = html;
  ['herringbone', 'chevron', 'strip-plank'].forEach(slug => {
    const cat = data.categories.find(c => c.slug === slug);
    const prods = (cat && cat.products) ? cat.products : [];
    const cards = prods.map(p => {
      const code = p.code;
      const label = code + (p.nameCn ? ' ' + p.nameCn : '');
      return '          <div class="prod-thumb">\n            <div class="prod-thumb-img">\n              <img loading="eager" src="images/products/' + slug + '/' + code + '/1.jpg" alt="' + escAttr(label) + '">\n            </div>\n            <span class="prod-thumb-code">' + escHtml(label) + '</span>\n          </div>';
    }).join('\n');
    const r = findGridRange(out, slug);
    if (!r) return;
    out = out.substring(0, r.gridOpenEnd) + '\n' + cards + '\n' + out.substring(r.gridClose);
  });

  writeFileText('products.html', out);
}

// ── Journal helpers ──────────────────────────────────────────────
function parseAllArticles(html) {
  const start = html.indexOf('var allArticles = [');
  const end = html.indexOf('];', start);
  if (start === -1 || end === -1) return [];
  const arrStr = html.substring(start + 'var allArticles = ['.length, end);
  const re = /\{\s*slug:\s*'([^']*)'\s*,\s*img:\s*'([^']*)'\s*,\s*tag:\s*'([^']*)'\s*,\s*title:\s*'([^']*)'\s*,\s*date:\s*'([^']*)'\s*\}/g;
  const out = []; let m;
  while ((m = re.exec(arrStr)) !== null) out.push({ slug: m[1], img: m[2], tag: m[3], title: m[4], date: m[5] });
  return out;
}

function removeArticleFromHtml(html, slug) {
  const escaped = slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp("\\n?\\s*\\{\\s*slug:\\s*'" + escaped + "'[^}]*\\},?", 'g');
  return html.replace(re, '');
}

function insertArticle(html, a) {
  const newEntry = "  { slug: '" + a.slug + "', img: '" + a.img + "', tag: '" + escHtmlForJS(a.tag) + "', title: '" + escHtmlForJS(a.title) + "', date: '" + a.date + "' }";
  const arrStart = html.indexOf('var allArticles = [');
  const insertPos = html.indexOf('[', arrStart) + 1;
  return html.substring(0, insertPos) + '\n' + newEntry + ',' + html.substring(insertPos);
}

function escHtmlForJS(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/'/g, "\\'");
}

// ── API: List articles ───────────────────────────────────────────
function apiListArticles(res) {
  try {
    const html = readFileText('journal.html');
    const articles = parseAllArticles(html);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(articles));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify([]));
  }
}

// ── API: Add article ─────────────────────────────────────────────
function apiAddArticle(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { slug, title, date, tag, excerpt, coverImg, body: articleBody } = JSON.parse(body);
      if (!slug || !title) throw new Error('Missing slug/title');
      const html = readFileText('journal.html');

      // Check uniqueness
      if (parseAllArticles(html).find(a => a.slug === slug)) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Slug already used' }));
      }

      const imgPath = 'images/vlog/' + slug + '.jpg';

      // Build article page
      const articleHtml = buildArticlePage(title, date, tag, excerpt, imgPath, articleBody || '');
      writeFileText('journal/' + slug + '.html', articleHtml);

      // Prepend to allArticles
      const newJournal = insertArticle(html, { slug, img: imgPath, tag: tag || 'Article', title, date: date || '' });
      writeFileText('journal.html', newJournal);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── API: Edit article ────────────────────────────────────────────
function apiEditArticle(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { slug, title, date, tag } = JSON.parse(body);
      const html = readFileText('journal.html');
      const articles = parseAllArticles(html);
      const a = articles.find(x => x.slug === slug);
      if (!a) throw new Error('Article not found');
      let out = removeArticleFromHtml(html, slug);
      out = insertArticle(out, { slug: a.slug, img: a.img, tag: tag || a.tag, title: title || a.title, date: date || a.date });

      // Update article page if exists
      try {
        const artPath = path.join(ROOT, 'journal', slug + '.html');
        const artHtml = fs.readFileSync(artPath, 'utf-8');
        let updated = artHtml.replace(/<title>[^<]*<\/title>/, '<title>' + (title || a.title) + ' — GARASTOR</title>');
        updated = updated.replace(/<h1>[^<]*<\/h1>/, '<h1>' + (title || a.title) + '</h1>');
        writeFileText('journal/' + slug + '.html', updated);
      } catch {}

      writeFileText('journal.html', out);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── API: Delete article (soft) ───────────────────────────────────
function apiDeleteArticle(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { slug } = JSON.parse(body);
      const html = readFileText('journal.html');
      const articles = parseAllArticles(html);
      const a = articles.find(x => x.slug === slug);
      if (!a) throw new Error('Article not found');
      const out = removeArticleFromHtml(html, slug);

      let trash = { products: [], vlogs: [] };
      try { trash = readJSON('admin-trash.json'); } catch {}
      trash.vlogs.push({ slug: a.slug, title: a.title, tag: a.tag, date: a.date, img: a.img, deletedAt: new Date().toISOString() });
      writeJSON('admin-trash.json', trash);

      writeFileText('journal.html', out);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── API: Restore article ─────────────────────────────────────────
function apiRestoreArticle(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { slug } = JSON.parse(body);
      const html = readFileText('journal.html');
      let trash = { products: [], vlogs: [] };
      try { trash = readJSON('admin-trash.json'); } catch {}
      const idx = trash.vlogs.findIndex(v => v.slug === slug);
      if (idx === -1) throw new Error('Not in trash');
      const a = trash.vlogs.splice(idx, 1)[0];
      writeJSON('admin-trash.json', trash);

      const out = insertArticle(html, a);
      writeFileText('journal.html', out);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── API: Upload image ────────────────────────────────────────────
function apiUploadImage(req, res) {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const cat = url.searchParams.get('cat');
  const code = url.searchParams.get('code');

  if (!cat || !code) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing cat/code' }));
  }

  let chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const buffer = Buffer.concat(chunks);

    // Simple boundary-based parsing for multipart
    const contentType = req.headers['content-type'] || '';
    const boundaryMatch = contentType.match(/boundary=(.+)/);
    if (!boundaryMatch || !buffer.includes('image/')) {
      // Raw binary upload
      const dir = path.join(ROOT, 'images/products', cat, code);
      fs.mkdirSync(dir, { recursive: true });
      const existing = fs.readdirSync(dir).filter(f => /^\d+\.jpg$/.test(f)).length;
      const dest = path.join(dir, (existing + 1) + '.jpg');
      fs.writeFileSync(dest, buffer);

      // Update products-data.json
      const data = readJSON('products-data.json');
      const catObj = data.categories.find(c => c.slug === cat);
      if (catObj) {
        const prod = catObj.products.find(p => p.code === code);
        if (prod) prod.images = existing + 1;
        recompute(data);
        writeJSON('products-data.json', data);
      }

      // Sync to dist
      syncDir('images/products/' + cat + '/' + code);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, index: existing + 1 }));
    }

    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upload parsing not supported' }));
  });
}

// ── API: Login ───────────────────────────────────────────────────
function apiLogin(req, res) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    try {
      const { password } = JSON.parse(body);
      if (password === ADMIN_PASSWORD) {
        const token = crypto.randomBytes(32).toString('hex');
        SESSION_TOKENS.set(token, Date.now());
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Set-Cookie': 'garastro_session=' + token + '; Path=/; HttpOnly; SameSite=Lax'
        });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Wrong password' }));
      }
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}

// ── Build article page ───────────────────────────────────────────
function buildArticlePage(title, date, tag, excerpt, coverImg, bodyHtml) {
  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<link rel="stylesheet" href="../css/style.css">\n<title>' + escHtmlForJS(title) + ' — GARASTOR</title>\n<style>body{background:#0f0d0a;color:#e8e4df;font-family:Georgia,serif;}.wrap{max-width:760px;margin:0 auto;padding:3rem 1.5rem;}.wrap h1{font-weight:400;font-size:2.2rem;line-height:1.3;color:#c8a96e;}figure{margin:1.5rem 0;}figure img{width:100%;}p{line-height:1.9;font-size:1.05rem;color:#d8d4cf;}header{margin-bottom:2rem;}nav a{color:#c8a96e;}nav{font-size:0.8rem;text-transform:uppercase;letter-spacing:0.1em;}</style>\n</head>\n<body>\n<div class="wrap">\n  <nav><a href="../journal.html">&larr; Back to Journal</a></nav>\n  <header>\n    <h1>' + title + '</h1>\n    <p style="color:#8a8580;font-size:0.85rem;letter-spacing:0.05em;text-transform:uppercase;">' + (tag || '') + ' &middot; ' + (date || '') + '</p>\n  </header>\n  <figure><img src="../' + coverImg + '" alt="' + title + '"></figure>\n  ' + (excerpt ? '<p style="font-style:italic;color:#c8a96e;font-size:1.1rem;">' + excerpt + '</p>' : '') + '\n  ' + (bodyHtml || '') + '\n</div>\n</body>\n</html>\n';
}

// ── HTTP Server ──────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const pathname = url.pathname;

  // ── API routes ──────────────────────────────────────────────
  if (pathname === '/api/login' && req.method === 'POST') return apiLogin(req, res);

  // All other API routes require auth
  if (pathname.startsWith('/api/')) {
    if (req.method === 'POST' && req.url === '/api/login') return apiLogin(req, res);
    if (!requireAuth(req, res)) return;

    if (pathname === '/api/products/list' && req.method === 'GET') return apiListProducts(res);
    if (pathname === '/api/products/add' && req.method === 'POST') return apiAddProduct(req, res);
    if (pathname === '/api/products/edit' && req.method === 'POST') return apiEditProduct(req, res);
    if (pathname === '/api/products/delete' && req.method === 'POST') return apiDeleteProduct(req, res);
    if (pathname === '/api/products/restore' && req.method === 'POST') return apiRestoreProduct(req, res);
    if (pathname === '/api/articles/list' && req.method === 'GET') return apiListArticles(res);
    if (pathname === '/api/articles/add' && req.method === 'POST') return apiAddArticle(req, res);
    if (pathname === '/api/articles/edit' && req.method === 'POST') return apiEditArticle(req, res);
    if (pathname === '/api/articles/delete' && req.method === 'POST') return apiDeleteArticle(req, res);
    if (pathname === '/api/articles/restore' && req.method === 'POST') return apiRestoreArticle(req, res);
    if (pathname === '/api/products/upload-image' && req.method === 'POST') return apiUploadImage(req, res);

    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'API not found' }));
  }

  // ── Static files from dist/ ─────────────────────────────────
  let filePath = path.join(DIST, pathname === '/' ? 'index.html' : pathname);
  // Prevent directory traversal
  if (!filePath.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  serveStatic(req, res, filePath);
});

server.listen(PORT, () => {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  GARASTOR Admin Server');
  console.log('  Live preview:  http://localhost:' + PORT);
  console.log('  Dashboard:     http://localhost:' + PORT + '/admin/');
  console.log('  Password:      ' + ADMIN_PASSWORD);
  console.log('═══════════════════════════════════════════════════════════');
});