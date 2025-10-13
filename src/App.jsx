import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js';
import { SimulationManager } from './lib/simulation.js';

const STORAGE_KEY = 'vr-circuitdesigner-state.v2';
const BOARD_HEIGHT = 1.2;

const componentCatalog = {
  source: {
    label: 'Power Source',
    description: 'DC supply feeding the circuit. Adjust voltage to explore different operating points.',
    defaultValue: 5,
    slider: { min: 3, max: 12, step: 0.1, format: value => `${value.toFixed(1)} V`, label: 'Voltage' },
    createMesh: createBatteryMesh,
  },
  resistor: {
    label: 'Resistor',
    description: 'Limits current through the circuit. Experiment with values to balance LED brightness.',
    defaultValue: 220,
    slider: { min: 50, max: 2000, step: 10, format: value => `${value.toFixed(0)} Ω`, label: 'Resistance' },
    createMesh: createResistorMesh,
  },
  capacitor: {
    label: 'Capacitor',
    description: 'Stabilises the rail voltage by storing charge when supply ripple rises.',
    defaultValue: 100,
    slider: { min: 10, max: 470, step: 10, format: value => `${value.toFixed(0)} µF`, label: 'Capacitance' },
    createMesh: createCapacitorMesh,
  },
  led: {
    label: 'LED Indicator',
    description: 'Outputs light proportional to forward current. Set Vf to explore diode behaviour.',
    defaultValue: 2.05,
    slider: { min: 1.7, max: 3.3, step: 0.05, format: value => `${value.toFixed(2)} V`, label: 'Forward Voltage' },
    createMesh: createLEDMesh,
  },
};

const defaultComponents = [
  { id: 'V1', type: 'source', value: componentCatalog.source.defaultValue },
  { id: 'R1', type: 'resistor', value: componentCatalog.resistor.defaultValue },
  { id: 'C1', type: 'capacitor', value: componentCatalog.capacitor.defaultValue },
  { id: 'LED1', type: 'led', value: componentCatalog.led.defaultValue },
];

const instructions = [
  'Drag components on the 2D map to reshape the circuit in real time.',
  'Add or remove series components to explore different circuit topologies.',
  'Focus a component to view its stats hovering directly above it.',
  'Use the multimeter overlay while you reposition components on the board.',
];

const breadboardDefaults = {
  segments: 2,
  columnsPerSegment: 16,
  rowCount: 10,
  columnPitch: 0.085,
  rowPitch: 0.028,
  baseHeight: BOARD_HEIGHT + 0.035,
};

const DEFAULT_TOTAL_COLUMNS = breadboardDefaults.columnsPerSegment * breadboardDefaults.segments;
const DEFAULT_TOTAL_ROWS = breadboardDefaults.rowCount;

let latestBoardMeta = { columns: DEFAULT_TOTAL_COLUMNS, rows: DEFAULT_TOTAL_ROWS };

export default function App() {
  const canvasRef = useRef(null);
  const vrButtonSlotRef = useRef(null);
  const simulatorRef = useRef(null);
  const sceneContextRef = useRef(null);

  const [components, setComponents] = useState(defaultComponents);
  const [layout, setLayout] = useState(() => generateInitialLayout(defaultComponents));
  const [selectedId, setSelectedId] = useState(defaultComponents[1].id);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [solverMeta, setSolverMeta] = useState({ usingEEC: false, error: null });
  const [hydrated, setHydrated] = useState(false);

  const orderedComponents = useMemo(() => orderComponents(components), [components]);

  const handleLayoutChange = useCallback((id, coords) => {
    setLayout(prev => {
      const current = prev[id];
      const columns = latestBoardMeta.columns ?? DEFAULT_TOTAL_COLUMNS;
      const rows = latestBoardMeta.rows ?? DEFAULT_TOTAL_ROWS;
      const next = {
        col: clampInt(coords.col ?? 0, 0, columns - 1),
        row: clampInt(coords.row ?? 0, 0, rows - 1),
      };
      if (current && current.col === next.col && current.row === next.row) {
        return prev;
      }
      return {
        ...prev,
        [id]: next,
      };
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed.components) && parsed.components.length >= 2) {
          setComponents(rehydrateComponents(parsed.components));
          setLayout(rehydrateLayout(parsed.layout, parsed.components));
          const selectable = parsed.components.find(component => component.id !== parsed.components[0]?.id);
          if (selectable) {
            setSelectedId(selectable.id);
          }
        }
      }
    } catch (err) {
      console.warn('[VR Circuit Designer] Unable to restore saved workspace:', err);
    } finally {
      setHydrated(true);
    }
  }, []);

  useEffect(() => {
    if (!hydrated || typeof window === 'undefined') return;
    const payload = JSON.stringify({ components, layout });
    window.localStorage.setItem(STORAGE_KEY, payload);
  }, [components, layout, hydrated]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    const simulator = new SimulationManager(meta => setSolverMeta(prev => ({ ...prev, ...meta })));
    simulatorRef.current = simulator;

    const context = initialiseScene(canvas, vrButtonSlotRef, simulator, handleLayoutChange);
    sceneContextRef.current = context;

    context.sync({ components: orderedComponents, layout });
    simulator.configure({ components: orderedComponents });

    return () => {
      context.dispose();
      simulatorRef.current = null;
      sceneContextRef.current = null;
    };
  }, [handleLayoutChange]);

  useEffect(() => {
    const context = sceneContextRef.current;
    const simulator = simulatorRef.current;
    if (!context || !simulator) return;

    context.sync({ components: orderedComponents, layout });
    simulator.configure({ components: orderedComponents });
  }, [orderedComponents, layout]);

  const handleParamChange = (componentId, value) => {
    setComponents(prev =>
      prev.map(component =>
        component.id === componentId
          ? {
              ...component,
              value,
            }
          : component,
      ),
    );
  };

  const handleAddComponent = type => {
    const spec = componentCatalog[type];
    if (!spec) return;
    const id = generateComponentId(type, components);
    const nextComponent = {
      id,
      type,
      value: spec.defaultValue,
    };
    setComponents(prev => insertBeforeLed(prev, nextComponent));
    setLayout(prev => ({
      ...prev,
      [id]: generateSpawnCoordinate(Object.keys(prev).length),
    }));
    setSelectedId(id);
  };

  const handleRemoveComponent = id => {
    if (components.length <= 2) return;
    const target = components.find(component => component.id === id);
    if (!target || target.type === 'source') return;
    setComponents(prev => prev.filter(component => component.id !== id));
    setLayout(prev => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
    if (selectedId === id) {
      const fallback = components.find(component => component.id !== id && component.type !== 'source');
      if (fallback) setSelectedId(fallback.id);
    }
  };

  const handleMoveComponent = (id, direction) => {
    setComponents(prev => reorderComponent(prev, id, direction));
  };

  const selectedComponent = components.find(component => component.id === selectedId);

  return (
    <div className="app-root">
      <canvas ref={canvasRef} className="webgl-canvas" />
      <div ref={vrButtonSlotRef} className="vr-button-slot" />

      <CircuitMap
        components={orderedComponents}
        layout={layout}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onLayoutChange={handleLayoutChange}
      />

      <ControlDock
        open={controlsOpen}
        components={components}
        selected={selectedComponent}
        onToggle={() => setControlsOpen(prev => !prev)}
        onSelect={setSelectedId}
        onParamChange={handleParamChange}
        onAddComponent={handleAddComponent}
        onRemove={handleRemoveComponent}
        onMove={handleMoveComponent}
        instructions={instructions}
        solverMeta={solverMeta}
      />
    </div>
  );
}

