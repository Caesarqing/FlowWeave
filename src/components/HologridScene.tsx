import { useEffect, useRef } from "react";

type Point = {
  x: number;
  z: number;
};

type HologridPalette = {
  gradientStart: string;
  gradientMid: string;
  gradientEnd: string;
  lineCyan: string;
  lineGreen: string;
  node: string;
  ring: string;
};

const gridPoints: Point[] = [];

for (let x = -8; x <= 8; x += 2) {
  for (let z = -8; z <= 8; z += 2) {
    gridPoints.push({ x, z });
  }
}

export function HologridScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;
    const sceneCanvas = canvas;
    const ctx = context;

    const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frameId = 0;
    let width = 0;
    let height = 0;
    let ratio = 1;
    let palette = getPalette(sceneCanvas);

    function isReducedMotion() {
      return reducedMotionQuery.matches || document.documentElement.dataset.motion === "reduced";
    }

    function resize() {
      const rect = sceneCanvas.getBoundingClientRect();
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      ratio = Math.min(window.devicePixelRatio || 1, 1.5);
      sceneCanvas.width = Math.floor(width * ratio);
      sceneCanvas.height = Math.floor(height * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      palette = getPalette(sceneCanvas);
      draw(performance.now());
    }

    function project(x: number, z: number, drift: number) {
      const rotatedX = x * Math.cos(drift) - z * Math.sin(drift);
      const rotatedZ = x * Math.sin(drift) + z * Math.cos(drift);
      const depth = rotatedZ + 14;
      const scale = 320 / depth;
      return {
        alpha: Math.max(0.08, Math.min(0.52, 1 - depth / 24)),
        x: width / 2 + rotatedX * scale,
        y: height * 0.68 + (rotatedZ - 4) * scale * 0.28
      };
    }

    function draw(time: number) {
      const reducedMotion = isReducedMotion();
      const drift = reducedMotion ? 0.18 : time * 0.00012;
      ctx.clearRect(0, 0, width, height);

      const gradient = ctx.createRadialGradient(width * 0.5, height * 0.55, 0, width * 0.5, height * 0.55, Math.max(width, height) * 0.62);
      gradient.addColorStop(0, palette.gradientStart);
      gradient.addColorStop(0.42, palette.gradientMid);
      gradient.addColorStop(1, palette.gradientEnd);
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      drawGrid(drift);
      drawNodes(drift, time, reducedMotion);
      drawRing(time, reducedMotion);

      if (!reducedMotion) frameId = window.requestAnimationFrame(draw);
    }

    function drawGrid(drift: number) {
      ctx.lineWidth = 1;
      for (let index = -8; index <= 8; index += 1) {
        drawProjectedLine({ x: -8, z: index }, { x: 8, z: index }, drift, palette.lineCyan);
        drawProjectedLine({ x: index, z: -8 }, { x: index, z: 8 }, drift, palette.lineGreen);
      }
    }

    function drawProjectedLine(start: Point, end: Point, drift: number, color: string) {
      const from = project(start.x, start.z, drift);
      const to = project(end.x, end.z, drift);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.strokeStyle = color;
      ctx.globalAlpha = Math.min(from.alpha, to.alpha);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    function drawNodes(drift: number, time: number, reducedMotion: boolean) {
      const pulse = reducedMotion ? 0 : Math.sin(time * 0.002) * 0.45;
      for (const point of gridPoints) {
        const projected = project(point.x, point.z, drift);
        ctx.beginPath();
        ctx.arc(projected.x, projected.y, 1.2 + pulse * 0.25, 0, Math.PI * 2);
        ctx.fillStyle = palette.node;
        ctx.globalAlpha = projected.alpha;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function drawRing(time: number, reducedMotion: boolean) {
      const radiusX = Math.min(width, height) * 0.19;
      const radiusY = radiusX * 0.22;
      const offset = reducedMotion ? 0 : Math.sin(time * 0.0008) * 8;
      ctx.beginPath();
      ctx.ellipse(width / 2, height * 0.62 + offset, radiusX, radiusY, 0, 0, Math.PI * 2);
      ctx.strokeStyle = palette.ring;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(sceneCanvas);
    reducedMotionQuery.addEventListener("change", resize);
    const themeObserver = new MutationObserver(() => {
      palette = getPalette(sceneCanvas);
      if (isReducedMotion()) draw(performance.now());
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-motion"] });
    resize();

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver.disconnect();
      themeObserver.disconnect();
      reducedMotionQuery.removeEventListener("change", resize);
    };
  }, []);

  return <canvas aria-hidden="true" className="hologrid-scene" ref={canvasRef} />;
}

function getPalette(canvas: HTMLCanvasElement): HologridPalette {
  const styles = window.getComputedStyle(canvas);
  return {
    gradientStart: cssVariable(styles, "--hologrid-gradient-start", "rgba(66, 245, 167, 0.055)"),
    gradientMid: cssVariable(styles, "--hologrid-gradient-mid", "rgba(137, 236, 255, 0.03)"),
    gradientEnd: cssVariable(styles, "--hologrid-gradient-end", "rgba(2, 3, 3, 0)"),
    lineCyan: cssVariable(styles, "--hologrid-line-cyan", "rgba(137, 236, 255, 0.1)"),
    lineGreen: cssVariable(styles, "--hologrid-line-green", "rgba(66, 245, 167, 0.085)"),
    node: cssVariable(styles, "--hologrid-node", "rgba(184, 255, 242, 0.42)"),
    ring: cssVariable(styles, "--hologrid-ring", "rgba(137, 236, 255, 0.13)")
  };
}

function cssVariable(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
}
