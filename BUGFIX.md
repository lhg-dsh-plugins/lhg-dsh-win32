# 本版修复（BUGFIX）· 0.17.15 → 0.17.16

## 标题

`DecodingCollector`（`src/shell-decode.ts`）的窗口起点 `slid` 被逐次累加：输出第二次溢出窗口起，全部字节坐标错位——`nextOffset` 可超过实际输出的总字节数，增量 `readFrom()` 返回错位文本且不标 `lossy`。

## 现象与根因

该类是 win32 收集模式下为前台 shell 输出服务的解码读取器，模块头注释写明其契约：「offsets are byte coordinates into the UTF-8 text this reader serves; overflow keeps the TAIL and flags `lossy`」。

`refresh()` 在每次 `push()` 时都从**全部保留的原始字节**重新解码并重建窗口，裁剪量 `overflow = text.length - maxBytes` 是相对于当前完整文本的**绝对值**；但旧代码把每次的 `overflow` **累加**进 `slid`（`this.slid += overflow`）。于是同一段被丢弃的前缀被每个后续 push 重复计数一次：第二次溢出起 `slid` 系统性偏大，`readFrom()` 的起点判断与切片偏移随之错位，消费者按 `nextOffset` 增量读取会拿到窗口头部冒充的新数据（`lossy: false`），或在真实流尾读出并不存在的内容。

同函数的原始块保留上限（`rawCap = max(maxBytes*2, 65536)`）丢弃路径还有第二个记账缺口：已有 verdict 后丢弃的原始块从不计入 `slid`（仅 verdict 未定时写过一个 `slid = 1` 哨兵值），保留文本的真实起点被低估，效果同为错位且不标 `lossy`。

## 证据链

最小复现（离线，直接驱动 `DecodingCollector`，脚本在集成工作区 `.fixwork/win32/repro.mjs`，未入库）：窗口上限 10 字节，先后 push 16 字节与 4 字节（共 20 字节）。

修复前输出（exit 1，4 项失败）：

```
ok   first read text / nextOffset=16 / lossy=true        （首次溢出与上游既有测试一致）
FAIL incremental read text: got "ABCDEFGHIJ" expected "GHIJ"     （readFrom(16) 应只返回新增 4 字节）
FAIL incremental read nextOffset: got 26 expected 20             （nextOffset 超过实际输出的 20 字节）
FAIL from-zero nextOffset: got 26 expected 20
FAIL read at true tail: got {"text":"EFGHIJ","nextOffset":26,"lossy":false} expected {"text":"","nextOffset":20,"lossy":false}
```

修复后同一脚本 exit 0、10 项全过。新增的 3 条回归测试（`src/shell-decode.test.ts`，只新增、既有测试一字未改）在未修复代码上经 `git stash` 单独回退实现文件复跑为 3 failed / 14 passed，修复后 17/17 通过——其中一条专门覆盖 rawCap 丢块路径（maxBytes 40000、共 120000 字节分两段 push），一条覆盖 GBK 输出多次 push 的 `nextOffset` 不膨胀。

## 改动文件

- `src/shell-decode.ts`（唯一逻辑改动）：新增 `droppedTextBytes` 记账与 `textByteLength()` 辅助；丢块时把被丢原始块按当前 verdict 解码后的 UTF-8 字节数计入；`refresh()` 改为绝对重算 `slid = droppedTextBytes + overflow`（含无裁剪时归位），删除 `slid = 1` 哨兵。
- `src/shell-decode.test.ts`：新增 3 条回归测试（见上）。
- `package.json`：version 0.17.15 → 0.17.16、`repository.url` 改落点仓 `https://github.com/lhg-dsh-plugins/lhg-dsh-win32`。
- `package-lock.json`：根版本字段两处同步 0.17.16。
- `README.md`：顶部追加中文 lhg fork 头，上游原文一字未删。
- 新增 `UPSTREAM.md`、`BUGFIX.md`；`LICENSE` 与上游逐字一致。

未选 issue #89（peer 上界过窄）作为目标：上游 README/docs 已明确该窄区间是「刻意保留的旧版 bundle 边界」且有专门测试钉住（`dependency-contract.test.ts`），属维护者已表态的设计决定，与本缺陷的实锤性质不同，故未动。其余 open issue（#97/#91/#29/#18/#3 等）均为 Windows 宿主/PTY 专属行为，Linux 沙箱离线不可复现。

## 复验结果

- 复现脚本：修复前 exit 1（4 项失败）→ 修复后 exit 0（10 项全过）。
- `npm run typecheck`：退出 0。
- 全量 `npx vitest run`：276 passed / 0 failed（基线 273 + 新增 3），唯一失败的测试**文件**是 `src/spawn.test.ts`——其依赖的 `node-pty` 原生模块在本沙箱安装时下载失败、整文件加载即报错，基线与修复后逐字一致，属环境伪影、与本修复无关。

## 验证边界

- 丢块记账按丢弃时点的 verdict 解码被丢字节：若某多字节字符恰好跨在丢块边界上，被丢侧与保留侧各产生一个替换字符，坐标在接缝处可有至多约 3 字节的近似；verdict 若在丢块后由 `unknown` 翻转为 legacy 编码，先前丢块按 UTF-8 计的字节数亦不再精确。两种情形都只发生在超过 rawCap（≥64KB）的长输出接缝处，窗口内容本身不受影响。
- 本缺陷与修复均在平台无关的纯逻辑层验证（`DecodingCollector` 在 Linux 上与上游测试同跑）；win32 宿主内的端到端收集路径未在真实 Windows/DSH 宿主复验。
