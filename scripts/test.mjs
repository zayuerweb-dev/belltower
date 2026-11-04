#!/usr/bin/env node
// belltower 的总测试入口:CI 跑的就是这一条。退出 0 才算过。
//   1. 框架自测(framework/scripts/test-hooks.mjs,含 ledger-push 沙箱)
//   2. init:装进一个空项目 → 在**装好的项目里**再跑一遍框架自测(证明不依赖本仓库)
//   2b. init --preset:只装选中的板块;预设表跟 README 一致
//   3. sync:预演不写、--apply 才写、项目自己的文件不碰
//   3b. sync --add:装好的项目只补一个塔(装 skill、配置和两张表各补一行),补过的不重复
//   4. scan-public:本仓库零命中;每条规则各埋一个雷,都要扫得出来
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0, fail = 0;
const assert = (name, ok, detail = "") => {
  if (ok) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? `  — ${String(detail).slice(0, 300)}` : ""}`); }
};
const node = (script, args = [], cwd = ROOT) => spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
const counts = (out) => { const m = out.match(/(\d+) passed, (\d+) failed/); return m ? [+m[1], +m[2]] : null; };
const tmps = [];
const tmp = (p) => { const d = mkdtempSync(join(tmpdir(), p)); tmps.push(d); return d; };

// ── 1. 框架自测 ─────────────────────────────────────────────────────────
{
  const r = node("scripts/test-hooks.mjs", [], join(ROOT, "framework"));
  const c = counts(r.stdout);
  assert(`框架自测全绿(${c ? `${c[0]} passed, ${c[1]} failed` : "没读到计数"})`, r.status === 0 && c && c[1] === 0 && c[0] > 0,
    r.stdout.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));
  rmSync(join(ROOT, "framework/.claude/.session-state"), { recursive: true, force: true });
  rmSync(join(ROOT, "framework/docs"), { recursive: true, force: true });
}

// ── 2. init ─────────────────────────────────────────────────────────────
const man = JSON.parse(readFileSync(join(ROOT, "belltower.manifest.json"), "utf8"));
const P = tmp("bt-proj-");
execFileSync("git", ["init", "-q"], { cwd: P });
{
  const r = node(join(ROOT, "scripts/belltower-init.mjs"), [P]);
  assert("init 退出 0", r.status === 0, r.stdout + r.stderr);
  const all = [...man.framework, ...man.init];
  const missing = all.filter((e) => !existsSync(join(P, e.dst))).map((e) => e.dst);
  assert(`init 装齐清单里 ${all.length} 项`, missing.length === 0, missing.join(", "));
  assert("init 写了 lock(带版本号)", JSON.parse(readFileSync(join(P, ".claude/belltower.lock.json"), "utf8")).version === man.version);
  // 巡检塔是板块,但不立号:boards 里有它,ranges 里没有(期望值写死在这儿,不读 example 文件)
  const cfgP = JSON.parse(readFileSync(join(P, ".claude/belltower.json"), "utf8"));
  assert("init 不带预设:belltower.json 的 boards 含 patrol、ranges 不含 patrol(巡检塔没有号段)",
    Array.isArray(cfgP.boards) && cfgP.boards.includes("patrol") && cfgP.ranges && !("patrol" in cfgP.ranges) && cfgP.ranges.meta === "Q7xx",
    JSON.stringify(cfgP.boards) + JSON.stringify(cfgP.ranges));

  const t = node("scripts/test-hooks.mjs", [], P);
  const c = counts(t.stdout);
  assert(`装好的项目里框架自测全绿(${c ? `${c[0]} passed` : "没读到计数"})`, t.status === 0 && c && c[1] === 0,
    t.stdout.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));

  const s = spawnSync(process.execPath, [".claude/hooks/session-start.mjs"], { cwd: P, encoding: "utf8" });
  assert("装好的项目里开局 hook 能跑、报出九个板块", s.status === 0 && /plan \/ product \/ dev \/ data \/ ops \/ biz \/ meta \/ test \/ patrol/.test(s.stdout), s.stdout);

  writeFileSync(join(P, "CLAUDE.md"), "# 项目自己写的\n");
  const again = node(join(ROOT, "scripts/belltower-init.mjs"), [P]);
  assert("再 init 一次:起步模板已存在 → 跳过,不覆盖项目的", again.status === 0 && readFileSync(join(P, "CLAUDE.md"), "utf8") === "# 项目自己写的\n", again.stdout);

  appendFileSync(join(P, ".claude/hooks/now.mjs"), "\n// 项目就地改过\n");
  const conflict = node(join(ROOT, "scripts/belltower-init.mjs"), [P]);
  assert("再 init 一次:框架文件被改过 → 报冲突、退出 1、不覆盖",
    conflict.status === 1 && /冲突/.test(conflict.stdout) && readFileSync(join(P, ".claude/hooks/now.mjs"), "utf8").includes("项目就地改过"), conflict.stdout);
}

// ── 2b. init --preset ───────────────────────────────────────────────────
{
  const { presets } = JSON.parse(readFileSync(join(ROOT, "presets.json"), "utf8"));
  for (const [k, p] of Object.entries(presets)) {
    assert(`预设 ${k}:含 meta、每个板块都有开塔时机、都是框架里有的板块`,
      p.boards.includes("meta") && p.boards.every((b) => p.open[b] && existsSync(join(ROOT, `framework/.claude/skills/tower-${b}/SKILL.md`))),
      JSON.stringify(p));
    assert(`预设 ${k}:带 patrol(定时例程绑在它身上),排在 meta 后面`,
      p.boards.includes("patrol") && p.boards.indexOf("patrol") > p.boards.indexOf("meta"), JSON.stringify(p.boards));
  }
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const drift = Object.entries(presets).filter(([k, p]) => !readme.includes(`| \`${k}\` | ${p.boards.join(" · ")} |`));
  assert("README 的预设表跟 presets.json 一致(两处语言各一张)",
    !drift.length && Object.keys(presets).every((k) => readme.split(`| \`${k}\` |`).length === 3), drift.map(([k]) => k).join(", "));

  const Q = tmp("bt-preset-");
  execFileSync("git", ["init", "-q"], { cwd: Q });
  const r = node(join(ROOT, "scripts/belltower-init.mjs"), [Q, "--preset", "minimal"]);
  assert("init --preset minimal 退出 0", r.status === 0, r.stdout + r.stderr);
  const skills = ["plan", "product", "dev", "data", "ops", "biz", "meta", "test", "patrol"].filter((b) => existsSync(join(Q, `.claude/skills/tower-${b}/SKILL.md`)));
  assert("init --preset minimal:只装 dev、meta、patrol 三个板块的 SKILL.md", skills.join() === "dev,meta,patrol", skills.join());
  const cfg = JSON.parse(readFileSync(join(Q, ".claude/belltower.json"), "utf8"));
  assert("init --preset minimal:belltower.json 的 boards 只留选中的,ranges 只留有号段的(patrol 没号段)",
    cfg.boards.join() === "meta,patrol,dev" && Object.keys(cfg.ranges).join() === "meta,dev", JSON.stringify(cfg.boards) + JSON.stringify(cfg.ranges));
  const md = readFileSync(join(Q, "CLAUDE.md"), "utf8");
  assert("init --preset minimal:CLAUDE.md 路由表删了没选的行、「塔」一格填了开塔时机",
    !md.includes("`tower-plan` |") && /`tower-dev` \| 现在开 \|/.test(md) && /`tower-patrol` \| 跟 meta 一起开/.test(md),
    md.split("\n").filter((l) => l.includes("`tower-")).join(" | "));
  const pool = readFileSync(join(Q, "docs/session-pool.md"), "utf8");
  assert("init --preset minimal:活表只留选中板块的行",
    /^\| dev \| `tower-dev`/m.test(pool) && /^\| patrol \| `tower-patrol`/m.test(pool) && !/^\| plan \| `tower-plan`/m.test(pool));
  assert("init --preset minimal:lock 记下预设", JSON.parse(readFileSync(join(Q, ".claude/belltower.lock.json"), "utf8")).preset === "minimal");
  const t = node("scripts/test-hooks.mjs", [], Q);
  const c = counts(t.stdout);
  assert("init --preset minimal:装好的项目里框架自测全绿", t.status === 0 && c && c[1] === 0, t.stdout.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));
  const sy = node(join(Q, "scripts/belltower-sync.mjs"), ["--source", ROOT], Q);
  assert("sync:没开的板块不算「缺起步文件」", sy.status === 0 && !/tower-plan/.test(sy.stdout), sy.stdout);
  const bad = node(join(ROOT, "scripts/belltower-init.mjs"), [tmp("bt-preset-"), "--preset", "nope"]);
  assert("init --preset 给了不存在的预设 → 退出 2、列出可选的", bad.status === 2 && /minimal/.test(bad.stderr), bad.stderr);
}

