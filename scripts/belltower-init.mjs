#!/usr/bin/env node
// 把 belltower 装进一个项目:框架文件 + 起步模板各拷一份。
//
// 用法:node scripts/belltower-init.mjs <项目目录> [--force]
//   - 框架文件(清单 framework):目标已有且不同 → 不覆盖,报出来;要更新走 belltower-sync。
//   - 起步模板(清单 init):目标已有 → 跳过(归项目了);--force 才覆盖。
//   - 最后在项目里写 `.claude/belltower.lock.json`,记下装的是哪个版本。
// 装完先改 `.claude/belltower.json`(仓库名、代码目录、板块、敏感路径),再跑 `node scripts/test-hooks.mjs`。
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const force = args.includes("--force");
const target = args.find((a) => !a.startsWith("--"));
if (!target) { console.error("用法:node scripts/belltower-init.mjs <项目目录> [--force]"); process.exit(2); }
const T = resolve(target);
const man = JSON.parse(readFileSync(join(SRC, "belltower.manifest.json"), "utf8"));

const same = (a, b) => existsSync(b) && readFileSync(a).equals(readFileSync(b));
const put = (src, dst) => { mkdirSync(dirname(dst), { recursive: true }); copyFileSync(src, dst); };
const rep = { 新装: [], 已一致: [], 跳过: [], 覆盖: [], 冲突: [] };

for (const e of man.framework) {
  const s = join(SRC, e.src), d = join(T, e.dst);
  if (!existsSync(d)) { put(s, d); rep.新装.push(e.dst); }
  else if (same(s, d)) rep.已一致.push(e.dst);
  else if (force) { put(s, d); rep.覆盖.push(e.dst); }
  else rep.冲突.push(e.dst);
}
for (const e of man.init) {
  const s = join(SRC, e.src), d = join(T, e.dst);
  if (!existsSync(d)) { put(s, d); rep.新装.push(e.dst); }
  else if (force) { put(s, d); rep.覆盖.push(e.dst); }
  else rep.跳过.push(e.dst);
}
mkdirSync(join(T, ".claude"), { recursive: true });
writeFileSync(join(T, ".claude/belltower.lock.json"),
  JSON.stringify({ version: man.version, upstream: man.upstream }, null, 2) + "\n");

for (const [k, v] of Object.entries(rep)) if (v.length) console.log(`${k} ${v.length}:\n  ${v.join("\n  ")}`);
console.log(`\nbelltower ${man.version} → ${T}`);
if (rep.冲突.length) {
  console.log("⚠ 上面「冲突」的框架文件项目里已有别的版本,没动。确认要换成框架版就加 --force,或改用 belltower-sync。");
  process.exit(1);
}
console.log("下一步:改 .claude/belltower.json → 填 CLAUDE.md 里的「项目填写」→ node scripts/test-hooks.mjs");
