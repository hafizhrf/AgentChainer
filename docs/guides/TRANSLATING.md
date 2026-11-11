# Translating the UI

The UI's text lives in `apps/desktop/src/i18n/locales/<language>/<area>.json`
([ADR-0011](../adr/0011-ui-text-catalogs.md), X-13). English (`en/`) is the source. A translation has the same files
and the same keys. `pnpm test` fails when one is missing, extra, empty, or changes a `{{value}}` or a `<tag>`.

## Where the text lives

| Catalogs | What they hold | Loaded |
|---|---|---|
| `apps/desktop/src/i18n/locales/<language>/` | The UI. `menu.json` and `native.json` are also read by the Rust core (the macOS menu, its errors). | Indonesian in its own chunk |
| `packages/protocol/src/locales/<language>.json` | Text the UI and the sidecar share: approval reasons, agent and folder problems, cadences | Bundled |
| `packages/sidecar/src/i18n/locales/<language>/` | The sidecar's errors, setup findings, plan reasons, apply and rollback messages, deploy, plugin and MCP server messages | Bundled |

The catalog's own prose (items, profiles, workflows) is translated in its YAML, next to the English, in an
`i18n.<code>` block ([CATALOG.md §3](../CATALOG.md#3-item-schema)). A new language adds its block to every shipped
file, and `build-catalog.ts` checks they're complete.

One language holds for the whole process (`setLanguage` in the protocol package). The sidecar gets it from
`AGENTCHAINER_LANGUAGE` at spawn.

**Never translated:**
- text Claude reads (prompts, guard reasons);
- files written into a repository, commit messages, pull requests, and the evidence report;
- log lines;
- raw output from git, gh or the CLI.

Saved records (setup runs, deploys, schedules) keep the language they were written in.

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
> skill, MCP, MCP server, token, context window, worktree, prompt, agent, subagent, worker, supervisor, fleet, gate,
> guard, checkpoint, deploy, deployment, production, rollback, smoke test, test, lint, typecheck, build, CI, workflow,
> tier, effort, terminal, editor, chat, fork, file, folder, path, setup, run (the noun), API key, secret,
> environment, exit code, output, log.
>
> git's verbs and places: push, pull, fetch, stage, unstage, checkout, fast-forward, stash, rebase, squash, remote,
> upstream, working tree, HEAD.
>
> Tools' words: linter, formatter, test runner, symlink, registry, image (Docker), front matter, exit code.

Indonesian grammar goes around them: "Session baru", "Tutup session", "di-deploy", "di-commit", "Sudah di-push",
"Rencana setup", "Rollback run".

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
| Turn (of a chat) | Giliran |
| Queue / Queued / Queue message | Antrean / Dalam antrean / Antrekan pesan |
| Composer | Kotak pesan |
| Graph / Timeline | Graf / Linimasa |
| Project / Preview / Provider | Proyek / Pratinjau / Penyedia |
| Triage | Triase |
| Split (a task) / Split (a workflow step's kind) | Pecah / Pemecahan |
| Draft (a contract) | Susun draf |
| Continue (an XL run) | Teruskan (Resume stays Lanjutkan) |
| Step / Round / Fix round / Flow | Langkah / Putaran / Putaran perbaikan / Alur |
| Criterion / Reviewer / A review | Kriteria / Peninjau / Tinjauan |
| Reviewed / Not reviewed | Ditinjau / Belum ditinjau |
| Installed / On / Off / Turn on / Turn off | Terpasang / Aktif / Nonaktif / Aktifkan / Nonaktifkan |
| Interrupted / Not verified / Accepted with risk | Terinterupsi / Belum diverifikasi / Diterima dengan risiko |
| Skipped / Cancelled / Not run (a skipped step) | Dilewati / Dibatalkan / Tidak dijalankan |
| Deployed / Deploying… | Ter-deploy / Men-deploy… |
| Publish (a branch) | Terbitkan |
| Revert (a file, a hunk) | Kembalikan |
| Sign in / Signed in / Not signed in | Masuk / Sudah masuk / Belum masuk |
| Appearance / Options / Limits / About | Tampilan / Opsi / Batas / Tentang |
| Restart / Later / Not now | Mulai ulang / Nanti / Nanti saja |
| Minimize / Maximize / Restore (a window) | Perkecil / Maksimalkan / Pulihkan |
| Read-only | Hanya baca |
| Confidence / Signals | Keyakinan / Sinyal |
| Generate / Regenerate | Buat / Buat ulang |
| Self-test / Screenshot | Uji mandiri / Tangkapan layar |
| Repository | Repositori |
| e.g. | mis. |
| Diverged (branches) / Detached | Bercabang / detached |
| Reinstall / Timed out / Integrity check | Pasang ulang / Melewati batas waktu / Pemeriksaan integritas |
| Drafting (a step) / Drafting the contract | Penyusunan draf / Menyusun draf kontrak |
| Linked (to a provider) / Site | Ditautkan / Situs |
| Untitled session | Session tanpa judul |
| Proposal / Hook manager | Usulan / Pengelola hook |
| Pinned (a version) / Backup / Undo | Di-pin / Cadangan / Pembatalan |
| Dependencies / A check (CI, PR) / Role | Dependensi / Pemeriksaan / Peran |
| Revise / Your own agent | Revisi / Agent milik Anda |
| Turn ran out / Its budget ran out | Semua gilirannya terpakai / Anggarannya habis |
| Stopped by the user / Left as it is | Dihentikan oleh Anda / Dibiarkan apa adanya |
| `cmd` exited N | `cmd` keluar dengan exit code N |
| Error / Conflicts | Kesalahan / Konflik |
| Must-fix / Should-fix / Note (review findings) | Wajib diperbaiki / Sebaiknya diperbaiki / Catatan |
| Finding / Review findings | Temuan / Temuan tinjauan |
| Fix: … / Fix CI: … (steps) | Perbaiki: … / Perbaiki CI: … |
| Local gates / Integration gates | Gate lokal / Gate integrasi |
| Task branch | Branch task |
| Request / Outcome / Verdict / Estimates | Permintaan / Hasil / Keputusan / Perkiraan |
| New / Modified / Deleted (files) / Binary | Baru / Diubah / Dihapus / Biner |
| Secrets scan / Security notes | Pemindaian secret / Catatan keamanan |
| Remaining risks and manual steps | Risiko tersisa dan langkah manual |

When a term isn't here, translate it the way the nearest entry does, then add it to this table in the same PR.
