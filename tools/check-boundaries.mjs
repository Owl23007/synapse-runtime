import { readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
const packages = ["apps", "packages"].flatMap((group) =>
  readdirSync(resolve(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const dir = resolve(root, group, entry.name);
      try {
        return [{ dir, group, ...JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8")) }];
      } catch (error) {
        if (error.code === "ENOENT") return [];
        throw error;
      }
    })
);
const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
const failures = [];
const mechanisms = new Set(["@synapse/runtime-config", "@synapse/runtime-i18n", "@synapse/runtime-user-config"]);
const graph = new Map();

function files(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}
for (const pkg of packages) {
  const dependencies = Object.keys(pkg.dependencies ?? {}).filter((name) => byName.has(name));
  graph.set(pkg.name, dependencies);
  for (const name of dependencies) {
    if (pkg.group === "packages" && byName.get(name).group === "apps")
      failures.push(`${pkg.name} depends on application ${name}`);
    if (pkg.group === "apps" && byName.get(name).group === "apps")
      failures.push(`${pkg.name} depends on another application ${name}`);
    if (pkg.name === "@synapse/runtime-client") failures.push(`Runtime client depends on implementation ${name}`);
    if (
      pkg.name === "@synapse/runtime-tui" &&
      ![
        "@synapse/runtime-client",
        "@synapse/runtime-config",
        "@synapse/runtime-user-config",
        "@synapse/runtime-i18n"
      ].includes(name)
    )
      failures.push(`TUI depends on server implementation ${name}`);
    if (mechanisms.has(pkg.name)) failures.push(`${pkg.name} infrastructure imports business package ${name}`);
    if (pkg.name === "@synapse/runtime-agent-loop" && name === "@synapse/runtime-agent-api-provider")
      failures.push("Agent loop depends on concrete HTTP provider");
  }
  if (pkg.name === "@synapse/runtime-server" && ["ink", "react"].some((name) => name in (pkg.dependencies ?? {})))
    failures.push("Runtime server depends on TUI rendering libraries");
  for (const path of files(resolve(pkg.dir, "src"))) {
    const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
    const imports = [];
    function visit(node) {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        imports.push(node.moduleSpecifier.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        imports.push(node.arguments[0].text);
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
        imports.push(node.argument.literal.text);
      ts.forEachChild(node, visit);
    }
    visit(source);
    for (const specifier of imports) {
      const label = relative(root, path).split(sep).join("/");
      if (specifier.startsWith(".")) {
        const target = resolve(dirname(path), specifier);
        if (!target.startsWith(pkg.dir + sep)) failures.push(`${label}: cross-package relative import ${specifier}`);
      } else if (specifier.startsWith("@synapse/")) {
        const name = specifier.split("/").slice(0, 2).join("/");
        if (!byName.has(name)) failures.push(`${label}: unknown workspace dependency ${name}`);
        else if (
          name !== pkg.name &&
          !(name in (pkg.dependencies ?? {})) &&
          !(path.endsWith(".test.ts") && name in (pkg.devDependencies ?? {}))
        )
          failures.push(`${label}: undeclared dependency ${name}`);
        const subpath = specifier.slice(name.length);
        if (subpath && byName.has(name) && !("." + subpath in byName.get(name).exports))
          failures.push(`${label}: unexported subpath ${specifier}`);
      }
    }
  }
}
const visited = new Set();
function visitPackage(name, chain = []) {
  if (chain.includes(name)) {
    failures.push(`Dependency cycle: ${[...chain, name].join(" -> ")}`);
    return;
  }
  if (visited.has(name)) return;
  for (const next of graph.get(name) ?? []) visitPackage(next, [...chain, name]);
  visited.add(name);
}
for (const pkg of packages) visitPackage(pkg.name);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log(`架构边界检查通过：${packages.length} 个包，无循环或跨层依赖`);
