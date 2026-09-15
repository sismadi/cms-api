# Konversi POS → CMS Multi-User (v3: penamaan `cms` + URL publik rapi)

Ringkasan perubahan dari `pos-api-main` + `pos-app-main` menjadi platform
CMS multi-user. Dokumen ini adalah revisi kedua: v1 memakai SSR 1-origin,
v2 memecahnya jadi microservices + query routing, dan v3 (dokumen ini)
menyeragamkan penamaan ke `cms` serta merapikan URL publik.

## Keputusan arsitektur yang masih berlaku

1. **1 user = 1 CMS**, isolasi data penuh — persis pola toko di versi
   POS, hanya kontennya diganti dari produk/transaksi menjadi artikel.
2. **2 repo/layanan terpisah** (microservices):

```
cms-api/   <- repo ini — BACKEND MURNI (Cloudflare Worker + D1, JSON only)
  worker.js
  schema.sql
  wrangler.toml
cms-app/   <- FRONTEND MURNI (static SPA, dideploy sendiri, mis. GitHub Pages)
  index.html
  engine.js, db.js, auth.js, dataset.js
  pages/*.js (termasuk pages/public.js)
```

## Perubahan v3 — satu istilah: `cms`

Sebelumnya istilah bercampur: `tenant` (warisan pola multi-tenant POS),
`toko` (warisan domain POS), dan `blog` (nama produk versi v1/v2). Semua
diseragamkan menjadi **`cms`**, di seluruh lapisan, tanpa sisa:

| Lama (v2)              | Baru (v3)            | Tempat                        |
|------------------------|----------------------|-------------------------------|
| tabel `tenants`        | tabel `cms`          | schema.sql, worker.js, db.js  |
| kolom `tenantId`       | kolom `cmsId`        | schema.sql, worker.js, db.js  |
| kolom `kodeToko`       | kolom `kodeCms`      | schema.sql, worker.js, auth.js|
| query `?tenantId=`     | query `?cmsId=`      | endpoint `/api`               |
| `view=blog`            | `view=profile`       | endpoint `/public`            |
| rute `?page=tenant`    | rute `?page=cms`     | cms-app (halaman superadmin)  |
| `pages/tenant.js`      | `pages/cms.js`       | cms-app                       |
| `db.allTenants()` dst. | `db.allCms()` dst.   | db.js                         |
| sesi `blogSession`     | sesi `cmsSession`    | auth.js (localStorage)        |
| "Piawai Blog"          | "Piawai CMS"         | index.html, judul halaman     |

Konsekuensi: **sesi login lama otomatis tidak terbaca** (key localStorage
berubah) — pengguna cukup masuk ulang. Database lama juga tidak kompatibel;
jalankan `schema.sql` yang baru (lihat Deploy).

## Perubahan v3 — URL publik yang rapi

Di v2, URL publik berbentuk pasangan key=value yang panjang:
`...?page=artikel&user=<kode>&slug=<slug>`. Di v3, rute **publik** memakai
query string yang diisi **segmen mirip path**:

| Halaman     | URL v3                                  |
|-------------|------------------------------------------|
| Beranda     | `cms.piawai.id/`                         |
| Profil CMS  | `cms.piawai.id/?profile/<kodeCms>`       |
| Artikel     | `cms.piawai.id/?user/<kodeCms>/<slug>`   |

Yang **tidak** berubah: ini tetap query string murni — path selalu `/`,
jadi hosting statis apa pun (GitHub Pages, Cloudflare Pages, Netlify)
tetap menyajikan `index.html` yang sama **tanpa konfigurasi rewrite apa
pun**. Yang diubah hanya *isi* query-nya, supaya alamat enak dibaca dan
dibagikan. Alasan lengkap kenapa query string (bukan path sungguhan)
tetap dipakai ada di bagian berikutnya.

Rute **admin** sengaja TETAP format lama `?page=slug&param=nilai`
(`?page=dashboard`, `?page=editor&id=...`), karena tidak pernah dibagikan
atau diindeks — tidak ada untungnya dirapikan, dan formatnya lebih mudah
dibaca saat menambah parameter baru.

Implementasinya terpusat di `cms-app/engine.js`:
`PRETTY_PUBLIC_ROUTES` (peta rute publik), `parseLocationParams()`
(URL → params), dan `buildQueryString()` (params → URL). Menambah rute
publik baru cukup menambah satu entri di `PRETTY_PUBLIC_ROUTES`.

## Kenapa query string, bukan path?

