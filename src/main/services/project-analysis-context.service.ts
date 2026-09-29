import type { SourceSnapshot } from "./source-snapshot.service";
import { createRequire } from "node:module";
import { readFile, realpath } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, posix, relative, sep } from "node:path";
import type * as TypeScript from "typescript";
import type { AnalysisLanguage, AnalysisScope, PackageExport, ProjectAnalysisContext, SemanticDiagnostic, WorkspacePackage } from "../../types";

const require = createRequire(import.meta.url);
const CONFIGURATION_NAME = /^(?:package\.json|(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json|pnpm-workspace\.yaml|pyproject\.toml|setup\.(?:py|cfg)|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|go\.(?:mod|work))$/;

export class AnalysisConfigurationError extends Error {
  constructor(path: string, detail: string, cause: unknown) {
    super(`Static analysis configuration is invalid: ${path}: ${detail}`, { cause });
    this.name = "AnalysisConfigurationError";
  }
}

/** Discovers only scanned configuration and source files; never executes project code. */
export async function discoverProjectAnalysisContext(rootPath: string, projectPaths: string[], snapshot?: SourceSnapshot): Promise<ProjectAnalysisContext> {
  const paths = [...projectPaths].sort();
  const canonicalRoot = await realpath(rootPath);
  const configurationPaths = paths.filter((path) => CONFIGURATION_NAME.test(posix.basename(path)));
  const configuration = new Map<string, Record<string, unknown>>();
  const diagnostics: SemanticDiagnostic[] = [];
  for (const path of configurationPaths) {
    const content = snapshot ? snapshot.read(join(rootPath, path)) : await readFile(join(rootPath, path), "utf8");
    if (content === undefined) throw new Error(`Missing configuration snapshot: ${path}`);
    if (path.endsWith("package.json")) configuration.set(path, parseObjectJson(path, content));
    else if (path.endsWith("pnpm-workspace.yaml")) configuration.set(path, parseYaml(path, content));
    else if (path.endsWith("pyproject.toml")) configuration.set(path, parsePythonConfiguration(path, content));
    else if (path.endsWith("pom.xml")) configuration.set(path, parseMavenConfiguration(path, content));
    else if (/go\.(?:mod|work)$/.test(path)) configuration.set(path, parseGoConfiguration(path, content));
    else if (/\.gradle(?:\.kts)?$/.test(path)) configuration.set(path, parseGradleConfiguration(path, content, diagnostics));
    else if (path.endsWith("setup.py")) diagnostics.push({ code: "dynamic-python-configuration", severity: "warning", filePath: path, message: "setup.py is executable configuration and is not executed. Only explicit source roots and source-level package bindings are analyzed." });
  }
  const ts = require("typescript") as typeof TypeScript;
  const compilerConfigurations = new Map<string, TypeScript.ParsedCommandLine>();
  for (const path of configurationPaths.filter((candidate) => /(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json$/.test(posix.basename(candidate)))) {
    const result = ts.getParsedCommandLineOfConfigFile(join(rootPath, path), {}, {
      ...(snapshot?.system ?? ts.sys),
      onUnRecoverableConfigFileDiagnostic: (error) => { throw compilerConfigurationError(ts, path, [error]); }
    });
    if (!result) throw new AnalysisConfigurationError(path, "TypeScript configuration could not be read", undefined);
    const errors = result.errors.filter((error) => error.code !== 18003 && error.code !== 18002);
    if (errors.length > 0) throw compilerConfigurationError(ts, path, errors);
    compilerConfigurations.set(path, result);
    const source = result.options.configFile;
    const inheritedPaths = source && typeof source === "object" && "extendedSourceFiles" in source ? stringArray(source.extendedSourceFiles) : [];
    for (const extended of inheritedPaths) {
      const extendedPath = relative(rootPath, extended).split(sep).join("/");
      if (!configurationPaths.includes(extendedPath)) configurationPaths.push(extendedPath);
    }
  }
  const packages: WorkspacePackage[] = [];
  for (const [manifestPath, manifest] of configuration) {
    if (!manifestPath.endsWith("package.json")) continue;
    if (manifest.name !== undefined && typeof manifest.name !== "string") throw new AnalysisConfigurationError(manifestPath, "package name must be a string", undefined);
    if (typeof manifest.name !== "string") continue;
    const packageRoot = cleanRoot(posix.dirname(manifestPath));
    const configPath = preferredCompilerConfiguration(packageRoot, compilerConfigurations);
    const config = configPath ? compilerConfigurations.get(configPath) : undefined;
    const exports = manifest.exports;
    if (exports !== undefined && !isPackageExport(exports)) throw new AnalysisConfigurationError(manifestPath, "package exports contains unsupported values", undefined);
    const workspaceRoot = nearestWorkspaceRoot(packageRoot, configuration);
    packages.push({
      name: manifest.name, rootPath: packageRoot, manifestPath, workspaceRoot,
      exports: exports as PackageExport | undefined,
      main: optionalString(manifest.main, manifestPath, "main"),
      types: optionalString(manifest.types ?? manifest.typings, manifestPath, "types"),
      dependencies: dependencyNames(manifest, manifestPath),
      sourceRoot: config?.options.rootDir ? insideWorkspace(rootPath, config.options.rootDir, configPath!, canonicalRoot) : undefined,
      outputRoot: config?.options.outDir ? insideWorkspace(rootPath, config.options.outDir, configPath!, canonicalRoot) : undefined,
      configurationPath: configPath
    });
  }
  const scopes: AnalysisScope[] = [];
  for (const language of ["typescript", "python", "java", "go"] as const) {
    const sourcePaths = paths.filter((path) => sourceLanguage(path) === language);
    const roots = languageRoots(language, configurationPaths, sourcePaths);
    const filesByRoot = new Map<string, string[]>();
    for (const path of sourcePaths) {
      const root = nearestRoot(path, roots) ?? "";
      filesByRoot.set(root, [...(filesByRoot.get(root) ?? []), path]);
    }
    for (const [scopeRoot, scopedPaths] of filesByRoot) {
      const configs = configurationPaths.filter((path) => cleanRoot(posix.dirname(path)) === scopeRoot);
      const packageManifest = packages.find((candidate) => candidate.rootPath === scopeRoot);
      const python = configuration.get(posix.join(scopeRoot, "pyproject.toml"));
      const maven = configuration.get(posix.join(scopeRoot, "pom.xml"));
      const gradle = [...configuration.entries()].find(([path]) => cleanRoot(posix.dirname(path)) === scopeRoot && /build\.gradle/.test(path))?.[1];
      const go = configuration.get(posix.join(scopeRoot, "go.mod"));
      const sourceRoots = language === "python" ? pythonSourceRoots(scopeRoot, python, scopedPaths)
        : language === "java" ? javaSourceRoots(scopeRoot, maven, gradle)
        : language === "typescript" && packageManifest?.sourceRoot ? [packageManifest.sourceRoot]
        : [scopeRoot];
      scopes.push({
        id: `${language}:${scopeRoot || "."}`, language, rootPath: scopeRoot,
        sourceRoots, paths: scopedPaths, configurationPaths: configs,
        packageName: language === "go" ? stringValue(go?.module) : language === "java" ? mavenCoordinate(maven) ?? `gradle:${scopeRoot}` : packageManifest?.name,
        dependencies: language === "go" ? goDependencies(scopeRoot, go, configuration) : language === "java" ? javaDependencies(scopeRoot, maven, gradle, configuration) : packageManifest?.dependencies
      });
    }
  }
  return { scopes: scopes.sort((a, b) => a.id.localeCompare(b.id)), packages: packages.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath)), configurationPaths: [...configurationPaths].sort(), diagnostics };
}

