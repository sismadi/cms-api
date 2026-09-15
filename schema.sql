-- ============================================================
-- schema.sql — Skema Cloudflare D1 untuk BLOG MULTI-USER
-- (dikonversi dari skema POS multi-tenant; struktur isolasi tenant
-- DIPERTAHANKAN APA ADANYA — hanya tabel bisnisnya yang diganti).
-- ============================================================
-- Konsep: 1 user = 1 tenant (satu "blog" dengan ruang data terisolasi
-- penuh, persis seperti 1 toko di versi POS). `tenants.kodeToko` kini
-- berperan RANGKAP:
--   1. Kode login (dipakai di form Masuk, sama seperti sebelumnya)
--   2. SLUG URL publik  -> piawai.id/<kodeToko>  dan
--                          piawai.id/<kodeToko>/<slug-artikel>
-- Karena itu formatnya WAJIB url-safe (huruf kecil, angka, strip),
-- lihat validasi di auth.js (klien) dan worker.js (server, tabel
-- `tenants`). Kata-kata reserved (login/register/dashboard/dst) tidak
-- boleh dipakai sebagai kodeToko — lihat RESERVED_SLUGS di worker.js.
--
-- Entitas:
--   tenants   -> satu baris per BLOG/PENULIS (tidak di-scope, memang
--                daftar tenant itu sendiri)
--   users     -> akun login per-tenant (owner/penulis/superadmin) —
--                satu tenant BISA punya lebih dari satu akun penulis
--   post      -> artikel milik satu tenant
--   komentar  -> komentar publik (tanpa login) pada satu artikel
-- ============================================================

DROP TABLE IF EXISTS komentar;
DROP TABLE IF EXISTS post;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS tenants;

-- ---------------------------------------------------------------
-- tenants — TIDAK di-scope (tabel global). kodeToko = slug URL publik
-- DAN kode login, jadi harus unik & url-safe (lihat catatan di atas).
-- ---------------------------------------------------------------
CREATE TABLE tenants (
  id        TEXT PRIMARY KEY,
  kodeToko  TEXT UNIQUE NOT NULL,      -- slug URL publik + kode login, lowercase
  nama      TEXT NOT NULL,             -- nama tampilan penulis/blog
  bio       TEXT,                      -- deskripsi singkat, tampil di halaman /:user
  avatarUrl TEXT,
  status    TEXT NOT NULL DEFAULT 'aktif',   -- aktif | nonaktif
  createdAt TEXT NOT NULL
);

CREATE TABLE users (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL,
  username  TEXT NOT NULL,
  password  TEXT NOT NULL,             -- catatan: plaintext, lihat README (bukan untuk produksi)
  name      TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'owner',  -- superadmin | owner | penulis
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_users_tenant ON users(tenantId);

-- ---------------------------------------------------------------
-- post — artikel. `slug` unik PER TENANT (bukan global) supaya dua
-- penulis berbeda boleh punya artikel dengan slug yang sama; URL
-- publiknya tetap unik karena selalu diawali /<kodeToko>/.
-- ---------------------------------------------------------------
CREATE TABLE post (
  id           TEXT PRIMARY KEY,
  tenantId     TEXT NOT NULL,
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
CREATE INDEX idx_post_tenant ON post(tenantId);
CREATE UNIQUE INDEX idx_post_tenant_slug ON post(tenantId, slug);
CREATE INDEX idx_post_tenant_status ON post(tenantId, status, publishedAt);

-- ---------------------------------------------------------------
-- komentar — komentar publik (tanpa login), diposting lewat <form>
-- HTML biasa langsung ke worker.js (lihat handleCommentSubmit), jadi
-- TETAP jalan walau JavaScript di browser pengunjung dimatikan.
-- ---------------------------------------------------------------
CREATE TABLE komentar (
  id        TEXT PRIMARY KEY,
  tenantId  TEXT NOT NULL,
  postId    TEXT NOT NULL,
  nama      TEXT NOT NULL,
  email     TEXT,
  isi       TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'approved', -- approved | pending (lihat README utk moderasi ke depan)
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_komentar_tenant ON komentar(tenantId);
CREATE INDEX idx_komentar_post ON komentar(postId);

-- ============================================================
-- SEED DATA DEMO
-- Tenant "system" (kodeToko SUPERADMIN) khusus akun superadmin yang
-- mengelola daftar blog/tenant lain. Tenant "tnt_demo" (kodeToko
-- "wawan") adalah contoh blog dengan 2 artikel (1 publish, 1 draft).
-- ============================================================
INSERT INTO tenants (id, kodeToko, nama, bio, avatarUrl, status, createdAt) VALUES
 ('system',   'superadmin', 'Sistem (Superadmin)', '-', NULL, 'aktif', datetime('now')),
 ('tnt_demo', 'wawan',      'Wawan',  'Pracademic — praktisi & akademisi. Menulis soal software, riset, dan hal-hal di antaranya.', NULL, 'aktif', datetime('now'));

INSERT INTO users (id, tenantId, username, password, name, role, createdAt) VALUES
 ('usr_super', 'system',   'superadmin', 'super123', 'Super Admin', 'superadmin', datetime('now')),
 ('usr_owner', 'tnt_demo', 'wawan',      'wawan123',  'Wawan',       'owner',      datetime('now'));

INSERT INTO post (id, tenantId, slug, judul, ringkasan, konten, kategori, tags, status, views, publishedAt, createdAt, updatedAt) VALUES
 ('pst_1', 'tnt_demo', 'selamat-datang',
   'Selamat Datang di Blog Ini',
   'Artikel pertama sebagai contoh — bisa dihapus atau diedit kapan saja.',
   '<p>Ini adalah artikel contoh. Konten disimpan sebagai HTML, jadi Anda bisa menulis paragraf, <strong>teks tebal</strong>, tautan, dan elemen HTML dasar lainnya langsung di editor.</p><p>Selamat menulis!</p>',
   'Umum', 'perkenalan,blog', 'publish', 0, datetime('now'), datetime('now'), datetime('now')),
 ('pst_2', 'tnt_demo', 'draft-catatan-riset',
   'Draft: Catatan Riset (belum tayang)',
   'Contoh artikel berstatus draft — tidak tampil di halaman publik sampai dipublish.',
   '<p>Isi draft di sini.</p>',
   'Riset', 'draft', 'draft', 0, NULL, datetime('now'), datetime('now'));
