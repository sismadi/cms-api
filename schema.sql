-- ============================================================
-- schema.sql — Skema Cloudflare D1 untuk PLATFORM CMS MULTI-USER
-- VERSI TER-HARDENING (lihat SECURITY.md & worker.js).
-- ============================================================
-- Perubahan dari versi sebelumnya:
--   * users.password (plaintext) -> users.passwordHash (PBKDF2-SHA256)
--   * users(cmsId, username) kini UNIQUE — mencegah dua akun identik
--     dalam satu CMS yang membuat hasil login ambigu.
--   * komentar.userId (wajib) — komentar hanya dari pengguna login,
--     identitasnya tertelusur; kolom `email` bebas-ketik dihapus.
--   * tabel baru rate_limit — penegakan lockout login/registrasi/komentar
--     di server (frontend-only lockout tidak menghentikan bot).
-- ============================================================

DROP TABLE IF EXISTS rate_limit;
DROP TABLE IF EXISTS komentar;
DROP TABLE IF EXISTS post;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS cms;

-- ---------------------------------------------------------------
-- cms — tabel global. kodeCms = slug URL publik + kode login.
-- ---------------------------------------------------------------
CREATE TABLE cms (
  id        TEXT PRIMARY KEY,
  kodeCms   TEXT UNIQUE NOT NULL,
  nama      TEXT NOT NULL,
  bio       TEXT,
  avatarUrl TEXT,
  status    TEXT NOT NULL DEFAULT 'aktif',   -- aktif | nonaktif
  createdAt TEXT NOT NULL
);

-- ---------------------------------------------------------------
-- users — akun login per-CMS. TIDAK PERNAH dapat dibaca lewat /api
-- (lihat BLOCKED_TABLES di worker.js); hanya endpoint login/register
-- yang menyentuhnya, dan keduanya tidak pernah mengembalikan hash.
-- ---------------------------------------------------------------
CREATE TABLE users (
  id           TEXT PRIMARY KEY,
  cmsId        TEXT NOT NULL,
  username     TEXT NOT NULL,
  passwordHash TEXT NOT NULL,   -- format: pbkdf2$sha256$<iter>$<salt>$<hash>
  name         TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'owner',  -- superadmin | owner | penulis
  createdAt    TEXT NOT NULL
);
CREATE INDEX idx_users_cms ON users(cmsId);
CREATE UNIQUE INDEX idx_users_cms_username ON users(cmsId, username);

-- ---------------------------------------------------------------
-- post — artikel; slug unik PER CMS.
-- ---------------------------------------------------------------
CREATE TABLE post (
  id           TEXT PRIMARY KEY,
  cmsId        TEXT NOT NULL,
  slug         TEXT NOT NULL,
  judul        TEXT NOT NULL,
  ringkasan    TEXT,
  konten       TEXT NOT NULL DEFAULT '',   -- HTML, sudah di-sanitize server-side
  coverImage   TEXT,
  kategori     TEXT,
  tags         TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft | publish
  views        INTEGER DEFAULT 0,
  publishedAt  TEXT,
  createdAt    TEXT NOT NULL,
  updatedAt    TEXT NOT NULL
);
CREATE INDEX idx_post_cms ON post(cmsId);
CREATE UNIQUE INDEX idx_post_cms_slug ON post(cmsId, slug);
CREATE INDEX idx_post_cms_status ON post(cmsId, status, publishedAt);

-- ---------------------------------------------------------------
-- komentar — hanya dari pengguna yang login. `nama` & `userId` diisi
-- server dari token sesi, bukan dari body request.
-- ---------------------------------------------------------------
CREATE TABLE komentar (
  id        TEXT PRIMARY KEY,
  cmsId     TEXT NOT NULL,
  postId    TEXT NOT NULL,
  userId    TEXT NOT NULL,
  nama      TEXT NOT NULL,
  isi       TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'approved', -- approved | pending
  createdAt TEXT NOT NULL
);
CREATE INDEX idx_komentar_cms ON komentar(cmsId);
CREATE INDEX idx_komentar_post ON komentar(postId);
CREATE INDEX idx_komentar_user ON komentar(userId);

-- ---------------------------------------------------------------
-- rate_limit — penghitung percobaan per kunci (mis. "login:ip:1.2.3.4",
-- "login:acc:wawan:wawan", "komentar:<userId>"). Dibersihkan berkala:
--   DELETE FROM rate_limit WHERE blockedUntil < <now-ms> AND windowStart < <now-ms - 86400000>;
-- ---------------------------------------------------------------
CREATE TABLE rate_limit (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  windowStart  INTEGER NOT NULL,
  blockedUntil INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- SEED DATA DEMO
-- Password di bawah sudah DALAM BENTUK HASH PBKDF2-SHA256 (100.000
-- iterasi — batas maksimal yang didukung WebCrypto Cloudflare Workers).
-- Plaintext-nya hanya untuk demo lokal — GANTI SEBELUM
-- PRODUKSI, dan hapus baris demo ini di lingkungan sungguhan.
--   superadmin / Sup3rAdmin!2026
--   wawan      / Wawan!Demo2026
-- (Cara membuat hash baru ada di README.md bagian "Membuat hash password".)
-- ============================================================
INSERT INTO cms (id, kodeCms, nama, bio, avatarUrl, status, createdAt) VALUES
 ('system',   'superadmin', 'Sistem (Superadmin)', '-', NULL, 'aktif', datetime('now')),
 ('cms_demo', 'wawan',      'Wawan', 'Pracademic — praktisi & akademisi. Menulis soal software, riset, dan hal-hal di antaranya.', NULL, 'aktif', datetime('now'));

INSERT INTO users (id, cmsId, username, passwordHash, name, role, createdAt) VALUES
 ('usr_super', 'system',   'superadmin', 'pbkdf2$sha256$100000$oYpuW3kiXWshL5LW3AtR2Q$MBRtyakD2M8_6YZ4GDgOwXDCrW9rCpWcpIy4Gvrm-Sk', 'Super Admin', 'superadmin', datetime('now')),
 ('usr_owner', 'cms_demo', 'wawan',      'pbkdf2$sha256$100000$cDzAvxJlnyReoWcKbPyw-Q$3N-07IxVjQ43SOSbMjQc3o7be_0OR_tpipp7akIdsUc',      'Wawan',       'owner',      datetime('now'));

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
