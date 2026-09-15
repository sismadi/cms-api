// ============================================================
// worker.js — Worker generik di atas D1, untuk BLOG MULTI-USER.
// ============================================================
// Dikonversi dari worker POS multi-tenant. Bagian CRUD (/api/:table)
// DIPERTAHANKAN pola-nya persis (lihat komentar asli di bawah) — yang
// berubah cuma daftar TABLES/SCOPED_TABLES. Yang BARU di file ini:
//
//   1. SSR HALAMAN PUBLIK (tanpa perlu JS di browser pengunjung):
//        GET  /                      -> daftar blog aktif
//        GET  /:user                 -> profil + daftar artikel publish milik :user
//        GET  /:user/:slug           -> 1 artikel penuh + form komentar
//        POST /:user/:slug           -> submit komentar (form HTML biasa)
//
//   2. SERVING APLIKASI ADMIN (SPA) lewat static assets binding
//      (lihat wrangler.toml [assets]). Path admin (login/register/
//      dashboard/editor/postingan/profil/tenant) SELALU disajikan
//      app.html apa pun sub-path-nya (mis. /editor/post_123), supaya
//      client-side router di engine.js yang mengambil alih dari sana.
//      Path selain itu yang memang cocok dengan file statis (style.css,
//      engine.js, dst.) TIDAK PERNAH sampai ke Worker ini — sudah
//      dilayani langsung oleh asset layer Cloudflare (lihat
//      developers.cloudflare.com/workers/static-assets/routing/).
//
// ------------------------------------------------------------
// ISOLASI TENANT (SAMA seperti versi POS — lihat catatan keamanan asli)
// ------------------------------------------------------------
// Semua tabel scoped WAJIB ?tenantId= di /api, dan diverifikasi baris
// per baris sebelum GET-by-id/PATCH/DELETE. tenantId dikirim klien
// lewat query string, BUKAN diverifikasi via token sesi tervalidasi
// server-side — cukup untuk mencegah bug frontend membocorkan data
// tenant lain, TAPI TIDAK mencegah pengguna nakal mengganti tenantId
// di devtools. Untuk produksi sungguhan: ganti dengan JWT/sesi yang
// diverifikasi di Worker.
// ============================================================

const SCOPED_TABLES = new Set(['users', 'post', 'komentar']);

const TABLES = {
  tenants:  { jsonCols: [] },
  users:    { jsonCols: [] },
  post:     { jsonCols: [] },
  komentar: { jsonCols: [] },
};

// Kata-kata yang TIDAK BOLEH dipakai sebagai kodeToko (slug URL publik +
// kode login) karena akan bertabrakan secara semantik dengan rute admin/
// aset statis. Ini lapisan kedua — validasi utama tetap di auth.js
// (klien), ini adalah jaring pengaman sisi server untuk endpoint /api.
const RESERVED_SLUGS = new Set([
  'login', 'register', 'dashboard', 'editor', 'postingan', 'profil',
  'tenant', 'app', 'api', 'pages', 'assets', 'static', 'admin',
  'tentang', 'cari', 'search', 'robots.txt', 'sitemap.xml', 'favicon.ico',
  'app.html', 'index.html', 'style.css', 'svg.css', 'svg.js', 'engine.js',
  'auth.js', 'db.js', 'dataset.js',
]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,29}$/; // 2-30 char, lowercase, angka, strip

const ADMIN_TOP_PATHS = new Set(['login', 'register', 'dashboard', 'editor', 'postingan', 'profil', 'tenant']);
const ADMIN_SHELL_PATH = '/app.html';

