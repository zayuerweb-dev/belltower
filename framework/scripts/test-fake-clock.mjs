#!/usr/bin/env node
// 假时钟(scripts/fake-clock.mjs)的断言。跑法:node scripts/test-fake-clock.mjs
// 每条都在子进程里跑:假时钟靠 NODE_OPTIONS 的 --import 挂上去,本进程不挂。期望值(毫秒数)写死在这儿。
// ★ 变异验证:FC_MODULE=<改坏的副本路径> node scripts/test-fake-clock.mjs —— 换一份被测脚本跑同一套断言。
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MOD = resolve(process.env.FC_MODULE || resolve(dirname(fileURLToPath(import.meta.url)), "fake-clock.mjs"));

let pass = 0, fail = 0;
const results = [];
function assert(name, cond, detail = "") {
  if (cond) { pass++; results.push(`  PASS  ${name}`); }
  else { fail++; results.push(`  FAIL  ${name}${detail ? `  — ${String(detail).slice(0, 300)}` : ""}`); }
}

// 跑一段代码(node -e),stdout 当 JSON 解析。外面要是套着假钟,继承来的那几个变量先清掉,免得串味。
function run(code, extraEnv = {}, { clock = true } = {}) {
  const env = { ...process.env };
  for (const k of ["FAKE_START", "FAKE_REAL_BASE", "NODE_OPTIONS"]) delete env[k];
  if (clock) env.NODE_OPTIONS = `--import ${pathToFileURL(MOD).href}`;
  const r = spawnSync(process.execPath, ["-e", code], { encoding: "utf8", env: { ...env, ...extraEnv } });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "", j };
}
const within = (v, lo, hi) => typeof v === "number" && v >= lo && v <= hi;
// 本进程的 Date 也可能被外面套的假钟换掉了(总入口第 6 节拿假钟跑整套框架自测,test-hooks 又调到这里)——
// 要拿真时刻当参照,就起一个不挂钟的子进程去取,别用本进程的 Date.now()。
const realNow = () => Number(run(`console.log(Date.now())`, {}, { clock: false }).out.trim());
const show = (r) => `code=${r.code} out=${r.out.trim().slice(0, 200)} err=${r.err.trim().slice(0, 200)}`;

const S = "2031-01-02T03:04:05Z", S_MS = 1925089445000;          // 期望值写死,不在这里现算
const SLACK = 5000;                                              // 起子进程的耗时,宽一点

// ── 挂上就从 FAKE_START 起走 ────────────────────────────────────────────
{
  const r = run(`console.log(JSON.stringify({ now: Date.now(), d: +new Date(), inst: new Date() instanceof Date, iso: new Date().toISOString() }))`, { FAKE_START: S });
  assert("挂上假时钟:Date.now() 从 FAKE_START 起", within(r.j?.now, S_MS, S_MS + SLACK), show(r));
  assert("挂上假时钟:不带参数的 new Date() 也是假时刻", within(r.j?.d, S_MS, S_MS + SLACK), show(r));
  assert("假的 Date 还是 Date(instanceof、toISOString 照常)", r.j?.inst === true && /^2031-01-02T03:0[4-9]/.test(r.j?.iso ?? ""), show(r));
}
{
  const r = run(`console.log(JSON.stringify({ zero: new Date(0).toISOString(), parse: Date.parse("2000-01-01T00:00:00Z"), utc: Date.UTC(2000, 0, 1), local: new Date(2000, 0, 1, 12).getDate() }))`, { FAKE_START: S });
  assert("带参数的 new Date(x)、Date.parse、Date.UTC 不受影响",
    r.j?.zero === "1970-01-01T00:00:00.000Z" && r.j?.parse === 946684800000 && r.j?.utc === 946684800000 && r.j?.local === 1, show(r));
}
// 带时区偏移的起点:项目时区零点前 10 秒(美东冬令时 −05:00)
{
  const r = run(`console.log(JSON.stringify({ now: Date.now(), day: new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date()) }))`,
    { FAKE_START: "2031-01-02T23:59:50-05:00" });
  assert("FAKE_START 带时区偏移也认(23:59:50−05:00 = 04:59:50Z),项目时区里还是当天",
    within(r.j?.now, 1925182790000, 1925182790000 + SLACK) && r.j?.day === "2031-01-02", show(r));
}

// ── 钟会走,而且父子进程是同一只钟 ──────────────────────────────────────
{
  const r = run(`const a = Date.now(); const t = performance.now(); while (performance.now() - t < 300); console.log(JSON.stringify({ d: Date.now() - a }))`, { FAKE_START: S });
  assert("钟会走:隔 300 毫秒真时间,假时刻也往前走约 300 毫秒", within(r.j?.d, 290, 3000), show(r));
}
// 子进程等 1.2 秒再起孙进程:同一只钟 → 孙进程读到的比子进程晚 ≥1.2 秒;各起各的钟 → 孙进程又从 FAKE_START 起,反倒更早
{
  const r = run([
    `const a = Date.now(); const t = performance.now(); while (performance.now() - t < 1200);`,
    `const g = require("node:child_process").spawnSync(process.execPath, ["-e", "console.log(Date.now())"], { encoding: "utf8" });`,
    `console.log(JSON.stringify({ a, b: Number(g.stdout) }))`].join("\n"), { FAKE_START: S });
  const gap = (r.j?.b ?? 0) - (r.j?.a ?? 0);
  assert("孙进程跟子进程是同一只钟(继承 FAKE_REAL_BASE,不从 FAKE_START 重新起跑)",
    within(gap, 1100, 10000) && within(r.j?.b, S_MS + 1100, S_MS + 10000 + SLACK), `差 ${gap} 毫秒 · ${show(r)}`);
}
// 调用方自己给 FAKE_REAL_BASE = 真时刻 − 10 秒 → 假钟已经走了 10 秒(scripts/test.mjs 靠这个知道假钟哪一刻起跑)
{
  const r = run(`console.log(JSON.stringify({ now: Date.now() }))`, { FAKE_START: S, FAKE_REAL_BASE: String(realNow() - 10000) });
  assert("调用方给的 FAKE_REAL_BASE 照认:起点往前挪 10 秒,假时刻就多走 10 秒",
    within(r.j?.now, S_MS + 10000, S_MS + 10000 + SLACK), show(r));
}

// ── 没给 / 给坏了 ──────────────────────────────────────────────────────
{
  const before = realNow();
  const r = run(`console.log(JSON.stringify({ now: Date.now(), base: process.env.FAKE_REAL_BASE ?? null }))`);
  assert("挂上了但没给 FAKE_START:Date 原样不动,也不留 FAKE_REAL_BASE",
    within(r.j?.now, before - SLACK, realNow() + SLACK) && r.j?.base === null, show(r));
}
{
  const r = run(`console.log("还跑到了这里")`, { FAKE_START: "下周一早上" });
  assert("FAKE_START 写坏了:当场报错退出,不悄悄用真钟接着跑",
    r.code !== 0 && /FAKE_START 解析不了/.test(r.err) && !/还跑到了这里/.test(r.out), show(r));
}

console.log(results.join("\n"));
console.log(`\nfake-clock: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
