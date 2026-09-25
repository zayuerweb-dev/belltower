#!/usr/bin/env node
// 在项目里把框架文件更新到 belltower 的某个版本。**只碰清单里的 framework 文件**,
// 项目自己的东西(CLAUDE.md、belltower.json、四件台账、各板块 SKILL.md、冻结清单)永远不碰。
//
// 用法(在项目根跑):
//   node scripts/belltower-sync.mjs [--ref <tag 或分支>=main] [--source <本地 belltower 目录或 git URL>] [--apply]
//   - 默认只列出会变什么(预演);加 --apply 才写。
//   - --source 缺省 = lock 文件里的 upstream。
// 写完更新 `.claude/belltower.lock.json`。之后跑一遍 `node scripts/test-hooks.mjs`,绿了再提交。
// 为什么默认预演:框架文件被项目就地改过的话,覆盖 = 静默丢掉项目的改动。先看再写。
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const apply = args.includes("--apply");
const ref = opt("--ref") ?? "main";
let lock = {};
try { lock = JSON.parse(readFileSync(".claude/belltower.lock.json", "utf8")); } catch {}
const source = opt("--source") ?? lock.upstream;
if (!source) { console.error("不知道从哪同步:给 --source,或先用 belltower-init 装一次(会写 lock 文件)。"); process.exit(2); }

let SRC = source, tmp = null;
const isDir = (() => { try { return statSync(source).isDirectory(); } catch { return false; } })();
if (!isDir) {
  tmp = mkdtempSync(join(tmpdir(), "belltower-"));
  try {
    execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", ref, source, tmp], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) { console.error(`拉不下来 ${source}@${ref}:${String(e.stderr ?? e.message).trim()}`); process.exit(2); }
  SRC = tmp;
}

try {
  const man = JSON.parse(readFileSync(join(SRC, "belltower.manifest.json"), "utf8"));
  const changed = [], added = [];
  for (const e of man.framework) {
    const s = join(SRC, e.src), d = e.dst;
    if (!existsSync(d)) added.push(e);
    else if (!readFileSync(s).equals(readFileSync(d))) changed.push(e);
  }
  const missingInit = man.init.filter((e) => !existsSync(e.dst)).map((e) => e.dst);

  console.log(`belltower ${lock.version ?? "(未知)"} → ${man.version}(${isDir ? source : `${source}@${ref}`})`);
  for (const e of added) console.log(`  + ${e.dst}`);
  for (const e of changed) console.log(`  ~ ${e.dst}`);
  if (!added.length && !changed.length) console.log("  框架文件都已一致。");
  if (missingInit.length) console.log(`  (项目缺这些起步文件,sync 不补;要补用 belltower-init:${missingInit.join("、")})`);

  if (!apply) { if (added.length || changed.length) console.log("\n预演,没写任何东西。确认后加 --apply。"); }
  else {
    for (const e of [...added, ...changed]) { mkdirSync(dirname(e.dst), { recursive: true }); copyFileSync(join(SRC, e.src), e.dst); }
    mkdirSync(".claude", { recursive: true });
    writeFileSync(".claude/belltower.lock.json", JSON.stringify({ version: man.version, upstream: lock.upstream ?? (isDir ? undefined : source), ref: isDir ? undefined : ref }, null, 2) + "\n");
    console.log(`\n已写 ${added.length + changed.length} 个文件。下一步:node scripts/test-hooks.mjs,绿了再提交。`);
  }
} finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