function initialiseScene(canvas, vrButtonSlotRef, simulator, onLayoutChange) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.xr.enabled = true;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xcad8c0);

  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 100);
  camera.position.set(0, 1.65, 3.6);

  const vrButton = VRButton.createButton(renderer);
  if (vrButtonSlotRef.current) {
    vrButtonSlotRef.current.innerHTML = '';
    vrButtonSlotRef.current.appendChild(vrButton);
  } else {
    document.body.appendChild(vrButton);
  }

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 1.35, 0);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 1.2;
  controls.maxDistance = 7;
  controls.minPolarAngle = THREE.MathUtils.degToRad(25);
  controls.maxPolarAngle = THREE.MathUtils.degToRad(135);
  controls.enableRotate = true;
  controls.enableZoom = false;
  controls.enabled = true;

  const hemiLight = new THREE.HemisphereLight(0xd8e6c8, 0x2b3324, 1.05);
  hemiLight.position.set(0, 6, 0);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
  dirLight.position.set(3.8, 6.5, 5.2);
  dirLight.castShadow = true;
  scene.add(dirLight);

  scene.add(new THREE.AmbientLight(0xcfd6c5, 0.35));

  const rimLight = new THREE.PointLight(0xe3f2c7, 0.45, 9);
  rimLight.position.set(-3.5, 3.2, 2.4);
  scene.add(rimLight);

  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(12, 64),
    new THREE.MeshStandardMaterial({
      color: 0xe7ebe0,
      roughness: 0.9,
      metalness: 0.03,
    }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(12, 36, 0xd0d7c8, 0xb7bfad);
  grid.position.y = 0.001;
  scene.add(grid);

  const breadboardState = {
    segments: breadboardDefaults.segments,
    columnsPerSegment: breadboardDefaults.columnsPerSegment,
    rowCount: breadboardDefaults.rowCount,
    columnPitch: breadboardDefaults.columnPitch,
    rowPitch: breadboardDefaults.rowPitch,
    baseHeight: breadboardDefaults.baseHeight,
    group: null,
    surfaceGroup: null,
    width: breadboardDefaults.columnsPerSegment * breadboardDefaults.columnPitch * breadboardDefaults.segments,
    depth: breadboardDefaults.rowCount * breadboardDefaults.rowPitch,
    gridToPosition: () => new THREE.Vector3(),
    positionToGrid: () => ({ col: 0, row: 0 }),
  };

  buildBreadboard();

  const interactiveObjects = [];
  const componentRefs = new Map();
  const wireRefs = [];
  const emissiveMaterials = [];

  const statsLabel = createStatsLabel(scene);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const tempMatrix = new THREE.Matrix4();
  const tempVec = new THREE.Vector3();
  const tempBox = new THREE.Box3();
  const dragState = {
    active: false,
    pointerId: null,
    componentId: null,
    target: null,
    plane: new THREE.Plane(),
    intersection: new THREE.Vector3(),
    offset: new THREE.Vector3(),
    gridCol: null,
    gridRow: null,
    componentType: null,
  };

  let currentHover = null;
  let currentFocus = null;

  const simulatorState = {
    lastStatsKey: '',
  };
  let lastSyncPayload = null;

  function buildBreadboard(existingChildren) {
    const preserved = existingChildren
      ? [...existingChildren]
      : breadboardState.surfaceGroup
        ? [...breadboardState.surfaceGroup.children]
        : [];

    preserved.forEach(child => {
      if (child.parent) child.parent.remove(child);
    });

    if (breadboardState.group) {
      scene.remove(breadboardState.group);
    }

    const columns = breadboardState.segments * breadboardState.columnsPerSegment;
    const rows = breadboardState.rowCount;
    breadboardState.width = columns * breadboardState.columnPitch;
    breadboardState.depth = rows * breadboardState.rowPitch;

    const group = new THREE.Group();

    const baseWidth = breadboardState.width + 0.22;
    const baseDepth = breadboardState.depth + 0.22;
    const base = new THREE.Mesh(
      new THREE.BoxGeometry(baseWidth, 0.14, baseDepth),
      new THREE.MeshStandardMaterial({
        color: 0xe4e9df,
        metalness: 0.15,
        roughness: 0.6,
        emissive: 0xd9dfd4,
        emissiveIntensity: 0.16,
      }),
    );
    base.position.set(0, BOARD_HEIGHT + 0.07, 0);
    base.receiveShadow = true;
    base.castShadow = true;
    group.add(base);

    const topCanvas = document.createElement('canvas');
    topCanvas.width = 1024;
    topCanvas.height = 512;
    const ctx = topCanvas.getContext('2d');
    ctx.fillStyle = '#f8f9f5';
    ctx.fillRect(0, 0, topCanvas.width, topCanvas.height);

    const railHeight = 68;
    ctx.fillStyle = '#e0e4d9';
    ctx.fillRect(0, railHeight, topCanvas.width, topCanvas.height - railHeight * 2);

    ctx.strokeStyle = '#c0c6ba';
    ctx.lineWidth = 3;
    ctx.strokeRect(40, 40, topCanvas.width - 80, topCanvas.height - 80);

    ctx.fillStyle = '#d9534f';
    ctx.fillRect(60, 60, topCanvas.width - 120, 24);
    ctx.fillStyle = '#4a90e2';
    ctx.fillRect(60, topCanvas.height - 84, topCanvas.width - 120, 24);

    ctx.fillStyle = '#9ca69a';
    const holeRadius = 4;
    const holeSpacingX = (topCanvas.width - 120) / Math.max(columns - 1, 1);
    const holeSpacingY = (topCanvas.height - 200) / Math.max(rows - 1, 1);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < columns; col += 1) {
        const x = 60 + col * holeSpacingX;
        const y = 120 + row * holeSpacingY;
        ctx.beginPath();
        ctx.arc(x, y, holeRadius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    const topTexture = new THREE.CanvasTexture(topCanvas);
    topTexture.colorSpace = THREE.SRGBColorSpace;
    topTexture.anisotropy = 4;

    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(breadboardState.width + 0.12, breadboardState.depth + 0.12),
      new THREE.MeshStandardMaterial({
        map: topTexture,
        roughness: 0.38,
        metalness: 0.1,
        emissive: 0xf1f3ec,
        emissiveIntensity: 0.12,
        side: THREE.DoubleSide,
      }),
    );
    top.rotation.x = -Math.PI / 2;
    top.position.set(0, breadboardState.baseHeight - 0.015, 0);
    top.receiveShadow = true;
    group.add(top);

    const surfaceGroup = new THREE.Group();
    surfaceGroup.position.y = breadboardState.baseHeight;
    preserved.forEach(child => surfaceGroup.add(child));
    group.add(surfaceGroup);

    breadboardState.group = group;
    breadboardState.surfaceGroup = surfaceGroup;
    breadboardState.gridToPosition = (col, row) => {
      const columns = breadboardState.segments * breadboardState.columnsPerSegment;
      const rows = breadboardState.rowCount;
      const x = (col - (columns - 1) / 2) * breadboardState.columnPitch;
      const z = (row - (rows - 1) / 2) * breadboardState.rowPitch;
      return new THREE.Vector3(x, breadboardState.baseHeight, z);
    };
    breadboardState.positionToGrid = (x, z) => {
      const columns = breadboardState.segments * breadboardState.columnsPerSegment;
      const rows = breadboardState.rowCount;
      const col = clampInt(Math.round(x / breadboardState.columnPitch + (columns - 1) / 2), 0, columns - 1);
      const row = clampInt(Math.round(z / breadboardState.rowPitch + (rows - 1) / 2), 0, rows - 1);
      return { col, row };
    };
    latestBoardMeta = { columns, rows };
    updateMeasurementBounds();
    scene.add(group);
  }

  function updateMeasurementBounds() {}

  function registerMaterial(material, meta = {}) {
    if (!material) return;
    if (!material.userData) material.userData = {};
    if (material.emissiveIntensity !== undefined && material.userData.baseEmissiveIntensity === undefined) {
      material.userData.baseEmissiveIntensity = material.emissiveIntensity;
    }
    if (emissiveMaterials.some(entry => entry.material === material)) return;
    emissiveMaterials.push({
      material,
      componentId: meta.componentId ?? null,
      type: meta.type ?? null,
      effect: meta.effect ?? null,
    });
  }

  function unregisterMaterial(material) {
    const index = emissiveMaterials.findIndex(entry => entry.material === material);
    if (index >= 0) emissiveMaterials.splice(index, 1);
  }

  function registerInteractiveMesh(mesh, data) {
    mesh.userData = {
      ...mesh.userData,
      ...data,
    };
    interactiveObjects.push(mesh);
  }

  function unregisterInteractiveMesh(mesh) {
    const index = interactiveObjects.indexOf(mesh);
    if (index >= 0) interactiveObjects.splice(index, 1);
  }

  function ensureComponent(instance, layout) {
    const existing = componentRefs.get(instance.id);
    if (existing) {
      existing.instance = instance;
      existing.group.userData.name = getComponentLabel(instance);
      existing.group.userData.description = componentCatalog[instance.type]?.description ?? '';
      return existing;
    }

    const factory = componentCatalog[instance.type]?.createMesh ?? createPlaceholderMesh;
    const group = factory(getComponentLabel(instance));
    group.userData = {
      id: instance.id,
      type: instance.type,
      name: getComponentLabel(instance),
      description: componentCatalog[instance.type]?.description ?? '',
      kind: 'component',
    };

    group.traverse(child => {
      if (!child.isMesh) return;
      const effect = child.userData?.effect ?? null;
      registerMaterial(child.material, {
        componentId: instance.id,
        type: instance.type,
        effect,
      });
      registerInteractiveMesh(child, {
        id: instance.id,
        type: instance.type,
        name: getComponentLabel(instance),
        description: componentCatalog[instance.type]?.description ?? '',
        kind: 'component',
      });
    });

    breadboardState.surfaceGroup.add(group);
    componentRefs.set(instance.id, { group, instance });
    updateComponentPosition(instance.id, layout);
    return componentRefs.get(instance.id);
  }

  function registerPanel() {}


  function createMeasurementEnvironment() {}

function removeComponent(id) {
    const ref = componentRefs.get(id);
    if (!ref) return;
    ref.group.traverse(child => {
      if (child.isMesh) unregisterInteractiveMesh(child);
      if (child.material) unregisterMaterial(child.material);
      if (child.material && child.material.dispose) {
        child.material.dispose();
      }
      if (child.geometry && child.geometry.dispose) {
        child.geometry.dispose();
      }
    });
    breadboardState.surfaceGroup.remove(ref.group);
    componentRefs.delete(id);
  }

  function updateComponentPosition(id, layout) {
    const ref = componentRefs.get(id);
    if (!ref) return;
    const coords = layout[id] ?? generateSpawnCoordinate(0);
    const columns = breadboardState.segments * breadboardState.columnsPerSegment;
    const rows = breadboardState.rowCount;
    const col = clampInt(coords.col ?? 0, 0, columns - 1);
   const row = clampInt(coords.row ?? 0, 0, rows - 1);
    const pos = breadboardState.gridToPosition(col, row);
    const offsetY = componentYOffset(ref.instance.type);
    ref.group.position.set(pos.x, pos.y + offsetY, pos.z);
    ref.group.userData.grid = { col, row };
  }

  function rebuildWires(orderedComponents, layout) {
    wireRefs.forEach(entry => {
      entry.group.traverse(child => {
        if (child.material) unregisterMaterial(child.material);
        if (child.material && child.material.dispose) child.material.dispose();
        if (child.geometry && child.geometry.dispose) child.geometry.dispose();
        unregisterInteractiveMesh(child);
      });
      breadboardState.surfaceGroup.remove(entry.group);
    });
    wireRefs.length = 0;

    if (orderedComponents.length < 2) return;

    const pairs = [];
    for (let i = 0; i < orderedComponents.length - 1; i += 1) {
      pairs.push([orderedComponents[i], orderedComponents[i + 1]]);
    }
    pairs.push([orderedComponents[orderedComponents.length - 1], orderedComponents[0]]);

    pairs.forEach(([from, to], index) => {
      const wireId = `wire-${index}`;
      const group = new THREE.Group();

      const points = computeWirePoints(
        componentRefs.get(from.id)?.group.position,
        componentRefs.get(to.id)?.group.position,
        index,
      );
      if (!points) return;

      const curve = new THREE.CatmullRomCurve3(points);
      const mesh = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 80, 0.022, 16, false),
        new THREE.MeshStandardMaterial({
          color: 0x102347,
          metalness: 0.88,
          roughness: 0.2,
          emissive: 0x081628,
          emissiveIntensity: 0.42,
        }),
      );
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = {
        id: wireId,
        kind: 'wire',
        name: `Trace ${index + 1}`,
        description: `Connects ${getComponentLabel(from)} → ${getComponentLabel(to)}.`,
        wireIndex: index,
      };
      registerInteractiveMesh(mesh, mesh.userData);
      registerMaterial(mesh.material, { componentId: `wire-${index}`, type: 'wire' });

      const dashed = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getSpacedPoints(160)),
        new THREE.LineDashedMaterial({
          color: 0x74d6ff,
          linewidth: 1,
          scale: 1,
          dashSize: 0.08,
          gapSize: 0.05,
          transparent: true,
          opacity: 0.7,
        }),
      );
      dashed.computeLineDistances();

      group.add(mesh);
      group.add(dashed);
      breadboardState.surfaceGroup.add(group);

      wireRefs.push({
        id: wireId,
        group,
        mesh,
        line: dashed,
        index,
        simKey: `wire-${index}`,
        baseSpeed: 1.4 + Math.sin(index * 0.8) * 0.2,
      });
    });
  }

  function sync({ components, layout }) {
    lastSyncPayload = {
      components: components.map(component => ({ ...component })),
      layout: Object.fromEntries(Object.entries(layout).map(([id, coords]) => [id, { ...coords }])),
    };
    const availableIds = new Set();
    components.forEach(component => {
      ensureComponent(component, layout);
      availableIds.add(component.id);
    });
    Array.from(componentRefs.keys()).forEach(id => {
      if (!availableIds.has(id)) removeComponent(id);
    });
    components.forEach(component => updateComponentPosition(component.id, layout));
    rebuildWires(components, layout);
    updateMeasurementPanels(0);
  }

  function toScreenPosition(object) {
    tempBox.setFromObject(object);
    const center = tempBox.getCenter(tempVec);
    statsLabel.sprite.position.copy(center);
    statsLabel.sprite.position.y += 0.28;
  }

  function updateStats(target, lines) {
    if (!statsLabel) return;
    if (!target) {
      statsLabel.sprite.visible = false;
      simulatorState.lastStatsKey = '';
      return;
    }
    statsLabel.sprite.visible = true;
    toScreenPosition(target);
    const key = lines.join('|');
    if (key !== simulatorState.lastStatsKey) {
      drawStatsLabel(statsLabel, target.userData?.name ?? 'Component', lines);
      simulatorState.lastStatsKey = key;
    }
  }

  function updateStatsForFocus() {
    if (!currentFocus) {
      updateStats(null, []);
      return;
    }
    const data = currentFocus.userData;
    if (!data) return;
    let lines = [];
    if (data.kind === 'component') {
      lines = simulator?.getComponentLines(data.id) ?? [];
    } else if (data.kind === 'wire') {
      const wireData = simulator?.getWireData(data.wireIndex) ?? { current: 0 };
      lines = [
        `Current: ${(wireData.current * 1000).toFixed(1)} mA`,
        'Series path between nodes.',
      ];
    }
    updateStats(currentFocus.parent ?? currentFocus, lines);
  }

  function setHover(object) {
    if (currentHover === object) return;
    if (currentHover && currentHover !== currentFocus) {
      setHighlight(currentHover, false);
    }
    currentHover = object;
    if (currentHover && currentHover !== currentFocus) {
      setHighlight(currentHover, true);
    }
  }

  function clearHover() {
    if (currentHover && currentHover !== currentFocus) {
      setHighlight(currentHover, false);
    }
    currentHover = null;
  }

  function setFocus(object) {
    if (currentFocus === object) return;
    if (currentFocus) {
      setHighlight(currentFocus, false, true);
    }
    currentFocus = object;
    simulatorState.lastStatsKey = '';
    if (currentFocus) {
      setHighlight(currentFocus, true, true);
      updateStatsForFocus();
    } else {
      updateStats(null, []);
    }
  }

  function setHighlight(object, enabled, selected = false) {
    if (!object) return;
    const material = object.material;
    if (!material) return;
    if (!material.userData) material.userData = {};

    if (enabled) {
      material.userData.originalEmissive = material.emissive?.clone?.() ?? material.userData.originalEmissive;
      material.userData.originalColor = material.color?.clone?.() ?? material.userData.originalColor;
      if (material.userData.originalEmissiveIntensity === undefined) {
        material.userData.originalEmissiveIntensity =
          material.emissiveIntensity ??
          material.userData.baseEmissiveIntensity ??
          0.35;
      }
      if (material.emissive) {
        material.emissive.setHex(selected ? 0x57acff : 0x2f6ab4);
        const base = material.userData.originalEmissiveIntensity ?? 0.35;
        material.emissiveIntensity = selected ? Math.max(base, 0.95) : Math.max(base, 0.5);
      } else if (material.color) {
        material.color.offsetHSL(0.06, 0.12, 0.15);
      }
    } else {
      if (material.userData.originalEmissive && material.emissive) {
        material.emissive.copy(material.userData.originalEmissive);
        const base =
          material.userData.originalEmissiveIntensity ??
          material.userData.baseEmissiveIntensity ??
          0.35;
        material.emissiveIntensity = base;
      }
      if (material.userData.originalColor && material.color) {
        material.color.copy(material.userData.originalColor);
      }
    }
  }

  function processIntersections(intersections, select) {
    if (intersections.length === 0) {
      if (select) setFocus(null);
      else clearHover();
      return null;
    }
    const { object } = intersections[0];
    if (select) setFocus(object);
    else setHover(object);
    return object;
  }

  function handlePointerMove(event) {
    if (renderer.xr.isPresenting) return;
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);

    if (dragState.active) {
      event.preventDefault();
      if (dragState.target && raycaster.ray.intersectPlane(dragState.plane, dragState.intersection)) {
        const targetPosition = dragState.intersection.clone().add(dragState.offset);
        const grid = breadboardState.positionToGrid(targetPosition.x, targetPosition.z);
        const pos = breadboardState.gridToPosition(grid.col, grid.row);
        const offsetY = componentYOffset(dragState.componentType ?? 'component');
        dragState.target.position.set(pos.x, pos.y + offsetY, pos.z);
        dragState.offset.copy(dragState.target.position).sub(dragState.intersection);

        if (grid.col !== dragState.gridCol || grid.row !== dragState.gridRow) {
          dragState.gridCol = grid.col;
          dragState.gridRow = grid.row;
          onLayoutChange?.(dragState.componentId, { col: grid.col, row: grid.row });
        }
      }
      return;
    }

    processIntersections(raycaster.intersectObjects(interactiveObjects, false), false);
  }

  function handlePointerDown(event) {
    if (renderer.xr.isPresenting) return;
    pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
    raycaster.setFromCamera(pointer, camera);
    const hit = processIntersections(raycaster.intersectObjects(interactiveObjects, false), true);

    if (hit && hit.userData?.kind === 'component' && event.button === 0 && !dragState.active) {
      const entry = componentRefs.get(hit.userData.id);
      if (entry?.group) {
        event.preventDefault();
        dragState.active = true;
        dragState.pointerId = event.pointerId;
        dragState.componentId = entry.instance.id;
        dragState.componentType = entry.instance.type;
        dragState.target = entry.group;
        dragState.plane.set(new THREE.Vector3(0, 1, 0), -entry.group.position.y);
        dragState.gridCol = null;
        dragState.gridRow = null;

        if (raycaster.ray.intersectPlane(dragState.plane, dragState.intersection)) {
          dragState.offset
            .copy(entry.group.position)
            .sub(dragState.intersection);
        } else {
          dragState.offset.set(0, 0, 0);
        }

        controls.enabled = false;
        if (renderer.domElement.setPointerCapture) {
          try {
            renderer.domElement.setPointerCapture(event.pointerId);
          } catch (err) {
            // ignore pointer capture errors
          }
        }
      }
    }
  }

  function handlePointerUp(event) {
    if (!dragState.active || event.pointerId !== dragState.pointerId) return;

    dragState.active = false;
    dragState.pointerId = null;
    dragState.componentId = null;
    dragState.target = null;
    dragState.componentType = null;
    dragState.gridCol = null;
    dragState.gridRow = null;
    dragState.offset.set(0, 0, 0);
    controls.enabled = true;

    if (renderer.domElement.releasePointerCapture) {
      try {
        renderer.domElement.releasePointerCapture(event.pointerId);
      } catch (err) {
        // ignore pointer capture errors
      }
    }
  }

  function handleXRController(controller, select) {
    tempMatrix.identity().extractRotation(controller.matrixWorld);
    const origin = new THREE.Vector3().setFromMatrixPosition(controller.matrixWorld);
    const direction = new THREE.Vector3(0, 0, -1).applyMatrix4(tempMatrix);
    raycaster.ray.origin.copy(origin);
    raycaster.ray.direction.copy(direction);
    processIntersections(raycaster.intersectObjects(interactiveObjects, false), select);
  }

  function animateWires(delta) {
    wireRefs.forEach((entry, index) => {
      const stats = simulator?.getWireData(index) ?? { current: 0, magnitude: 0, direction: 1 };
      const magnitude = Math.abs(stats.current);
      const direction = Math.sign(stats.current) || 1;
      const speed = entry.baseSpeed * (0.5 + magnitude * 6);
      const material = entry.line.material;
      material.dashOffset -= delta * speed * direction;
      material.opacity = THREE.MathUtils.clamp(0.38 + magnitude * 8, 0.4, 0.98);
      const hue = THREE.MathUtils.clamp(0.56 - magnitude * 0.12, 0.42, 0.58);
      const lightness = THREE.MathUtils.clamp(0.39 + magnitude * 1.6, 0.35, 0.8);
      material.color.setHSL(hue, 0.92, lightness);
      if (entry.mesh?.material?.emissive) {
        const base = entry.mesh.material.userData?.baseEmissiveIntensity ?? 0.2;
        entry.mesh.material.emissiveIntensity = THREE.MathUtils.clamp(base + magnitude * 5.2, base, 1.25);
      }
    });
  }

  function pulseComponents(elapsed) {
    const ledBrightness = simulator.getNormalizedValue('ledBrightness');
    const capacitorCharge = simulator.getNormalizedValue('capacitorCharge');
    const resistorHeat = simulator.getNormalizedValue('resistorPower');

    emissiveMaterials.forEach((entry, index) => {
      const { material, type, effect } = entry;
      if (!material) return;

      if (effect === 'ledBulb') {
        const base = material.userData?.baseEmissiveIntensity ?? 1;
        material.emissiveIntensity = THREE.MathUtils.clamp(base + ledBrightness * 1.4, base, base + 2.2);
        if (material.transparent) {
          material.opacity = THREE.MathUtils.clamp(0.45 + ledBrightness * 0.35, 0.45, 0.95);
        }
        return;
      }

      if (!material.emissive) return;

      const base = material.userData?.baseEmissiveIntensity ?? 0.4;
      let target = base + Math.sin(elapsed * 1.6 + index) * 0.05;

      if (type === 'capacitor') {
        target = THREE.MathUtils.clamp(base + capacitorCharge * 0.5, base, base + 0.75);
      } else if (type === 'resistor') {
        target = THREE.MathUtils.clamp(base + resistorHeat * 0.4, base, base + 0.7);
      } else if (type === 'source') {
        target = THREE.MathUtils.clamp(base + ledBrightness * 0.2, base, base + 0.4);
      }

      material.emissiveIntensity = target;
    });
  }

  function updateMeasurementPanels() {}


  const clock = new THREE.Clock();

  function onAnimationFrame() {
    const delta = clock.getDelta();
    const elapsed = clock.elapsedTime;
    simulator.update(delta);
    animateWires(delta);
    pulseComponents(elapsed);
    if (currentFocus) updateStatsForFocus();

    renderer.render(scene, camera);
  }

  renderer.setAnimationLoop(onAnimationFrame);

  renderer.domElement.addEventListener('pointermove', handlePointerMove);
  renderer.domElement.addEventListener('pointerdown', handlePointerDown);
  renderer.domElement.addEventListener('pointerup', handlePointerUp);
  renderer.domElement.addEventListener('pointercancel', handlePointerUp);

  const controller1 = renderer.xr.getController(0);
  const controller2 = renderer.xr.getController(1);
  [controller1, controller2].forEach(controller => {
    if (!controller) return;
    controller.addEventListener('selectstart', event => {
      event.target.userData.isSelecting = true;
      handleXRController(event.target, true);
    });
    controller.addEventListener('selectend', event => {
      event.target.userData.isSelecting = false;
    });
    controller.addEventListener('connected', event => {
      controller.add(createControllerRay(event.data?.gamepad));
    });
    controller.addEventListener('disconnected', () => {
      controller.remove(controller.children[0]);
    });
    scene.add(controller);
    controller.userData.isSelecting = false;
  });

  renderer.xr.addEventListener('sessionstart', () => setFocus(null));
  renderer.xr.addEventListener('sessionend', () => setFocus(null));

  function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  }

  window.addEventListener('resize', onResize);

  return {
    sync,
    dispose() {
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener('pointermove', handlePointerMove);
      renderer.domElement.removeEventListener('pointerdown', handlePointerDown);
      renderer.domElement.removeEventListener('pointerup', handlePointerUp);
      renderer.domElement.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('resize', onResize);
      renderer.dispose();
      if (vrButton.parentElement) vrButton.parentElement.removeChild(vrButton);
    },
  };
}