// ── 3. sync ─────────────────────────────────────────────────────────────
{
  const sync = (...a) => node("scripts/belltower-sync.mjs", ["--source", ROOT, ...a], P);
  const dry = sync();
  assert("sync 预演:列出被改过的框架文件", dry.status === 0 && /~ \.claude\/hooks\/now\.mjs/.test(dry.stdout), dry.stdout + dry.stderr);
  assert("sync 预演:不写", readFileSync(join(P, ".claude/hooks/now.mjs"), "utf8").includes("项目就地改过"));

  rmSync(join(P, ".claude/hooks/guard-bash.mjs"));
  rmSync(join(P, "docs/journal.md"));
  // 项目往 settings.json 里加了自己的 hook 和键;框架那边的 hook 又被改旧了一处
  const st = JSON.parse(readFileSync(join(P, ".claude/settings.json"), "utf8"));
  st.hooks.PreToolUse.push({ matcher: "Bash", hooks: [{ type: "command", command: "node scripts/project-own-hook.mjs" }] });
  st.permissions = { allow: ["Bash(npm test)"] };
  delete st.hooks.Stop;
  writeFileSync(join(P, ".claude/settings.json"), JSON.stringify(st, null, 2) + "\n");
  const ap = sync("--apply");
  const st2 = JSON.parse(readFileSync(join(P, ".claude/settings.json"), "utf8"));
  const cmds = (ev) => (st2.hooks[ev] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
  assert("sync --apply:settings.json 合并,项目自己的 hook 和键留着",
    cmds("PreToolUse").includes("node scripts/project-own-hook.mjs") && st2.permissions?.allow?.[0] === "Bash(npm test)", JSON.stringify(st2).slice(0, 300));
  assert("sync --apply:settings.json 里框架的 hook 补回来、不重复",
    cmds("Stop").includes("node .claude/hooks/guard-stop.mjs") &&
    cmds("PreToolUse").filter((c) => c === "node .claude/hooks/guard-bash.mjs").length === 1, JSON.stringify(st2.hooks));
  assert("sync --apply:改过的框架文件恢复成框架版",
    ap.status === 0 && readFileSync(join(P, ".claude/hooks/now.mjs"), "utf8") === readFileSync(join(ROOT, "framework/.claude/hooks/now.mjs"), "utf8"), ap.stdout + ap.stderr);
  assert("sync --apply:缺的框架文件补上", existsSync(join(P, ".claude/hooks/guard-bash.mjs")));
  assert("sync 不碰项目自己的文件(CLAUDE.md 原样)", readFileSync(join(P, "CLAUDE.md"), "utf8") === "# 项目自己写的\n");
  assert("sync 不补起步文件(删掉的台账不会被模板顶回来),只提示", !existsSync(join(P, "docs/journal.md")) && /docs\/journal\.md/.test(ap.stdout), ap.stdout);
  const clean = sync();
  assert("sync 之后再预演:框架文件都已一致", /框架文件都已一致/.test(clean.stdout), clean.stdout);

  const noSrc = tmp("bt-nosrc-");
  const r = spawnSync(process.execPath, [join(P, "scripts/belltower-sync.mjs")], { cwd: noSrc, encoding: "utf8" });
  assert("sync 没有 lock 也没给 --source → 退出 2 说清楚", r.status === 2 && /--source/.test(r.stderr), r.stderr);
}

// ── 3b. sync --add ──────────────────────────────────────────────────────
// 装好的项目里只有 sync 没有 init,补开一个塔只能靠 sync --add。拿一个 minimal 项目补它没有的 test。
// minimal 的板块清单不写死(预设以后会加板块):只断言「原来的原样 + 末尾多了 test」。
{
  const A = tmp("bt-add-");
  execFileSync("git", ["init", "-q"], { cwd: A });
  node(join(ROOT, "scripts/belltower-init.mjs"), [A, "--preset", "minimal"]);
  const add = (...a) => node("scripts/belltower-sync.mjs", ["--source", ROOT, ...a], A);
  const rd = (f) => (existsSync(join(A, f)) ? readFileSync(join(A, f), "utf8") : null);
  const SKILL = ".claude/skills/tower-test/SKILL.md";
  const snap = () => JSON.stringify([SKILL, ".claude/belltower.json", "CLAUDE.md", "docs/session-pool.md", ".claude/belltower.lock.json"].map(rd));
  // 要补的两行取自模板;找法跟实现不一样(按整格找,不用正则),免得跟着一起错
  const tplLine = (f, cell) => readFileSync(join(ROOT, f), "utf8").split("\n").find((l) => l.includes(cell)) ?? "(模板里没有这一行)";
  const routeRow = tplLine("framework/templates/CLAUDE.md", "| `tower-test` |");
  const poolRow = tplLine("framework/templates/docs/session-pool.md", "| test | `tower-test` |");
  // 板块行:| 开头、有一格是 `tower-…`
  const isRow = (l) => l.startsWith("|") && l.includes(" | `tower-");
  // after 恰好是 before 在「原来最后一个板块行」后面插了 row,别的行一个字没动
  const insertedAfterLast = (before, after, row) => {
    const at = before.findLastIndex(isRow) + 1;
    return at > 0 && after.length === before.length + 1 && after[at] === row &&
      JSON.stringify([...after.slice(0, at), ...after.slice(at + 1)]) === JSON.stringify(before);
  };

  const s0 = snap();
  const nope = add("--add", "nope");
  assert("sync --add 不存在的板块 → 退出 2、列出源里有的板块",
    nope.status === 2 && ["plan", "product", "dev", "data", "ops", "biz", "meta", "test", "patrol"].every((b) => nope.stderr.includes(b)), nope.stdout + nope.stderr);
  const mixed = add("--add", "test,nope", "--apply");
  assert("sync --add 里有一个不存在 → 整次不做(--apply 也一个字不写)", mixed.status === 2 && snap() === s0, mixed.stdout + mixed.stderr);
  const bare = add("--add");
  assert("sync --add 没跟板块名 → 退出 2", bare.status === 2 && /--add/.test(bare.stderr), bare.stdout + bare.stderr);

  const dry = add("--add", "test");
  assert("sync --add 预演:逐项列出要做的改动",
    dry.status === 0 && [`+ ${SKILL}`, "~ .claude/belltower.json(", "~ CLAUDE.md(补一行)", "~ docs/session-pool.md(补一行)"].every((s) => dry.stdout.includes(s)),
    dry.stdout + dry.stderr);
  assert("sync --add 预演:一个字不写", snap() === s0);
  // 模板正文里也写着 `tower-ops`(minimal 没装 ops):「已有」只认表里的行,不然这个板块永远补不上
  const ops = add("--add", "ops");
  assert("sync --add:CLAUDE.md 正文里提到 `tower-ops` 不算已有路由行,照样补",
    rd("CLAUDE.md").split("\n").some((l) => !isRow(l) && l.includes("`tower-ops`")) && ops.stdout.includes("~ CLAUDE.md(补一行)"), ops.stdout);

  const cfg0 = JSON.parse(rd(".claude/belltower.json")), md0 = rd("CLAUDE.md").split("\n"), pool0 = rd("docs/session-pool.md").split("\n");
  const ap = add("--add", "test", "--apply");
  assert("sync --add --apply:装上 tower-test/SKILL.md(跟模板一字不差)",
    ap.status === 0 && rd(SKILL) === readFileSync(join(ROOT, "framework", SKILL), "utf8"), ap.stdout + ap.stderr);
  const cfgText = rd(".claude/belltower.json"), cfg1 = JSON.parse(cfgText);
  assert("sync --add --apply:boards 原样 + 末尾多了 test", JSON.stringify(cfg1.boards) === JSON.stringify([...cfg0.boards, "test"]), cfgText);
  assert("sync --add --apply:ranges 原样 + 多了 test 的号段 Q8xx", JSON.stringify(cfg1.ranges) === JSON.stringify({ ...cfg0.ranges, test: "Q8xx" }), cfgText);
  const rest = (c) => JSON.stringify({ ...c, boards: 0, ranges: 0 });
  assert("sync --add --apply:belltower.json 别的键和顺序原样,2 空格缩进 + 末尾换行",
    rest(cfg1) === rest(cfg0) && cfgText === JSON.stringify(cfg1, null, 2) + "\n", cfgText);
  assert("sync --add --apply:CLAUDE.md 恰好多一行,插在路由表最后一个板块行后面",
    insertedAfterLast(md0, rd("CLAUDE.md").split("\n"), routeRow), rd("CLAUDE.md").split("\n").filter(isRow).join(" / "));
  assert("sync --add --apply:活表恰好多一行,插在塔表最后一个板块行后面",
    insertedAfterLast(pool0, rd("docs/session-pool.md").split("\n"), poolRow), rd("docs/session-pool.md").split("\n").filter(isRow).join(" / "));
  const t = node("scripts/test-hooks.mjs", [], A);
  const c = counts(t.stdout);
  assert("sync --add --apply 之后,项目里框架自测仍全绿", t.status === 0 && c && c[1] === 0, t.stdout.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));

  // 项目填过 SKILL.md 之后再补一次:已有的不覆盖,报「已装」,什么都不变
  // (上面没装上的话不追加:让下面的断言红,而不是整个测试崩在这一行)
  if (existsSync(join(A, SKILL))) appendFileSync(join(A, SKILL), "\n项目自己填的\n");
  const s1 = snap();
  const again = add("--add", "test", "--apply");
  assert("sync --add 再跑一次:报「已装」、什么都不改(填过的 SKILL.md 不被覆盖)",
    again.status === 0 && /补板块 test:已装/.test(again.stdout) && snap() === s1, again.stdout + again.stderr);

  // 开着的板块缺了 skill:提示走 --add,别再叫人用项目里没有的 belltower-init
  rmSync(join(A, SKILL), { force: true });
  const hint = add();
  assert("sync:开着的板块缺 skill → 提示用 --add <板块>",
    /--add test/.test(hint.stdout) && !/belltower-init[^\n]*tower-test/.test(hint.stdout), hint.stdout);

  // 项目自己重写过 CLAUDE.md(没有路由表),belltower.json 删了 boards(靠默认值)
  const B = tmp("bt-add-");
  execFileSync("git", ["init", "-q"], { cwd: B });
  node(join(ROOT, "scripts/belltower-init.mjs"), [B, "--preset", "minimal"]);
  writeFileSync(join(B, "CLAUDE.md"), "# 项目自己写的\n");
  const cb = JSON.parse(readFileSync(join(B, ".claude/belltower.json"), "utf8"));
  delete cb.boards;
  writeFileSync(join(B, ".claude/belltower.json"), JSON.stringify(cb, null, 2) + "\n");
  const nb = node("scripts/belltower-sync.mjs", ["--source", ROOT, "--add", "test", "--apply"], B);
  assert("sync --add:CLAUDE.md 没有路由表 → 打印要补的那一行、退出 0、文件不变",
    nb.status === 0 && nb.stdout.includes(routeRow) && readFileSync(join(B, "CLAUDE.md"), "utf8") === "# 项目自己写的\n", nb.stdout + nb.stderr);
  const cb1 = JSON.parse(readFileSync(join(B, ".claude/belltower.json"), "utf8"));
  assert("sync --add:belltower.json 没有 boards 键 → 不写 boards、提示一句(ranges 照补)",
    !("boards" in cb1) && /没有 boards/.test(nb.stdout) && cb1.ranges?.test === "Q8xx", JSON.stringify(cb1) + " | " + nb.stdout);

  // 巡检塔出来之前装的项目补 patrol:它没有号段,ranges 一个键都不许多
  const C = tmp("bt-add-");
  execFileSync("git", ["init", "-q"], { cwd: C });
  node(join(ROOT, "scripts/belltower-init.mjs"), [C, "--preset", "minimal"]);
  // 摆成「装的时候还没有巡检塔」的样子:去掉它的 skill、配置里的它、两张表里它那一行
  rmSync(join(C, ".claude/skills/tower-patrol"), { recursive: true, force: true });
  const cc = JSON.parse(readFileSync(join(C, ".claude/belltower.json"), "utf8"));
  cc.boards = cc.boards.filter((b) => b !== "patrol");
  if (cc.ranges) delete cc.ranges.patrol;   // 本来就不该有;万一有,删掉才算「装的时候没有它」
  writeFileSync(join(C, ".claude/belltower.json"), JSON.stringify(cc, null, 2) + "\n");
  for (const f of ["CLAUDE.md", "docs/session-pool.md"]) {
    writeFileSync(join(C, f), readFileSync(join(C, f), "utf8").split("\n").filter((l) => !l.includes("`tower-patrol` |")).join("\n"));
  }
  const pr = node("scripts/belltower-sync.mjs", ["--source", ROOT, "--add", "patrol", "--apply"], C);
  const cc1 = JSON.parse(readFileSync(join(C, ".claude/belltower.json"), "utf8"));
  assert("sync --add patrol:装上 tower-patrol/SKILL.md,boards 末尾多了 patrol",
    pr.status === 0 && existsSync(join(C, ".claude/skills/tower-patrol/SKILL.md")) &&
    JSON.stringify(cc1.boards) === JSON.stringify([...cc.boards, "patrol"]), pr.stdout + pr.stderr);
  assert("sync --add patrol:ranges 原样(巡检塔没有号段,不补)", JSON.stringify(cc1.ranges) === JSON.stringify(cc.ranges), JSON.stringify(cc1.ranges));
  assert("sync --add patrol:路由表、活表各补回 patrol 那一行",
    readFileSync(join(C, "CLAUDE.md"), "utf8").includes("| `tower-patrol` |") &&
    /^\| patrol \| `tower-patrol` \|/m.test(readFileSync(join(C, "docs/session-pool.md"), "utf8")), pr.stdout);
}

