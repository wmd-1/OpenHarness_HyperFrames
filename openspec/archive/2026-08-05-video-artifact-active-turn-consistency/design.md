# Design: 多轮产物预览轮次一致性（activeTurn 单一权威）

## 1. 当前问题 / 症状证据

J5 E2E（`real-multiturn-artifact.spec.ts`）在两轮 `submit` 后：
- 切换条渲染出 `第 1 轮` / `第 2 轮` 两个 tab（✅ 多轮切换条存在）；
- `第 2 轮` tab `aria-selected="true"`（✅ 在第 44 行断言前一度成立）；
- **但** `video` `src` 实测为 `turns/0/artifact`（应为 `turns/1/artifact`）→ 第 44 行断言失败。

后端诊断已证明两轮产物均正确抵达（`has_artifact=true`），故该失败是纯前端 `activeTurn` 状态未可靠推进到最新轮所致。

## 2. 根因（派生状态由两个异步来源推导，且对时序敏感）

`activeTurn` 并非独立输入状态，而是由**两个异步来源共同推导的派生状态**：

- **turn lifecycle 来源**：`conversation.turnActive`（轮开始/结束边界，随 `turn_complete` 帧变化）；
- **artifact 来源**：`latestArtifact`（`artifactTurns` 的最后一个元素，每完成一轮带产物时更新）。

`VideoModulePage.tsx:183-193` 用一个 effect 把这两个来源合并成 `activeTurn`，但其合并规则**对到达时序敏感**——它依赖 `turnActive` 的「起始快照」（`turnStartArtifactRef`）与「结束边界」（`prevActiveRef`）来判定是否推进，而这两个来源的更新在异步渲染中是**解耦、可乱序**的。当 `turn_complete`（turnActive=false）与 artifact 消息（latestArtifact 0→1）未按 effect 内部假设的「先消息后边界」到达时，守卫 `latestArtifact !== turnStartArtifactRef.current` 会被旧快照「吃掉」，导致 `activeTurn` 从未被推进到最新轮，停在首轮索引 0。

```ts
const prevActiveRef = useRef(false);
const turnStartArtifactRef = useRef<number | null>(null);
useEffect(() => {
  if (!prevActiveRef.current && conversation.turnActive) {
    turnStartArtifactRef.current = latestArtifact;        // 轮开始快照
  } else if (prevActiveRef.current && !conversation.turnActive) {
    if (latestArtifact !== null && latestArtifact !== turnStartArtifactRef.current) {
      setActiveTurn(latestArtifact);                       // 仅在「结束边界 + 与开始快照不同」时推进
      setPreviewOpen(true);
    }
  }
  prevActiveRef.current = conversation.turnActive;
}, [conversation.turnActive, latestArtifact]);
```

两种到达顺序下的表现（关键不在 commit 顺序本身，而在**派生状态对来源时序敏感**这一结构缺陷）：

- **到达顺序 A（artifact 先到）**：commit1 `latestArtifact=1, turnActive=true` → 两分支均不触发；commit2 `turnActive=false, latestArtifact=1` → `1 !== 0` → `setActiveTurn(1)` ✅
- **到达顺序 B（turnActive 先到）**：commit1 `turnActive=false, latestArtifact=0` → `else-if` 触发但 `0 !== 0` 为 false → **不更新**，且 `prevActiveRef` 被置 false；commit2 `latestArtifact=1, turnActive=false` → `prevActiveRef=false` → 两分支均不触发 → **`activeTurn` 永远停在 0** ❌

实际 E2E 命中顺序 B（或混合态），致 `activeTurn` 停在首轮索引 0，预览播第 1 轮。因为 `VideoPreviewPanel` 的 tab 与 `src` 皆由 `activeTurn` 派生，二者「内部自洽」地都显示第 1 轮，但违背了「默认选中最新轮 / tab↔src 一致」契约（用户视角：第 2 轮已存在，却没被选中、视频也是旧的）。

## 3. 状态机契约（before / after）

**Before（缺陷态）**
```
turn_complete(N) → turnActive=false, artifactTurns=[0..N]
                    activeTurn 由两个异步来源推导且对到达时序敏感 → 可能 = 0（首轮）
VideoPreviewPanel: tab selected = (turn===activeTurn), src = turns/{activeTurn}/artifact
                    ⇒ 显示第 1 轮，与「第 N 轮已存在且应默认选中」矛盾
```

**After（目标态）**
```
activeTurn 解析优先级（高→低）：
  1. 用户显式点击某 tab（pinned） → activeTurn = 该轮，不被自动逻辑覆盖
  2. 会话首屏（无手动钉选）       → activeTurn = artifactTurns 最后元素（最新）
  3. 新 artifact 到达且未 pinned   → activeTurn 自动收敛到 latestArtifact（最新）
  否则（已 pinned 旧轮）          → 保持钉选，直到新轮完成重评估
turn_complete(N) 后：activeTurn 必然 = N（最新），与两个异步来源到达顺序无关
VideoPreviewPanel: tab selected 与 src 同源于 activeTurn ⇒ 必然一致
```

