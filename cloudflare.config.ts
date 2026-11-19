import { defineConfig } from "cf/config";

// Static, assets-only Worker. Build the folder with `npm run build:site`, deploy with `npm run deploy`.
export default defineConfig({
  worker: {
    name: "trial-screening",
    compatibilityDate: "2026-11-01",
    domains: ["screening.abhimanyusethia.com"],
  },
});
