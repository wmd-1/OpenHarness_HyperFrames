// 示例流程图（demo 信贷审批流程 SVG 移植为 JSX；后端接入前的静态演示图表）。

import { forwardRef } from 'react';

export const SAMPLE_DIAGRAM_NAME = '信贷审批流程.drawio';
export const SAMPLE_DIAGRAM_WIDTH = 700;
export const SAMPLE_DIAGRAM_HEIGHT = 420;

export const SampleDiagram = forwardRef<SVGSVGElement, { scale: number }>(
  function SampleDiagram({ scale }, ref) {
    return (
      <svg
        ref={ref}
        viewBox={`0 0 ${SAMPLE_DIAGRAM_WIDTH} ${SAMPLE_DIAGRAM_HEIGHT}`}
        xmlns="http://www.w3.org/2000/svg"
        fontFamily="PingFang SC, Microsoft YaHei, Helvetica Neue, sans-serif"
        style={{ maxWidth: '100%', maxHeight: '100%', transform: `scale(${scale})` }}
        role="img"
        aria-label={SAMPLE_DIAGRAM_NAME}
      >
        <defs>
          <filter id="ds">
            <feDropShadow dx="0" dy="1" stdDeviation="2" floodOpacity="0.08" />
          </filter>
          <marker id="ah" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="#9ca3af" />
          </marker>
          <marker id="ahg" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="#059669" />
          </marker>
          <marker id="ahr" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
            <path d="M0,0 L8,3 L0,6" fill="#dc2626" />
          </marker>
        </defs>
        {/* 开始 */}
        <ellipse cx="340" cy="30" rx="50" ry="20" fill="#059669" filter="url(#ds)" />
        <text x="340" y="36" textAnchor="middle" fill="#fff" fontSize="14" fontWeight="600">
          开始
        </text>
        {/* 开始→提交申请 */}
        <line x1="340" y1="50" x2="340" y2="78" stroke="#9ca3af" strokeWidth="1.5" markerEnd="url(#ah)" />
        {/* 提交贷款申请 */}
        <rect x="260" y="78" width="160" height="46" rx="8" fill="#fff" stroke="#d1d5db" strokeWidth="1" filter="url(#ds)" />
        <text x="340" y="106" textAnchor="middle" fill="#1f2937" fontSize="13">
          提交贷款申请
        </text>
        {/* 提交申请→信用评估 */}
        <line x1="340" y1="124" x2="340" y2="156" stroke="#9ca3af" strokeWidth="1.5" markerEnd="url(#ah)" />
        {/* 信用评估审核 */}
        <rect x="260" y="156" width="160" height="46" rx="8" fill="#fff" stroke="#d1d5db" strokeWidth="1" filter="url(#ds)" />
        <text x="340" y="184" textAnchor="middle" fill="#1f2937" fontSize="13">
          信用评估审核
        </text>
        {/* 信用评估→决策 */}
        <line x1="340" y1="202" x2="340" y2="232" stroke="#9ca3af" strokeWidth="1.5" markerEnd="url(#ah)" />
        {/* 评估合格? 菱形 */}
        <polygon points="340,232 400,270 340,308 280,270" fill="#fff" stroke="#1a56db" strokeWidth="1.5" filter="url(#ds)" />
        <text x="340" y="274" textAnchor="middle" fill="#1a56db" fontSize="12" fontWeight="500">
          评估合格?
        </text>
        {/* 是 → 签约放款 */}
        <line x1="340" y1="308" x2="340" y2="340" stroke="#059669" strokeWidth="1.5" markerEnd="url(#ahg)" />
        <text x="355" y="330" fill="#059669" fontSize="11" fontWeight="500">
          是
        </text>
        <rect x="260" y="340" width="160" height="46" rx="8" fill="#e8f0fe" stroke="#1a56db" strokeWidth="1" filter="url(#ds)" />
        <text x="340" y="368" textAnchor="middle" fill="#1a56db" fontSize="13" fontWeight="500">
          签约放款
        </text>
        {/* 否 → 拒绝通知 */}
        <line x1="400" y1="270" x2="480" y2="270" stroke="#dc2626" strokeWidth="1.5" markerEnd="url(#ahr)" />
        <text x="435" y="262" fill="#dc2626" fontSize="11" fontWeight="500">
          否
        </text>
        <rect x="480" y="247" width="130" height="46" rx="8" fill="#fef2f2" stroke="#dc2626" strokeWidth="1" filter="url(#ds)" />
        <text x="545" y="275" textAnchor="middle" fill="#dc2626" fontSize="13">
          拒绝通知
        </text>
        {/* 循环箭头 拒绝→提交申请 */}
        <path
          d="M545,247 L545,101 L420,101"
          stroke="#dc2626"
          strokeWidth="1.5"
          fill="none"
          strokeDasharray="5,3"
          markerEnd="url(#ahr)"
        />
        <text x="560" y="174" fill="#dc2626" fontSize="10">
          重新申请
        </text>
      </svg>
    );
  },
);