function ControlDock({
  open,
  components,
  selected,
  onToggle,
  onSelect,
  onParamChange,
  onAddComponent,
  onRemove,
  onMove,
  instructions,
  solverMeta,
}) {
  return (
    <div className={`controls-panel ${open ? 'controls-panel--open' : ''}`}>
      <button className="controls-toggle" type="button" onClick={onToggle}>
        {open ? 'Hide Controls' : 'Show Controls'}
      </button>
      <div className="controls-content">
        <section className="controls-section">
          <h3>Series Components</h3>
          <ul className="component-list">
            {components.map((component, index) => {
              const spec = componentCatalog[component.type];
              return (
                <li
                  key={component.id}
                  className={`component-list__item ${selected?.id === component.id ? 'component-list__item--selected' : ''}`}
                >
                  <button
                    type="button"
                    className="component-list__label"
                    onClick={() => onSelect(component.id)}
                  >
                    <span>{getComponentLabel(component)}</span>
                    <span className="component-list__type">{spec?.label ?? component.type}</span>
                  </button>
                  {component.type !== 'source' && (
                    <div className="component-list__actions">
                      <button type="button" onClick={() => onMove(component.id, -1)} aria-label="Move up">
                        ↑
                      </button>
                      <button type="button" onClick={() => onMove(component.id, 1)} aria-label="Move down">
                        ↓
                      </button>
                      <button type="button" onClick={() => onRemove(component.id)} aria-label="Remove">
                        ✕
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="component-add">
            <span>Add Component:</span>
            <div className="component-add__buttons">
              <button type="button" onClick={() => onAddComponent('resistor')}>+ Resistor</button>
              <button type="button" onClick={() => onAddComponent('capacitor')}>+ Capacitor</button>
              <button type="button" onClick={() => onAddComponent('led')}>+ LED</button>
            </div>
          </div>
        </section>

        {selected && (
          <section className="controls-section">
            <h3>Parameters</h3>
            <ComponentSlider component={selected} onParamChange={onParamChange} />
          </section>
        )}

        <section className="controls-section">
          <h3>Status</h3>
          <div className="solver-status">
            <span className="solver-pill solver-pill--active">Series solver running</span>
            <p className="solver-hint">Advanced circuit solver integration coming soon.</p>
          </div>
        </section>

        <section className="controls-section">
          <h3>Tips</h3>
          <ul className="controls-list">
            {instructions.map(entry => (
              <li key={entry}>{entry}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

function ComponentSlider({ component, onParamChange }) {
  const spec = componentCatalog[component.type];
  if (!spec?.slider) {
    return <p>No adjustable parameters for this component.</p>;
  }
  return (
    <div className="control">
      <label>
        <span>{spec.slider.label}</span>
        <span className="control-value">{spec.slider.format(component.value ?? spec.defaultValue)}</span>
      </label>
      <input
        type="range"
        min={spec.slider.min}
        max={spec.slider.max}
        step={spec.slider.step}
        value={component.value ?? spec.defaultValue}
        onChange={event => onParamChange(component.id, Number(event.target.value))}
      />
    </div>
  );
}

function CircuitMap({ components, layout, selectedId, onSelect, onLayoutChange }) {
  const svgRef = useRef(null);
  const dragRef = useRef(null);

  const layoutEntries = Object.entries(layout ?? {});
  const totalColumns = Math.max(
    latestBoardMeta.columns ?? DEFAULT_TOTAL_COLUMNS,
    ...layoutEntries.map(([, coords]) => (coords?.col ?? 0) + 1),
  );
  const totalRows = latestBoardMeta.rows ?? DEFAULT_TOTAL_ROWS;

  const toSvgCoords = (coords = { col: 0, row: 0 }) => {
    const col = clampInt(coords.col ?? 0, 0, totalColumns - 1);
    const row = clampInt(coords.row ?? 0, 0, totalRows - 1);
    const x = 12 + (totalColumns > 1 ? (col / (totalColumns - 1)) * 76 : 38);
    const y = 12 + (totalRows > 1 ? (row / (totalRows - 1)) * 76 : 38);
    return { x, y };
  };

  const updateCoordinates = (event, id) => {
    if (!svgRef.current) return;
    const rect = svgRef.current.getBoundingClientRect();
    const relativeX = clamp((event.clientX - rect.left - 12) / 76, 0, 1);
    const relativeY = clamp((event.clientY - rect.top - 12) / 76, 0, 1);
    const col = clampInt(Math.round(relativeX * (totalColumns - 1)), 0, totalColumns - 1);
    const row = clampInt(Math.round(relativeY * (totalRows - 1)), 0, totalRows - 1);
    onLayoutChange(id, { col, row });
  };

  const handlePointerMove = event => {
    if (!dragRef.current) return;
    updateCoordinates(event, dragRef.current);
  };

  const handlePointerUp = () => {
    dragRef.current = null;
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
  };

  const handlePointerDown = (event, id) => {
    event.preventDefault();
    dragRef.current = id;
    onSelect(id);
    updateCoordinates(event, id);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp, { once: true });
  };

  const orderedIds = components.map(component => component.id);

  return (
    <div className="map-panel">
      <h3>2D Layout</h3>
      <svg ref={svgRef} viewBox="0 0 100 100" className="map-svg">
        <defs>
          <linearGradient id="board-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="rgba(220, 226, 216, 0.95)" />
            <stop offset="100%" stopColor="rgba(210, 218, 205, 0.95)" />
          </linearGradient>
        </defs>
        <rect x="8" y="12" width="84" height="76" rx="6" ry="6" fill="url(#board-gradient)" className="map-board" />
        {orderedIds.length > 1 &&
          orderedIds.map((id, index) => {
            const nextId = orderedIds[(index + 1) % orderedIds.length];
            const start = toSvgCoords(layout[id]);
            const end = toSvgCoords(layout[nextId]);
            return (
              <line
                key={`${id}-${nextId}`}
                className="map-connection"
                x1={start.x}
                y1={start.y}
                x2={end.x}
                y2={end.y}
              />
            );
          })}
        {orderedIds.map(id => {
          const { x, y } = toSvgCoords(layout[id]);
          return (
            <g key={id}>
              <circle
                className={`map-component ${selectedId === id ? 'map-component--selected' : ''}`}
                cx={x}
                cy={y}
                r="6"
                onPointerDown={event => handlePointerDown(event, id)}
              />
              <text className="map-label" x={x} y={y - 9}>
                {id.toUpperCase()}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="map-hint">Drag nodes to reposition components on the board.</p>
    </div>
  );
}

function createControllerRay(hasGamepad) {
  if (!hasGamepad) {
    return new THREE.Mesh(
      new THREE.BoxGeometry(0.03, 0.03, 0.1),
      new THREE.MeshBasicMaterial({ color: 0x6bb6ff, transparent: true, opacity: 0.4 }),
    );
  }
  const geometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  const material = new THREE.LineBasicMaterial({ color: 0x6bb6ff, transparent: true, opacity: 0.6 });
  const line = new THREE.Line(geometry, material);
  line.name = 'controller-ray';
  line.scale.z = 2.4;
  return line;
}

function createStatsLabel(scene) {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const context = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false });
  material.opacity = 0.96;
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(0.9, 0.45, 0.9);
  sprite.visible = false;
  sprite.renderOrder = 10;
  scene.add(sprite);
  return { canvas, context, texture, sprite };
}

function drawStatsLabel(label, title, lines) {
  const ctx = label.context;
  const { canvas } = label;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(14, 24, 46, 0.88)';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.font = '34px "Segoe UI", sans-serif';
  ctx.fillStyle = '#9fd6ff';
  ctx.textAlign = 'center';
  ctx.fillText(title, canvas.width / 2, 70);
  ctx.font = '26px "Segoe UI", sans-serif';
  ctx.fillStyle = '#d9e6ff';
  lines.forEach((line, index) => {
    ctx.fillText(line, canvas.width / 2, 132 + index * 42);
  });
  label.texture.needsUpdate = true;
}

function createBatteryMesh(label) {
  const group = new THREE.Group();
  const outer = new THREE.Mesh(
    new THREE.CylinderGeometry(0.11, 0.11, 0.36, 36),
    new THREE.MeshStandardMaterial({
      color: 0x2755b5,
      metalness: 0.68,
      roughness: 0.3,
      emissive: 0x0a1c48,
      emissiveIntensity: 0.55,
    }),
  );
  outer.rotation.x = Math.PI / 2;
  group.add(outer);

  const capMaterial = new THREE.MeshStandardMaterial({
    color: 0x8fd8ff,
    metalness: 1,
    roughness: 0.12,
    emissive: 0x1f3c7a,
    emissiveIntensity: 0.58,
  });
  const positiveCap = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.045, 32), capMaterial);
  positiveCap.position.set(0.18, 0, 0);
  positiveCap.rotation.x = Math.PI / 2;
  group.add(positiveCap);
  const negativeCap = positiveCap.clone();
  negativeCap.position.x = -0.18;
  group.add(negativeCap);

  group.rotation.y = Math.PI / 2;
  return group;
}

function createResistorMesh(label) {
  const group = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.09, 0.09, 0.24, 32),
    new THREE.MeshStandardMaterial({
      color: 0xffa149,
      metalness: 0.3,
      roughness: 0.48,
      emissive: 0x351504,
      emissiveIntensity: 0.58,
    }),
  );
  body.rotation.z = Math.PI / 2;
  group.add(body);

  const ringMaterial = new THREE.MeshStandardMaterial({
    color: 0x2a68ff,
    metalness: 0.35,
    roughness: 0.35,
    emissive: 0x102a62,
    emissiveIntensity: 0.6,
  });
  for (let i = -1; i <= 1; i += 1) {
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.092, 0.092, 0.02, 28), ringMaterial);
    ring.rotation.z = Math.PI / 2;
    ring.position.x = i * 0.05;
    group.add(ring);
  }

  const leadMaterial = new THREE.MeshStandardMaterial({
    color: 0xcad5ff,
    metalness: 0.92,
    roughness: 0.22,
  });
  const leadGeometry = new THREE.CylinderGeometry(0.015, 0.015, 0.18, 16);
  const leadLeft = new THREE.Mesh(leadGeometry, leadMaterial);
  leadLeft.position.x = -0.22;
  leadLeft.rotation.z = Math.PI / 2;
  group.add(leadLeft);
  const leadRight = leadLeft.clone();
  leadRight.position.x = 0.22;
  group.add(leadRight);

  return group;
}

function createCapacitorMesh(label) {
  const group = new THREE.Group();
  const shell = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.08, 0.22, 48),
    new THREE.MeshStandardMaterial({
      color: 0x1a3d94,
      metalness: 0.58,
      roughness: 0.18,
      emissive: 0x081c45,
      emissiveIntensity: 0.68,
    }),
  );
  group.add(shell);

  const top = new THREE.Mesh(
    new THREE.CircleGeometry(0.08, 48),
    new THREE.MeshStandardMaterial({
      color: 0x2f6dff,
      metalness: 0.52,
      roughness: 0.32,
      emissive: 0x1b366c,
      emissiveIntensity: 0.5,
    }),
  );
  top.rotation.x = Math.PI / 2;
  top.position.y = 0.11;
  group.add(top);
  const bottom = top.clone();
  bottom.rotation.x = -Math.PI / 2;
  bottom.position.y = -0.11;
  group.add(bottom);

  const leadMaterial = new THREE.MeshStandardMaterial({
    color: 0xd4e3ff,
    metalness: 0.95,
    roughness: 0.24,
  });
  const leadGeometry = new THREE.CylinderGeometry(0.013, 0.013, 0.16, 16);
  const leadLeft = new THREE.Mesh(leadGeometry, leadMaterial);
  leadLeft.position.set(-0.03, -0.19, 0);
  group.add(leadLeft);
  const leadRight = leadLeft.clone();
  leadRight.position.x = 0.03;
  group.add(leadRight);

  return group;
}

function createLEDMesh(label) {
  const group = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.06, 0.06, 32),
    new THREE.MeshStandardMaterial({
      color: 0x0a1730,
      metalness: 0.62,
      roughness: 0.28,
      emissive: 0x060f1d,
      emissiveIntensity: 0.42,
    }),
  );
  group.add(base);

  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.072, 32, 16, 0, Math.PI * 2, 0, Math.PI / 1.22),
    new THREE.MeshStandardMaterial({
      color: 0x37e2ff,
      metalness: 0.28,
      roughness: 0.08,
      transparent: true,
      opacity: 0.9,
      emissive: 0x6cf5ff,
      emissiveIntensity: 1.2,
    }),
  );
  bulb.position.y = 0.09;
  bulb.userData = { effect: 'ledBulb' };
  group.add(bulb);

  const leadMaterial = new THREE.MeshStandardMaterial({
    color: 0xe2ebff,
    metalness: 1,
    roughness: 0.1,
  });
  const leadGeometry = new THREE.CylinderGeometry(0.012, 0.012, 0.14, 12);
  const leadLeft = new THREE.Mesh(leadGeometry, leadMaterial);
  leadLeft.position.set(-0.02, -0.15, 0);
  group.add(leadLeft);
  const leadRight = leadLeft.clone();
  leadRight.position.x = 0.02;
  group.add(leadRight);

  return group;
}

