// 直推 main 的口子清单 —— 哪些文件可以不走 PR、用 `node scripts/ledger-push.mjs` 直推 main。
//
// 两处读它,改这里两处一起变(清单只许有这一份,两份一定分叉):
//   · scripts/ledger-push.mjs —— 体检(只许这些有改动)、从分支取文件、同步到 main、PR 模式的 ledger/* 分支
//   · .claude/hooks/guard-stop.mjs 闸门12 —— PR 模式下这些文件没进 origin/main 就拦一次
//     (hook 引用这里失败时退回它自己写死的台账四件)
//
// 清单 = 台账四件(写死,框架的底线)+ 项目配置 `.claude/belltower.json` 的 `directPush`(默认空)。
// 「台账四件」这个名字不变:额外放行的文件不算台账,只是推送这条路跟台账一样。
// 要再放行别的文件,**先问用户**(CLAUDE.md〈台账走 main〉);问过了把路径写进 directPush,
// 别改这里 —— 这是框架文件,sync 会覆盖。directPush 收什么、不收什么见 .claude/hooks/lib/config.mjs。
import { config } from '../../.claude/hooks/lib/config.mjs';

export const LEDGER = [
  'docs/journal.md',
  'docs/BACKLOG.md',
  'docs/session-pool.md',
  'docs/gate-log.md',
];
export const EXTRA = config().directPush.filter((f) => !LEDGER.includes(f));
export const DIRECT_PUSH = [...LEDGER, ...EXTRA];
