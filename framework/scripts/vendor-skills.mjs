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
 * 用法:node scripts/vendor-skills.mjs [--src <已克隆的仓库路径>] [--plugins design,engineering,…]
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
const DEST = '.claude/skills';
const MANIFEST = join(DEST, 'VENDORED.md');

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
    // frontmatter 的 name 改成带插件前缀的,免得六个插件之间撞名
    const p = join(to, 'SKILL.md');
    const s = readFileSync(p, 'utf8').replace(/^name:\s*.*$/m, `name: ${name}`);
    writeFileSync(p, s);
    const desc = (s.match(/^description:\s*(.*)$/m) || [, ''])[1].slice(0, 90);
    rows.push(`- \`${name}\` — ${desc}`);
  }
}
mkdirSync(DEST, { recursive: true });
writeFileSync(MANIFEST, `# 外来 skill 清单(自动生成,别手改)

来源:${REPO} @ \`${sha.slice(0, 12)}\`,Apache-2.0(许可证全文见 \`_vendor-LICENSE-knowledge-work-plugins\`)。
同步命令:\`node scripts/vendor-skills.mjs\`。目录名 = \`<插件>-<skill>\`,frontmatter 的 name 同步改过,其余原样。
同步日期:${new Date().toISOString().slice(0, 10)}。共 ${rows.length} 个。

${rows.join('\n')}
`);
cpSync(join(src, 'LICENSE'), join(DEST, '_vendor-LICENSE-knowledge-work-plugins'));
console.log(`✓ 拷入 ${rows.length} 个 skill(来源 ${sha.slice(0, 12)}),清单在 ${MANIFEST}`);