function createPlaceholderMesh(label) {
  const group = new THREE.Group();
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.12, 0.18),
    new THREE.MeshStandardMaterial({
      color: 0x26354a,
      metalness: 0.4,
      roughness: 0.6,
      emissive: 0x111b2e,
      emissiveIntensity: 0.3,
    }),
  );
  group.add(mesh);
  return group;
}

function createMeasurementPanel({ id, title, description, size, position, effect }) {
  const group = new THREE.Group();
  group.position.copy(position);

  const frame = new THREE.Mesh(
    new THREE.PlaneGeometry(size.x + 0.2, size.y + 0.2),
    new THREE.MeshStandardMaterial({
      color: 0xd5dbce,
      metalness: 0.2,
      roughness: 0.6,
      emissive: 0xc7cebf,
      emissiveIntensity: 0.2,
      side: THREE.DoubleSide,
    }),
  );
  frame.position.set(0, 0, -0.03);
  group.add(frame);

  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f1f3eb';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const surface = new THREE.Mesh(
    new THREE.PlaneGeometry(size.x, size.y),
    new THREE.MeshStandardMaterial({
      color: 0xf7f8f3,
      roughness: 0.35,
      metalness: 0.12,
      map: texture,
      emissive: 0xe9ece4,
      emissiveIntensity: 0.18,
      side: THREE.DoubleSide,
    }),
  );
  surface.userData = { effect };
  group.add(surface);

  return {
    id,
    title,
    description,
    size,
    group,
    canvas,
    ctx,
    texture,
    surface,
    effect,
    type: effect === 'oscilloscope' ? 'oscilloscope' : 'multimeter',
    baseZ: position.z,
  };
}

