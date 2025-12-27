import type { Config } from "tailwindcss";

export default {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        panel: "rgba(var(--panel-rgb), <alpha-value>)",
      },
    },
  },
  plugins: [],
} satisfies Config;
