#!/usr/bin/env node
// 公开前的泄漏扫描:本仓库是公开的,推上去就撤不回。推之前必须跑这个,退出 0 才许推。
//
// 只扫**通用形状**(会话 ID、个人链接、邮箱、本机路径、提交 sha、PR 号、模型 ID、密钥前缀)。
// 项目专有的词(公司名、客户名、行业词)不写在这里 —— 写进来本身就是泄漏;
// 那一层用 `--words <文件>` 从仓库外带进来,文件一行一个正则,`#` 开头是注释。
//
// 例外:行里带 `scan-public:ok` 的跳过(只给测试夹具用,每处都要在评审里看得见)。
//
// 用法:node scripts/scan-public.mjs [目录=仓库根] [--words 词表文件]
// 出处:这套框架是从一个私有项目里洗出来的。洗的时候靠人眼,漏一个就是公开事故 —— 所以机器扫。
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DEFAULT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const wi = args.indexOf("--words");
const wordsFile = wi >= 0 ? args[wi + 1] : null;
const root = resolve(args.filter((a, i) => !a.startsWith("--") && (wi < 0 || i !== wi + 1))[0] ?? ROOT_DEFAULT);

// 允许出现的唯一 GitHub 账号 = 清单里写的上游地址。
let upstream = "";
try { upstream = JSON.parse(readFileSync(join(root, "belltower.manifest.json"), "utf8")).upstream ?? ""; } catch {}
const upstreamPath = upstream.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").toLowerCase();

// 测试里摆的假会话 ID:大写字母 + 一串 0,真 ID 是混排的 base62,不会长这样。
const FAKE_ID = /^(session|cse)_[A-Z]+0{4,}[0-9]*$/;
const ALLOWED_EMAIL = /@(example\.(com|org|net)|users\.noreply\.github\.com)$/i;

const RULES = [
  { id: "会话/触发器/环境 ID", re: /\b(session|cse|trig|env)_[A-Za-z0-9]{12,}\b/g, ok: (m) => FAKE_ID.test(m) },
  { id: "claude.ai 个人链接", re: /claude\.ai\/(code|chat|artifact|project|share)\/[A-Za-z0-9_-]+/g },
  { id: "邮箱", re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+/g, ok: (m) => ALLOWED_EMAIL.test(m) || /^[^@]+@[0-9.]+$/.test(m) },
  { id: "GitHub 账号", re: /github\.com\/([A-Za-z0-9_.-]+)(\/[A-Za-z0-9_.-]+)?/g,
    ok: (m) => {
      const p = m.replace(/^github\.com\//, "").toLowerCase().replace(/\.git$/, "");
      return (upstreamPath && p.startsWith(upstreamPath)) || /^(apps|features|settings|marketplace|<owner>|owner|o|you|your-org|acme|anthropics)(\/|$)/.test(p);
    } },
  // scan-public:ok —— 下一行是规则本身
  { id: "本机路径", re: /(\/home\/[a-z][\w-]*\/|\/Users\/[A-Za-z][\w-]*\/|[A-Za-z]:\\\\?Users\\|\\Desktop\\|\/root\/\.|\/tmp\/claude-)/g },
  { id: "提交 sha(40 位)", re: /\b[0-9a-f]{40}\b/g },
  { id: "提交 sha(反引号里的短 sha)", re: /`[0-9a-f]{7,12}`/g, ok: (m) => !/[0-9]/.test(m) || !/[a-f]/.test(m) },
  { id: "PR 号", re: /(\bPR ?#\d+|\/pull\/\d+)/g },
  { id: "模型 ID", re: /\bclaude-[a-z]+-[0-9][\w.-]*/g },
  { id: "密钥前缀", re: /\b(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-ant-[A-Za-z0-9_-]{10,}|AKIA[0-9A-Z]{16})\b/g },
];

const words = [];
if (wordsFile) {
  for (const line of readFileSync(wordsFile, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    try { words.push(new RegExp(t, "gi")); } catch { console.error(`词表里这条正则写坏了:${t}`); process.exit(2); }
  }
}

const SKIP_DIR = new Set([".git", "node_modules"]);
function* walk(d) {
  for (const n of readdirSync(d)) {
    if (SKIP_DIR.has(n)) continue;
    const p = join(d, n);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p); else if (st.size < 2_000_000) yield p;
  }
}

const hits = [];
if (!existsSync(root)) { console.error(`目录不存在:${root}`); process.exit(2); }
for (const f of walk(root)) {
  const rel = relative(root, f);
  const lines = readFileSync(f, "utf8").split("\n");
  lines.forEach((text, i) => {
    // 行尾 `scan-public:ok` = 人工确认过的测试夹具 / 规则源码;上一行写了它也算(给规则定义那种长行用)。
    if (/scan-public:ok/.test(text) || /scan-public:ok —— 下一行/.test(lines[i - 1] ?? "")) return;
    for (const r of RULES) {
      for (const m of text.matchAll(r.re)) if (!r.ok?.(m[0])) hits.push({ rel, n: i + 1, id: r.id, m: m[0] });
    }
    for (const w of words) {
      for (const m of text.matchAll(w)) {
        // 上游地址里的账号名是唯一的例外
        if (upstreamPath && text.toLowerCase().includes(upstreamPath) && upstreamPath.includes(m[0].toLowerCase())) continue;
        hits.push({ rel, n: i + 1, id: "项目词表", m: m[0] });
      }
    }
  });
}

for (const h of hits) console.log(`${h.rel}:${h.n}  [${h.id}]  ${h.m}`);
console.log(`\n扫描 ${root}:通用规则 ${RULES.length} 条${wordsFile ? ` + 词表 ${words.length} 条` : ""},命中 ${hits.length} 处。`);
process.exit(hits.length ? 1 : 0);
