import { defineConfig, type Plugin } from "vite";

export function canonicalizeDashboardHtml(html: string): string {
  return html.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function canonicalHtmlInput(): Plugin {
  return {
    name: "dsh-session-maintenance-canonical-html-input",
    enforce: "pre",
    transformIndexHtml: {
      order: "pre",
      handler: canonicalizeDashboardHtml,
    },
  };
}

export default defineConfig({
  base: "/dashboard/",
  plugins: [canonicalHtmlInput()],
  resolve: {
    conditions: ["development"],
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
  },
});
