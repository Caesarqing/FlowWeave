import { useEffect, useRef } from "react";
import type * as ThreeNamespace from "three";

export function HologridScene() {
  const mountRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const mountElement = mountRef.current;
    if (!mountElement) return;
    const mount = mountElement;

    let disposed = false;
    let cleanupScene: (() => void) | undefined;

    void import("three").then((THREE: typeof ThreeNamespace) => {
      if (disposed || !mount.isConnected) return;

      const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 80);
      camera.position.set(0, 5.2, 8.6);
      camera.lookAt(0, -0.35, 0);

      let renderer: ThreeNamespace.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
      } catch {
        return;
      }
      renderer.setClearColor(0x000000, 0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      mount.appendChild(renderer.domElement);

      const grid = new THREE.GridHelper(18, 36, 0x3af7a4, 0x45d9ff);
      const gridMaterial: ThreeNamespace.Material[] = grid.material instanceof Array ? grid.material : [grid.material];
      gridMaterial.forEach((material) => {
        material.transparent = true;
        material.opacity = 0.18;
        material.depthWrite = false;
      });
      grid.position.y = -1.6;
      scene.add(grid);

      const pointGeometry = new THREE.BufferGeometry();
      const positions: number[] = [];
      for (let x = -8; x <= 8; x += 2) {
        for (let z = -8; z <= 8; z += 2) {
          positions.push(x, -1.58, z);
        }
      }
      pointGeometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
      const pointMaterial = new THREE.PointsMaterial({
        color: 0xb8fff2,
        size: 0.035,
        transparent: true,
        opacity: 0.46,
        depthWrite: false
      });
      const points = new THREE.Points(pointGeometry, pointMaterial);
      scene.add(points);

      const ringGeometry = new THREE.TorusGeometry(2.9, 0.008, 8, 96);
      const ringMaterial = new THREE.MeshBasicMaterial({ color: 0x45d9ff, transparent: true, opacity: 0.16, depthWrite: false });
      const ring = new THREE.Mesh(ringGeometry, ringMaterial);
      ring.rotation.x = Math.PI / 2;
      ring.position.set(0, -1.54, 0);
      scene.add(ring);

      let frameId = 0;

      function resize() {
        const { width, height } = mount.getBoundingClientRect();
        if (width <= 0 || height <= 0) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
      }

      function render(time = 0) {
        if (!reducedMotion) {
          const drift = time * 0.00012;
          grid.rotation.y = drift;
          points.rotation.y = drift;
          ring.rotation.z = time * 0.00016;
        }
        renderer.render(scene, camera);
        if (!reducedMotion) frameId = window.requestAnimationFrame(render);
      }

      const resizeObserver = new ResizeObserver(() => {
        resize();
        if (reducedMotion) render();
      });
      resizeObserver.observe(mount);
      resize();
      render();

      cleanupScene = () => {
        window.cancelAnimationFrame(frameId);
        resizeObserver.disconnect();
        if (renderer.domElement.parentElement === mount) mount.removeChild(renderer.domElement);
        pointGeometry.dispose();
        pointMaterial.dispose();
        ringGeometry.dispose();
        ringMaterial.dispose();
        gridMaterial.forEach((material) => material.dispose());
        renderer.dispose();
      };
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanupScene?.();
    };
  }, []);

  return <div aria-hidden="true" className="hologrid-scene" ref={mountRef} />;
}
