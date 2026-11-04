#!/usr/bin/env node
/**
 * 把 anthropics/knowledge-work-plugins(Apache-2.0)里六个职能插件的 skill
 * 拷进项目的 .claude/skills/,让云塔百分之百读得到(claude.ai 里装的插件不进云会话,
 * 见 docs/platform-facts.md)。belltower 本身不带这些 skill —— 各项目自己从上游拉。
 *
 * 为什么不直接在 settings.json 里声明插件:那六个插件各自捆着 6–16 个 MCP server
 * (合计 62 个),声明进来每个会话开局都会挂一排「需要授权」的连接器;我们要的只是
 * 里面的 skill(方法),连接器已经在 claude.ai 里按需连了。
 *
 * 开局瘦身:拷进来的每个 SKILL.md,frontmatter 都补一行 `disable-model-invocation: true`
 *   (上游已经写了这个键的,改成 true,不重复)。加了这行,它的描述就不进每个会话开局的技能清单 ——
 *   几十个外来 skill 的描述,原来每次开局都要占掉一大块上下文(docs/platform-facts.md §6.1)。
 *   代价:模型自己想不起它们了。塔要用就按路径读 `.claude/skills/<名字>/SKILL.md`;用户打 `/<名字>` 照样能调 [未实测]。
 *   不想要:加 `--keep-in-list`,这次拷进来的都不加这一行(上游写了什么就是什么)。
 *
 * 用法:node scripts/vendor-skills.mjs [--src <已克隆的仓库路径>] [--plugins design,engineering,…] [--keep-in-list]
 *   不给 --src 就自己浅克隆到临时目录。重跑 = 重新同步(先删旧的再拷)。
 * 产出:.claude/skills/<插件>-<skill>/ …  +  .claude/skills/VENDORED.md(清单、来源提交、许可证)
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'https://github.com/anthropics/knowledge-work-plugins';
const DEFAULT_PLUGINS = ['design', 'product-management', 'engineering', 'data', 'operations', 'marketing'];
const pi = process.argv.indexOf('--plugins');
const PLUGINS = pi > -1 && process.argv[pi + 1]
  ? process.argv[pi + 1].split(',').map((x) => x.trim()).filter(Boolean)
  : DEFAULT_PLUGINS;
const HIDE = !process.argv.includes('--keep-in-list');
const DEST = '.claude/skills';
const MANIFEST = join(DEST, 'VENDORED.md');

// frontmatter 改写:name 换成带插件前缀的(免得六个插件之间撞名);HIDE 时补上 / 改成 disable-model-invocation: true。
// 只动 frontmatter,正文一个字不碰。没有 frontmatter 的返回 null(不是合法 skill)。
function rewriteFrontmatter(text, name) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!m) return null;
  let fm = m[1].replace(/^name:\s*.*$/m, `name: ${name}`);
  if (HIDE) {
    if (/^disable-model-invocation:/m.test(fm)) fm = fm.replace(/^disable-model-invocation:.*$/m, 'disable-model-invocation: true');
    else if (/^name:/m.test(fm)) fm = fm.replace(/^(name:.*)$/m, '$1\ndisable-model-invocation: true');
    else fm = `disable-model-invocation: true\n${fm}`;
  }
  return `---\n${fm}\n---\n` + text.slice(m[0].length);
}

let src = null;
const i = process.argv.indexOf('--src');
if (i > -1) src = process.argv[i + 1];
if (!src) {
  src = mkdtempSync(join(tmpdir(), 'kwp-'));
  execFileSync('git', ['clone', '-q', '--depth', '1', REPO, src], { stdio: 'inherit' });
}
const sha = execFileSync('git', ['-C', src, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

// 先删上一次拷进来的(按清单),保证重跑是干净的同步
if (existsSync(MANIFEST)) {
  for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
    const m = line.match(/^- `([a-z0-9-]+)`/);
    if (m && existsSync(join(DEST, m[1]))) rmSync(join(DEST, m[1]), { recursive: true });
  }
}

const rows = [];
for (const plugin of PLUGINS) {
  const sdir = join(src, plugin, 'skills');
  if (!existsSync(sdir)) { console.error(`✗ ${plugin}: 没有 skills/ 目录`); continue; }
  for (const skill of readdirSync(sdir)) {
    const from = join(sdir, skill);
    if (!existsSync(join(from, 'SKILL.md'))) continue;
    const name = `${plugin}-${skill}`;
    const to = join(DEST, name);
    cpSync(from, to, { recursive: true });
    const p = join(to, 'SKILL.md');
    const s = rewriteFrontmatter(readFileSync(p, 'utf8'), name);
    if (s === null) { console.error(`✗ ${name}: SKILL.md 没有 frontmatter,跳过`); rmSync(to, { recursive: true, force: true }); continue; }
    writeFileSync(p, s);
    const desc = (s.match(/^description:\s*(.*)$/m) || [, ''])[1].slice(0, 90);
    rows.push(`- \`${name}\` — ${desc}`);
  }
}
mkdirSync(DEST, { recursive: true });
const usage = HIDE
  ? '用法:**描述不进会话的技能清单**(`disable-model-invocation: true`,省开局上下文),模型自己不会想起它们。' +
    '塔要用就按路径读 `.claude/skills/<名字>/SKILL.md`,照着做;用户在输入框打 `/<名字>` 照样能调 [未实测]。' +
    '要让它们进清单:重跑时加 `--keep-in-list`。'
  : '这次带了 `--keep-in-list`:没加 `disable-model-invocation`,上游写了什么就是什么(没写的,描述都进技能清单)。';
writeFileSync(MANIFEST, `# 外来 skill 清单(自动生成,别手改)

来源:${REPO} @ \`${sha.slice(0, 12)}\`,Apache-2.0(许可证全文见 \`_vendor-LICENSE-knowledge-work-plugins\`)。
同步命令:\`node scripts/vendor-skills.mjs\`。目录名 = \`<插件>-<skill>\`,frontmatter 的 name 同步改过${HIDE ? '、加了 `disable-model-invocation: true`' : ''},其余原样。
${usage}
同步日期:${new Date().toISOString().slice(0, 10)}。共 ${rows.length} 个。

${rows.join('\n')}
`);
cpSync(join(src, 'LICENSE'), join(DEST, '_vendor-LICENSE-knowledge-work-plugins'));
console.log(`✓ 拷入 ${rows.length} 个 skill(来源 ${sha.slice(0, 12)}),清单在 ${MANIFEST}` +
  (HIDE ? ';都加了 disable-model-invocation: true(不进技能清单)' : ';带了 --keep-in-list,没加 disable-model-invocation'));