function componentYOffset(type) {
  switch (type) {
    case 'source':
      return 0.045;
    case 'resistor':
      return 0.035;
    case 'capacitor':
      return 0.04;
    case 'led':
      return 0.04;
    default:
      return 0.04;
  }
}

function computeWirePoints(start, end, index) {
  if (!start || !end) return null;
  const s = start.clone();
  const e = end.clone();
  const direction = e.clone().sub(s).normalize();
  const offsetDistance = 0.04;
  const startPoint = s.clone().add(direction.clone().multiplyScalar(offsetDistance));
  const endPoint = e.clone().add(direction.clone().multiplyScalar(-offsetDistance));
  const mid = startPoint.clone().add(endPoint).multiplyScalar(0.5);
  mid.y += 0.08 + Math.sin(index) * 0.03;
  if (direction.lengthSq() > 0.00001) {
    const perp = new THREE.Vector3(-direction.z, 0, direction.x)
      .normalize()
      .multiplyScalar(0.12 * Math.sin(index * 0.7 + 0.5));
    mid.add(perp);
  }
  startPoint.y += 0.008;
  endPoint.y += 0.008;
  return [startPoint, mid, endPoint];
}

function orderComponents(components) {
  const source = components.find(component => component.type === 'source');
  const others = components.filter(component => component !== source);
  return source ? [source, ...others] : components.slice();
}

