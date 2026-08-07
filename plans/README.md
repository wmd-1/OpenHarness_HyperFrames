<!-- 最后更新：2026-08-03 -->

# plans — 实施计划文档

各项功能/整改的实施计划（plan），与 OpenSpec 变更（`openspec/changes/`）
配套：plan 描述执行路线与里程碑，spec 描述能力契约。

## 目录约定

```
plans/
├── <Topic>_Plan_<YYYY-MM-DD>.md   # 进行中的计划
└── archive/                        # 已完成/已过期计划的归档
```

- 计划完成或废弃后移入 `archive/`，不删除（保留决策轨迹）；
- 当前进行中：
- 已归档（`archive/`）：

  - `Design_Agent_Frontend_Modal_Layout_Plan_2026-08-02.md`（提示框/模态框布局间距整改，对应 openspec `design-frontend-modal-layout`，2026-08-02 实施完成并归档）
  - 

  - `Design_Agent_Frontend_Architecture_v2_2026-07-31.md`（设计前端架构 v2）
  - `Design_Agent_Frontend_Four_Modules_Plan_2026-07-31.md`（四大模块建设方案）
  - `Design_Agent_Frontend_Layout_Abstraction_Plan_2026-08-03.md`（v2 收敛第一阶段：ModalShell + DrawerShell 公共原语 + z-index/a11y 修复；DetailLayout/Card/断点统一拆为后续独立立项，见附录 B/C/D）
