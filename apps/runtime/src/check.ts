import { checkTranslations, type Messages } from "@synapse/runtime-i18n";
import { applicationLocales } from "./composition/locales.js";
import { loadConfigFile } from "./config/loader.js";
import { loadEnvFile } from "@synapse/runtime-config/node";

const [command, ...args] = process.argv.slice(2);
try {
  if (command === "i18n") {
    const namespaces = new Set<string>();
    const errors: string[] = [];
    await Promise.all(
      applicationLocales.map(async (definition) => {
        if (namespaces.has(definition.namespace)) errors.push(`Namespace conflict: ${definition.namespace}`);
        namespaces.add(definition.namespace);
        const resources = definition.resources as Record<string, () => Promise<{ default: Messages }>>;
        const canonical = (await resources[definition.canonicalLocale]!()).default;
        await Promise.all(
          Object.entries(resources).map(async ([locale, load]) => {
            for (const issue of checkTranslations(canonical, (await load()).default))
              errors.push(`${definition.namespace}/${locale}: ${issue}`);
          })
        );
      })
    );
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`国际化检查通过：${namespaces.size} 个命名空间`);
  } else if (command === "config") {
    const path = args[0];
    if (!path) throw new Error("Usage: config <path> [--env-file <path>]");
    const envIndex = args.indexOf("--env-file");
    if (envIndex >= 0) {
      const envPath = args[envIndex + 1];
      if (!envPath) throw new Error("--env-file requires a path");
      loadEnvFile(envPath);
    }
    await loadConfigFile(path);
    console.log(`配置检查通过：${path}`);
  } else throw new Error("Usage: check <config|i18n>");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
