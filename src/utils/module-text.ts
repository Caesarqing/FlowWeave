import type { ArchitectureModuleCategory, GraphNode } from "../types";

type Translate = (key: string, params?: Record<string, string | number>) => string;

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
  if (isGeneratedScanGuidance(node.guidanceDraft)) {
    return t("module.generatedScanGuidance", { title: node.title });
  }

  if (isGeneratedArchitectureGuidance(node.guidanceDraft)) {
    return t("module.generatedArchitectureGuidance", { title: node.title });
  }

  return node.guidanceDraft;
}

export function editableModuleGuidance(node: GraphNode, t: Translate): string {
  if (isGeneratedModuleGuidance(node.guidanceDraft)) return "";
  return localizedModuleGuidance(node, t);
}

export function isGeneratedModuleGuidance(value: string): boolean {
  return isGeneratedScanGuidance(value) || isGeneratedArchitectureGuidance(value);
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

function isGeneratedScanGuidance(value: string): boolean {
  return value.includes("检查这些文件的职责边界") ||
    value.includes("Review the responsibility boundaries of these files");
}

function isGeneratedArchitectureGuidance(value: string): boolean {
  return value.includes("功能架构职责修改代码") ||
    value.includes("functional architecture responsibility");
}
