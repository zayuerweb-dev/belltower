// 假时钟 —— 只给测试和排查用,不进任何流程。测试进程和它起的每个子进程(hook、node -e、孙进程)共用一只往前走的假钟:
//   FAKE_START=2031-01-02T23:59:57-05:00 NODE_OPTIONS="--import $PWD/scripts/fake-clock.mjs" node scripts/test-hooks.mjs
// 路径要写绝对的(`$PWD/…`):hook 常在临时目录里跑,相对路径到了子进程就找不到。
// 假时刻 = FAKE_START + (真时刻 − 第一个进程起跑那刻);子进程靠继承的 FAKE_REAL_BASE 对齐,所以跨进程是同一只钟。
//
// 跟 BELLTOWER_NOW(.claude/hooks/lib/now.mjs)的分工:
//   BELLTOWER_NOW 只钉走 lib/now.mjs 的那几处,只在 CLAUDE_HOOK_TEST=1 时认,而且钉住不走;
//   假时钟换的是**每个 node 进程**的 Date,而且会走。所以它补的是钉子够不着的地方:
//   ① 整套测试放到项目时区零点前几秒跑 —— 测试开头算的「今天」和哪处绕过钉子现取的「今天」差一天,当场红出来
//      (只靠真钟,得碰巧半夜跑才看得见);
//   ② 起点放到几个月后 —— 夹具里写死的日期红出来;
//   ③ 文档里拿 Date.now() 算窗口的命令(巡检塔周一那几条),给一个固定的「现在」,期望值才能写死。
// 只换 Date / Date.now:git 记的提交时刻、文件 mtime、performance.now() 都还是真的;
//   Intl.DateTimeFormat().format() 不带参数时也还是真时刻 [实测✅ 2026-11-04,Node 22] —— 要假的就把 new Date() 传进去。
//   Date() 不带 new 当函数调会报错(class 不许不带 new 调);框架代码里没有这种写法。
// 出处:装了框架的项目拿它复现过「整套测试跑过零点、几条当天判据误红」(修法是测试钉时钟,框架里就是 BELLTOWER_NOW),
//   也扫出过一个夹具写死了日期、过了那天一直红。
const RealDate = Date;
if (process.env.FAKE_START) {
  const start = RealDate.parse(process.env.FAKE_START);
  if (Number.isNaN(start)) throw new Error(`FAKE_START 解析不了:${process.env.FAKE_START}`);
  process.env.FAKE_REAL_BASE ||= String(RealDate.now());
  const offset = start - Number(process.env.FAKE_REAL_BASE);
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(RealDate.now() + offset); else super(...a); }
    static now() { return RealDate.now() + offset; }
  };
}
