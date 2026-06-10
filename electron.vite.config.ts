import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/main/index.ts")
      }
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/preload/index.ts"),
        output: {
          format: "cjs",
          entryFileNames: "index.cjs"
        }
      }
    }
  },
  renderer: {
    root: __dirname,
    plugins: [react()],
    publicDir: "logo",
    server: {
      host: "127.0.0.1",
      port: 5000,
      strictPort: false
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, "index.html"),
        output: {
          manualChunks(id) {
            if (id.includes("node_modules/monaco-editor") || id.includes("node_modules/@monaco-editor")) return "monaco";
            if (id.includes("node_modules/@xyflow")) return "react-flow";
            if (
              id.includes("node_modules/react/") ||
              id.includes("node_modules/react-dom/") ||
              id.includes("node_modules/zustand/") ||
              id.includes("node_modules/lucide-react/")
            ) return "vendor";
            return undefined;
          }
        }
      }
    }
  }
});
