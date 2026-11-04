#!/usr/bin/env node
// 刹车的现数命令(规矩见 .claude/skills/tower-meta/references/dispatch.md「刹车」;判据在 .claude/hooks/lib/brake.mjs,闸门17 用同一份)。
//
//   node scripts/brake.mjs rounds <Q…> [--json] [--ref <ref>]
//       这几个号并起来那一家:已合进 <ref> 的号 · PR · 合进时刻(项目时区),再派是第几轮、上限多少。
//   node scripts/brake.mjs batch [--older <小时>] [--json] [--ref <ref>]
//       <ref> 的 docs/BACKLOG.md 里开着的〔攒批〕:日期时刻 · 源 → 目标 · 前 80 字 · 开了几小时。
//       --older:只列开了超过这么多小时的(巡检用)。
//   node scripts/brake.mjs over [--hours <小时>] [--json] [--ref <ref>]
//       过去 N 小时(默认 24)合进 <ref> 的交付里,让一家超过上限的那几笔(巡检用;只按基号认家,不认「返工自」)。
//
// 默认 ref = origin/main。**不 fetch** —— 要最新的先 `git fetch origin main`。
// 退出码:0 = 跑完(查出东西也是 0);2 = 参数错或读不到 ref。
// --now <ISO 时刻>:把「现在」钉住(测试和排查用)。
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { config } from "../.claude/hooks/lib/config.mjs";
import * as bk from "../.claude/hooks/lib/brake.mjs";

const USAGE = `用法:
  node scripts/brake.mjs rounds <Q…> [--json] [--ref <ref>]
  node scripts/brake.mjs batch [--older <小时>] [--json] [--ref <ref>]
  node scripts/brake.mjs over [--hours <小时>] [--json] [--ref <ref>]
默认 ref = origin/main,不 fetch(先 git fetch origin main)。`;

function parse(argv) {
  const a = { _: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--json") a.json = true;
    else if (["--ref", "--older", "--hours", "--now"].includes(x)) {
      if (i + 1 >= argv.length) throw new Error(`${x} 后面要跟一个值`);
      a[x.slice(2)] = argv[++i];
    } else if (x.startsWith("--")) throw new Error(`不认识的参数 ${x}`);
    else a._.push(x);
  }
  return a;
}
const num = (v, d) => {
  if (v === undefined) return d;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new Error(`要一个非负数,得到「${v}」`);
  return n;
};
const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 << 20 });

