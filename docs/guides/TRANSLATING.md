# Translating the UI

The UI's text lives in `apps/desktop/src/i18n/locales/<language>/<area>.json`
([ADR-0011](../adr/0011-ui-text-catalogs.md), X-13). English (`en/`) is the source. A translation has the same files
and the same keys. `pnpm test` fails when one is missing, extra, empty, or changes a `{{value}}` or a `<tag>`.

## Adding a language

1. Copy `locales/en/` to `locales/<code>/` and translate the values. Add a `locales/<code>/index.ts` like the one in
   `locales/id/`.
2. Register the language in `i18n/index.ts`:
   - add it to `LANGUAGES`, named in itself;
   - add its BCP 47 tag;
   - add its loader in `setLocale`.
3. Accept it in `settings.rs` (`normalized`), and give `menu.rs` its `menu.json`.
4. Add it to the parity tests in `i18n/catalog.test.ts`.

## Rules for every language

- **Keep markup and values exactly:** `{{name}}` and `<code>…</code>`, `<kbd>…</kbd>`, `<strong>…</strong>`. Don't
  translate what's inside `<code>`: commands, paths and file names.
- **Plurals:** use the forms the language has. Indonesian has one, so it writes only the `…_other` key, with
  `{{count}}`.
- **Don't translate names:** AgentChainer, Claude, Claude Code CLI, GitHub, Vercel, Opus, Sonnet, Haiku. Keys on the
  keyboard (Ctrl, Shift, Esc, Enter) and git's own words (HEAD, main) stay as they are too.
- **Punctuation:** keep "…" (one character) where English has it, and end with a full stop where English does.
- **Length:** buttons and tabs have little room. Prefer the short word.

## Bahasa Indonesia (`id`)

**Register:**
- Formal **"Anda"**, always capitalized. Never "kamu".
- Address the person directly and briefly; avoid "silakan" and "mohon" in buttons.

**Case:**
- Sentence case everywhere ("Buka folder…", "Pengaturan workspace").
- The exception is the menu bar (`menu.json`), which follows macOS's Indonesian menus: "Pilih Semua", "Keluar dari
  AgentChainer".

**Buttons:** imperative verbs, e.g. "Simpan", "Batal", "Terapkan".

### Kept in English

These are what Indonesian developers say. They're written lowercase inside a sentence and capitalized at its start:

> workspace, session, task, sub-task, commit, branch, PR, pull request, merge, diff, repo, plugin, marketplace, hook,
> MCP, MCP server, token, context window, worktree, prompt, agent, subagent, worker, supervisor, fleet, gate, deploy,
> deployment, rollback, smoke test, lint, typecheck, build, CI, workflow, tier, effort, terminal, editor, chat, fork,
> file, folder, setup.

Indonesian grammar goes around them: "Session baru", "Tutup session", "di-deploy", "di-commit", "Rencana setup".

### Standard translations

| English | Bahasa Indonesia |
|---|---|
| Settings / Workspace settings | Pengaturan / Pengaturan workspace |
| Home | Beranda |
| Overview | Ringkasan |
| Setup check / Setup plan | Pemeriksaan setup / Rencana setup |
| History | Riwayat |
| Commands / Command palette | Perintah / Palet perintah |
| Permissions / Permission profile | Izin / Profil izin |
| Metrics | Metrik |
| Changes | Perubahan |
| Details / Result / Source | Detail / Hasil / Sumber |
| License / Name / Scope | Lisensi / Nama / Cakupan |
| Tools | Tool |
| Team / Main agent / Background task | Tim / Agent utama / Task latar belakang |
| Schedule / Lessons | Jadwal / Pelajaran |
| Contract / Objective / Acceptance criteria / Out of scope | Kontrak / Tujuan / Kriteria penerimaan / Di luar cakupan |
| Evidence / Evidence report | Bukti / Laporan bukti |
| Merge gates | Gate merge |
| Risk / Low, medium, high risk | Risiko / Risiko rendah, sedang, tinggi |
| Budget / Budget cap / Cost | Anggaran / Batas anggaran / Biaya |
| Approval / Approve / Deny | Persetujuan / Setujui / Tolak |
| Allow once / Always allow | Izinkan sekali / Selalu izinkan |
| Review / Review first | Tinjau / Tinjau dulu |
| Theme / Light / Dark / System | Tema / Terang / Gelap / Sistem |
| Language | Bahasa |
| Model / Default | Model / Default |
| Safe / Standard / Plan first / Autonomous (modes) | Aman / Standar / Rencana dulu / Otonom |
| Save / Cancel / Close / Dismiss | Simpan / Batal / Tutup / Tutup |
| Delete / Remove / Rename | Hapus / Hapus / Ganti nama |
| Edit / Copy / Copied | Edit / Salin / Disalin |
| Open / Open folder… / Open in editor | Buka / Buka folder… / Buka di editor |
| Refresh / Check again | Muat ulang / Periksa lagi |
| Apply / Apply selected | Terapkan / Terapkan yang dipilih |
| Install / Uninstall / Update / Updates | Pasang / Copot / Perbarui / Pembaruan |
| Resume / Stop / Interrupt / Run | Lanjutkan / Hentikan / Interupsi / Jalankan |
| Roll back / Roll back run | Rollback / Rollback run |
| Rewind files | Kembalikan file |
| Discard / Show / Hide / Search / Send | Buang / Tampilkan / Sembunyikan / Cari / Kirim |
| Attach files | Lampirkan file |
| Back to … | Kembali ke … |
| New (session, task) | … baru ("Session baru", "Task baru") |
| Export diagnostics | Ekspor diagnostik |
| Running / Done / Failed / Stopped / Paused | Berjalan / Selesai / Gagal / Dihentikan / Dijeda |
| Passed / Not run / Ready / Missing / Draft | Lulus / Belum dijalankan / Siap / Belum ada / Draf |
| Waiting for approval / Waiting for you | Menunggu persetujuan / Menunggu Anda |
| Loading… / Saving… / Checking… / Working… | Memuat… / Menyimpan… / Memeriksa… / Bekerja… |
| Generating… / Scanning… / Stopping… | Membuat… / Memindai… / Menghentikan… |
| s / min / h (durations) | dtk / mnt / jam |

When a term isn't here, translate it the way the nearest entry does, then add it to this table in the same PR.
