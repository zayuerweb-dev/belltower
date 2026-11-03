#!/usr/bin/env node
// 在项目里把框架文件更新到 belltower 的某个版本。**只碰清单里的 framework 文件**(`.claude/settings.json` 合并不覆盖,见下),
// 项目自己的东西(CLAUDE.md、belltower.json、四件台账、各板块 SKILL.md、冻结清单)不碰 —— 例外只有 --add 点名补的板块,也只加不改。
//
// 用法(在项目根跑):
//   node scripts/belltower-sync.mjs [--ref <tag 或分支>=main] [--source <本地 belltower 目录或 git URL>] [--add <板块>[,<板块>…]] [--apply]
//   - 默认只列出会变什么(预演);加 --apply 才写。
//   - --source 缺省 = lock 文件里的 upstream。
//   - --add:给装好的项目补开塔。项目里只有 sync 没有 init,不靠它就只能手抄。框架文件照常同步,另外每个板块:
//     装上源里它缺的起步文件(`.claude/skills/tower-<板块>/` 下,已有的不覆盖);belltower.json 的 boards 末尾加上它、
//     ranges 补上号段;CLAUDE.md 路由表、活表塔表各补一行,插在最后一个板块行后面。补过的报「已装」,什么都不改。
//     表找不到、belltower.json 读不了 → 不动,把要手工加的打出来。源里没有这个板块 → 退出 2,列出有哪些。
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
// --add 一次可以给几个(逗号隔开),也可以写几次;板块名对不对,拿到源才核得了
const addArgs = args.flatMap((a, i) => (a === "--add" ? [args[i + 1] ?? ""] : []));
if (addArgs.some((v) => v.startsWith("--") || !v.replace(/[,\s]/g, ""))) {
  console.error("--add 后面要跟板块名,例如 --add test 或 --add test,ops"); process.exit(2);
}
const adds = [...new Set(addArgs.flatMap((v) => v.split(",")).map((s) => s.trim()).filter(Boolean))];
let lock = {};
try { lock = JSON.parse(readFileSync(".claude/belltower.lock.json", "utf8")); } catch {}
const source = opt("--source") ?? lock.upstream;
if (!source) { console.error("不知道从哪同步:给 --source,或先用 belltower-init 装一次(会写 lock 文件)。"); process.exit(2); }

