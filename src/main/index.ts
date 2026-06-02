/// <reference types="electron-vite/node" />

import { app, BrowserWindow } from "electron";
import { join } from "node:path";
import { registerAgentIpc } from "./ipc/agent.ipc";
import { registerGitIpc } from "./ipc/git.ipc";
import { registerProjectIpc } from "./ipc/project.ipc";
import { configureAgentRegistry } from "./services/agent-registry.service";

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1120,
    minHeight: 720,
    title: "FlowWeave",
    backgroundColor: "#080a13",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  return window;
}

app.whenReady().then(() => {
  configureAgentRegistry(app.getPath("userData"));
  registerProjectIpc();
  registerAgentIpc();
  registerGitIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
