import type { Config } from 'tailwindcss';

// Tailwind CSS 4 uses CSS-first configuration (see src/index.css @theme).
// This file only pins content globs + dark-mode strategy for tooling.
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: ['selector', '[data-theme="dark"]'],
} satisfies Config;
