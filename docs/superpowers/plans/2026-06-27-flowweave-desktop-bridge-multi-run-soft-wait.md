# FlowWeave Desktop Bridge Multi-Run Soft-Wait Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` recommended or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Canvas/模块图与时序图 Agent 审核在同时或连续运行时只处理一个 run、另一个超时失败或晚到过期的问题。

**Architecture:** 不合并 run。每个 artifact 仍保留独立 `runId`，但 desktop bridge 改为显式 pending 队列，review 层把超时从失败条件改成软等待提示，晚到 `response.json` 按 `runId/projectId/artifactTarget/reviewId/scanFingerprint` 精确导入并采纳。CLI 仍保留进程超时；desktop artifact-analysis 不再因等待时间到达而失败。

**Tech Stack:** Electron main process, TypeScript, React renderer, Vitest.

---

## Summary

- 不合并 Canvas 和时序图 run；每个 artifact 仍使用独立 run。
- Desktop artifact-analysis 的 `planTimeoutMs` 改为软等待阈值，不再直接写 `review-failed`。
- Desktop bridge 写入 `pending-requests.json`，Agent 按队列逐个处理 pending request。
- 晚到 `response.json` 通过 run log 导入并走统一 artifact adoption。
- Artifact review 启动时使用 `.flowweave/project.json` 中的当前扫描指纹。

## Key Changes

- 扩展 desktop `request.json`，加入 `artifactTarget`、`scanFingerprint`、`reviewId`、`runDirectory`、`responsePath`。
- 新增 `ArtifactAdoption.status = "late"`。
- 扩展 architecture/sequence review status，加入 `softTimedOutAt` 和 `message`。
- 新增 `.flowweave/agent-bridge/pending-requests.json` manifest，记录 pending/completed/failed request。
- 新增软等待服务，替换 architecture/sequence 中的硬超时 pending 轮询。

## Test Plan

- Desktop bridge manifest 能记录多个 pending request。
- 只写回一个 run 时只完成该 run，其他 run 保持 pending/late。
- 超过软等待阈值后 review 仍为 reviewing，不写 review-failed。
- 晚到 `response.json` 可以通过 run history/read artifact 导入并应用。
- 错误 run/project/target 被 rejected，不写 artifact。
- scan fingerprint mismatch 被 stale，不写 artifact。
- Renderer 显示 pending/late/applied/stale/rejected，并隐藏 stale 的 Apply result。

## Assumptions

- 不创建 git commit。
- `stale` 结果不允许强制覆盖当前 artifact。
- CLI 进程超时不改变。
