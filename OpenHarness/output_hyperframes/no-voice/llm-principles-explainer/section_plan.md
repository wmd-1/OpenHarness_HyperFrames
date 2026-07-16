# 大模型技术原理解密

## Film Direction

**Palette system:** block-frame — #FE90E8 primary · #C0F7FE secondary · #000000 tertiary · #F7CB46 accent · #FFFFFF costume. Deco cycle: #F7CB46 · #99E885 · #C0F7FE · #FE90E8. Bold saturated backgrounds with 4px solid ink borders on cards. Hard black offset shadows (4px-6px). High contrast between light backgrounds and dark text.

**Type roles:** Inter display for headlines (bold, 48-72px), Inter body for explanatory text (24-32px, medium weight), Space Grotesk mono for technical terms (18-24px). All text left-aligned or centered on hero screens. 70% frame coverage: generous padding (80-120px), large type fills available space.

**Motion defaults + budget:** GSAP timeline, `power2.out` for entrances, `power1.inOut` for transitions. 30s total ÷ 6 scenes = ~5s each. Consistent stagger for multi-element reveals (0.12s between items). Background elements subtle pulse on entry (scale 1.02-1.00). 4px offset shadow lift on foreground cards.

**Ambient system:** Full-bleed background fills with subtle dot-grid texture from design system. Deco corner pins on content cards (from components library). Occasional star-burst accent on key terms.

**Film negative list:** No gradients that reduce contrast. No thin or light fonts below 300 weight. No muted/pastel backgrounds that wash out. No video clips or images (faceless). No decorative elements that exceed 20% of frame.

**Transition vocabulary:** `crossfade` (default 0.4s) for dissolve moments; `zoom-through` for scale transitions emphasizing macro/micro shifts; `push-slide` directional (LEFT/RIGHT) for side-content entrances; `blur-crossfade` when background colors shift dramatically.

**Visual register mix:** 70% typography-driven (large headlines + supporting body), 30% abstract visual diagrams (pulsing nodes for attention, expanding concentric rings for scale, chain-link visuals for sequential concepts). Bold infographic style throughout.

**Stillness allocation:** 0.5s pause at scene start before first element animates in. Full-reset moment at scene 3 (pre-training) midpoint to emphasize shift in scale.

---

## Scene 1: 什么是大模型

**Continuity:** break
**Transition:** crossfade 0.2s
**Duration:** 5s
**Captions offset compensation:** 0s
**Effects:** `kinetic-beat-slam` (headline impact), `center-outward-expansion` (pulsing rings), `sine-wave-loop` (ambient background breathing)
**SFX:** none

Hero opening. Centered bold headline "大模型 (LLM)" in large Inter display (72px, bold), with subtitle "AI的核心引擎" revealing 0.4s later in Inter body (36px). Background: full-bleed #C0F7FE with dot-grid pattern. A pulsing concentric circles motif radiates from behind the headline to convey "scale" — 3 circles animate opacity 0→0.3→0 in sequence (each 1.2s cycle). Below subtitle, a tagline "基于深度学习的超大规模神经网络" in Space Grotesk mono on a pill-shaped chip with #F7CB46 background. Chip slides up 0.8s after subtitle.

---

## Scene 2: Transformer架构

**Continuity:** break
**Transition:** push-slide LEFT 0.5s
**Duration:** 6s
**Captions offset compensation:** 0s
**Effects:** `svg-path-draw` (connection lines), `scale-swap-transition` (node focus shifts), `3d-text-depth-layers` (headline depth)
**SFX:** none

Headline "Transformer" top-left (48px Inter display). To the right, a node-link diagram: 3 vertical columns of circles (4 nodes each), with animated Bezier curves flowing between columns representing Self-Attention (curves animate stroke-dashoffset). Below the diagram at 3s, a text card with 4px #FE90E8 border and hard black shadow: "多头注意力 · Multi-Head Attention" + "位置编码 · Positional Encoding" — two mono terms on #F7CB46 chip backgrounds. Cards stagger in from bottom.

---

## Scene 3: 大规模预训练

**Continuity:** break
**Transition:** zoom-through 0.6s
**Duration:** 6s
**Captions offset compensation:** 0s
**Effects:** `center-outward-expansion` (data stream), `discrete-text-sequence` (concept reveals), `3d-text-depth-layers` (headline on dark bg)
**SFX:** none

Background transitions to #000000 (full black) for dramatic contrast. Headline "预训练" in white Inter display (60px). A data-stream visual: multiple columns of text snippets in Space Grotesk mono (gray #888) scroll upward at different speeds — suggesting massive text corpus. Key concepts appear with pill headers: "Next Token Prediction" / "Masked Language Model" / "语法·知识·推理". At 4.5s, a bottom banner card slides in: "掌握语言底层规律" in Inter body (#F7CB46 accent).

---

## Scene 4: 对齐与微调

**Continuity:** break
**Transition:** push-slide RIGHT 0.5s
**Duration:** 6s
**Captions offset compensation:** 0s
**Effects:** `stat-bars-and-fills` (timeline progress), `svg-path-draw` (connecting arrows), `sine-wave-loop` (step card ambient)
**SFX:** none

Light background (#FFFFFF). Vertical timeline structure: 3 steps with connecting line. Step 1: "指令微调" with subtitle "Instruction Tuning". Step 2: arrow connecting down to "奖励模型" (Reward Model). Step 3: arrow to "RLHF". Each step fades in sequentially (0-2s, 2-4s, 4-5.5s). A quote card wraps the key message "让模型输出符合人类偏好的回答" in Inter body (28px). Timeline has 4px solid border (#FE90E8) and hard 4px black offset shadow.

---

## Scene 5: 推理与思维链

**Continuity:** break
**Transition:** crossfade 0.4s
**Duration:** 5s
**Captions offset compensation:** 0s
**Effects:** `discrete-text-sequence` (word-by-word generation), `svg-path-draw` (reasoning arrows), `scale-swap-transition` (phase transition)
**SFX:** none

Phase 1 (0-2.5s): "Auto-regressive Decoding" in mono Space Grotesk (32px) at top left. A horizontal word-by-word generation animation: tokens appear left to right, each appearing with a small bounce scale (0→1). Tokens: "大 → 模型 → 正在 → 生成 → 回答". Each word on a pill chip with #C0F7FE background. Phase 2 (2.5-5s): "Chain-of-Thought" switches to a stepped reasoning diagram — 3 cards connected by arrows: "步骤1 → 步骤2 → 结论". Side panel: "KV-Cache" badge (mono, #F7CB46 background). Bottom text: "大幅提升推理效率" in Inter (28px).

---

## Scene 6: Scaling Law与未来

**Continuity:** break
**Transition:** zoom-through 0.5s
**Duration:** 4s
**Captions offset compensation:** 0s
**Effects:** `svg-path-draw` (chart curve), `kinetic-beat-slam` (final tagline impact), `sine-wave-loop` (chart point breathing)
**SFX:** none

Grand finale. Background: #FE90E8 (primary) full bleed. Center: "Scaling Law" in giant Inter display (72px, white). Below: an upward-curving line chart (abstract SVG path) with 3 labeled points: "模型 ↑", "数据 ↑", "计算 ↑" — each label scales in at 1s, 1.8s, 2.6s. At 3s, bottom line appears on a white chip with hard black shadow: "通往AGI的重要路径" (Inter body, 32px). Final 0.5s: all elements hold for a beat.