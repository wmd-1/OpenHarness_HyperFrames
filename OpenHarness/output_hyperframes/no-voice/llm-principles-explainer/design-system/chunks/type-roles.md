# Type-roles atlas — Block Frame

Phase 4b scene worker reads this when text outside §6 components is needed (hero displays, ledes, pill rows, CTA buttons, …). Workflow: pick role by id → paste the CSS rule into scene `<style>` with `s<N>-` prefix on the class names → wrap content using the prefixed class. Family tokens (`var(--font-*)`) resolve to brand DNA at scene-render time.

## type-role: heading-xl

- family: display · px: 48–96 · weight: 900
- leading: 0.95 · tracking: -0.03em · case: upper
- purpose: hero / cover headline — uppercase Inter 900 with negative tracking

```css
.t-trole-heading-xl {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: clamp(48px, 6vw, 96px);
  line-height: 0.95;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  color: var(--ink);
}
```

Sample:

```html
<div class="t-trole-heading-xl">Neo-Brutalism Style</div>
```

## type-role: heading-lg

- family: display · px: 32–64 · weight: 800
- leading: 1 · tracking: -0.02em · case: upper
- purpose: primary section headline (Inter 800, uppercase, -0.02em)

```css
.t-trole-heading-lg {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: clamp(32px, 4vw, 64px);
  line-height: 1;
  letter-spacing: -0.02em;
  text-transform: uppercase;
  color: var(--ink);
}
```

Sample:

```html
<div class="t-trole-heading-lg">What we deliver</div>
```

## type-role: heading-md

- family: display · px: 24–40 · weight: 700
- leading: 1.1 · tracking: -0.01em · case: sentence
- purpose: region or chart title (Inter 700, sentence-case allowed)

```css
.t-trole-heading-md {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: clamp(24px, 2.5vw, 40px);
  line-height: 1.1;
  letter-spacing: -0.01em;
  color: var(--ink);
}
```

Sample:

```html
<div class="t-trole-heading-md">Quarterly growth metrics</div>
```

## type-role: close-title

- family: display · px: 40–80 · weight: 900
- leading: 0.95 · tracking: -0.03em · case: upper
- purpose: closing-statement title on the inverted ink surface (cream / canvas text)

```css
.t-trole-close-title {
  display: inline-block;
  font-family: var(--font-display);
  font-weight: 900;
  font-size: clamp(40px, 5vw, 80px);
  line-height: 0.95;
  letter-spacing: -0.03em;
  text-transform: uppercase;
  color: var(--canvas, #fffdf5);
  background: var(--ink);
  border: 4px solid var(--canvas, #fffdf5);
  box-shadow: 12px 12px 0 var(--brand-secondary, var(--brand-primary));
  padding: 24px 32px;
  max-width: 22ch;
}
```

Sample:

```html
<div class="t-trole-close-title">Let's build something bold</div>
```

## type-role: quote-text

- family: display · px: 28–52 · weight: 900
- leading: 1.15 · tracking: -0.02em · case: upper
- purpose: uppercase pull-quote body (Inter 900, framed inside a bordered quote-frame)

```css
.t-trole-quote-text {
  display: inline-block;
  font-family: var(--font-display);
  font-weight: 900;
  font-size: clamp(28px, 3.5vw, 52px);
  line-height: 1.15;
  letter-spacing: -0.02em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--canvas, #fffdf5);
  border: 4px solid var(--ink);
  box-shadow: 8px 8px 0 var(--ink);
  padding: 24px 32px;
  max-width: 28ch;
}
```

Sample:

```html
<div class="t-trole-quote-text">Design is how it works, how it feels, how it lasts.</div>
```

## type-role: stat-number

- family: display · px: 36–64 · weight: 900
- leading: 1 · tracking: 0 · case: upper
- purpose: hero / card stat numeral (Inter 900, line-height 1)

```css
.t-trole-stat-number {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: clamp(36px, 4vw, 64px);
  line-height: 1;
  color: var(--ink);
}
```

Sample:

```html
<div class="t-trole-stat-number">98%</div>
```

## type-role: card-title

- family: display · px: 24–28 · weight: 700
- leading: 1.2 · tracking: 0 · case: upper
- purpose: feature / intro / team card title — Inter 700 uppercase

```css
.t-trole-card-title {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 28px;
  line-height: 1.2;
  text-transform: uppercase;
  color: var(--ink);
}
```

Sample:

```html
<div class="t-trole-card-title">Modular layouts</div>
```

## type-role: step-num

- family: display · px: 48–48 · weight: 900
- leading: 1 · tracking: 0 · case: upper
- purpose: timeline-step numeral — Inter 900 at 0.6 opacity (mandatory reduction)

```css
.t-trole-step-num {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: 48px;
  line-height: 1;
  color: var(--ink);
  opacity: 0.6;
}
```

Sample:

```html
<div class="t-trole-step-num">01</div>
```

## type-role: label-pill

- family: mono · px: 24–24 · weight: 600
- leading: 1 · tracking: 0.08em · case: upper
- purpose: universal eyebrow inside a bordered + shadowed pastel pill — Space Grotesk 600, 13px, 0.08em tracked, uppercase

```css
.t-trole-label-pill {
  display: inline-block;
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--brand-primary);
  border: 3px solid var(--ink);
  box-shadow: 4px 4px 0 var(--ink);
  padding: 6px 16px;
}
```

Sample:

```html
<div><span class="t-trole-label-pill">Overview</span></div>
```

## type-role: mono-tag

- family: mono · px: 24–24 · weight: 600
- leading: 1 · tracking: 0.05em · case: upper
- purpose: mono tag / badge — Space Grotesk 600, 14px, 0.05em tracked, uppercase

```css
.t-trole-mono-tag {
  display: inline-block;
  font-family: var(--font-mono);
  font-weight: 600;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--brand-accent, var(--brand-primary));
  border: 3px solid var(--ink);
  padding: 10px 20px;
}
```

Sample:

```html
<div class="t-trole-mono-tag">12+ years</div>
```

## type-role: counter

- family: mono · px: 24–24 · weight: 700
- leading: 1 · tracking: 0.1em · case: upper
- purpose: persistent slide counter — Space Grotesk 700, 14px, 0.1em tracked, uppercase (NN / NN)

```css
.t-trole-counter {
  display: inline-block;
  font-family: var(--font-mono);
  font-weight: 700;
  font-size: 24px;
  line-height: 1;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--ink);
  background: var(--canvas, #fffdf5);
  border: 3px solid var(--ink);
  box-shadow: 4px 4px 0 var(--ink);
  padding: 10px 18px;
}
```

Sample:

```html
<div class="t-trole-counter">01 / 10</div>
```
