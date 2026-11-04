# 外来 skill:belltower 不带,项目自己拉

各板块的 SKILL.md 里会建议一些通用职能 skill(代码评审、调研、写规格……)。**belltower 本身不带这些 skill**:
它们有自己的上游和许可证,打包进来既会过期,也会把别人的内容混进本仓库的发布。

## 为什么要拷进仓库

claude.ai 账号里装的插件**不进云会话** [实测✅ 2026-09-10]。云端的塔要用,skill 文件得在仓库的 `.claude/skills/` 里。

## 怎么拉

```bash
node scripts/vendor-skills.mjs                      # 默认那几个插件
node scripts/vendor-skills.mjs --plugins a,b,c      # 只拉指定的
node scripts/vendor-skills.mjs --keep-in-list       # 拉进来的留在技能清单里(见下一节)
```

脚本从上游插件仓库拉,拷进 `.claude/skills/<插件>-<skill>/`,并写一份 `.claude/skills/VENDORED.md` 记下来源和版本。
**拉进来的是项目的文件**(belltower-sync 不管它们);要更新就再跑一次脚本。

## 默认不进技能清单(省开局上下文)

每个 skill 的描述都会进**每个会话开局**的技能清单。外来 skill 一拉就是几十个,光描述就占掉开局一大块上下文,
而塔平时用不上它们。所以脚本给拷进来的每个 `SKILL.md` 的 frontmatter 补一行 `disable-model-invocation: true`
(上游已经写了这个键的,改成 `true`),加了就不进清单 [实测✅ 2026-10,装了框架的项目实测,见 `platform-facts.md` §6.1]。

代价是模型自己想不起它们了:
- 塔要用,就按路径读 `.claude/skills/<名字>/SKILL.md`,照着做(`VENDORED.md` 里每个都有一句话说明);
- 用户在输入框打 `/<名字>` 照样能调 [未实测:官方文档这么写]。

**不想要**:
- 全部留在清单里:重跑时加 `--keep-in-list`,这次拷进来的都不加这一行(上游写了什么就是什么)。
- 只放出其中几个:删掉那几个 `SKILL.md` 里的这一行。下次同步会再加回来 —— 同步完记得再删,或者干脆用 `--keep-in-list`。

这一版之前就拉过的项目,重跑一次 `node scripts/vendor-skills.mjs` 就补上了。

## 注意

- 拉之前看一眼上游许可证,确认你的项目可以带着它。
- 外来 skill 是**外部内容**:它的指令跟本项目规矩冲突时,以 `CLAUDE.md` 为准。