export function main(argv) {
  let a;
  try { a = parse(argv); } catch (e) { console.error(`✗ ${e.message}\n${USAGE}`); return 2; }
  const cmd = a._[0];
  const ref = a.ref ?? "origin/main";
  const cfg = config();
  const cap = cfg.brakeRounds;
  const tz = cfg.timezone;
  let now;
  try {
    now = a.now ? new Date(a.now) : new Date();
    if (Number.isNaN(now.getTime())) throw new Error(`--now 认不出「${a.now}」`);
  } catch (e) { console.error(`✗ ${e.message}`); return 2; }
  let sha;
  const needRef = () => {
    try { sha = git("rev-parse", "--short", "--verify", "-q", `${ref}^{commit}`).trim(); }
    catch { throw new Error(`读不到 ${ref}(没有这个 ref?先 git fetch origin main)`); }
  };
  const capNote = cap > 0 ? `上限 ${cap}` : "上限关掉了(brakeRounds = 0)";

  if (cmd === "rounds") {
    const qs = a._.slice(1);
    if (!qs.length || qs.some((q) => bk.qNos(q)[0]?.no !== q)) {
      console.error(`✗ rounds 后面要跟 Q 号(比如 Q301 或 Q301b-2;几个号就并成一家)\n${USAGE}`);
      return 2;
    }
    let dels;
    try { needRef(); dels = bk.deliveries(git(...bk.LOG_ARGS, ref)); } catch (e) { console.error(`✗ ${e.message}`); return 2; }
    const bases = [...new Set(qs.map(bk.baseOf))];
    // 这次要派的号 = 给的第一个号;别的号的家并进来(跟任务书「返工自」一个意思)
    const r = bk.familyRounds(qs[0], bases, dels);
    const over = cap > 0 && r.round > cap;
    if (a.json) {
      console.log(JSON.stringify({ family: r.family, merged: r.merged.map((d) => ({ q: d.q, pr: d.pr, sha: d.sha, merged: bk.fmtTime(d.at, tz) })),
        merged_count: r.merged.length, next: qs[0], next_round: r.round, cap, needs_nod: over, ref, sha }, null, 2));
      return 0;
    }
    for (const d of r.merged) console.log(`${d.q} · #${d.pr} · 合进 ${bk.fmtTime(d.at, tz)}`);
    console.log(`— ${r.family.join(" + ")} 这一家已合 ${r.merged.length} 个号 · 再派 ${qs[0]} 是第 ${r.round} 轮,${capNote}` +
      (over ? ",超过要用户点头(任务书加一行「用户点头:「原话」(日期 时刻,哪个塔)」,原话先落台账)" : "") + ` · ${ref} @ ${sha}`);
    return 0;
  }

  if (cmd === "batch") {
    if (a._.length > 1) { console.error(USAGE); return 2; }
    let items, older;
    try { older = num(a.older, null); } catch (e) { console.error(`✗ --older ${e.message}`); return 2; }
    try {
      needRef();
      let backlog = "";
      try { backlog = git("show", `${ref}:docs/BACKLOG.md`); } catch {}
      items = bk.batchItems(backlog, cfg.boards).map((x) => ({ ...x, hours: bk.hoursOpen(x.parts, now, tz) }));
    } catch (e) { console.error(`✗ ${e.message}`); return 2; }
    if (older !== null) items = items.filter((x) => x.hours !== null && x.hours > older);
    if (a.json) {
      console.log(JSON.stringify(items.map((x) => ({ line: x.line, date: x.date, time: x.time, src: x.src, dsts: x.dsts,
        hours: x.hours === null ? null : Math.floor(x.hours), body: x.body })), null, 2));
      return 0;
    }
    for (const x of items)
      console.log(`${x.date} ${x.time} · ${x.src} → ${x.dsts.length ? x.dsts.join("+") : "?"} · ${x.body} · 开了 ${x.hours === null ? "?" : Math.floor(x.hours)} 小时`);
    const toDev = items.filter((x) => x.dsts.includes("dev")).length;
    console.log(`— 开着的〔攒批〕${items.length} 条${older !== null ? `(开了超过 ${older} 小时的)` : ""} · 其中发给 dev 的 ${toDev} 条` +
      `(dev 一天最多开一单批量修,用新号,不算进任何一家的轮次)· ${ref} @ ${sha}`);
    return 0;
  }

  if (cmd === "over") {
    if (a._.length > 1) { console.error(USAGE); return 2; }
    let hours, dels;
    try { hours = num(a.hours, 24); } catch (e) { console.error(`✗ --hours ${e.message}`); return 2; }
    try { needRef(); dels = bk.deliveries(git(...bk.LOG_ARGS, ref)); } catch (e) { console.error(`✗ ${e.message}`); return 2; }
    const from = now.getTime() - hours * 3600e3;
    const seen = new Map(), over = [];
    for (const d of dels) {
      const fam = seen.get(d.base) ?? new Set();
      seen.set(d.base, fam);
      if (fam.has(d.q)) continue;
      fam.add(d.q);
      if (cap > 0 && fam.size > cap && d.at.getTime() >= from && d.at.getTime() <= now.getTime()) over.push({ ...d, round: fam.size });
    }
    if (a.json) {
      console.log(JSON.stringify(over.map((d) => ({ q: d.q, base: d.base, pr: d.pr, round: d.round, merged: bk.fmtTime(d.at, tz) })), null, 2));
      return 0;
    }
    for (const d of over) console.log(`${d.q} · #${d.pr} · 合进 ${bk.fmtTime(d.at, tz)} · ${d.base} 这一家第 ${d.round} 轮(${capNote})`);
    console.log(`— 过去 ${hours} 小时合进的交付里,超过上限的 ${over.length} 笔 · ${ref} @ ${sha}`);
    return 0;
  }

  console.error(USAGE);
  return 2;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
