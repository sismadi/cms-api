-- ============================================================
-- schema.sql — Skema Cloudflare D1 untuk PLATFORM CMS MULTI-USER
-- (dikonversi dari skema POS multi-akun/multi-toko; struktur isolasi
-- per-akun DIPERTAHANKAN APA ADANYA — hanya tabel bisnisnya yang diganti).
-- ============================================================
-- Konsep: 1 user = 1 CMS (satu ruang konten dengan data terisolasi
-- penuh, persis seperti 1 toko di versi POS). `cms.kodeCms` kini
-- berperan RANGKAP:
--   1. Kode login (dipakai di form Masuk, sama seperti sebelumnya)
--   2. SLUG URL publik  -> cms.piawai.id/?profile/<kodeCms>  dan
--                          cms.piawai.id/?user/<kodeCms>/<slug-artikel>
-- Karena itu formatnya WAJIB url-safe (huruf kecil, angka, strip),
-- lihat validasi di auth.js (klien) dan worker.js (server, tabel
-- `cms`). Kata-kata reserved (login/register/dashboard/dst) tidak
-- boleh dipakai sebagai kodeCms — lihat RESERVED_SLUGS di worker.js.
--
-- Entitas:
--   cms       -> satu baris per AKUN CMS/PENULIS (tidak di-scope, memang
--                daftar CMS itu sendiri)
--   users     -> akun login per-CMS (owner/penulis/superadmin) —
--                satu CMS BISA punya lebih dari satu akun penulis
--   post      -> artikel milik satu CMS
--   komentar  -> komentar publik (tanpa login) pada satu artikel
-- ============================================================

DROP TABLE IF EXISTS komentar;
DROP TABLE IF EXISTS post;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS cms;

-- ---------------------------------------------------------------
-- cms — TIDAK di-scope (tabel global). kodeCms = slug URL publik
-- DAN kode login, jadi harus unik & url-safe (lihat catatan di atas).
-- ---------------------------------------------------------------
CREATE TABLE cms (
  id        TEXT PRIMARY KEY,
  kodeCms   TEXT UNIQUE NOT NULL,      -- slug URL publik + kode login, lowercase
  nama      TEXT NOT NULL,             -- nama tampilan penulis/CMS
  bio       TEXT,                      -- deskripsi singkat, tampil di halaman ?profile/<kodeCms>
  avatarUrl TEXT,
  status    TEXT NOT NULL DEFAULT 'aktif',   -- aktif | nonaktif
  createdAt TEXT NOT NULL
);

CREATE TABLE users (
  id        TEXT PRIMARY KEY,
  cmsId     TEXT NOT NULL,
  username  TEXT NOT NULL,
  password  TEXT NOT NULL,             -- catatan: plaintext, lihat README (bukan untuk produksi)
  name      TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'owner',  -- superadmin | owner | penulis
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_users_cms ON users(cmsId);

-- ---------------------------------------------------------------
-- post — artikel. `slug` unik PER CMS (bukan global) supaya dua
-- penulis berbeda boleh punya artikel dengan slug yang sama; URL
-- publiknya tetap unik karena selalu diawali ?user/<kodeCms>/.
-- ---------------------------------------------------------------
CREATE TABLE post (
  id           TEXT PRIMARY KEY,
  cmsId        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  judul        TEXT NOT NULL,
  ringkasan    TEXT,                   -- excerpt, dipakai utk meta description & daftar artikel
  konten       TEXT NOT NULL DEFAULT '', -- HTML artikel (lihat README soal kenapa HTML, bukan markdown, di v1)
  coverImage   TEXT,
  kategori     TEXT,
  tags         TEXT,                   -- comma-separated, mis. "cloudflare,d1,worker"
  status       TEXT NOT NULL DEFAULT 'draft', -- draft | publish
  views        INTEGER DEFAULT 0,
  publishedAt  TEXT,
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL
);
CREATE INDEX idx_post_cms ON post(cmsId);
CREATE UNIQUE INDEX idx_post_cms_slug ON post(cmsId, slug);
CREATE INDEX idx_post_cms_status ON post(cmsId, status, publishedAt);

-- ---------------------------------------------------------------
-- komentar — komentar publik (tanpa login), diposting lewat fetch AJAX
-- ke worker.js (lihat pages/public.js -> publicPage.handleKomentarSubmit).
-- ---------------------------------------------------------------
CREATE TABLE komentar (
  id        TEXT PRIMARY KEY,
  cmsId     TEXT NOT NULL,
  postId    TEXT NOT NULL,
  nama      TEXT NOT NULL,
  email     TEXT,
  isi       TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'approved', -- approved | pending (lihat README utk moderasi ke depan)
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_komentar_cms ON komentar(cmsId);
CREATE INDEX idx_komentar_post ON komentar(postId);

-- ============================================================
-- SEED DATA DEMO
-- CMS "system" (kodeCms SUPERADMIN) khusus akun superadmin yang
-- mengelola daftar CMS lain. CMS "cms_demo" (kodeCms "wawan") adalah
-- contoh CMS dengan 2 artikel (1 publish, 1 draft).
-- ============================================================
INSERT INTO cms (id, kodeCms, nama, bio, avatarUrl, status, createdAt) VALUES
 ('system',  'superadmin', 'Sistem (Superadmin)', '-', NULL, 'aktif', datetime('now')),
 ('cms_demo', 'wawan',     'Wawan',  'Pracademic — praktisi & akademisi. Menulis soal software, riset, dan hal-hal di antaranya.', NULL, 'aktif', datetime('now'));

INSERT INTO users (id, cmsId, username, password, name, role, createdAt) VALUES
 ('usr_super', 'system',   'superadmin', 'super123', 'Super Admin', 'superadmin', datetime('now')),
 ('usr_owner', 'cms_demo', 'wawan',      'wawan123',  'Wawan',       'owner',      datetime('now'));

INSERT INTO post (id, cmsId, slug, judul, ringkasan, konten, kategori, tags, status, views, publishedAt, createdAt, updatedAt) VALUES
 ('pst_1', 'cms_demo', 'selamat-datang',
   'Selamat Datang di CMS Ini',
   'Artikel pertama sebagai contoh — bisa dihapus atau diedit kapan saja.',
   '<p>Ini adalah artikel contoh. Konten disimpan sebagai HTML, jadi Anda bisa menulis paragraf, <strong>teks tebal</strong>, tautan, dan elemen HTML dasar lainnya langsung di editor.</p><p>Selamat menulis!</p>',
   'Umum', 'perkenalan,cms', 'publish', 0, datetime('now'), datetime('now'), datetime('now')),
 ('pst_2', 'cms_demo', 'draft-catatan-riset',
   'Draft: Catatan Riset (belum tayang)',
   'Contoh artikel berstatus draft — tidak tampil di halaman publik sampai dipublish.',
   '<p>Isi draft di sini.</p>',
   'Riset', 'draft', 'draft', 0, NULL, datetime('now'), datetime('now'));