// ── 4. scan-public ──────────────────────────────────────────────────────
{
  const self = node("scripts/scan-public.mjs", [ROOT]);
  assert("scan-public:本仓库零命中", self.status === 0, self.stdout.split("\n").slice(0, 10).join(" | "));

  // 每条规则各埋一个雷。雷是现拼的(不以原样出现在本文件里),免得本文件自己被扫中。
  const J = (...p) => p.join("");
  const MINES = {
    "会话/触发器/环境 ID": J("session", "_01Xq9LmN3pRt7VwZ2aB"),
    "claude.ai 个人链接": J("claude", ".ai/code/", "abc123"),
    "邮箱": J("someone", "@", "realcorp.io"),
    "GitHub 账号": J("github", ".com/", "some-person/repo"),
    "本机路径": J("/home/", "alice/work/x"),
    "提交 sha(40 位)": "0123456789abcdef".repeat(3).slice(0, 40),
    "提交 sha(反引号里的短 sha)": "`" + "3fa9c1e" + "`",
    "PR 号": J("PR", " #", "42"),
    "模型 ID": J("claude", "-", "somename", "-", "9"),
    "密钥前缀": J("ghp", "_", "A".repeat(30)),
  };
  for (const [rule, mine] of Object.entries(MINES)) {
    const d = tmp("bt-scan-");
    writeFileSync(join(d, "leak.md"), `正常的一行\n这里有雷:${mine}\n`);
    const r = node(join(ROOT, "scripts/scan-public.mjs"), [d]);
    assert(`scan-public 扫得出「${rule}」`, r.status === 1 && r.stdout.includes(`[${rule}]`), r.stdout);
  }
  const d = tmp("bt-scan-");
  writeFileSync(join(d, "ok.md"), [
    "占位 ID " + J("session", "_PLAN0000000000000001"),
    "示例邮箱 " + J("a", "@", "example.com"),
    "夹具 " + J("PR", " #", "7") + "  <!-- scan-public:ok -->", ""].join("\n"));
  const ok = node(join(ROOT, "scripts/scan-public.mjs"), [d]);
  assert("scan-public 放过假 ID / example 邮箱 / 标了 scan-public:ok 的夹具", ok.status === 0, ok.stdout);

  const w = join(tmp("bt-words-"), "words.txt");
  writeFileSync(w, "# 注释\n\\bwidgetco\\b\n");
  writeFileSync(join(d, "biz.md"), "我们给 WidgetCo 做的\n");
  const wr = node(join(ROOT, "scripts/scan-public.mjs"), [d, "--words", w]);
  assert("scan-public --words:项目词表生效(不区分大小写)", wr.status === 1 && /\[项目词表\]\s+WidgetCo/.test(wr.stdout), wr.stdout);
}