let SRC = source, tmp = null;
// 拿到源之后要退出 2 走这里:process.exit 不走下面的 finally,临时克隆得自己删
const bail = (msg) => { console.error(msg); if (tmp) rmSync(tmp, { recursive: true, force: true }); process.exit(2); };
const isDir = (() => { try { return statSync(source).isDirectory(); } catch { return false; } })();
if (!isDir) {
  tmp = mkdtempSync(join(tmpdir(), "belltower-"));
  try {
    execFileSync("git", ["clone", "-q", "--depth", "1", "--branch", ref, source, tmp], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (e) { console.error(`拉不下来 ${source}@${ref}:${String(e.stderr ?? e.message).trim()}`); process.exit(2); }
  SRC = tmp;
}

// `.claude/settings.json` 不整份覆盖,而是合并:项目往里加的 hook、加的键,整份覆盖会被静默删掉
// (装了框架的项目实际丢过一次,靠项目自己的测试才发现)。
//   - 框架定义的键:用框架的值(跟以前一样,框架能改默认);
//   - hooks:框架的全要,项目的 hook 只要命令不在框架同一事件里,就原样(连 matcher)接在后面;
//   - 项目独有的键(permissions、enabledPlugins……):原样保留。
const SETTINGS = ".claude/settings.json";
function mergeSettings(fw, proj) {
  const out = { ...proj, ...structuredClone(fw) };
  let kept = Object.keys(proj).filter((k) => !(k in fw)).length;
  for (const [ev, groups] of Object.entries(proj.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const fwCmds = new Set((fw.hooks?.[ev] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command)));
    for (const g of groups) {
      const own = (g.hooks ?? []).filter((h) => !fwCmds.has(h.command));
      if (!own.length) continue;
      out.hooks ??= {};
      (out.hooks[ev] ??= []).push({ ...g, hooks: own });
      kept += own.length;
    }
  }
  return { text: JSON.stringify(out, null, 2) + "\n", kept };
}

// 板块文件的落点 `.claude/skills/tower-<板块>/…` → 板块名;别的文件 → undefined
const boardOf = (dst) => dst.match(/^\.claude\/skills\/tower-([a-z0-9-]+)\//)?.[1];
// 两张表的行格式,跟 belltower-init 裁预设用的同一个(这里板块名都在第 1 组)
const ROUTE_ROW = /^\|.*\| `tower-([a-z0-9-]+)` \| .*\|$/;   // CLAUDE.md〈板块路由〉
const POOL_ROW = /^\| ([a-z0-9-]+) \| `tower-\1` \|/;          // docs/session-pool.md 塔表
const CFG = ".claude/belltower.json";

// --add 的计划:项目文件先在内存里改好,预演和 --apply 用的是同一份结果。
// 返回 plan(每个板块要做的 todo、要人手工做的 notes)、copies(要装的 init 条目)、text(文件 → 改后全文)。
function planAdd(man) {
  const copies = [], text = {};
  const cur = (f) => text[f] ?? (existsSync(f) ? readFileSync(f, "utf8") : null);
  let cfg = null, ex = {};
  try { cfg = JSON.parse(readFileSync(CFG, "utf8")); } catch {}
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) cfg = null;
  try { ex = JSON.parse(readFileSync(join(SRC, "framework/.claude/belltower.example.json"), "utf8")); } catch {}
  const plan = adds.map((b) => {
    const todo = [], notes = [];
    for (const e of man.init) if (boardOf(e.dst) === b && !existsSync(e.dst)) { copies.push(e); todo.push(`+ ${e.dst}`); }

    // belltower.json。没写 boards / ranges = 在用默认值(全套板块),这时写进去一个,反倒把默认值盖窄了 —— 所以只补已经写了的
    const rg = typeof ex?.ranges?.[b] === "string" ? ex.ranges[b] : null;
    if (!cfg) notes.push({ msg: `${CFG} ${existsSync(CFG) ? "不是合法的 JSON 对象" : "不存在"},没动;要手工加:boards 末尾加 "${b}"${rg ? `,ranges 加 "${b}": "${rg}"` : ""}` });
    else {
      const did = [];
      if (!Array.isArray(cfg.boards) || !cfg.boards.length) notes.push({ msg: `${CFG} 里没有 boards(开局 hook 用默认板块清单),没加;默认清单里没有 ${b} 的话手工加上` });
      else if (!cfg.boards.includes(b)) { cfg.boards.push(b); did.push(`boards 末尾加 ${b}`); }
      const rs = cfg.ranges;
      if (rg && rs && typeof rs === "object" && !Array.isArray(rs) && !Object.hasOwn(rs, b)) { rs[b] = rg; did.push(`ranges 加 ${b}: ${rg}`); }
      if (did.length) { todo.push(`~ ${CFG}(${did.join(",")})`); text[CFG] = JSON.stringify(cfg, null, 2) + "\n"; }
    }

    // 两张表各补一行,插在最后一个板块行后面;找不到表 → 不动,打出那一行让人手工贴。
    // 「已有」只认表里的行:模板正文里也写着 `tower-ops`、`tower-data`,按「哪行含它」判,预设没装的这两个就永远补不上。
    for (const [f, tpl, re, name] of [["CLAUDE.md", "framework/templates/CLAUDE.md", ROUTE_ROW, "板块路由表"],
      ["docs/session-pool.md", "framework/templates/docs/session-pool.md", POOL_ROW, "塔表"]]) {
      const t = cur(f), lines = t === null ? [] : t.split("\n");
      if (lines.some((l) => l.match(re)?.[1] === b)) continue;
      let row;
      try { row = readFileSync(join(SRC, tpl), "utf8").split("\n").find((l) => l.match(re)?.[1] === b); } catch {}
      if (!row) { notes.push({ msg: `源的 ${tpl} 里没有 ${b} 那一行,${f} 没动` }); continue; }
      let last = -1;
      lines.forEach((l, i) => { if (re.test(l)) last = i; });
      if (last < 0) { notes.push({ msg: `${f} ${t === null ? "不存在" : `里找不到${name}`},没动;要的话把下面这行手工贴进去`, row }); continue; }
      lines.splice(last + 1, 0, row);
      text[f] = lines.join("\n");
      todo.push(`~ ${f}(补一行)`);
    }
    return { b, todo, notes };
  });
  return { plan, copies, text };
}

try {
  const man = JSON.parse(readFileSync(join(SRC, "belltower.manifest.json"), "utf8"));
  // --add 的板块先核:源的 init 里有它的文件才算有。有一个不对整次不做,免得 --apply 写到一半才退
  const srcBoards = [...new Set(man.init.map((e) => boardOf(e.dst)).filter(Boolean))];
  const bad = adds.filter((b) => !srcBoards.includes(b));
  if (bad.length) bail(`源里没有板块「${bad.join("、")}」。可选的板块:${srcBoards.join(" · ")}`);
  const changed = [], added = [];
  const merged = {};   // dst → 合并后的内容
  for (const e of man.framework) {
    const s = join(SRC, e.src), d = e.dst;
    if (!existsSync(d)) { added.push(e); continue; }
    if (d === SETTINGS) {
      let m = null;
      try { m = mergeSettings(JSON.parse(readFileSync(s, "utf8")), JSON.parse(readFileSync(d, "utf8"))); } catch {}
      if (m) { if (m.text !== readFileSync(d, "utf8")) { merged[d] = m; changed.push(e); } continue; }
      console.log(`  (项目的 ${d} 不是合法 JSON,只能整份换成框架版;项目自己加的东西请事后补回)`);
    }
    if (!readFileSync(s).equals(readFileSync(d))) changed.push(e);
  }
  // 项目没开的板块(不在 belltower.json 的 boards 里),它的 SKILL.md 缺着是本来就没装,不算缺;这次 --add 的也不算
  let boards = null;
  try { boards = JSON.parse(readFileSync(".claude/belltower.json", "utf8")).boards; } catch {}
  const unused = (dst) => { const b = boardOf(dst); return Array.isArray(boards) && b && !boards.includes(b); };
  const missingInit = man.init.filter((e) => !existsSync(e.dst) && !unused(e.dst) && !adds.includes(boardOf(e.dst)));
  const missSkill = missingInit.filter((e) => boardOf(e.dst));
  const missOther = missingInit.filter((e) => !boardOf(e.dst)).map((e) => e.dst);
  const { plan, copies, text } = planAdd(man);

  console.log(`belltower ${lock.version ?? "(未知)"} → ${man.version}(${isDir ? source : `${source}@${ref}`})`);
  for (const e of added) console.log(`  + ${e.dst}`);
  for (const e of changed) console.log(`  ~ ${e.dst}${merged[e.dst] ? `(合并:框架部分更新,保留项目自己的 ${merged[e.dst].kept} 项)` : ""}`);
  if (!added.length && !changed.length) console.log("  框架文件都已一致。");
  // 缺的是板块 skill → 指 --add(装好的项目里没有 belltower-init);别的起步文件照旧
  if (missSkill.length) {
    console.log(`  (项目缺板块 skill:${missSkill.map((e) => e.dst).join("、")};要补用 --add ${[...new Set(missSkill.map((e) => boardOf(e.dst)))].join(",")})`);
  }
  if (missOther.length) console.log(`  (项目缺这些起步文件,sync 不补;要补用 belltower-init:${missOther.join("、")})`);
  for (const { b, todo, notes } of plan) {
    console.log(`补板块 ${b}:${todo.length ? "" : "已装,没有要改的。"}`);
    for (const t of todo) console.log(`  ${t}`);
    for (const n of notes) console.log(`  (${n.msg})${n.row ? `\n      ${n.row}` : ""}`);
  }

  const nAdd = copies.length + Object.keys(text).length;
  if (!apply) { if (added.length || changed.length || nAdd) console.log("\n预演,没写任何东西。确认后加 --apply。"); }
  else {
    for (const e of [...added, ...changed, ...copies]) {
      mkdirSync(dirname(e.dst), { recursive: true });
      if (merged[e.dst]) writeFileSync(e.dst, merged[e.dst].text);
      else copyFileSync(join(SRC, e.src), e.dst);
    }
    for (const [f, t] of Object.entries(text)) writeFileSync(f, t);
    mkdirSync(".claude", { recursive: true });
    writeFileSync(".claude/belltower.lock.json", JSON.stringify({ version: man.version, upstream: lock.upstream ?? (isDir ? undefined : source), ref: isDir ? undefined : ref }, null, 2) + "\n");
    // 新装的 SKILL.md、路由表新补的行带着模板的「项目填写」,先填再测
    const fill = copies.length || text["CLAUDE.md"] ? "填好新补进来的「项目填写」→ " : "";
    console.log(`\n已写 ${added.length + changed.length + nAdd} 个文件。下一步:${fill}node scripts/test-hooks.mjs,绿了再提交。`);
  }
} finally { if (tmp) rmSync(tmp, { recursive: true, force: true }); }
