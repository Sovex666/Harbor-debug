// Benchmark-only Vite config. Source edits made while a run is in progress
// must not hot-reload the page being measured, and the dev server's own
// startup cost is kept out of the run: Tailwind scans only the app's sources
// instead of the whole repository, and no file watcher is created.
import { mergeConfig, type ConfigEnv, type Plugin } from "vite";
import base from "../../vite.config";

const tailwindAppSources: Plugin = {
  name: "benchmark-tailwind-app-sources",
  enforce: "pre",
  transform(code, id) {
    if (!/[\\/]src[\\/]index\.css$/.test(id.split("?")[0])) return null;
    return code.replace(
      '@import "tailwindcss";',
      '@import "tailwindcss" source("./");\n@source "../index.html";\n@source "../index-tv.html";',
    );
  },
};

export default (env: ConfigEnv) => {
  const config = mergeConfig(typeof base === "function" ? base(env) : base, {
    server: { hmr: false },
    plugins: [tailwindAppSources],
  });
  // mergeConfig skips null values, so the watcher is disabled directly.
  config.server = { ...config.server, watch: null };
  return config;
};
