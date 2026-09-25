#!/usr/bin/env node
// 把 belltower 装进一个项目:框架文件 + 起步模板各拷一份。
//
// 用法:node scripts/belltower-init.mjs <项目目录> [--preset <预设>] [--force]
//   - --preset:按项目类型只装一组塔(见 presets.json;不带参数值 = 列出预设)。不给 = 八个全装。
//     选了预设:没选的板块不装 SKILL.md;新装的 belltower.json 只留选中的 boards / ranges;
//     新装的 CLAUDE.md 板块路由表删掉没选的行,「塔」那一格填成预设里写的开塔时机。已有的文件不碰。
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
const pi = args.indexOf("--preset");
const presetKey = pi >= 0 ? args[pi + 1] : undefined;
const target = args.find((a, i) => !a.startsWith("--") && (pi < 0 || i !== pi + 1));
const { presets } = JSON.parse(readFileSync(join(SRC, "presets.json"), "utf8"));
const listPresets = () => Object.entries(presets)
  .map(([k, p]) => `  ${k.padEnd(12)} ${p.name}:${p.boards.join(" · ")}`).join("\n");
if (pi >= 0 && !presets[presetKey]) {
  console.error(`${presetKey ? `没有预设「${presetKey}」。` : ""}可选的预设:\n${listPresets()}`);
  process.exit(2);
}
if (!target) { console.error("用法:node scripts/belltower-init.mjs <项目目录> [--preset <预设>] [--force]"); process.exit(2); }
const T = resolve(target);
const man = JSON.parse(readFileSync(join(SRC, "belltower.manifest.json"), "utf8"));
const preset = presets[presetKey];
// 板块 SKILL.md 的落点;没选的板块不装
const boardOf = (dst) => dst.match(/^\.claude\/skills\/tower-([a-z0-9-]+)\/SKILL\.md$/)?.[1];
const wanted = (dst) => !preset || !boardOf(dst) || preset.boards.includes(boardOf(dst));

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
for (const e of man.init.filter((e) => wanted(e.dst))) {
  const s = join(SRC, e.src), d = join(T, e.dst);
  if (!existsSync(d)) { put(s, d); rep.新装.push(e.dst); }
  else if (force) { put(s, d); rep.覆盖.push(e.dst); }
  else rep.跳过.push(e.dst);
}
// 预设只改这一次新装(或 --force 覆盖)的起步文件;项目已有的归项目,不碰
const fresh = (dst) => rep.新装.includes(dst) || rep.覆盖.includes(dst);
if (preset && fresh(".claude/belltower.json")) {
  const f = join(T, ".claude/belltower.json");
  const cfg = JSON.parse(readFileSync(f, "utf8"));
  cfg.boards = [...preset.boards];
  cfg.ranges = Object.fromEntries(preset.boards.filter((b) => cfg.ranges?.[b]).map((b) => [b, cfg.ranges[b]]));
  writeFileSync(f, JSON.stringify(cfg, null, 2) + "\n");
}
if (preset && fresh("CLAUDE.md")) {
  const f = join(T, "CLAUDE.md");
  const lines = readFileSync(f, "utf8").split("\n").flatMap((l) => {
    const m = l.match(/^(\|.*\| `tower-([a-z0-9-]+)` \| ).*\|$/);
    if (!m) return [l];
    return preset.boards.includes(m[2]) ? [`${m[1]}${preset.open[m[2]] ?? "<!-- 项目填写 -->"} |`] : [];
  });
  writeFileSync(f, lines.join("\n"));
}
if (preset && fresh("docs/session-pool.md")) {
  const f = join(T, "docs/session-pool.md");
  const lines = readFileSync(f, "utf8").split("\n")
    .filter((l) => { const m = l.match(/^\| ([a-z0-9-]+) \| `tower-\1` \|/); return !m || preset.boards.includes(m[1]); });
  writeFileSync(f, lines.join("\n"));
}
mkdirSync(join(T, ".claude"), { recursive: true });
writeFileSync(join(T, ".claude/belltower.lock.json"),
  JSON.stringify({ version: man.version, upstream: man.upstream, preset: presetKey }, null, 2) + "\n");

for (const [k, v] of Object.entries(rep)) if (v.length) console.log(`${k} ${v.length}:\n  ${v.join("\n  ")}`);
console.log(`\nbelltower ${man.version} → ${T}${preset ? `(预设 ${presetKey}:${preset.boards.join(" · ")})` : ""}`);
if (rep.冲突.length) {
  console.log("⚠ 上面「冲突」的框架文件项目里已有别的版本,没动。确认要换成框架版就加 --force,或改用 belltower-sync。");
  process.exit(1);
}
console.log("下一步:改 .claude/belltower.json → 填 CLAUDE.md 里的「项目填写」→ node scripts/test-hooks.mjs");