function insertBeforeLed(list, component) {
  const copy = list.slice();
  const ledIndex = copy.findIndex(item => item.type === 'led' && item !== copy[0]);
  if (ledIndex > 0) {
    copy.splice(ledIndex, 0, component);
  } else {
    copy.push(component);
  }
  return copy;
}

function reorderComponent(list, id, direction) {
  const copy = list.slice();
  const index = copy.findIndex(item => item.id === id);
  if (index <= 0 || index >= copy.length) return copy;
  const targetIndex = clamp(index + direction, 1, copy.length - 1);
  if (index === targetIndex) return copy;
  const [item] = copy.splice(index, 1);
  copy.splice(targetIndex, 0, item);
  return copy;
}

function getComponentLabel(component) {
  const spec = componentCatalog[component.type];
  return `${spec?.label ?? component.type} (${component.id})`;
}

function generateComponentId(type, components) {
  const prefix = type === 'source' ? 'V' : type === 'resistor' ? 'R' : type === 'capacitor' ? 'C' : 'LED';
  let counter = 1;
  while (components.some(component => component.id === `${prefix}${counter}`)) {
    counter += 1;
  }
  return `${prefix}${counter}`;
}

function rehydrateComponents(rawComponents) {
  return rawComponents.map(component => ({
    id: component.id,
    type: component.type,
    value: component.value ?? componentCatalog[component.type]?.defaultValue ?? 0,
  }));
}

