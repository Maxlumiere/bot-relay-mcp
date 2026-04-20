// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * v2.1 Phase 4h — `relay generate-hooks` subcommand.
 *
 * Emits a ~/.claude/settings.json fragment (default) OR full file (--full)
 * containing the three hook entries with correctly-quoted absolute paths for
 * this install. Paths containing spaces are single-quoted per HANDOFF.md
 * edge-case discipline.
 */
import path from "path";
import { fileURLToPath } from "url";

/**
 * Quote a shell command path for embedding in JSON's "command" field.
 * Paths without spaces pass through unchanged. Paths with spaces get
 * single-quoted inside the JSON string value — double-quote is the JSON
 * delimiter; single-quote survives to the shell that Claude Code spawns.
 */
function quoteForHookCommand(p: string): string {
  if (!/\s/.test(p)) return p;
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

function resolveInstallDir(): string {
  // dist/cli/generate-hooks.js → dist/cli → dist → project root.
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function hooksConfig(): any {
  const root = resolveInstallDir();
  const sessionStart = path.join(root, "hooks", "check-relay.sh");
  const postToolUse = path.join(root, "hooks", "post-tool-use-check.sh");
  const stop = path.join(root, "hooks", "stop-check.sh");
  return {
    hooks: {
      SessionStart: [
        {
          matcher: "startup|resume",
          hooks: [{ type: "command", command: quoteForHookCommand(sessionStart), timeout: 10 }],
        },
      ],
      PostToolUse: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: quoteForHookCommand(postToolUse), timeout: 5 }],
        },
      ],
      Stop: [
        {
          matcher: "*",
          hooks: [{ type: "command", command: quoteForHookCommand(stop), timeout: 5 }],
        },
      ],
    },
  };
}

export async function run(argv: string[]): Promise<number> {
  const full = argv.includes("--full");
  const help = argv.includes("--help") || argv.includes("-h");
  if (help) {
    process.stdout.write(
      "Usage: relay generate-hooks [--full]\n\n" +
        "Emits hook entries for ~/.claude/settings.json.\n" +
        "Default: JSON fragment to merge into an existing settings.json.\n" +
        "--full : complete settings.json template (overwrite target).\n"
    );
    return 0;
  }
  const payload = hooksConfig();
  if (full) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    // Fragment: just the `hooks` object so operators can splice it in.
    process.stdout.write(JSON.stringify(payload.hooks, null, 2) + "\n");
  }
  return 0;
}
