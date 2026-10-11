import { Profiler, type ReactNode } from "react";
import { recordCanvasProfilerWindowCommit } from "../utils/react-profiler";

const reactProfilerEnabled = import.meta.env.DEV && import.meta.env.VITE_FLOWWEAVE_REACT_PROFILE === "1";

type CanvasProfilerBoundaryProps = {
  id: string;
  children: ReactNode;
};

export function CanvasProfilerBoundary({ id, children }: CanvasProfilerBoundaryProps) {
  if (!reactProfilerEnabled || children === null || children === undefined || children === false) return children;
  return <Profiler id={id} onRender={recordCanvasProfilerWindowCommit}>{children}</Profiler>;
}