function parseObjectJson(path: string, content: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(content);
    if (!isObject(value)) throw new TypeError("configuration must be an object");
    return value;
  } catch (error) { throw new AnalysisConfigurationError(path, errorMessage(error), error); }
}

function parseYaml(path: string, content: string): Record<string, unknown> {
  const lines = content.split(/\r?\n/);
  const packages: string[] = [];
  let inPackages = false;
  let foundPackages = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = stripYamlComment(lines[index]).trimEnd();
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      inPackages = /^packages\s*:\s*(?:#.*)?$/.test(line);
      if (inPackages) {
        if (foundPackages) throw new AnalysisConfigurationError(path, "duplicate packages key", undefined);
        foundPackages = true;
      }
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s+-\s+(.+?)\s*$/)?.[1];
    if (!item) throw new AnalysisConfigurationError(path, `unsupported packages entry at line ${index + 1}`, undefined);
    try { packages.push(parseYamlString(item)); }
    catch (error) { throw new AnalysisConfigurationError(path, `packages entry at line ${index + 1}: ${errorMessage(error)}`, error); }
  }
  if (!foundPackages) throw new AnalysisConfigurationError(path, "workspace packages must be declared as a string list", undefined);
  return { packages };
}

function parsePythonConfiguration(path: string, content: string): Record<string, unknown> {
  try { return parseStaticToml(content); }
  catch (error) { throw new AnalysisConfigurationError(path, errorMessage(error), error); }
}

