import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { gemmaDeckApiPlugin } from "./src/server/apiPlugin";

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), ""));

  return {
    plugins: [gemmaDeckApiPlugin(), react()],
    server: {
      port: 5174,
      strictPort: false
    },
    preview: {
      port: 4174,
      strictPort: false
    },
    test: {
      globals: true,
      environment: "node",
      coverage: {
        provider: "v8",
        reporter: ["text", "json-summary"],
        include: ["src/server/**/*.ts", "src/shared/**/*.ts"],
        exclude: ["src/server/apiPlugin.ts"]
      },
      exclude: ["node_modules", "dist", "tests/e2e/**"]
    }
  };
});
