// Prototype page (prototype.html): an Ä built from the original model's parts
// (its A, plus dots and necks cut from its I), next to the original A, in the
// same colour and lit like the app, front-on and turned.
import { useMemo } from "react";
import { createRoot } from "react-dom/client";
import { Canvas } from "@react-three/fiber";
import { Environment, Lightformer, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import umlautUrl from "./assets/prototype-umlaut.glb?url";

const CAP = 1.6;
const material = new THREE.MeshPhysicalMaterial({ color: "#3a6fe0", metalness: 0.85, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.08 });

/** The named mesh, scaled so the original A is CAP tall, sitting on y = 0. */
function useLetter(name: string, scale: number) {
  const { scene } = useGLTF(umlautUrl);
  return useMemo(() => {
    scene.updateMatrixWorld(true);
    const mesh = scene.getObjectByName(name) as THREE.Mesh;
    const g = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
    g.scale(scale, scale, scale);
    g.computeBoundingBox();
    const box = g.boundingBox!;
    g.translate(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2);
    g.computeVertexNormals();
    return g;
  }, [scene, name, scale]);
}

function Row({ y, turn }: { y: number; turn: number }) {
  const { scene } = useGLTF(umlautUrl);
  // Scale from the original A's height, so both share it.
  const scale = useMemo(() => {
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene.getObjectByName("A")!);
    return CAP / (box.max.y - box.min.y);
  }, [scene]);
  const a = useLetter("A", scale);
  const umlaut = useLetter("Ä", scale);
  return (
    <group position={[0, y, 0]}>
      <mesh geometry={a} material={material} position={[-1.3, 0, 0]} rotation-y={turn} />
      <mesh geometry={umlaut} material={material} position={[1.3, 0, 0]} rotation-y={turn} />
    </group>
  );
}

function Prototype() {
  return (
    <Canvas camera={{ position: [0, 0, 9], fov: 40 }} style={{ position: "fixed", inset: 0, background: "#fff" }}>
      <ambientLight intensity={0.4} />
      <directionalLight position={[4, 6, 8]} intensity={1.4} />
      <Environment resolution={256}>
        <Lightformer intensity={2} position={[0, 5, 5]} scale={[10, 2, 1]} />
        <Lightformer intensity={1.5} position={[-6, 0, 3]} rotation-y={Math.PI / 2} scale={[8, 4, 1]} />
        <Lightformer intensity={1.5} position={[6, 0, 3]} rotation-y={-Math.PI / 2} scale={[8, 4, 1]} />
        <Lightformer intensity={0.6} color="#ffd9a0" position={[0, -4, 4]} scale={[10, 2, 1]} />
      </Environment>
      <Row y={0.3} turn={0} />
      <Row y={-2.3} turn={0.7} />
    </Canvas>
  );
}

createRoot(document.getElementById("root")!).render(<Prototype />);
