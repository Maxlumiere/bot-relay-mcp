# public-leak-scan

A denylist scanner for text about to be published (pull request titles, bodies, commit messages, branch names). The
`public-leak-gate` workflow runs it on every pull request, from the BASE branch only, with the list supplied as a
repository secret. It prints the field and term indexes only, never a term or the scanned text, and it fails closed
when the list is missing.

This file and `scan.mjs` are synced from a canonical copy: do not edit them here.

Self-test with any list that carries the canary line: `node scan.mjs --self-test --list <file>`.
