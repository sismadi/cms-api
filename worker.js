// ============================================================
// worker.js — API BACKEND MURNI untuk PLATFORM CMS MULTI-USER (Cloudflare Worker + D1).
// ============================================================
// PERUBAHAN ARSITEKTUR: repo ini sekarang HANYA backend (microservice
// API), dipisah total dari frontend (repo `cms-app`, dideploy sendiri
// mis. di GitHub Pages — lihat README.md). Konsekuensinya:
//
//   1. TIDAK ADA lagi SSR halaman publik di sini. Worker ini murni
//      mengembalikan JSON; yang merender HTML adalah frontend (client-side).
//   2. TIDAK ADA lagi static assets binding — repo ini tidak menyajikan
//      index.html/engine.js/dst. Frontend punya deployment/origin sendiri.
//   3. ROUTING PAKAI QUERY STRING, BUKAN PATH SEGMENT. Karena frontend &
//      backend sekarang 2 origin terpisah (klasik microservices: setiap
//      layanan komunikasi lewat kontrak API, bukan berbagi routing path
//      di 1 origin), path bawaan seperti /api/:table/:id tidak lagi
//      relevan — semua parameter (table, id, cmsId, view, dst.)
//      dikirim sebagai query string. Ini juga membuat backend lebih
//      mudah diletakkan di belakang API gateway/query router apa pun
//      tanpa perlu aturan path-rewrite.
//
// Ada 2 "permukaan" endpoint:
//   GET/POST/PATCH/DELETE /api?table=...&id=...&cmsId=...
//     -> CRUD generik (persis pola versi POS/monolith sebelumnya, hanya
//        parameternya sekarang di query string, bukan di path).
//   GET/POST /public?view=...&user=...&slug=...
//     -> data siap-pakai untuk halaman publik (dulu di-SSR di sini,
//        sekarang cuma JSON — frontend yang merender HTML-nya).
//
// ------------------------------------------------------------
// ISOLASI CMS (SAMA seperti versi sebelumnya — lihat catatan lama)
// ------------------------------------------------------------
// Semua tabel scoped WAJIB ?cmsId= di /api, dan diverifikasi baris
// per baris sebelum GET-by-id/PATCH/DELETE. cmsId dikirim klien lewat
// query string, BUKAN diverifikasi via token sesi tervalidasi server-side
// — cukup untuk mencegah bug frontend membocorkan data cms lain, TAPI
// TIDAK mencegah pengguna nakal mengganti cmsId di devtools. Untuk
// produksi sungguhan: ganti dengan JWT/sesi yang diverifikasi di Worker.
// ============================================================

const SCOPED_TABLES = new Set(['users', 'post', 'komentar']);