function genId(table) {
  return table + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ------------------------------------------------------------
// /api/:table — CRUD generik (pola sama seperti versi POS)
// ------------------------------------------------------------
async function handleApi(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean); // ['api', table, id?]

  if (parts[0] !== 'api' || !parts[1]) return json({ error: 'Not found' }, 404);
  const table = parts[1];
  const id = parts[2];
  if (!(table in TABLES)) return json({ error: `Tabel '${table}' tidak dikenal` }, 400);

  const scoped = SCOPED_TABLES.has(table);
  const tenantId = url.searchParams.get('tenantId');
  const db = env.DB;

  if (scoped && !tenantId && request.method !== 'OPTIONS') {
    return json({ error: `tenantId wajib untuk tabel '${table}'` }, 400);
  }

  if (request.method === 'GET') {
    if (id) {
      const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      if (scoped && row && row.tenantId !== tenantId) return json(null, 404);
      return json(row || null);
    }
    const stmt = scoped
      ? db.prepare(`SELECT * FROM ${table} WHERE tenantId = ?`).bind(tenantId)
      : db.prepare(`SELECT * FROM ${table}`);
    const { results } = await stmt.all();
    return json(results);
  }

  if (request.method === 'POST' && !id) {
    const body = await request.json();

    // Jaring pengaman: kodeToko tenant baru wajib url-safe & bukan kata reserved.
    if (table === 'tenants') {
      const kode = String(body.kodeToko || '').trim().toLowerCase();
      if (!SLUG_RE.test(kode)) {
        return json({ error: 'Kode/slug blog harus 2-30 karakter: huruf kecil, angka, atau tanda strip.' }, 400);
      }
      if (RESERVED_SLUGS.has(kode)) {
        return json({ error: `Kode/slug "${kode}" tidak dapat dipakai (dipakai sistem).` }, 400);
      }
      body.kodeToko = kode;
    }

    if (scoped) {
      if (!body.tenantId) return json({ error: 'tenantId wajib diisi pada data yang dikirim' }, 400);
      if (body.tenantId !== tenantId) return json({ error: 'tenantId pada data tidak cocok dengan query' }, 403);
    }
    const record = { id: body.id || genId(table), ...body };
    const cols = Object.keys(record);
    await db
      .prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(...cols.map(c => record[c]))
      .run();
    return json(record, 201);
  }

  if (request.method === 'PATCH' && id) {
    const patch = await request.json();
    const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
    if (!existing) return json(null, 404);
    if (scoped && existing.tenantId !== tenantId) return json(null, 404);

    const merged = { ...existing, ...patch };
    if (scoped) merged.tenantId = existing.tenantId; // tenantId tidak boleh dipindah lewat PATCH
    const cols = Object.keys(merged).filter(c => c !== 'id');
    await db
      .prepare(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`)
      .bind(...cols.map(c => merged[c]), id)
      .run();
    return json(merged);
  }

  if (request.method === 'DELETE' && id) {
    const existing = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
    if (!existing) return json({ ok: true }); // idempotent
    if (scoped && existing.tenantId !== tenantId) return json({ error: 'Tidak ditemukan' }, 404);
    await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ============================================================
// SSR — halaman publik. String HTML dibangun manual (tanpa engine.js)
// supaya nol dependency di Worker & selalu bisa dibaca tanpa JS.
// Class CSS dipakai ulang dari style.css yang SAMA dgn aplikasi admin
// (row/page/artikel/badge/info-card/dst, lihat engine.js `components`)
// supaya tampilan publik & admin konsisten tanpa file CSS terpisah.
// ============================================================

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtTanggal(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch { return iso; }
}

function baseLayout({ title, description, bodyHtml, canonicalPath, ogImage, jsonLd }) {
  const canonical = canonicalPath ? `<link rel="canonical" href="${esc(canonicalPath)}">` : '';
  const og = `
    <meta property="og:title" content="${esc(title)}">
    <meta property="og:description" content="${esc(description || '')}">
    <meta property="og:type" content="article">
    ${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
    <meta name="twitter:card" content="summary_large_image">`;
  return `<!DOCTYPE html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description || '')}">
${canonical}
${og}
<link rel="stylesheet" type="text/css" href="/style.css">
<link rel="stylesheet" type="text/css" href="/svg.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ''}
</head>
<body>
<div class="main" id="body">
  <div id="stickyHeaderWrap">
    <div class="row header">
      <div class="kiri"><a href="/" style="color:inherit;text-decoration:none;"><span class="orange">Piawai Blog</span></a></div>
      <div class="kanan"><a class="slcBtn" href="/login">Masuk / Tulis</a></div>
    </div>
  </div>
  <div id="content">${bodyHtml}</div>
  <div class="row footer">
    <div class="kiri">Piawai Blog &mdash; setiap penulis punya ruangnya sendiri</div>
    <div class="kanan">&nbsp; &copy; ${new Date().getFullYear()}</div>
  </div>
</div>
</body>
</html>`;
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
}

function notFoundPage(message = 'Halaman yang Anda cari tidak ditemukan.') {
  return htmlResponse(baseLayout({
    title: 'Tidak Ditemukan | Piawai Blog',
    description: message,
    bodyHtml: `<div class="row page"><div class="artikel"><h1>404</h1><p>${esc(message)}</p><p><a href="/">&larr; Kembali ke beranda</a></p></div></div>`,
  }), 404);
}

async function renderHome(env) {
  const { results: tenants } = await env.DB
    .prepare(`SELECT id, kodeToko, nama, bio, avatarUrl FROM tenants WHERE status = 'aktif' AND id != 'system' ORDER BY createdAt DESC LIMIT 50`)
    .all();

  const cards = tenants.map(t => `
    <div class="col-1-3 artikel">
      <span class="judul"><a href="/${esc(t.kodeToko)}">${esc(t.nama)}</a></span><br>
      <p>${esc((t.bio || '').slice(0, 140))}</p>
      <a href="/${esc(t.kodeToko)}">Baca artikel &raquo;</a>
    </div>`).join('');

  const body = `
    <div class="row page hero">
      <div class="col-2-3 artikel">
        <h1>Piawai Blog</h1><br>
        <em>Satu platform, banyak penulis</em> &mdash; setiap orang punya alamat blog dan ruang data sendiri.<br><br>
        <a href="/register" class="btn-cta">Mulai Menulis</a>
      </div>
    </div>
    <div class="row gading">
      ${cards || '<div class="col-1-1 artikel"><p>Belum ada blog aktif. Jadilah yang pertama &mdash; <a href="/register">daftar di sini</a>.</p></div>'}
    </div>`;

  return htmlResponse(baseLayout({
    title: 'Piawai Blog — Satu Platform, Banyak Penulis',
    description: 'Platform blog multi-user: setiap penulis punya alamat dan ruang data sendiri.',
    bodyHtml: body,
    canonicalPath: '/',
  }));
}

async function renderUserPage(userSlug, env) {
  const kode = userSlug.toLowerCase();
  const tenant = await env.DB.prepare(`SELECT * FROM tenants WHERE kodeToko = ? AND status = 'aktif'`).bind(kode).first();
  if (!tenant) return notFoundPage(`Blog "${userSlug}" tidak ditemukan.`);

  const { results: posts } = await env.DB
    .prepare(`SELECT slug, judul, ringkasan, kategori, publishedAt FROM post WHERE tenantId = ? AND status = 'publish' ORDER BY publishedAt DESC LIMIT 30`)
    .bind(tenant.id).all();

  const list = posts.map(p => `
    <div class="col-1-1 artikel" style="margin-bottom:1.2em;">
      <span class="judul"><a href="/${esc(kode)}/${esc(p.slug)}">${esc(p.judul)}</a></span>
      ${p.kategori ? `<span class="badge">${esc(p.kategori)}</span>` : ''}
      <br><small>${fmtTanggal(p.publishedAt)}</small>
      <p>${esc(p.ringkasan || '')}</p>
    </div>`).join('') || '<div class="col-1-1 artikel"><p>Belum ada artikel yang dipublikasikan.</p></div>';

  const body = `
    <div class="row page">
      <div class="artikel">
        ${tenant.avatarUrl ? `<img src="${esc(tenant.avatarUrl)}" alt="${esc(tenant.nama)}" style="width:72px;height:72px;border-radius:50%;object-fit:cover;">` : ''}
        <h1>${esc(tenant.nama)}</h1>
        <p>${esc(tenant.bio || '')}</p>
      </div>
    </div>
    <div class="row gading">${list}</div>`;

  return htmlResponse(baseLayout({
    title: `${tenant.nama} | Piawai Blog`,
    description: tenant.bio || `Artikel dari ${tenant.nama}`,
    bodyHtml: body,
    canonicalPath: `/${kode}`,
    jsonLd: { '@context': 'https://schema.org', '@type': 'Person', name: tenant.nama, description: tenant.bio || undefined },
  }));
}

async function renderPostPage(userSlug, postSlug, env, notice) {
  const kode = userSlug.toLowerCase();
  const tenant = await env.DB.prepare(`SELECT * FROM tenants WHERE kodeToko = ? AND status = 'aktif'`).bind(kode).first();
  if (!tenant) return notFoundPage(`Blog "${userSlug}" tidak ditemukan.`);

  const post = await env.DB
    .prepare(`SELECT * FROM post WHERE tenantId = ? AND slug = ? AND status = 'publish'`)
    .bind(tenant.id, postSlug).first();
  if (!post) return notFoundPage(`Artikel "${postSlug}" tidak ditemukan atau belum dipublikasikan.`);

  // Hitung view secara best-effort (tidak menghambat render kalau gagal).
  env.DB.prepare(`UPDATE post SET views = views + 1 WHERE id = ?`).bind(post.id).run().catch(() => {});

  const { results: komentarList } = await env.DB
    .prepare(`SELECT * FROM komentar WHERE postId = ? AND status = 'approved' ORDER BY createdAt ASC LIMIT 200`)
    .bind(post.id).all();

  const tags = (post.tags || '').split(',').map(t => t.trim()).filter(Boolean)
    .map(t => `<span class="badge">${esc(t)}</span>`).join(' ');

  const komentarHtml = komentarList.map(k => `
    <div class="info-card">
      <strong>${esc(k.nama)}</strong> <small>&middot; ${fmtTanggal(k.createdAt)}</small>
      <p>${esc(k.isi)}</p>
    </div>`).join('') || '<p>Belum ada komentar. Jadilah yang pertama.</p>';

  const noticeHtml = notice ? `<div class="info-card">${esc(notice)}</div>` : '';

  const body = `
    <div class="row page">
      <div class="artikel">
        <p><a href="/${esc(kode)}">&larr; ${esc(tenant.nama)}</a></p>
        <h1>${esc(post.judul)}</h1>
        <p><small>${fmtTanggal(post.publishedAt)} ${post.kategori ? '&middot; ' + esc(post.kategori) : ''}</small></p>
        ${tags}
        ${post.coverImage ? `<p><img src="${esc(post.coverImage)}" alt="${esc(post.judul)}" style="max-width:100%;"></p>` : ''}
        <div class="post-konten">${post.konten}</div>
        <hr>
        <h2>Komentar</h2>
        ${noticeHtml}
        ${komentarHtml}
        <h3>Tulis Komentar</h3>
        <form method="POST" action="/${esc(kode)}/${esc(post.slug)}" class="dynamic-form">
          <div class="a-row"><label>Nama *</label><input type="text" name="nama" required></div>
          <div class="a-row"><label>Email (opsional, tidak ditampilkan)</label><input type="email" name="email"></div>
          <div class="a-row"><label>Komentar *</label><textarea name="isi" rows="3" required></textarea></div>
          <button type="submit" class="slcBtn">Kirim Komentar</button>
        </form>
      </div>
    </div>`;

  return htmlResponse(baseLayout({
    title: `${post.judul} | ${tenant.nama}`,
    description: post.ringkasan || post.judul,
    bodyHtml: body,
    canonicalPath: `/${kode}/${post.slug}`,
    ogImage: post.coverImage || undefined,
    jsonLd: {
      '@context': 'https://schema.org', '@type': 'Article',
      headline: post.judul, description: post.ringkasan || undefined,
      datePublished: post.publishedAt || undefined, author: { '@type': 'Person', name: tenant.nama },
    },
  }));
}

/** POST /:user/:slug — submit komentar lewat <form> HTML biasa (jalan tanpa JS). */
async function handleCommentSubmit(userSlug, postSlug, request, env) {
  const kode = userSlug.toLowerCase();
  const tenant = await env.DB.prepare(`SELECT * FROM tenants WHERE kodeToko = ? AND status = 'aktif'`).bind(kode).first();
  if (!tenant) return notFoundPage(`Blog "${userSlug}" tidak ditemukan.`);
  const post = await env.DB.prepare(`SELECT * FROM post WHERE tenantId = ? AND slug = ? AND status = 'publish'`).bind(tenant.id, postSlug).first();
  if (!post) return notFoundPage(`Artikel "${postSlug}" tidak ditemukan.`);

  const form = await request.formData();
  const nama = String(form.get('nama') || '').trim().slice(0, 100);
  const email = String(form.get('email') || '').trim().slice(0, 200);
  const isi = String(form.get('isi') || '').trim().slice(0, 2000);

  if (!nama || !isi) {
    return renderPostPage(userSlug, postSlug, env, 'Nama dan komentar wajib diisi — silakan coba lagi.');
  }

  await env.DB.prepare(
    `INSERT INTO komentar (id, tenantId, postId, nama, email, isi, status, createdAt) VALUES (?, ?, ?, ?, ?, ?, 'approved', ?)`
  ).bind(genId('komentar'), tenant.id, post.id, nama, email, isi, new Date().toISOString()).run();

  // Redirect 303 supaya refresh halaman tidak mengirim ulang form (pola POST-redirect-GET).
  return new Response(null, { status: 303, headers: { Location: `/${kode}/${postSlug}#komentar` } });
}

// ============================================================
// Entry point
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (path.startsWith('/api/')) {
      try { return await handleApi(request, env); }
      catch (err) { return json({ error: err.message }, 500); }
    }

    const segs = path.split('/').filter(Boolean);

    // Path admin (SPA) — selalu sajikan app.html, client router (engine.js)
    // yang membaca window.location.pathname dan menampilkan halaman yang benar.
    // Ini juga menangani sub-path seperti /editor/post_123.
    if (segs.length === 0) {
      // handled below (public homepage)
    } else if (ADMIN_TOP_PATHS.has(segs[0].toLowerCase())) {
      const shellUrl = new URL(ADMIN_SHELL_PATH, url.origin);
      return env.ASSETS.fetch(new Request(shellUrl, request));
    }

    try {
      if (segs.length === 0) return await renderHome(env);
      if (segs.length === 1) return await renderUserPage(segs[0], env);
      if (segs.length === 2) {
        if (request.method === 'POST') return await handleCommentSubmit(segs[0], segs[1], request, env);
        return await renderPostPage(segs[0], segs[1], env);
      }
    } catch (err) {
      return htmlResponse(`<pre>Terjadi kesalahan: ${esc(err.message)}</pre>`, 500);
    }

    // Path lain yang tidak cocok pola manapun di atas: coba layani sebagai
    // aset statis (jaga-jaga), kalau tidak ada -> 404 halaman publik.
    try {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) return assetRes;
    } catch (e) { /* lanjut ke 404 di bawah */ }
    return notFoundPage();
  },
};