Karena frontend & backend adalah 2 origin/domain berbeda (bukan 1 Worker
lagi), tidak ada server yang bisa melakukan path-rewrite bersama untuk
keduanya. Hosting statis untuk frontend juga TIDAK BISA me-rewrite path
sembarang ke 1 file secara native — satu-satunya trik yang ada (redirect
404 → query string → `pushState`) pada akhirnya tetap lewat query string
juga. Karena itu, baik komunikasi API (`cms-app` → `cms-api`) maupun
routing halaman di dalam `cms-app`, semuanya konsisten pakai query string.

**Konsekuensi yang disadari & diterima:**
- SSR sungguhan (HTML dirender di server) **tidak ada**. Backend cuma
  JSON (`/public?view=...`); yang merender HTML adalah `cms-app` di klien
  (lihat `pages/public.js`). Pengindeksan mesin pencari bergantung pada
  kemampuan Google/dst. menjalankan JavaScript.
- Form komentar **wajib JS** (fetch ke `/public?view=komentar`), karena
  hosting statis tidak punya server untuk memproses `<form method="POST">`.

## Deploy

**Backend (`cms-api`):**
```
wrangler d1 create <NAMA_DB>       # isi database_id ke wrangler.toml
wrangler d1 execute <NAMA_DB> --file=schema.sql
wrangler deploy
```
Catat URL yang dihasilkan (mis. `https://cms-api.<akun>.workers.dev`).

**Frontend (`cms-app`):**
Isi `API_BASE` di `db.js` dengan URL backend di atas, lalu deploy folder
ini ke hosting statis pilihan. Untuk memakai `cms.piawai.id`, arahkan
subdomain tersebut ke hosting statis itu (custom domain di GitHub Pages /
Cloudflare Pages / Netlify) — tidak ada aturan rewrite yang perlu diatur.

## Pemetaan skema (POS → CMS)

| POS                          | CMS                                      |
|-------------------------------|------------------------------------------|
| `tenants` (toko)              | `cms` (akun CMS/penulis) — kolom `kodeCms` RANGKAP: kode login **dan** slug di URL publik |
| `users` (kasir/gudang/owner)  | `users` (penulis/owner/superadmin)       |
| `produk`, `lokasi`, `distribusi`, `transaksi`, `kontak`, `akun`, `jurnal`, dst. | **dihapus** |
| — | `post` (artikel) — baru |
| — | `komentar` (komentar publik per artikel) — baru |

## Endpoint backend (`cms-api`, semua query string)

- `GET/POST/PATCH/DELETE /api?table=&id=&cmsId=` — CRUD generik
  (aturan isolasi per-CMS tetap sama seperti versi POS).
- `GET /public?view=home` — daftar CMS aktif.
- `GET /public?view=profile&user=<kodeCms>` — profil + daftar artikel publish.
- `GET /public?view=artikel&user=<kodeCms>&slug=<slug>` — artikel + komentar.
- `POST /public?view=komentar&user=<kodeCms>&slug=<slug>` — kirim komentar.

Catatan: endpoint backend TIDAK ikut memakai bentuk "rapi" seperti URL
publik frontend. Backend adalah kontrak API antar-layanan — `view=profile`
sebagai pasangan key=value lebih mudah di-parse, di-log, dan diletakkan di
belakang API gateway ketimbang segmen posisional.

## Rute frontend (`cms-app`)

Publik (bentuk rapi, lihat tabel di atas): beranda `/`,
`?profile/<kodeCms>`, `?user/<kodeCms>/<slug>` — semuanya di
`pages/public.js`.

Admin (butuh login, format `?page=`): `login`, `register`, `dashboard`,
`editor` (+ `&id=`), `postingan`, `profil` (edit profil CMS sendiri),
`cms` (kelola semua CMS, khusus superadmin).

Perhatikan pasangan nama yang sengaja dibedakan: `?profile/<kodeCms>`
adalah halaman PUBLIK yang dilihat pengunjung, sedangkan `?page=profil`
adalah FORM EDIT halaman tersebut, khusus pemiliknya.

Tidak ada konsep "reserved slug" (kata terlarang untuk `kodeCms`) —
`kodeCms` tidak pernah jadi nama rute, dia selalu jadi nilai di dalam
query string publik, jadi tidak mungkin bentrok dengan rute admin.

## Yang SENGAJA belum digarap

- **Konten artikel = HTML mentah** (sama seperti sebelumnya).
- **Moderasi komentar**: kolom `status` di tabel `komentar` (default
  `approved`) belum ada UI moderasi.
- **`sitemap.xml`**: tanpa SSR, generatornya perlu jalan di sisi build/CI
  frontend (query `/public?view=home` + per-CMS), bukan di Worker.
- Keamanan `cmsId` di query string masih pola yang sama (lihat catatan
  di `worker.js`) — belum pakai sesi/JWT server-side.
- CORS backend masih `Access-Control-Allow-Origin: *` — untuk produksi,
  sebaiknya dibatasi ke domain frontend yang sebenarnya.