// ── 5. 派发配方的取号命令 ───────────────────────────────────────────────
// 命令从 dispatch.md 的代码块里**原样抠出来**跑,不在这儿另抄一份 —— 抄一份测的是抄的那份,
// 文档里那条改坏了照样绿。认哪一块:带「换成你的段」注释的那一块,必须恰好一块。
// 期望值写死在这儿;会话 ID 样的随机串是现拼的,免得本文件被 scan-public 扫中。
{
  const md = readFileSync(join(ROOT, "framework/.claude/skills/tower-meta/references/dispatch.md"), "utf8").replace(/\r\n/g, "\n");
  // 围栏可以缩进(列表项里的就是);去掉围栏那层缩进 = 读者从渲染出来的页面上粘贴的样子
  const blocks = [...md.matchAll(/^([ \t]*)```[^\n]*\n([\s\S]*?)\n\1```[ \t]*$/gm)]
    .map(([, ind, body]) => body.split("\n").map((l) => (l.startsWith(ind) ? l.slice(ind.length) : l)).join("\n"));
  const picked = blocks.filter((b) => b.includes("换成你的段"));
  assert("dispatch.md 里带「换成你的段」的取号代码块恰好一块", picked.length === 1, `找到 ${picked.length} 块`);
  const next = (backlog, journal) => {
    const d = tmp("bt-qnum-");
    mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "docs/BACKLOG.md"), "| 单号 | 板块 | 任务 | 依赖 | 状态 | 谁派 |\n|---|---|---|---|---|---|\n" + backlog);
    writeFileSync(join(d, "docs/journal.md"), "# journal\n\n" + journal);
    const r = spawnSync("bash", ["-c", picked[0] ?? "exit 1"], { cwd: d, encoding: "utf8" });
    return { out: (r.stdout ?? "").trim(), detail: `输出 ${JSON.stringify(r.stdout)} code=${r.status} ${r.error?.message ?? ""} ${r.stderr ?? ""}` };
  };
  const row = (q) => `| ${q} | meta | 某某 | — | 待派 | meta |\n`;
  // 下划线后面紧跟 Q7 加三位(有头边界、没尾边界的写法会切出 Q712),词尾又是 Q7456(有尾边界、没头边界的写法会认它)
  const SID = ["session", "Q7123AbCdEfGhQ7456"].join("_");
  for (const [name, backlog, journal, want] of [
    ["没有号 → 第一个号 Q701", "", "2026-01-01 · meta · 开张\n", "Q701"],
    ["{Q701, Q702} → Q703", row("Q701"), "2026-01-01 · meta · Q702 派了\n", "Q703"],
    ["{Q798, Q799} → 三位用完接四位 Q7001", row("Q799"), "2026-01-01 · meta · Q798 收了\n", "Q7001"],
    ["{Q799, Q7001} → Q7002(四位号按数值比,不被切成 Q700)", row("Q7001"), "2026-01-01 · meta · Q799 收了\n", "Q7002"],
    ["会话 ID 样的随机串里的 Q7 加三位不算号", row("Q701"), `2026-01-01 · meta · 工人 ${SID} 跑完 Q702\n`, "Q703"],
    ["同一行只隔一个字符的两个号都认(Q798/Q799)", "", "2026-01-01 · meta · 收了 Q798/Q799\n", "Q7001"],
    ["别的段、位数不对的不算", row("Q301") + row("Q3001"), "2026-01-01 · Q801 Q8001 Q70 Q70001\n", "Q701"],
    ["x999 也用过了 → 打「段用完了」,不给号", row("Q7999"), "", "段用完了"],
  ]) {
    const r = next(backlog, journal);
    assert(`取号命令:${name}`, r.out === want, `要 ${want},${r.detail}`);
  }
}

