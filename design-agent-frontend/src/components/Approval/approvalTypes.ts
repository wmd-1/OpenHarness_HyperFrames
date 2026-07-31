// 审批组件共享类型。

import type { ApprovalReply } from '../../types/ws';

/** 审批决策回调：allowed + reply（permission/edit_diff）或 answer（question）。 */
export type ApprovalDecision = (allowed: boolean, reply?: ApprovalReply, answer?: string) => void;
