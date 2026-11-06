#!/usr/bin/env node
// 交付分档的兜底判档(规矩见 .claude/skills/tower-meta/references/dispatch.md「交付分档」)。
// 档由 dev 判;这个命令只按「动了哪些文件」给一个**最低档**:命中 tiers.big 的算大,命中 tiers.mid 的最低算中,都没命中 = 小。
// dev 判的档低于它 → 按它来;test 只能往上调。路径模式从 `.claude/belltower.json` 的 tiers 读,框架不写死哪些目录算大。
//
//   node scripts/tier.mjs [--base <ref>] [--head <ref>] [--claim 小|中|大] [--json]
//       看 <base>...<head> 改了哪些文件(默认 origin/main...HEAD),报最低档和命中的文件。
//   node scripts/tier.mjs [--claim …] [--json] -- <文件…>
//       不读 git,直接判给出的这几个路径(相对仓库根)。
//
// 退出码:0 = 判完(--claim 不低于最低档也是 0);1 = --claim 低于最低档;2 = 参数错或读不到 ref。
// **不 fetch** —— 要最新的先 `git fetch origin main`。
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { config } from "../.claude/hooks/lib/config.mjs";

export const TIERS = ["小", "中", "大"];
const USAGE = `用法:
  node scripts/tier.mjs [--base <ref>] [--head <ref>] [--claim 小|中|大] [--json]
  node scripts/tier.mjs [--claim 小|中|大] [--json] -- <文件…>
默认 origin/main...HEAD,不 fetch。`;

// 路径模式 → RegExp:`**/` 任意层目录(含零层)· `**` 任意字符 · `*` 一段里任意字符 · `?` 一段里一个字符;别的字符照字面。
// 整条路径都要对上(锚头尾);写坏了(空串、不是字符串)→ null,那一条不算。
export function globRe(pat) {
  if (typeof pat !== "string" || !pat) return null;
  let s = "";
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === "*" && pat[i + 1] === "*") {
      if (pat[i + 2] === "/") { s += "(?:.*/)?"; i += 2; } else { s += ".*"; i += 1; }
    } else if (c === "*") s += "[^/]*";
    else if (c === "?") s += "[^/]";
    else s += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${s}$`);
}

// 最低档:{ tier, hits: [{ file, tier, pattern }] }。big 先看,命中 big 就不再记它的 mid。
export function floorOf(files, tiers) {
  const rules = [["大", tiers?.big ?? []], ["中", tiers?.mid ?? []]]
    .flatMap(([t, ps]) => ps.map((p) => ({ tier: t, pattern: p, re: globRe(p) })).filter((r) => r.re));
  const hits = [];
  for (const f of files) {
    const r = rules.find((x) => x.re.test(f));
    if (r) hits.push({ file: f, tier: r.tier, pattern: r.pattern });
  }
  const tier = hits.some((h) => h.tier === "大") ? "大" : hits.length ? "中" : "小";
  return { tier, hits };
}
export const rank = (t) => TIERS.indexOf(t);

function parse(argv) {
  const a = { files: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--") { a.files = argv.slice(i + 1); break; }
    if (x === "--json") a.json = true;
    else if (["--base", "--head", "--claim"].includes(x)) {
      if (i + 1 >= argv.length) throw new Error(`${x} 后面要跟一个值`);
      a[x.slice(2)] = argv[++i];
    } else throw new Error(`不认识的参数 ${x}`);
  }
  if (a.claim !== undefined && rank(a.claim) < 0) throw new Error(`--claim 只认 小 / 中 / 大,得到「${a.claim}」`);
  return a;
}

export function main(argv) {
  let a;
  try { a = parse(argv); } catch (e) { console.error(`✗ ${e.message}\n${USAGE}`); return 2; }
  const tiers = config().tiers;
  let files = a.files, range = "";
  if (!files) {
    range = `${a.base ?? "origin/main"}...${a.head ?? "HEAD"}`;
    try {
      files = execFileSync("git", ["diff", "--name-only", "--no-renames", range], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 })
        .split("\n").map((l) => l.trim()).filter(Boolean);
    } catch { console.error(`✗ 读不到 ${range}(没 fetch?ref 写错?)`); return 2; }
  }
  const { tier, hits } = floorOf(files, tiers);
  const low = a.claim !== undefined && rank(a.claim) < rank(tier);
  if (a.json) {
    console.log(JSON.stringify({ floor: tier, claim: a.claim ?? null, ok: !low, files: files.length, hits, range: range || null }, null, 2));
    return low ? 1 : 0;
  }
  for (const h of hits) console.log(`${h.tier} · ${h.file} · 命中 ${h.pattern}`);
  console.log(`— ${range || "给出的文件"}:${files.length} 个文件,按文件兜底最低「${tier}」` +
    (tier === "小" ? "(没碰到 tiers 里配的路径;档还是 dev 按改动性质判)" : ""));
  if (a.claim !== undefined) console.log(low ? `✗ 判的是「${a.claim}」,低于最低档「${tier}」—— 按「${tier}」走` : `✓ 判的是「${a.claim}」,不低于最低档`);
  if (!tiers.fullTestCmd) console.log("  (tiers.fullTestCmd 没配:全量回归用哪条命令,在 .claude/belltower.json 里写上)");
  else console.log(`  全量回归:${tiers.fullTestCmd}`);
  return low ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exit(main(process.argv.slice(2)));
