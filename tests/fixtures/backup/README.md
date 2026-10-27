# Backup archive fixtures

Read by `tests/backup-archive.test.ts`. Regenerating either changes its sha256, which the test pins.

| file | sha256 | how it was made |
|---|---|---|
| `legacy-macos-9-member.tar.gz` | `a227285001bc79cb935b9806dde3939a5d27d24a61a3d13ea312766579472afd` | macOS 27.0.1, `/usr/bin/tar` (bsdtar 3.5.3, libarchive 3.7.4), with the exact invocation of the export before SEC-22 (iii): `tar -czf <archive> relay.db manifest.json config.json` in a staging dir. The three files were written by node, so each carries `com.apple.provenance`, and tar added a `._<name>` AppleDouble member and a `PaxHeader/<name>` (typeflag `x`) before each one: 9 members, which is what every macOS backup made before SEC-22 (iii) holds. Two things differ from a real backup. The contents are synthetic. The header owner fields are pinned (`--uname relay --gname relay --uid 501 --gid 20`) so that no account name lands in the repo; the parser never reads them. |
| `gnu-magic-3-member.tar.gz` | `a2f0cd44e3b9f609175bc32bc22ed4fcfdea19747a492b17593eb1ff618991e1` | Python `tarfile` with `format=GNU_FORMAT` (magic `ustar  \0`, the default of GNU tar on Linux), the same three synthetic files, gzipped with mtime 0. NOT made by GNU tar itself: the Linux CI job also restores an archive that the runner's real GNU tar makes. |
