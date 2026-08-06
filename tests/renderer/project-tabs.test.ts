import { describe, expect, it } from "vitest";
import {
  addProjectTab,
  closeProjectTab
} from "../../src/utils/project-tabs";

describe("project tabs", () => {
  it("adds a project once and makes it active", () => {
    const session = addProjectTab({
      openProjectIds: ["project-a"],
      activeProjectId: "project-a",
      lastPageByProject: { "project-a": "canvas" },
      contextsByProject: {}
    }, "project-b");

    expect(session).toEqual({
      openProjectIds: ["project-a", "project-b"],
      activeProjectId: "project-b",
      lastPageByProject: { "project-a": "canvas", "project-b": "canvas" },
      contextsByProject: {}
    });
  });

  it("focuses an already-open project without duplicating its tab", () => {
    const session = addProjectTab({
      openProjectIds: ["project-a", "project-b"],
      activeProjectId: "project-a",
      lastPageByProject: { "project-a": "canvas", "project-b": "tools" },
      contextsByProject: {}
    }, "project-b");

    expect(session.openProjectIds).toEqual(["project-a", "project-b"]);
    expect(session.activeProjectId).toBe("project-b");
  });

  it("activates the nearest remaining tab when closing the active project", () => {
    const session = closeProjectTab({
      openProjectIds: ["project-a", "project-b", "project-c"],
      activeProjectId: "project-b",
      lastPageByProject: { "project-a": "canvas", "project-b": "tools", "project-c": "docs" },
      contextsByProject: {}
    }, "project-b");

    expect(session).toEqual({
      openProjectIds: ["project-a", "project-c"],
      activeProjectId: "project-c",
      lastPageByProject: { "project-a": "canvas", "project-c": "docs" },
      contextsByProject: {}
    });
  });

});
