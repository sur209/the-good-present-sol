process.env.ASTRO_TELEMETRY_DISABLED ??= "1";
await import(new URL("./bin/astro.mjs", import.meta.resolve("astro/package.json")).href);
