#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");

const skill = read("skills/codex-slides/SKILL.md");
assert.match(skill, /## Browser-first default/);
assert.match(skill, /Call `open_codex_slides` \/ CLI `open` \*\*without\*\* a project id/);
assert.match(skill, /Do not call `deep_research`[\s\S]*before opening the Browser/);
assert.match(skill, /Do not default to `create_deck`/);

const mcp = read("mcp/server.mjs");
assert.match(mcp, /"start_project"/);
assert.match(mcp, /"start_project_run"/);
assert.match(mcp, /"wait_project_run"/);
assert.match(mcp, /"cancel_project_run"/);
assert.match(mcp, /postJson\("\/api\/projects"/);
assert.match(mcp, /interactionMode: "browser-guided"/);
assert.match(mcp, /Use create_deck only when the user explicitly asks/);
assert.match(mcp, /preferredMode: "codex-internal-browser"/);
assert.match(mcp, /url\.searchParams\.set\("slide"/);
assert.match(mcp, /url\.searchParams\.set\("panel"/);
assert.match(mcp, /url\.searchParams\.set\("version"/);

const cli = read("skills/codex-slides/scripts/codex-slides.mjs");
assert.match(cli, /"start-project"/);
assert.match(cli, /"run-start"/);
assert.match(cli, /"run-status"/);
assert.match(cli, /"run-wait"/);
assert.match(cli, /"run-cancel"/);
assert.match(cli, /interactionMode: "browser-guided"/);

const manifest = JSON.parse(read(".codex-plugin/plugin.json"));
const packageManifest = JSON.parse(read("package.json"));
assert.ok(
  manifest.version.startsWith(`${packageManifest.version}+codex.`),
  `plugin version ${manifest.version} must track package version ${packageManifest.version}`,
);
assert.ok(
  manifest.interface.defaultPrompt.some(
    (prompt) => /(?:Browser|ブラウザ).*(?:step by step|段階的)/i.test(prompt),
  ),
);
assert.ok(manifest.interface.capabilities.includes("Guided project checkpoints"));
assert.ok(manifest.interface.capabilities.includes("Durable run start, status, wait, and cancel"));

for (const path of [
  "skills/codex-slides-verification/SKILL.md",
  "skills/codex-slides-known-errors/SKILL.md",
  "skills/codex-slides-structured-intake/SKILL.md",
]) {
  assert.match(read(path), /^---[\s\S]+?description:/, `${path} must be an installable Skill`);
}

process.stdout.write("Browser-first Codex contract passed.\n");