### 派生优先级（高 → 低）

1. **用户主动选择历史轮次 > 自动跟随最新轮次**：用户显式点击某历史轮次（pinned）→ `activeTurn = 该轮`，不被后续自动逻辑覆盖，直到新 artifact 到达按规则 3 重评估。
2. **首次进入默认最新 artifact**：会话首屏（无手动钉选）预览默认选中 `artifactTurns` 最后元素（最新产物轮），不滞留首轮。
3. **新 artifact 到达且未 pinned 时自动切换最新**：`latestArtifact` 推进且用户当前未钉选历史轮次 → `activeTurn` 自动收敛到该最新轮；若已钉选旧轮则保持，待新轮完成（规则 3）重评估。

## 4. 修复设计（最小、可单测）

将「当前预览轮次」收敛为**单一权威状态 `activeTurn`**，并以**不依赖两个异步来源到达时序**的纯函数规则推进：

1. **抽取纯函数**（便于单测，彻底消除组件内时序耦合）：
   ```ts
   // 返回应预览的轮次；pinned=false 时回退最新轮
   function resolveActiveTurn(
     current: number | null,
     artifactTurns: number[],
     pinned: boolean,
   ): number | null {
     if (artifactTurns.length === 0) return null;
     if (pinned && current !== null && artifactTurns.includes(current)) return current;
     return artifactTurns[artifactTurns.length - 1]; // 最新轮
   }
   ```
2. **替换时序敏感的脆弱 effect**：用只依赖 `artifactTurns`/`latestArtifact` 的 effect 驱动 `activeTurn`（彻底消除对 turn lifecycle 与 artifact 两个来源到达时序的耦合）：
   - 预览首次可播放（≥1 artifact）且 `activeTurn==null` → 置为 `latestArtifact`（默认最新，遵循优先级规则 2）。
   - 每当 `latestArtifact` 变化（新轮完成）且用户未手动钉选旧轮 → 推进 `activeTurn=latestArtifact`（遵循优先级规则 3）。
   - 用户点击 tab → `onSelectTurn(turn)` 置 `activeTurn=turn` 并标记 pinned（遵循优先级规则 1，旧轮也可选且不被后续自动推进覆盖，直到新轮完成后再按 pinned 规则重评估——见 §6）。
3. **保留 `VideoPreviewPanel` 不变**：其 `aria-selected={turn===activeTurn}` 与 `src=artifactStreamUrl(sid, activeTurn)` 已正确同源；修复后自动满足 spec 的 tab↔src 一致 Invariant。
4. **不引入 session-service 改动**；不改 `artifactStreamUrl` 签名与 `turns/{i}/artifact` 地址格式。

## 5. 回归 / E2E 测试计划

- **组件/单元（新增 `videoPreviewActiveTurn.test.tsx`，vitest + testing-library，无浏览器）：**
  - 纯函数 `resolveActiveTurn`：artifactTurns=[0,1]、pinned=false → 1；pinned=true 且 current=0 → 0；空数组 → null。
  - **真实失败路径（乱序到达收敛）**：`resolveActiveTurn(current=0, artifactTurns=[0,1], pinned=false)` → **必须返回 1**。该输入等价「turn_complete 与 artifactTurns 更新乱序、历史派生曾因时序停在首轮（current=0）但最新 artifact 已就位（artifactTurns=[0,1]）」，锁定「乱序下 activeTurn 仍必须收敛到 latest artifact（最新轮）」不变量，防止本 defect 回归。
  - `VideoPreviewPanel` props `artifactTurns=[0,1], activeTurn=1` → `video` `src` 含 `turns/1/artifact`；`第 2 轮` tab `aria-selected="true"`、`第 1 轮` `aria-selected="false"`（**锁定「选中第2轮 ⇒ src=turns/1」契约**）。
  - `VideoPreviewPanel` props `artifactTurns=[0,1], activeTurn=0` → `src` 含 `turns/0/artifact`、第 1 轮 selected（sanity）。
- **E2E（复用 `real-multiturn-artifact.spec.ts`）：** 两轮 submit 后断言「第 2 轮 selected + video src=turns/1」，及点击第 1 轮回切正确。修复后必须 PASS，作为本 change 的 E2E 回归。

## 6. 边界 / 并发考量

- **历史回显 / 切会话**：`currentId` 变化时 `activeTurn` 归 null（`VideoModulePage:148-152` 既有逻辑保留）；回显后首个 artifact 出现即默认最新轮。
- **手动钉选旧轮**：点第 1 轮后 `activeTurn=0` 且 pinned；新轮（第 3 轮）完成 → `latestArtifact=2` 且未钉选于最新 → 自动推进到 2（符合「新产出默认聚焦最新」直觉）。钉选态可用 `useRef`/state 记录，仅在同一会话内有效。
- **重连 replay**：`turnActive` 在 replay 期间语义不变，新轮完成后仍走 `latestArtifact` 规则，不触发历史重置。
- **单轮场景**：artifactTurns=[0] → activeTurn=0，行为不变。
- **无产物轮**：artifactTurns=[] → activeTurn=null，预览占位（既有）。
