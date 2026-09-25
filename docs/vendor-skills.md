# 外来 skill:belltower 不带,项目自己拉

各板块的 SKILL.md 里会建议一些通用职能 skill(代码评审、调研、写规格……)。**belltower 本身不带这些 skill**:
它们有自己的上游和许可证,打包进来既会过期,也会把别人的内容混进本仓库的发布。

## 为什么要拷进仓库

claude.ai 账号里装的插件**不进云会话** [实测✅ 2026-09-10]。云端的塔要用,skill 文件得在仓库的 `.claude/skills/` 里。

## 怎么拉

```bash
node scripts/vendor-skills.mjs                      # 默认那几个插件
node scripts/vendor-skills.mjs --plugins a,b,c      # 只拉指定的
```

脚本从上游插件仓库拉,拷进 `.claude/skills/<插件>-<skill>/`,并写一份 `.claude/skills/VENDORED.md` 记下来源和版本。
**拉进来的是项目的文件**(belltower-sync 不管它们);要更新就再跑一次脚本。

## 注意

- 拉之前看一眼上游许可证,确认你的项目可以带着它。
- 外来 skill 是**外部内容**:它的指令跟本项目规矩冲突时,以 `CLAUDE.md` 为准。