const TABLES = {
  cms:      { jsonCols: [] },
  users:    { jsonCols: [] },
  post:     { jsonCols: [] },
  komentar: { jsonCols: [] },
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,29}$/; // 2-30 char, lowercase, angka, strip

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
// /api — CRUD generik. Semua parameter (table, id, cmsId) di QUERY
// STRING, bukan path — lihat catatan arsitektur di atas berkas ini.
//   GET    /api?table=post&cmsId=T               -> list
//   GET    /api?table=post&id=I&cmsId=T          -> detail
//   POST   /api?table=post                       -> create (body JSON)
//   PATCH  /api?table=post&id=I&cmsId=T          -> update (body JSON)
//   DELETE /api?table=post&id=I&cmsId=T          -> delete
// ------------------------------------------------------------
async function handleApi(request, env) {
  const url = new URL(request.url);
  const table = url.searchParams.get('table');
  const id = url.searchParams.get('id');

  if (!table) return json({ error: "Query 'table' wajib diisi" }, 400);
  if (!(table in TABLES)) return json({ error: `Tabel '${table}' tidak dikenal` }, 400);

  const scoped = SCOPED_TABLES.has(table);
  const cmsId = url.searchParams.get('cmsId');
  const db = env.DB;

  if (scoped && !cmsId && request.method !== 'OPTIONS') {
    return json({ error: `cmsId wajib untuk tabel '${table}'` }, 400);
  }

  if (request.method === 'GET') {
    if (id) {
      const row = await db.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first();
      if (scoped && row && row.cmsId !== cmsId) return json(null, 404);
      return json(row || null);
    }
    const stmt = scoped
      ? db.prepare(`SELECT * FROM ${table} WHERE cmsId = ?`).bind(cmsId)
      : db.prepare(`SELECT * FROM ${table}`);
    const { results } = await stmt.all();
    return json(results);
  }

  if (request.method === 'POST' && !id) {
    const body = await request.json();

    // Jaring pengaman: kodeCms cms baru wajib url-safe. (Daftar kata
    // "reserved" terhadap path admin TIDAK diperlukan lagi di sini — di
    // arsitektur baru, kodeCms cuma jadi NILAI query string `?user=`
    // di frontend, tidak pernah jadi path segment yang bisa bentrok
    // dengan rute admin. Lihat README.md.)
    if (table === 'cms') {
      const kode = String(body.kodeCms || '').trim().toLowerCase();
      if (!SLUG_RE.test(kode)) {
        return json({ error: 'Kode/slug CMS harus 2-30 karakter: huruf kecil, angka, atau tanda strip.' }, 400);
      }
      body.kodeCms = kode;
    }

    if (scoped) {
      if (!body.cmsId) return json({ error: 'cmsId wajib diisi pada data yang dikirim' }, 400);
      if (body.cmsId !== cmsId) return json({ error: 'cmsId pada data tidak cocok dengan query' }, 403);
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
    if (scoped && existing.cmsId !== cmsId) return json(null, 404);

    const merged = { ...existing, ...patch };
    if (scoped) merged.cmsId = existing.cmsId; // cmsId tidak boleh dipindah lewat PATCH
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
    if (scoped && existing.cmsId !== cmsId) return json({ error: 'Tidak ditemukan' }, 404);
    await db.prepare(`DELETE FROM ${table} WHERE id = ?`).bind(id).run();
    return json({ ok: true });
  }

  return json({ error: 'Method not allowed' }, 405);
}

// ------------------------------------------------------------
// /public — data siap-pakai untuk halaman publik (dulu di-SSR jadi HTML
// langsung di Worker; sekarang cuma JSON, frontend yang merender).
//   GET  /public?view=home
//   GET  /public?view=profile&user=<kodeCms>
//   GET  /public?view=artikel&user=<kodeCms>&slug=<slug>
//   POST /public?view=komentar&user=<kodeCms>&slug=<slug>   body:{nama,email,isi}
// ------------------------------------------------------------
async function handlePublic(request, env) {
  const url = new URL(request.url);
  const view = url.searchParams.get('view');
  const userSlug = (url.searchParams.get('user') || '').toLowerCase();
  const postSlug = url.searchParams.get('slug') || '';

  if (view === 'home') {
    const { results } = await env.DB
      .prepare(`SELECT kodeCms, nama, bio, avatarUrl FROM cms WHERE status = 'aktif' AND id != 'system' ORDER BY nama ASC`)
      .all();
    return json({ cms: results });
  }

  if (view === 'profile') {
    const cms = await env.DB.prepare(`SELECT * FROM cms WHERE kodeCms = ? AND status = 'aktif'`).bind(userSlug).first();
    if (!cms) return json({ error: `CMS "${userSlug}" tidak ditemukan.` }, 404);
    const { results: posts } = await env.DB
      .prepare(`SELECT slug, judul, ringkasan, kategori, publishedAt FROM post WHERE cmsId = ? AND status = 'publish' ORDER BY publishedAt DESC LIMIT 30`)
      .bind(cms.id).all();
    return json({ cms, posts });
  }

  if (view === 'artikel') {
    const cms = await env.DB.prepare(`SELECT * FROM cms WHERE kodeCms = ? AND status = 'aktif'`).bind(userSlug).first();
    if (!cms) return json({ error: `CMS "${userSlug}" tidak ditemukan.` }, 404);
    const post = await env.DB.prepare(`SELECT * FROM post WHERE cmsId = ? AND slug = ? AND status = 'publish'`).bind(cms.id, postSlug).first();
    if (!post) return json({ error: `Artikel "${postSlug}" tidak ditemukan atau belum dipublikasikan.` }, 404);

    // Hitung view secara best-effort (tidak menghambat response kalau gagal).
    env.DB.prepare(`UPDATE post SET views = views + 1 WHERE id = ?`).bind(post.id).run().catch(() => {});

    const { results: komentar } = await env.DB
      .prepare(`SELECT * FROM komentar WHERE postId = ? AND status = 'approved' ORDER BY createdAt ASC LIMIT 200`)
      .bind(post.id).all();

    return json({ cms, post, komentar });
  }

  if (view === 'komentar' && request.method === 'POST') {
    const cms = await env.DB.prepare(`SELECT * FROM cms WHERE kodeCms = ? AND status = 'aktif'`).bind(userSlug).first();
    if (!cms) return json({ error: `CMS "${userSlug}" tidak ditemukan.` }, 404);
    const post = await env.DB.prepare(`SELECT * FROM post WHERE cmsId = ? AND slug = ? AND status = 'publish'`).bind(cms.id, postSlug).first();
    if (!post) return json({ error: `Artikel "${postSlug}" tidak ditemukan.` }, 404);

    const body = await request.json().catch(() => ({}));
    const nama = String(body.nama || '').trim().slice(0, 100);
    const email = String(body.email || '').trim().slice(0, 200);
    const isi = String(body.isi || '').trim().slice(0, 2000);
    if (!nama || !isi) return json({ error: 'Nama dan komentar wajib diisi.' }, 400);

    const komentar = {
      id: genId('komentar'), cmsId: cms.id, postId: post.id,
      nama, email, isi, status: 'approved', createdAt: new Date().toISOString(),
    };
    const cols = Object.keys(komentar);
    await env.DB
      .prepare(`INSERT INTO komentar (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .bind(...cols.map(c => komentar[c]))
      .run();
    return json(komentar, 201);
  }

  return json({ error: `View '${view}' tidak dikenal` }, 400);
}

// ============================================================
// Entry point — cuma 2 permukaan: /api dan /public. Tidak ada lagi
// fallback ke static assets atau SSR path-based (lihat catatan atas).
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    try {
      if (url.pathname === '/api') return await handleApi(request, env);
      if (url.pathname === '/public') return await handlePublic(request, env);
    } catch (err) {
      return json({ error: err.message }, 500);
    }

    return json({ error: 'Not found. Gunakan /api?table=... atau /public?view=...' }, 404);
  },
};
