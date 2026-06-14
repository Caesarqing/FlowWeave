import type { ArchitectureModuleCategory, GraphNode } from "../types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

const generatedSubtitles = new Set([
  "Request entry and orchestration",
  "Data model and persistence",
  "Testing and regression validation",
  "Backend business module",
  "请求入口与编排",
  "数据模型与持久化",
  "测试与回归验证",
  "后端业务模块"
]);

export function localizedModuleSubtitle(node: GraphNode, t: Translate): string {
  if (!generatedSubtitles.has(node.subtitle)) return node.subtitle;
  return t(`module.generatedSubtitle.${node.nodeType}`);
}

export function localizedModuleDescription(node: GraphNode, t: Translate): string {
  if (
    node.description.includes("模块由项目扫描生成") ||
    node.description.includes("was generated from the project scan")
  ) {
    return t("module.generatedScanDescription", {
      title: node.title,
      count: node.files.length
    });
  }

  if (/ module inferred from file structure and code symbols\.?$/i.test(node.description)) {
    return t("module.generatedArchitectureDescription", {
      role: localizedArchitectureCategory(node.category, node.nodeType, t)
    });
  }

  return node.description;
}

export function localizedModuleGuidance(node: GraphNode, t: Translate): string {
  if (
    node.guidanceDraft.includes("检查这些文件的职责边界") ||
    node.guidanceDraft.includes("Review the responsibility boundaries of these files")
  ) {
    return t("module.generatedScanGuidance", { title: node.title });
  }

  if (
    node.guidanceDraft.includes("功能架构职责修改代码") ||
    node.guidanceDraft.includes("functional architecture responsibility")
  ) {
    return t("module.generatedArchitectureGuidance", { title: node.title });
  }

  return node.guidanceDraft;
}

export function localizedModuleRole(node: GraphNode, t: Translate): string | undefined {
  if (!node.role) return undefined;
  if (/ module inferred from file structure and code symbols\.?$/i.test(node.role)) {
    return t("module.generatedArchitectureDescription", {
      role: localizedArchitectureCategory(node.category, node.nodeType, t)
    });
  }
  return node.role;
}

export function localizedArchitectureCategory(
  category: ArchitectureModuleCategory | undefined,
  nodeType: GraphNode["nodeType"],
  t: Translate
): string {
  return category ? t(`architectureCategory.${category}`) : t(`nodeType.${nodeType}`);
}