function rehydrateLayout(rawLayout, components) {
  const fallback = generateInitialLayout(components);
  if (!rawLayout) return fallback;
  const layout = {};
  components.forEach((component, index) => {
    const stored = rawLayout[component.id];
    if (stored && Number.isFinite(stored.col) && Number.isFinite(stored.row)) {
      layout[component.id] = {
        col: Math.round(stored.col),
        row: Math.round(stored.row),
      };
    } else if (stored && stored.u !== undefined && stored.v !== undefined) {
      layout[component.id] = convertNormalizedToGrid(stored);
    } else {
      layout[component.id] = generateSpawnCoordinate(index);
    }
  });
  return layout;
}

function generateInitialLayout(components) {
  const layout = {};
  components.forEach((component, index) => {
    layout[component.id] = generateSpawnCoordinate(index);
  });
  return layout;
}

function generateSpawnCoordinate(index) {
  const columns = latestBoardMeta.columns ?? DEFAULT_TOTAL_COLUMNS;
  const rows = latestBoardMeta.rows ?? DEFAULT_TOTAL_ROWS;
  const col = clampInt(Math.floor((index * 4) % columns), 0, columns - 1);
  const rowPattern = [2, 3, 6, 7];
  const row = clampInt(rowPattern[index % rowPattern.length] ?? 4, 0, rows - 1);
  return { col, row };
}

function convertNormalizedToGrid({ u, v }) {
  const columns = latestBoardMeta.columns ?? DEFAULT_TOTAL_COLUMNS;
  const rows = latestBoardMeta.rows ?? DEFAULT_TOTAL_ROWS;
  const col = clampInt(Math.round((u - 0.5) * columns + columns / 2), 0, columns - 1);
  const row = clampInt(Math.round((v - 0.5) * rows + rows / 2), 0, rows - 1);
  return { col, row };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value, min, max) {
  return Math.max(min, Math.min(max, Math.round(value)));
}
