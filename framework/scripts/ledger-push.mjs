#!/usr/bin/env node
/**
 * 台账直推 main。
 *
 * 为什么存在:塔与塔之间的细节只靠文件总线传(门铃只负责叫醒,见 tower.md
 * 「跨会话通信」节)。但各塔被开在各自分支上,写在自己分支的台账别的塔读不到 ——
 * 总线看着通、实际各说各话(2026-09-09 实测复发两次)。所以台账四件直推 main
 * (这个口子要用户授权过才开,授权范围只有台账四件)。
 *
 * 用法:改完台账文件后
 *     node scripts/ledger-push.mjs "一句话说明"
 *
 * 它只碰下面白名单里的文件。工作区里有别的改动就拒绝跑 —— 那是代码,
 * 代码走自己分支,不许借这个口子上 main。
 *
 * ★ main 加了分支保护(要求 CI 绿)之后,**直推**会被拒 —— 各塔的日常记账全断在这儿。
 *   所以加了**自适应**:先照旧试直推,推不上去再回退到 PR 模式(推一个 ledger/* 分支,
 *   由塔用 MCP 开 PR 再合)。保护没开时行为**一个字都不变**,开了才走新路。
 *
 *   ⚠ 怎么认出「被保护规则挡了」:**不解析 GitHub 的错误文字**(措辞会变,
 *   而且各种规则的措辞都不一样)。push 失败后现查 `origin/main` 的 sha 变没变 ——
 *   变了 = 别的塔抢先推了(照旧重试),没变 = 不是抢跑,是被规则挡了(转 PR 模式)。
 *   判据是事实不是字符串,跟闸门6 同形。
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

const LEDGER = [
  'docs/journal.md',
  'docs/BACKLOG.md',
  'docs/session-pool.md',
  'docs/gate-log.md',
];
const TMP = '_ledger_tmp';
const MAX_RETRY = 3;
// owner/repo 只用来打印开 PR 的命令:先读 .claude/belltower.json 的 repo,没有就从 origin 的 URL 现解析。
const [OWNER, REPO] = (() => {
  try {
    const r = JSON.parse(readFileSync('.claude/belltower.json', 'utf8')).repo;
    if (typeof r === 'string' && /^[\w.-]+\/[\w.-]+$/.test(r)) return r.split('/');
  } catch {}
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = url.match(/[:/]([\w.-]+)\/([\w.-]+?)(\.git)?$/);
    if (m) return [m[1], m[2]];
  } catch {}
  return ['<owner>', '<repo>'];
})();
// PR 模式下留给收尾闸门12 的记号。目录已 gitignore,不会跟着台账上主干。
const PENDING = '.claude/.session-state/ledger-pending.json';

// 只剃尾部空白 —— 不能用 .trim():`git status --porcelain` 每行前两位是状态码,
// 未暂存改动首位就是空格,trim 会把首行那个空格吃掉,文件名跟着少一个字母。
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    .replace(/\s+$/, '');

const die = (msg) => { console.error('\n✗ ' + msg + '\n'); process.exit(1); };

const msg = process.argv[2];

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch === 'main') die('你已经在 main 上了,直接 commit + push 就行,不用这个脚本。');

// ── 1) 工作区体检:只许台账有改动 ──────────────────────────────
const dirty = git('status', '--porcelain')
  .split('\n').filter(Boolean)
  .map((l) => l.slice(3).trim());
const stray = dirty.filter((f) => !LEDGER.includes(f));
if (stray.length) {
  die('工作区里有台账以外的改动,先把它们 commit 或 stash 掉:\n    ' + stray.join('\n    ') +
      '\n  (代码走自己分支,这个口子只给台账。)');
}
const changed = dirty.filter((f) => LEDGER.includes(f));

// ── 2) 台账有改动就先在自己分支上提交 ─────────────────────────
if (changed.length) {
  if (!msg) die('台账有改动,要一句话说明:node scripts/ledger-push.mjs "改了什么"');
  console.log('台账改动:\n    ' + changed.join('\n    '));
  git('add', ...changed);
  git('commit', '-m', msg);
  console.log(`\n已提交到 ${branch}:${git('rev-parse', '--short', 'HEAD')}`);
} else {
  console.log('工作区干净,只做同步。');
}

// ── 3) 把台账状态同步到 main ──────────────────────────────────
// 同步的是「整个台账文件的状态差」,不是某一个提交 —— 首次用或分支落后
// 好几轮时,单挑一个提交 cherry-pick 必然撞车(main 上没有它的前提)。
// 先 merge origin/main 进自己分支,让自己分支成为 main 的超集;
// 之后整份拿自己的台账覆盖过去就是无损的 —— 别人写的行已经在里面了。
// ── PR 模式:直推被规则挡住时走这条 ─────────────────────────────────
// 脚本只负责把台账推成一个**只含台账四件**的干净分支;开 PR + 合 PR 由塔用 MCP 做。
// 为什么不让脚本自己调 GitHub API:记账脚本不该拿着能改仓库的凭据,
// 而且塔手里本来就有 mcp__github__*,多这一步换来的是脚本零凭据。
function pushOwnBranch() {
  for (let i = 1; i <= MAX_RETRY; i++) {
    try { git('push', '-u', 'origin', branch); return true; } catch (e) {
      if (i === MAX_RETRY) {
        console.log('\n⚠ ' + branch + ' 自己没推上去(试了 ' + MAX_RETRY + ' 次):\n' +
                    String(e.stderr || e.message).trim() +
                    '\n  手工 git push -u origin ' + branch + ' 补一下。');
      }
    }
  }
  return false;
}

function prMode() {
  // HEAD 此刻在 TMP 上 = origin/main + 本塔的台账四件,除台账外一个文件不差
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(2, 13);  // 年月日T时分,例 260925T1643
  const slug = branch.replace(/^claude\//, '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 40);
  const ledgerBranch = `ledger/${slug}-${stamp}`;
  const title = `台账 · ${msg || `同步(来自 ${branch})`}`;

  let pushed = false;
  for (let i = 1; i <= MAX_RETRY && !pushed; i++) {
    try { git('push', 'origin', `${TMP}:refs/heads/${ledgerBranch}`); pushed = true; }
    catch (e) {
      if (i === MAX_RETRY) {
        git('checkout', branch);
        try { git('branch', '-D', TMP); } catch {}
        die('台账分支也推不上去(试了 ' + MAX_RETRY + ' 次):\n' +
            String(e.stderr || e.message).trim() +
            '\n  台账那笔提交还在 ' + branch + ' 上,没丢。');
      }
    }
  }

  // 留记号给收尾闸门12:推了分支但 PR 还没合 = 台账没进主干 = 别的塔读不到
  try {
    mkdirSync(dirname(PENDING), { recursive: true });
    writeFileSync(PENDING, JSON.stringify(
      { branch: ledgerBranch, from: branch, title, at: new Date().toISOString() }, null, 2));
  } catch {}

  git('checkout', branch);
  try { git('branch', '-D', TMP); } catch {}
  const branchPushed = pushOwnBranch();

  console.log(`
⚠ **台账还没进 main** —— 直推被挡住了(main 上了分支保护),已转 PR 模式。

台账已推成分支:**${ledgerBranch}**(内容 = origin/main + 本塔台账四件,别的文件一个没带)
${branchPushed ? `${branch} 也推上去了` : ''}

**接下来这两步是你(塔)的,脚本干不了 —— 不做的话别的塔读不到这笔台账:**

  1) 开 PR
     mcp__github__create_pull_request
       owner=${OWNER} repo=${REPO} base=main head=${ledgerBranch}
       title=${JSON.stringify(title)}
       body="台账同步,只动 docs/journal.md · BACKLOG.md · session-pool.md · gate-log.md 四件。来源分支 ${branch}。"

  2) 合 PR。两条路,优先第一条:
     甲) mcp__github__enable_pr_auto_merge —— CI 绿了 GitHub 自己合,**塔不用等**
     乙) 等 CI 绿(约 1–2 分钟)后:先 mcp__github__pull_request_read 看实际状态
         (闸门11 要求,不许凭 CI 徽章就合),再 mcp__github__merge_pull_request

  ⚠ PR 报 not mergeable / 冲突 = 别的塔在你开 PR 之后先合了它的台账。
     **重跑一次本脚本**(它会 fetch + merge origin/main 再来),不要手工去改 PR 分支。

  合掉之后 ${PENDING} 会由收尾闸门自己清掉(它现查台账进没进 main,不看这个文件说了算)。
`);
  process.exit(0);
}

// ── 3b) 推 main;推不上去就转 PR 模式 ─────────────────────────────
let pushedSha = null;
for (let i = 1; i <= MAX_RETRY && !pushedSha; i++) {
  git('fetch', 'origin', 'main');

  try {
    git('merge', '--no-edit', 'origin/main');
  } catch {
    try { git('merge', '--abort'); } catch {}
    die('把 main 并进 ' + branch + ' 时冲突了,git 自己解不开。\n' +
        '  手工解一次:git merge origin/main —— 解完再跑这个脚本。');
  }

  git('checkout', '-B', TMP, 'origin/main');
  try {
    git('checkout', branch, '--', ...LEDGER);
  } catch (e) {
    git('checkout', branch);
    try { git('branch', '-D', TMP); } catch {}
    die('取台账文件失败:' + String(e.stderr || e.message));
  }

  if (!git('status', '--porcelain')) {
    git('checkout', branch);
    git('branch', '-D', TMP);
    console.log('\n✓ main 上的台账已经跟你这边一致,没什么要推的。');
    process.exit(0);
  }

  git('commit', '-m', msg || `台账同步(来自 ${branch})`);

  // push 之前记下 main 此刻的 sha —— 失败后就靠它分辨两种失败,不靠读错误文字
  const mainBefore = git('rev-parse', 'origin/main');
  try {
    pushedSha = git('rev-parse', '--short', 'HEAD');
    git('push', 'origin', `${TMP}:main`);
  } catch (e) {
    pushedSha = null;
    // ★ 现查,不解析措辞:main 动了 = 别的塔抢先推了(重试能解决);
    //   main 没动 = 不是抢跑,是被规则挡下的(重试一万次也一样)→ 转 PR 模式。
    let mainMoved = false;
    try { git('fetch', 'origin', 'main'); mainMoved = git('rev-parse', 'origin/main') !== mainBefore; }
    catch { mainMoved = true; }   // 查不了就当抢跑,走老路重试 —— 保守的那一边

    if (!mainMoved) {
      console.log('  推 main 被拒,而 origin/main 一个字没动 —— 不是别的塔抢跑,是规则挡的。');
      prMode();   // 不返回
    }

    console.log(`  第 ${i} 次 push 被拒(origin/main 动了 = 别的塔抢先推了),重来…`);
    git('checkout', branch);
    try { git('branch', '-D', TMP); } catch {}
    if (i === MAX_RETRY) die('连试 ' + MAX_RETRY + ' 次都推不上去:\n' + String(e.stderr || e.message));
  }
}

// ── 4) 收摊:把刚推上 main 的那版并回自己分支,两边保持一致 ────
git('checkout', branch);
git('branch', '-D', TMP);
git('fetch', 'origin', 'main');
try {
  git('merge', '--no-edit', 'origin/main');
} catch {
  try { git('merge', '--abort'); } catch {}
  console.log('\n⚠ 台账已上 main,但并回 ' + branch + ' 时冲突了,自己 git merge origin/main 解一下。');
}

// ── 5) 把自己分支也推上去 ────────────────────────────────────
// 本脚本在自己分支上留了提交(台账那笔 + merge main 那笔)。只推 main 不推分支,
// 分支就永远「有 N 个未推的提交」—— 收尾闸门每次都念一遍,每个塔都念。
// 台账此刻已经在 main 上了,所以这一步失败**不算失败**,只提示。
const branchPushed = pushOwnBranch();

console.log(`\n✓ 台账已上 main:${pushedSha}`);
console.log(`✓ 回到 ${branch},两边一致${branchPushed ? ';分支也推上去了' : ''}`);
console.log('\n别的塔下次 git fetch origin main 就读得到了。');
