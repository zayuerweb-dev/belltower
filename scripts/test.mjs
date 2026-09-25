#!/usr/bin/env node
// belltower 的总测试入口:CI 跑的就是这一条。退出 0 才算过。
//   1. 框架自测(framework/scripts/test-hooks.mjs,含 ledger-push 沙箱)
//   2. init:装进一个空项目 → 在**装好的项目里**再跑一遍框架自测(证明不依赖本仓库)
//   3. sync:预演不写、--apply 才写、项目自己的文件不碰
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

  const t = node("scripts/test-hooks.mjs", [], P);
  const c = counts(t.stdout);
  assert(`装好的项目里框架自测全绿(${c ? `${c[0]} passed` : "没读到计数"})`, t.status === 0 && c && c[1] === 0,
    t.stdout.split("\n").filter((l) => /FAIL/.test(l)).join(" | "));

  const s = spawnSync(process.execPath, [".claude/hooks/session-start.mjs"], { cwd: P, encoding: "utf8" });
  assert("装好的项目里开局 hook 能跑、报出八个板块", s.status === 0 && /plan \/ product \/ dev \/ data \/ ops \/ biz \/ meta \/ test/.test(s.stdout), s.stdout);

  writeFileSync(join(P, "CLAUDE.md"), "# 项目自己写的\n");
  const again = node(join(ROOT, "scripts/belltower-init.mjs"), [P]);
  assert("再 init 一次:起步模板已存在 → 跳过,不覆盖项目的", again.status === 0 && readFileSync(join(P, "CLAUDE.md"), "utf8") === "# 项目自己写的\n", again.stdout);

  appendFileSync(join(P, ".claude/hooks/now.mjs"), "\n// 项目就地改过\n");
  const conflict = node(join(ROOT, "scripts/belltower-init.mjs"), [P]);
  assert("再 init 一次:框架文件被改过 → 报冲突、退出 1、不覆盖",
    conflict.status === 1 && /冲突/.test(conflict.stdout) && readFileSync(join(P, ".claude/hooks/now.mjs"), "utf8").includes("项目就地改过"), conflict.stdout);
}

// ── 3. sync ─────────────────────────────────────────────────────────────
{
  const sync = (...a) => node("scripts/belltower-sync.mjs", ["--source", ROOT, ...a], P);
  const dry = sync();
  assert("sync 预演:列出被改过的框架文件", dry.status === 0 && /~ \.claude\/hooks\/now\.mjs/.test(dry.stdout), dry.stdout + dry.stderr);
  assert("sync 预演:不写", readFileSync(join(P, ".claude/hooks/now.mjs"), "utf8").includes("项目就地改过"));

  rmSync(join(P, ".claude/hooks/guard-bash.mjs"));
  rmSync(join(P, "docs/journal.md"));
  const ap = sync("--apply");
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

for (const d of tmps) rmSync(d, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