// ── 6. 搬进来的工具:原话汇总 · 巡检周一两条命令 · 外来 skill 不进清单 · tower.md 按节读 · 假时钟跨零点 ──
// 期望值都写死在这儿。要「今天」的地方一律用假时钟(framework/scripts/fake-clock.mjs)钉住,不靠真钟碰运气。
{
  const { pathToFileURL } = await import("node:url");
  const { DEFAULTS } = await import(pathToFileURL(join(ROOT, "framework/.claude/hooks/lib/config.mjs")).href);
  const FC = pathToFileURL(join(ROOT, "framework/scripts/fake-clock.mjs")).href;
  // 挂假时钟的环境:FAKE_START = 假钟从哪一刻起;FAKE_REAL_BASE = 真钟哪一刻对上它(子进程都继承,所以是同一只钟)
  const clockEnv = (start, base = String(Date.now())) => ({ ...process.env, FAKE_START: start, FAKE_REAL_BASE: base,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import ${FC}`.trim() });
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const put = (root, rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
  // markdown 里的代码块:跟第 5 节同一个认法(围栏可缩进,去掉围栏那层缩进)
  const blocksOf = (md) => [...md.replace(/\r\n/g, "\n").matchAll(/^([ \t]*)```[^\n]*\n([\s\S]*?)\n\1```[ \t]*$/gm)]
    .map(([, ind, body]) => body.split("\n").map((l) => (l.startsWith(ind) ? l.slice(ind.length) : l)).join("\n"));
  const fails = (out) => out.split("\n").filter((l) => /FAIL/.test(l)).join(" | ");

  // 一个装好的项目,带 origin、main 推上去了:6a–6c 在它里面跑
  const F = tmp("bt-v031-");
  git(F, "init", "-q", "-b", "main");
  git(F, "config", "user.email", "t@example.com"); git(F, "config", "user.name", "t");
  node(join(ROOT, "scripts/belltower-init.mjs"), [F]);
  const ORIGIN = join(tmp("bt-v031-origin-"), "o.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", ORIGIN]);
  git(F, "remote", "add", "origin", ORIGIN);
  git(F, "add", "-A"); git(F, "commit", "-qm", "init"); git(F, "push", "-q", "-u", "origin", "main");

  // 6a. 两套新自测:本仓库跑一遍,装好的项目里再跑一遍(证明装进去之后路径照样对得上)
  for (const [name, script] of [["原话汇总", "scripts/test-user-quotes.mjs"], ["假时钟", "scripts/test-fake-clock.mjs"]]) {
    for (const [where, cwd] of [["", join(ROOT, "framework")], ["装好的项目里", F]]) {
      const r = node(script, [], cwd);
      const c = counts(r.stdout);
      assert(`${where}${name}自测全绿(${c ? `${c[0]} passed, ${c[1]} failed` : "没读到计数"})`,
        r.status === 0 && c && c[1] === 0 && c[0] > 0, fails(r.stdout) || r.stderr.slice(0, 300));
    }
  }

  // 6b. 刚装好的项目只有模板:一条原话都不该扫出来(模板里的示例行、讲规矩的句子都不算)
  {
    const r = node("scripts/user-quotes.mjs", ["--json"], F);
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    assert("刚装好的项目(只有模板)原话汇总扫出 0 条:模板里的示例行、讲规矩的句子都不算",
      r.status === 0 && j && j.files > 0 && j.quotes.length === 0,
      j ? j.quotes.map((q) => `${q.sources[0]?.path}:${q.sources[0]?.line}「${q.text}」`).join(" | ") : r.stderr.slice(0, 300));
  }

  // 6c. 巡检周一 (a)(a′):命令从 patrol.md 的代码块里原样抠出来跑(跟第 5 节一样,不在这儿另抄一份)
  {
    const md = readFileSync(join(ROOT, "framework/.claude/skills/tower-meta/references/patrol.md"), "utf8");
    const cmdA = blocksOf(md).filter((b) => b.includes("user-quotes.mjs --json"));
    const cmdB = blocksOf(md).filter((b) => b.includes("〔重申〕"));
    assert("patrol.md 里 (a)「又说一遍」、(a′)「又答一遍」的命令各恰好一块", cmdA.length === 1 && cmdB.length === 1, `(a) ${cmdA.length} 块,(a′) ${cmdB.length} 块`);
    // 〔重申〕的写法从模板里抠:模板教塔怎么写,巡检就得数得到这种写法
    const tpl = readFileSync(join(ROOT, "framework/templates/CLAUDE.md"), "utf8");
    const mark = (tpl.match(/`(〔重申〕[^`]*)`/) ?? [])[1] ?? "(模板里没找到〔重申〕的写法)";
    const FW_LP = String.fromCharCode(0xFF08);   // 全角左括号:用码位拼,手打的「全角」常常其实是半角
    put(F, "docs/journal.md", [
      "# 行为流水", "",
      "- 2031-02-24 10:00 · plan · 某事 · 用户 2031-02-24 09:50 原话「再说一遍,列表要分页」",
      "- 2031-02-26 09:00 · plan · 某事 · 〔重申〕(原出处:docs/design/list.md 第 2 节)",
      "- 2031-03-03 11:00 · dev · 某事 · 用户 2031-03-03 10:40 原话「又忘了加搜索框」",
      `- 2031-03-03 11:05 · dev · 某事 · 〔重申〕${FW_LP}原出处:2031-02-20 的原话)`,
      "- 2031-03-05 09:00 · product · 某事 · 用户 2031-03-05 08:50 原话「列表页先这样」",
      "- 2031-03-09 10:00 · product · 定列表页 · 用户 2031-03-09 09:40 原话「怎么还是没改」",
      "- 2031-03-09 10:05 · product · 定列表页 · 〔重申〕(原出处:docs/design/list.md 第 2 节)",
      `- 2031-03-10 08:00 · plan · 某事 · ${mark}`,
      "- 2031-03-10 09:00 · meta · 某事 · 用户 2031-03-10 08:30 原话「我说过表头要固定」",
      "- 2031-03-10 09:10 · meta · 某事 · 用户 2031-03-10 08:45 原话「为什么没发早报」",
      "- 2031-03-10 09:20 · meta · 〔重申〕标照办,以后照这个记",
      "  〔重申〕(原出处:接着上一行写的,行首没日期)",
      "", "## 杂记", "", "用户原话「为什么没按上次说的做」", ""].join("\n"));
    git(F, "add", "-A"); git(F, "commit", "-qm", "样例台账"); git(F, "push", "-q", "origin", "main");
    const cfgPath = join(F, ".claude/belltower.json");
    const cfg0 = readFileSync(cfgPath, "utf8");
    const withTz = (tz) => {
      const c = JSON.parse(cfg0);
      if (tz === undefined) delete c.timezone; else c.timezone = tz;
      writeFileSync(cfgPath, JSON.stringify(c, null, 2) + "\n");
    };
    const run = (cmd, start) => {
      const r = spawnSync("bash", ["-c", cmd ?? "exit 1"], { cwd: F, env: clockEnv(start), encoding: "utf8" });
      return { first: (r.stdout ?? "").split("\n")[0], out: r.stdout ?? "", detail: `code=${r.status} ${(r.stderr ?? "").slice(0, 200)}` };
    };
    // T1 = 2031-03-10T02:00Z:美东是 3/9 晚上 10 点,基里巴斯(+14)已经是 3/10。
    // T2 = 04:30Z:美东 3/10 凌晨 0:30,夏令时 3/9 刚切换 —— 拿「现在 − n×24 小时」算日子的话,往前数会少一天。
    const T1 = "2031-03-10T02:00:00Z", T2 = "2031-03-10T04:30:00Z";
    const A_39 = "又说一遍 · 本周 2031-03-03 至 2031-03-09 · 2 条 · 上周 2031-02-24 至 2031-03-02 · 1 条 · 没日期的 1 条";
    const A_310 = "又说一遍 · 本周 2031-03-04 至 2031-03-10 · 3 条 · 上周 2031-02-25 至 2031-03-03 · 1 条 · 没日期的 1 条";
    const B_39 = "又答一遍 · 本周 2031-03-03 至 2031-03-09 · 2 条 · 上周 2031-02-24 至 2031-03-02 · 1 条 · 行首没日期的 1 条";
    const B_310 = "又答一遍 · 本周 2031-03-04 至 2031-03-10 · 2 条 · 上周 2031-02-25 至 2031-03-03 · 2 条 · 行首没日期的 1 条";
    for (const [label, tz, start, wantA, wantB] of [
      ["配置写 America/New_York(那边还是 3/9)", "America/New_York", T1, A_39, B_39],
      ["时区从配置读:Pacific/Kiritimati 那边已经 3/10", "Pacific/Kiritimati", T1, A_310, B_310],
      ["配置没写 timezone → 用 America/New_York", undefined, T1, A_39, B_39],
      ["timezone 写坏了 → 不崩,用 America/New_York", "Mars/Olympus", T1, A_39, B_39],
      ["夏令时刚切换、美东凌晨 0:30:按日历往前数,窗口不少一天", undefined, T2, A_310, B_310],
    ]) {
      withTz(tz);
      const a = run(cmdA[0], start), b = run(cmdB[0], start);
      assert(`巡检周一 (a) ${label}`, a.first === wantA, `要「${wantA}」,得「${a.first}」 ${a.detail}`);
      assert(`巡检周一 (a′) ${label}`, b.first === wantB, `要「${wantB}」,得「${b.first}」 ${b.detail}`);
    }
    // 早报要列出本周那几条:原话带出处;(a′) 只列带「(原出处」的行
    withTz("America/New_York");
    const a = run(cmdA[0], T1), b = run(cmdB[0], T1);
    const aList = a.out.split("\n").slice(1).filter(Boolean), bList = b.out.split("\n").slice(1).filter(Boolean);
    assert("巡检周一 (a) 逐条列出本周那几句原话和出处(上周的不列)",
      aList.length === 2 && /「又忘了加搜索框」 docs\/journal\.md:\d+/.test(a.out) && /「怎么还是没改」/.test(a.out) && !aList.some((l) => l.includes("再说一遍")), a.out);
    assert("巡检周一 (a′) 逐条列出本周那几行(讲标记本身的那行不算)", bList.length === 2 && !/标照办/.test(b.out), b.out);
    assert("模板里教的〔重申〕写法,(a′) 数得到", mark.startsWith("〔重申〕") && run(cmdB[0], T2).out.includes(mark), mark);
    writeFileSync(cfgPath, cfg0);
  }

  // 6d. 外来 skill 默认不进技能清单:拷进来的 SKILL.md 补 disable-model-invocation: true;--keep-in-list 不补
  {
    const U = tmp("bt-kwp-");
    git(U, "init", "-q", "-b", "main");
    git(U, "config", "user.email", "t@example.com"); git(U, "config", "user.name", "t");
    put(U, "LICENSE", "Apache-2.0(测试夹具)\n");
    put(U, "alpha/skills/foo/SKILL.md", "---\nname: foo\ndescription: 示例 skill 甲\n---\n\n# foo\n正文第一行\nname: 正文里这行不是 frontmatter\n");
    put(U, "alpha/skills/bar/SKILL.md", "---\nname: bar\ndisable-model-invocation: false\ndescription: 上游自己写了 false\n---\n正文\n");
    put(U, "alpha/skills/nofm/SKILL.md", "# 没有 frontmatter 的\n");
    put(U, "alpha/skills/empty/README.md", "没有 SKILL.md\n");
    put(U, "beta/skills/qux/SKILL.md", "---\nname: qux\ndescription: 没选的插件\n---\n");
    git(U, "add", "-A"); git(U, "commit", "-qm", "上游");
    const V = tmp("bt-vendor-");
    const vend = (...a) => node(join(ROOT, "framework/scripts/vendor-skills.mjs"), ["--src", U, "--plugins", "alpha", ...a], V);
    const rd = (f) => (existsSync(join(V, ".claude/skills", f)) ? readFileSync(join(V, ".claude/skills", f), "utf8") : null);
    const BODY = "\n# foo\n正文第一行\nname: 正文里这行不是 frontmatter\n";
    const r = vend();
    assert("vendor-skills:frontmatter 改名、紧跟一行 disable-model-invocation: true;正文一个字不动(正文里的 name: 行也不动)",
      r.status === 0 && rd("alpha-foo/SKILL.md") === "---\nname: alpha-foo\ndisable-model-invocation: true\ndescription: 示例 skill 甲\n---\n" + BODY,
      (r.stdout + r.stderr).slice(0, 300) + " | " + rd("alpha-foo/SKILL.md"));
    const bar = rd("alpha-bar/SKILL.md") ?? "";
    assert("vendor-skills:上游写了 disable-model-invocation: false → 改成 true,不重复一行",
      (bar.match(/^disable-model-invocation:/gm) ?? []).length === 1 && /^disable-model-invocation: true$/m.test(bar), bar);
    assert("vendor-skills:没 frontmatter 的跳过并报出来;没选的插件、没 SKILL.md 的目录不拷",
      rd("alpha-nofm/SKILL.md") === null && /alpha-nofm.*没有 frontmatter/.test(r.stderr) && rd("beta-qux/SKILL.md") === null &&
      !existsSync(join(V, ".claude/skills/alpha-empty")), r.stderr);
    const man = rd("VENDORED.md") ?? "";
    assert("vendor-skills:VENDORED.md 写明加了 disable-model-invocation、怎么取消(--keep-in-list)",
      /^- `alpha-foo`/m.test(man) && /^- `alpha-bar`/m.test(man) && man.includes("disable-model-invocation: true") && man.includes("--keep-in-list"), man.slice(0, 400));
    vend();
    assert("vendor-skills 重跑:还是恰好一行 disable-model-invocation", ((rd("alpha-foo/SKILL.md") ?? "").match(/^disable-model-invocation:/gm) ?? []).length === 1, rd("alpha-foo/SKILL.md"));
    const k = vend("--keep-in-list");
    assert("vendor-skills --keep-in-list:不加这一行,上游写的原样留着",
      k.status === 0 && rd("alpha-foo/SKILL.md") === "---\nname: alpha-foo\ndescription: 示例 skill 甲\n---\n" + BODY &&
      /^disable-model-invocation: false$/m.test(rd("alpha-bar/SKILL.md") ?? "") && /--keep-in-list/.test(rd("VENDORED.md") ?? ""),
      rd("alpha-foo/SKILL.md") + " | " + rd("alpha-bar/SKILL.md"));
  }

  // 6e. tower.md 开头的「按节读」索引:每个 `## ` 节恰好一行;开局读哪几节前后说法一致;切节命令切得出那一节
  {
    const md = readFileSync(join(ROOT, "framework/.claude/skills/tower-meta/references/tower.md"), "utf8").replace(/\r\n/g, "\n");
    const lines = md.split("\n");
    const heads = lines.filter((l) => l.startsWith("## ")).map((l) => l.slice(3));
    const hi = lines.findIndex((l) => l.startsWith("| 节"));
    const rows = [];
    for (let i = hi + 2; hi >= 0 && i < lines.length && lines[i].startsWith("|"); i++) rows.push(lines[i].split("|").map((s) => s.trim()).slice(1, 3));
    const names = rows.map((r) => r[0]);
    const lostHeads = heads.filter((h) => names.filter((n) => h.startsWith(n)).length !== 1);
    const lostRows = names.filter((n) => heads.filter((h) => h.startsWith(n)).length !== 1);
    assert(`tower.md 按节读:${heads.length} 个 \`## \` 节各对上索引里恰好一行,索引没有多的行`,
      heads.length > 0 && !lostHeads.length && !lostRows.length && names.length === heads.length,
      `没对上的节:${lostHeads.join(" / ")};没对上的行:${lostRows.join(" / ")}`);
    const said = [...(lines.find((l) => l.startsWith("**按节读")) ?? "").matchAll(/「([^」]+)」/g)].map((m) => m[1]);
    const startup = rows.filter((r) => /每次开局/.test(r[1] ?? "")).map((r) => r[0]);
    assert("tower.md 按节读:开头那句「开局只读哪几节」= 表里标「每次开局」的那几行",
      startup.length > 0 && JSON.stringify(said) === JSON.stringify(startup), `开头说 ${said.join("、")};表里 ${startup.join("、")}`);
    const cmd = blocksOf(md).filter((b) => b.startsWith("awk "));
    const D = tmp("bt-tower-");
    put(D, ".claude/skills/tower-meta/references/tower.md", md);
    const s = lines.findIndex((l) => l.startsWith("## 塔的开局动作"));
    const e = lines.findIndex((l, i) => i > s && l.startsWith("## "));
    const want = lines.slice(s, e).join("\n") + "\n";
    const r = spawnSync("bash", ["-c", cmd[0] ?? "exit 1"], { cwd: D, encoding: "utf8" });
    assert("tower.md 按节读:切节命令只有一条,切出来恰好是「塔的开局动作」整节",
      cmd.length === 1 && s > 0 && e > s && r.stdout === want, `命令 ${cmd.length} 条;切出 ${(r.stdout ?? "").split("\n").length} 行,要 ${want.split("\n").length} 行`);
  }

  // 6f. 顾问姿态第 0 步「问之前先查已定的」:模板和 architecture §4 都有
  {
    const tpl = readFileSync(join(ROOT, "framework/templates/CLAUDE.md"), "utf8");
    const posture = tpl.split("\n").find((l) => l.startsWith("**各板块共用一种顾问姿态**")) ?? "";
    assert("模板顾问姿态那行:第一步是「问之前先查已定的」", /\*\*问之前先查已定的\*\*\s*\S\s*先讲清词/.test(posture), posture);
    assert("模板写了查到相关的怎么问(带日期、塔、原话)和〔重申〕(原出处 标", tpl.includes("说过「<原话>」」,再只问差在哪") && /`〔重申〕\(原出处/.test(tpl));
    const sec4 = readFileSync(join(ROOT, "docs/architecture.md"), "utf8").split(/^## /m).find((x) => x.startsWith("4. 顾问姿态")) ?? "";
    const i0 = sec4.indexOf("0. **问之前先查已定的**"), i1 = sec4.indexOf("1. **先讲清**");
    assert("architecture §4 加了第 0 步「问之前先查已定的」,排在「先讲清」前面", i0 >= 0 && i1 > i0, sec4.slice(0, 200));
  }

  // 6g. 假时钟跨零点:把框架自测放到项目时区 23:59:59 起跑。测试开头钉了 BELLTOWER_NOW,hook 都走 lib/now.mjs;
  //     哪处绕开钉子现取「今天」,跑到零点后就跟测试算的差一天 —— 只靠真钟,得碰巧半夜跑才看得见。
  {
    const TZ = DEFAULTS.timezone;   // framework/ 下没有 belltower.json → 自测跑在默认时区
    const off = (t) => {   // 那一刻 TZ 的 UTC 偏移(分钟),现取,不写死 −04 / −05
      const s = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" }).formatToParts(t).find((p) => p.type === "timeZoneName")?.value ?? "";
      const m = s.match(/GMT([+-])(\d\d):(\d\d)/);
      return m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
    };
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
    let start = Date.parse(`${day}T23:59:59Z`);
    for (let k = 0; k < 2; k++) start = Date.parse(`${day}T23:59:59Z`) - off(new Date(start)) * 60000;
    const wall = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(start);
    const probe = spawnSync(process.execPath, ["-e", "console.log(Date.now())"], { env: clockEnv(new Date(start).toISOString()), encoding: "utf8" });
    const seen = Number((probe.stdout ?? "").trim());
    assert(`假时钟挂上了:起点是 ${TZ} 的 23:59:59,子进程读到的就是这一刻`, wall === "23:59:59" && seen >= start && seen < start + 5000,
      `起点 ${wall};子进程读到 ${probe.stdout} ${(probe.stderr ?? "").slice(0, 200)}`);
    const spawnAt = Date.now();
    const r = spawnSync(process.execPath, ["scripts/test-hooks.mjs"], { cwd: join(ROOT, "framework"), env: clockEnv(new Date(start).toISOString(), String(spawnAt)), encoding: "utf8" });
    const took = Date.now() - spawnAt;
    const c = counts(r.stdout ?? "");
    assert(`假时钟:框架自测从 23:59:59 起跑、跑过零点仍全绿(${c ? `${c[0]} passed, ${c[1]} failed` : "没读到计数"},跑了 ${(took / 1000).toFixed(1)} 秒)`,
      r.status === 0 && c && c[1] === 0 && c[0] > 0 && took > 1500, fails(r.stdout ?? "") || (r.stderr ?? "").slice(0, 300));
    rmSync(join(ROOT, "framework/.claude/.session-state"), { recursive: true, force: true });
    rmSync(join(ROOT, "framework/docs"), { recursive: true, force: true });
  }
}

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