function parseMavenConfiguration(path: string, content: string): Record<string, unknown> {
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new AnalysisConfigurationError(path, "DTD and entity declarations are not supported", undefined);
  try {
    const document = parseStaticXml(content);
    if (!isObject(document.project)) throw new TypeError("Maven configuration must contain a project");
    return document.project;
  } catch (error) { throw new AnalysisConfigurationError(path, errorMessage(error), error); }
}

function stripYamlComment(line: string): string {
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "'" && character === "'" && line[index + 1] === "'") { index += 1; continue; }
    if (quote && character === quote && (quote === "'" || line[index - 1] !== "\\")) { quote = ""; continue; }
    if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
    if (!quote && character === "#" && (index === 0 || /\s/.test(line[index - 1]))) return line.slice(0, index);
  }
  if (quote) throw new TypeError("unterminated YAML string");
  return line;
}

function parseYamlString(value: string): string {
  if (value.startsWith("\"") && value.endsWith("\"")) return JSON.parse(value) as string;
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
  if (/^[&*!|>@`{[\],]/.test(value) || /:\s/.test(value)) throw new TypeError("workspace package must be a plain or quoted string");
  return value;
}

function parseStaticToml(content: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let table: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    let line = stripTomlComment(lines[index]).trim();
    if (!line) continue;
    const arrayHeader = line.match(/^\[\[([^\]]+)\]\]$/);
    if (arrayHeader) { table = ensureTomlArrayTable(root, parseTomlKey(arrayHeader[1])); continue; }
    const header = line.match(/^\[([^\]]+)\]$/);
    if (header) { table = parseTomlKey(header[1]); ensureTomlTable(root, table); continue; }
    if (line.startsWith("[") || line.endsWith("]")) throw new TypeError(`invalid table at line ${index + 1}`);
    const separator = findTomlSeparator(line, "=");
    if (separator < 1) throw new TypeError(`expected key-value pair at line ${index + 1}`);
    const key = parseTomlKey(line.slice(0, separator).trim());
    let valueText = line.slice(separator + 1).trim();
    while (!tomlValueComplete(valueText)) {
      index += 1;
      if (index >= lines.length) throw new TypeError(`unfinished value at line ${index}`);
      valueText += `\n${stripTomlComment(lines[index]).trim()}`;
    }
    const parent = ensureTomlTable(root, table);
    setTomlValue(parent, key, parseTomlValue(valueText), index + 1);
  }
  return root;
}

function stripTomlComment(line: string): string {
  let quote = "";
  let triple = false;
  for (let index = 0; index < line.length; index += 1) {
    if (!quote && line.slice(index, index + 3) === "\"\"\"") { quote = '"'; triple = true; index += 2; continue; }
    if (!quote && line.slice(index, index + 3) === "'''" ) { quote = "'"; triple = true; index += 2; continue; }
    const character = line[index];
    if (quote && triple && line.slice(index, index + 3) === `${quote}${quote}${quote}`) { quote = ""; triple = false; index += 2; continue; }
    if (quote && !triple && character === quote && (quote === "'" || line[index - 1] !== "\\")) { quote = ""; continue; }
    if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
    if (!quote && character === "#") return line.slice(0, index);
  }
  return line;
}

function parseTomlKey(value: string): string[] {
  if (!value.trim()) throw new TypeError(`unsupported TOML key: ${value}`);
  const keys = value.split(".").map((part) => {
    const key = part.trim();
    const quoted = key.match(/^(?:"([^"]*)"|'([^']*)')$/);
    return quoted ? quoted[1] ?? quoted[2] : key;
  });
  if (!keys.length || keys.some((key) => key !== "" && !/^[\w-]+$/.test(key))) throw new TypeError(`unsupported TOML key: ${value}`);
  return keys;
}

function ensureTomlTable(root: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  let current = root;
  for (const key of keys) {
    const value = current[key];
    if (value === undefined) current[key] = {};
    else if (Array.isArray(value)) {
      const latest = value.at(-1);
      if (!isObject(latest)) throw new TypeError(`TOML array table has no current entry: ${keys.join(".")}`);
      current = latest;
      continue;
    }
    else if (!isObject(value)) throw new TypeError(`TOML table conflicts with value: ${keys.join(".")}`);
    current = current[key] as Record<string, unknown>;
  }
  return current;
}

function ensureTomlArrayTable(root: Record<string, unknown>, keys: string[]): string[] {
  const name = keys.at(-1);
  if (!name) throw new TypeError("TOML array table name is empty");
  const parent = ensureTomlTable(root, keys.slice(0, -1));
  const value = parent[name];
  if (value === undefined) parent[name] = [];
  else if (!Array.isArray(value)) throw new TypeError(`TOML array table conflicts with value: ${keys.join(".")}`);
  (parent[name] as unknown[]).push({});
  return keys;
}

function setTomlValue(root: Record<string, unknown>, keys: string[], value: unknown, line: number): void {
  const parent = ensureTomlTable(root, keys.slice(0, -1));
  const key = keys.at(-1)!;
  if (parent[key] !== undefined) throw new TypeError(`duplicate TOML key ${keys.join(".")} at line ${line}`);
  parent[key] = value;
}

function tomlValueComplete(value: string): boolean {
  let quote = "";
  let triple = false;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    if (!quote && (value.slice(index, index + 3) === "\"\"\"" || value.slice(index, index + 3) === "'''")) { quote = value[index]; triple = true; index += 2; continue; }
    const character = value[index];
    if (quote && triple && value.slice(index, index + 3) === `${quote}${quote}${quote}`) { quote = ""; triple = false; index += 2; continue; }
    if (quote && !triple && character === quote && (quote === "'" || value[index - 1] !== "\\")) { quote = ""; continue; }
    if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
    if (!quote && (character === "[" || character === "{")) depth += 1;
    if (!quote && (character === "]" || character === "}")) depth -= 1;
  }
  return !quote && depth === 0;
}

function parseTomlValue(value: string): unknown {
  const text = value.trim();
  if ((text.startsWith("\"\"\"") && text.endsWith("\"\"\"")) || (text.startsWith("'''") && text.endsWith("'''"))) return text.slice(3, -3);
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text[0] === '"' ? JSON.parse(text) as string : text.slice(1, -1);
  }
  if (text.startsWith("[")) {
    if (!text.endsWith("]")) throw new TypeError(`invalid TOML array: ${text}`);
    const body = text.slice(1, -1).trim();
    return body ? splitTomlValues(body).filter(Boolean).map(parseTomlValue) : [];
  }
  if (text.startsWith("{")) {
    if (!text.endsWith("}")) throw new TypeError(`invalid TOML inline table: ${text}`);
    const object: Record<string, unknown> = {};
    for (const entry of splitTomlValues(text.slice(1, -1))) {
      if (!entry.trim()) continue;
      const separator = findTomlSeparator(entry, "=");
      if (separator < 1) throw new TypeError(`invalid TOML inline table entry: ${entry}`);
      setTomlValue(object, parseTomlKey(entry.slice(0, separator).trim()), parseTomlValue(entry.slice(separator + 1)), 0);
    }
    return object;
  }
  if (text === "true") return true;
  if (text === "false") return false;
  if (/^[+-]?(?:\d[\d_]*)(?:\.\d[\d_]*)?(?:[eE][+-]?\d[\d_]*)?$/.test(text)) return Number(text.replaceAll("_", ""));
  if (!text || /[\[\]{}]/.test(text)) throw new TypeError(`unsupported TOML value: ${text}`);
  return text;
}

function splitTomlValues(value: string): string[] {
  const values: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote && character === quote && (quote === "'" || value[index - 1] !== "\\")) { quote = ""; continue; }
    if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
    if (!quote && (character === "[" || character === "{")) depth += 1;
    if (!quote && (character === "]" || character === "}")) depth -= 1;
    if (!quote && depth === 0 && character === ",") { values.push(value.slice(start, index).trim()); start = index + 1; }
  }
  values.push(value.slice(start).trim());
  return values;
}

function findTomlSeparator(value: string, separator: string): number {
  let quote = "";
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote && character === quote && (quote === "'" || value[index - 1] !== "\\")) { quote = ""; continue; }
    if (!quote && (character === "'" || character === '"')) { quote = character; continue; }
    if (!quote && (character === "[" || character === "{")) depth += 1;
    if (!quote && (character === "]" || character === "}")) depth -= 1;
    if (!quote && depth === 0 && character === separator) return index;
  }
  return -1;
}

type XmlNode = { name: string; text: string; children: Map<string, XmlNode[]> };

function parseStaticXml(content: string): Record<string, unknown> {
  const root: XmlNode = { name: "", text: "", children: new Map() };
  const stack = [root];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?[\w:.-]+(?:\s+(?:"[^"]*"|'[^']*'|[^'">])*)?\s*\/?>/g;
  let cursor = 0;
  for (const match of content.matchAll(tokens)) {
    const token = match[0];
    const index = match.index ?? 0;
    const between = content.slice(cursor, index);
    if (between.includes("<")) throw new TypeError("malformed XML text");
    stack.at(-1)!.text += decodeXmlText(between);
    cursor = index + token.length;
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("<![CDATA[")) { stack.at(-1)!.text += token.slice(9, -3); continue; }
    const closing = token.match(/^<\/([\w:.-]+)\s*>$/);
    if (closing) {
      if (stack.length === 1 || stack.at(-1)!.name !== localXmlName(closing[1])) throw new TypeError(`mismatched XML closing tag ${closing[1]}`);
      stack.pop();
      continue;
    }
    const opening = token.match(/^<([\w:.-]+)(?:\s[^>]*)?\s*(\/?)>$/);
    if (!opening) throw new TypeError(`unsupported XML token ${token.slice(0, 80)}`);
    const node: XmlNode = { name: localXmlName(opening[1]), text: "", children: new Map() };
    const parent = stack.at(-1)!;
    parent.children.set(node.name, [...(parent.children.get(node.name) ?? []), node]);
    if (!opening[2]) stack.push(node);
  }
  if (content.slice(cursor).includes("<")) throw new TypeError("malformed XML tail");
  stack.at(-1)!.text += decodeXmlText(content.slice(cursor));
  if (stack.length !== 1) throw new TypeError(`unclosed XML tag ${stack.at(-1)!.name}`);
  const parsed = xmlObject(root);
  if (!isObject(parsed)) throw new TypeError("empty XML document");
  return parsed;
}

function xmlObject(node: XmlNode): unknown {
  if (node.children.size === 0) return node.text.trim();
  const object: Record<string, unknown> = {};
  for (const [name, children] of node.children) object[name] = children.length === 1 ? xmlObject(children[0]) : children.map(xmlObject);
  return object;
}

function localXmlName(name: string): string { return name.split(":").at(-1)!; }

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (entity, name: string) => {
    if (name === "amp") return "&";
    if (name === "lt") return "<";
    if (name === "gt") return ">";
    if (name === "quot") return '"';
    if (name === "apos") return "'";
    const codepoint = name.startsWith("#x") ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
    if (!Number.isSafeInteger(codepoint) || codepoint < 0 || codepoint > 0x10ffff) throw new TypeError(`invalid XML character reference ${entity}`);
    return String.fromCodePoint(codepoint);
  }).replace(/&[^\s;]+;/g, (entity) => { throw new TypeError(`unsupported XML entity ${entity}`); });
}

function parseGoConfiguration(path: string, content: string): Record<string, unknown> {
  const module = content.match(/^\s*module\s+(?:"([^"]+)"|([^\s]+))/m);
  if (path.endsWith("go.mod") && !module) throw new AnalysisConfigurationError(path, "go.mod has no module directive", undefined);
  const replacements = [...content.matchAll(/(?:^|\n)\s*(?:replace\s+)?([^\s()]+)(?:\s+[^\s=>]+)?\s*=>\s*(\.[^\s]+)\s*(?:\/\/[^\n]*)?(?=\n|$)/g)]
    .map((match) => `${match[1]}=>${posix.normalize(posix.join(posix.dirname(path), match[2]))}`);
  const uses = path.endsWith("go.work") ? [...content.matchAll(/^\s*(?:use\s+)?(\.?\.?\/[^\s()]+|\.)\s*(?:\/\/[^\n]*)?$/gm)].map((match) => sourceRootWithinScope(cleanRoot(posix.dirname(path)), match[1])) : [];
  return { module: module?.[1] ?? module?.[2], replacements, uses };
}

function parseGradleConfiguration(path: string, content: string, diagnostics: SemanticDiagnostic[]): Record<string, unknown> {
  const roots = [...content.matchAll(/(?:srcDirs?|setSrcDirs)\s*(?:\(|=)?\s*(?:\[|listOf\()?\s*['"]([^'"]+)['"]/g)].map((match) => match[1]);
  if (/srcDir/.test(content) && roots.length === 0) diagnostics.push({ code: "dynamic-gradle-source-roots", severity: "warning", filePath: path, message: "Gradle source roots are computed dynamically; the build script is not executed. Source-level package references remain available." });
  const projects = [...content.matchAll(/project\(\s*['"](:[^'"]+)['"]\s*\)/g)].map((match) => match[1]);
  if (/dependencies\s*\{/.test(content) && /(?:project\(\s*[^'"\s]|sourceSets\.[\w]+\.)/.test(content)) diagnostics.push({ code: "dynamic-gradle-dependencies", severity: "warning", filePath: path, message: "Computed Gradle project dependencies cannot be resolved without executing the build." });
  return { sourceRoots: roots, projects };
}

function mavenCoordinate(config: Record<string, unknown> | undefined): string | undefined {
  const parent = objectValue(config?.parent);
  const group = stringValue(config?.groupId) ?? stringValue(parent?.groupId);
  const artifact = stringValue(config?.artifactId);
  return group && artifact ? `${group}:${artifact}` : undefined;
}

function javaDependencies(root: string, maven: Record<string, unknown> | undefined, gradle: Record<string, unknown> | undefined, configuration: Map<string, Record<string, unknown>>): string[] {
  const entries = objectValue(maven?.dependencies)?.dependency;
  const dependencies = (Array.isArray(entries) ? entries : entries === undefined ? [] : [entries]).flatMap((entry) => {
    if (!isObject(entry)) throw new AnalysisConfigurationError(posix.join(root, "pom.xml"), "dependency must be an object", undefined);
    const coordinate = mavenCoordinate(entry);
    return coordinate ? [coordinate] : [];
  });
  const settingsRoot = nearestRoot(root, [...configuration.keys()].filter((path) => /settings\.gradle/.test(path)).map((path) => cleanRoot(posix.dirname(path))));
  for (const project of stringArray(gradle?.projects)) {
    if (settingsRoot === undefined) continue;
    const targetRoot = posix.join(settingsRoot, project.slice(1).replaceAll(":", "/"));
    if ([...configuration.keys()].some((path) => cleanRoot(posix.dirname(path)) === targetRoot && /build\.gradle/.test(path))) dependencies.push(`gradle:${targetRoot}`);
  }
  return [...new Set(dependencies)].sort();
}

function goDependencies(root: string, config: Record<string, unknown> | undefined, configuration: Map<string, Record<string, unknown>>): string[] {
  const workspacePath = [...configuration.keys()].filter((path) => path.endsWith("go.work") && within(root, cleanRoot(posix.dirname(path)))).sort((a, b) => b.length - a.length)[0];
  const workspace = workspacePath ? configuration.get(workspacePath) : undefined;
  const siblings = stringArray(workspace?.uses).flatMap((usedRoot) => {
    const module = stringValue(configuration.get(posix.join(usedRoot, "go.mod"))?.module);
    return module ? [`${module}=>${usedRoot}`] : [];
  });
  return [...new Set([...siblings, ...stringArray(workspace?.replacements), ...stringArray(config?.replacements)])].sort();
}

function compilerConfigurationError(ts: typeof TypeScript, path: string, errors: readonly TypeScript.Diagnostic[]): AnalysisConfigurationError {
  return new AnalysisConfigurationError(path, errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n")).join("; "), errors);
}

function preferredCompilerConfiguration(root: string, configurations: Map<string, TypeScript.ParsedCommandLine>): string | undefined {
  const local = [...configurations.keys()].filter((path) => cleanRoot(posix.dirname(path)) === root);
  return local.find((path) => posix.basename(path) === "tsconfig.json") ?? local.find((path) => posix.basename(path) === "jsconfig.json") ?? local[0];
}

function nearestWorkspaceRoot(root: string, configuration: Map<string, Record<string, unknown>>): string | undefined {
  const roots = [...configuration.entries()].filter(([path, value]) => path.endsWith("pnpm-workspace.yaml") || value.workspaces !== undefined).map(([path]) => cleanRoot(posix.dirname(path)));
  return nearestRoot(root, roots);
}

function languageRoots(language: AnalysisLanguage, configurations: string[], paths: string[]): string[] {
  const patterns: Record<AnalysisLanguage, RegExp> = {
    typescript: /^(?:package\.json|(?:tsconfig|jsconfig)(?:\.[\w-]+)?\.json)$/,
    python: /^(?:pyproject\.toml|setup\.(?:cfg|py))$/,
    java: /^(?:pom\.xml|build\.gradle(?:\.kts)?)$/,
    go: /^go\.mod$/
  };
  const roots = configurations.filter((path) => patterns[language].test(posix.basename(path))).map((path) => cleanRoot(posix.dirname(path)));
  if (language === "python" && roots.length === 0) {
    for (const path of paths.filter((candidate) => candidate.endsWith("/__init__.py"))) {
      const parent = cleanRoot(posix.dirname(posix.dirname(path)));
      if (!roots.some((root) => within(parent, root))) roots.push(parent);
    }
  }
  return [...new Set(["", ...roots])];
}

function pythonSourceRoots(root: string, config: Record<string, unknown> | undefined, paths: string[]): string[] {
  const tool = objectValue(config?.tool);
  const setuptools = objectValue(tool?.setuptools);
  const packageDir = objectValue(setuptools?.["package-dir"]);
  const explicit = packageDir ? Object.values(packageDir).filter((value): value is string => typeof value === "string") : [];
  const poetry = objectValue(tool?.poetry);
  if (Array.isArray(poetry?.packages)) for (const entry of poetry.packages) if (isObject(entry) && typeof entry.from === "string") explicit.push(entry.from);
  const hatchPackages = objectValue(objectValue(objectValue(objectValue(tool?.hatch)?.build)?.targets)?.wheel)?.packages;
  if (Array.isArray(hatchPackages)) for (const value of hatchPackages) if (typeof value === "string") explicit.push(posix.dirname(value));
  if (explicit.length > 0) return [...new Set(explicit.map((value) => sourceRootWithinScope(root, value)))].sort();
  const src = posix.join(root, "src");
  return paths.some((path) => within(path, src)) ? [src] : [root];
}

function javaSourceRoots(root: string, maven: Record<string, unknown> | undefined, gradle: Record<string, unknown> | undefined): string[] {
  const build = objectValue(maven?.build);
  const values = stringArray(gradle?.sourceRoots);
  if (values.length > 0) return [...new Set(values.map((value) => sourceRootWithinScope(root, value)))].sort();
  const properties = objectValue(maven?.properties);
  return [stringValue(build?.sourceDirectory) ?? "src/main/java", stringValue(build?.testSourceDirectory) ?? "src/test/java"].map((value) => {
    const expanded = value.replace(/\$\{([^}]+)\}/g, (match, name: string) => name === "project.basedir" || name === "basedir" ? "." : stringValue(properties?.[name]) ?? match);
    if (/\$\{/.test(expanded)) throw new AnalysisConfigurationError(posix.join(root, "pom.xml"), `source directory has unresolved property: ${value}`, undefined);
    return sourceRootWithinScope(root, expanded);
  });
}

function sourceRootWithinScope(root: string, path: string): string {
  if (isAbsolute(path)) throw new AnalysisConfigurationError(root, `source root must remain inside the scanned project: ${path}`, undefined);
  const normalized = posix.normalize(posix.join(root, path));
  if (normalized === ".." || normalized.startsWith("../")) throw new AnalysisConfigurationError(root, `source root escapes the scanned project: ${path}`, undefined);
  return cleanRoot(normalized);
}

function insideWorkspace(root: string, path: string, configPath: string, canonicalRoot: string): string {
  const lexical = relative(root, path).split(sep).join("/");
  const result = lexical === ".." || lexical.startsWith("../") || isAbsolute(lexical) ? relative(canonicalRoot, path).split(sep).join("/") : lexical;
  if (result === ".." || result.startsWith("../") || isAbsolute(result)) throw new AnalysisConfigurationError(configPath, `compiler path leaves the scanned workspace: ${path}`, undefined);
  return cleanRoot(result);
}

function dependencyNames(manifest: Record<string, unknown>, path: string): string[] {
  const names: string[] = [];
  for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const value = manifest[key];
    if (value !== undefined && !isObject(value)) throw new AnalysisConfigurationError(path, `${key} must be an object`, undefined);
    if (isObject(value)) names.push(...Object.keys(value));
  }
  return [...new Set(names)].sort();
}

function sourceLanguage(path: string): AnalysisLanguage | undefined {
  const extension = extname(path);
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"].includes(extension)) return "typescript";
  if (extension === ".py") return "python";
  if (extension === ".java") return "java";
  if (extension === ".go") return "go";
  return undefined;
}
function nearestRoot(path: string, roots: string[]): string | undefined { return roots.filter((root) => within(path, root)).sort((a, b) => b.length - a.length || a.localeCompare(b))[0]; }
function within(path: string, root: string): boolean { return root === "" || path === root || path.startsWith(`${root}/`); }
function cleanRoot(path: string): string { return path === "." ? "" : path.replace(/\/$/, ""); }
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function objectValue(value: unknown): Record<string, unknown> | undefined { return isObject(value) ? value : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function stringArray(value: unknown): string[] { return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []; }
function optionalString(value: unknown, path: string, field: string): string | undefined { if (value === undefined) return undefined; if (typeof value !== "string") throw new AnalysisConfigurationError(path, `${field} must be a string`, undefined); return value; }
function isPackageExport(value: unknown): value is PackageExport { return value === null || typeof value === "string" || (Array.isArray(value) ? value.every(isPackageExport) : isObject(value) && Object.values(value).every(isPackageExport)); }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
