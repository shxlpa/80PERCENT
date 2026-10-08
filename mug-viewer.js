import * as THREE from './vendor/three.module.js';
import { STLLoader } from './vendor/STLLoader.js';

const TAU = Math.PI * 2;
const INITIAL_YAW = Math.PI / 3;
const ELEVATION_DEGREES = 14;
const ELEVATION = THREE.MathUtils.degToRad(ELEVATION_DEGREES);

// An angle control should take the shortest route across the 0° / 360° seam.
export function nearestYaw(current, requested) {
  return current + Math.atan2(Math.sin(requested - current), Math.cos(requested - current));
}

/**
 * Mount the original, complete mug scan. The camera is fixed at 14° above the
 * table. Every input changes only the turntable's Y rotation; there is no orbit,
 * vertical drag, zoom, or pan controller.
 */
export function mountMugViewer(container) {
  if (!(container instanceof HTMLElement)) {
    throw new TypeError('mountMugViewer requires a container element.');
  }

  const status = container.querySelector('.viewer-status') || document.createElement('p');
  status.classList.add('viewer-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.textContent = 'Loading the mug…';
  status.hidden = false;
  if (!status.parentNode) container.append(status);
  container.dataset.ready = 'false';
  container.dataset.elevation = String(ELEVATION_DEGREES);
  container.dataset.yaw = String(INITIAL_YAW);
  container.dataset.pitch = '0';

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch (error) {
    status.textContent = 'The 3D view is unavailable in this browser. You can still explore the photographs.';
    container.dataset.error = 'webgl';
    console.error('Mug viewer could not start:', error);
    return { setYaw() {}, reset() {}, dispose() {}, ready: Promise.resolve(false) };
  }

  renderer.setClearColor(0x201819, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.94;

  const canvas = renderer.domElement;
  canvas.classList.add('mug-canvas');
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-roledescription', 'interactive 3D mug');
  canvas.setAttribute('aria-label', 'A three-dimensional scan of a ceramic mug. Click and drag left and right, or drag with a finger, to turn it. Use the left and right arrow keys to rotate, or Home to reset. The viewing angle stays fixed at 14 degrees.');
  canvas.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight Home');
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'pan-y', cursor: 'grab' });
  container.prepend(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-3, 3, 2, -2, 0.1, 30);
  camera.position.set(0, 8 * Math.sin(ELEVATION), 8 * Math.cos(ELEVATION));
  camera.lookAt(0, 0, 0);
  // The camera position and orientation remain fixed for the entire session.

  const turntable = new THREE.Group();
  turntable.rotation.y = INITIAL_YAW;
  scene.add(turntable);
  scene.add(new THREE.HemisphereLight(0xfff5e7, 0x504344, 1.65));

  const keyLight = new THREE.DirectionalLight(0xffead3, 3.3);
  keyLight.position.set(-4, 6, 7);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xe9efff, 1.3);
  fillLight.position.set(5, 2, 3);
  scene.add(fillLight);
  const edgeLight = new THREE.DirectionalLight(0xffd3a2, 2.8);
  edgeLight.position.set(1, 5, -5);
  scene.add(edgeLight);

  const material = new THREE.MeshStandardMaterial({
    color: 0xc7b49b,
    roughness: 0.74,
    metalness: 0.025,
    side: THREE.DoubleSide,
  });

  // A soft, unobtrusive contact shadow keeps the turntable motion grounded.
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const shadowContext = shadowCanvas.getContext('2d');
  const shadowGradient = shadowContext.createRadialGradient(64, 64, 8, 64, 64, 64);
  shadowGradient.addColorStop(0, 'rgba(0,0,0,0.5)');
  shadowGradient.addColorStop(0.45, 'rgba(0,0,0,0.24)');
  shadowGradient.addColorStop(1, 'rgba(0,0,0,0)');
  shadowContext.fillStyle = shadowGradient;
  shadowContext.fillRect(0, 0, 128, 128);
  const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
  const shadowMaterial = new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false });
  const shadowGeometry = new THREE.PlaneGeometry(3.6, 3.6);
  const shadow = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = -1.215;
  scene.add(shadow);

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const abortController = new AbortController();
  let disposed = false;
  let geometry;
  let targetYaw = INITIAL_YAW;
  let frame = 0;
  let lastFrame = 0;
  let visible = true;
  let loaded = false;
  let contextLost = false;
  let dragging = false;
  let activePointer = null;
  let lastPointerX = null;

  function publishState() {
    const yaw = ((turntable.rotation.y % TAU) + TAU) % TAU;
    container.dataset.yaw = yaw.toFixed(6);
    container.dataset.yawDegrees = THREE.MathUtils.radToDeg(yaw).toFixed(2);
    container.dispatchEvent(new CustomEvent('mug:rotate', { detail: { yaw, elevation: ELEVATION_DEGREES } }));
  }

  function requestRender() {
    if (!frame && !disposed && visible && !document.hidden && !contextLost) {
      frame = requestAnimationFrame(render);
    }
  }

  function render(now) {
    frame = 0;
    if (disposed || !visible || document.hidden || contextLost) return;
    const elapsed = lastFrame ? Math.min((now - lastFrame) / 1000, 0.05) : 1 / 60;
    lastFrame = now;
    const difference = targetYaw - turntable.rotation.y;
    if (reducedMotion.matches || Math.abs(difference) < 0.0002) {
      turntable.rotation.y = targetYaw;
    } else {
      turntable.rotation.y += difference * (1 - Math.exp(-13 * elapsed));
    }
    renderer.render(scene, camera);
    publishState();
    if (loaded && container.dataset.ready !== 'true') {
      container.dataset.ready = 'true';
      status.hidden = true;
      container.dispatchEvent(new CustomEvent('mug:ready'));
    }
    if (Math.abs(targetYaw - turntable.rotation.y) >= 0.0002) requestRender();
    else lastFrame = 0;
  }

  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height || disposed) return;
    const aspect = width / height;
    // Keep the complete handle inside the frame through every horizontal turn.
    const viewHeight = Math.max(3.45, 4.75 / aspect);
    camera.left = -viewHeight * aspect / 2;
    camera.right = viewHeight * aspect / 2;
    camera.top = viewHeight / 2;
    camera.bottom = -viewHeight / 2;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    requestRender();
  }

  function setYaw(radians) {
    if (!Number.isFinite(radians) || disposed) return;
    targetYaw = nearestYaw(turntable.rotation.y, radians);
    requestRender();
  }

  function reset() {
    setYaw(INITIAL_YAW);
  }

  function onPointerDown(event) {
    if (event.button !== 0 || activePointer !== null) return;
    activePointer = event.pointerId;
    dragging = true;
    lastPointerX = event.clientX;
    canvas.style.cursor = 'grabbing';
    canvas.setPointerCapture(event.pointerId);
    if (event.pointerType === 'mouse') event.preventDefault();
    canvas.dataset.pointerFocus = 'true';
    canvas.focus({ preventScroll: true });
  }

  function onPointerMove(event) {
    if (!dragging || event.pointerId !== activePointer) return;
    if (lastPointerX !== null) {
      const width = Math.max(canvas.getBoundingClientRect().width, 1);
      // No clientY is read: vertical movement cannot change the viewing angle.
      targetYaw += (event.clientX - lastPointerX) / width * TAU;
      requestRender();
    }
    lastPointerX = event.clientX;
  }

  function onPointerEnd(event) {
    if (event.pointerId !== activePointer) return;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    activePointer = null;
    dragging = false;
    lastPointerX = null;
    canvas.style.cursor = 'grab';
  }

  function onPointerLeave() {
    if (!dragging) lastPointerX = null;
  }

  function onBlur() {
    delete canvas.dataset.pointerFocus;
  }

  function onKeyDown(event) {
    delete canvas.dataset.pointerFocus;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      targetYaw += (event.key === 'ArrowRight' ? 1 : -1) * Math.PI / 12;
      requestRender();
    } else if (event.key === 'Home') {
      event.preventDefault();
      reset();
    }
  }

  function onVisibilityChange() {
    if (document.hidden && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
    } else requestRender();
  }

  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    container.dataset.ready = 'false';
    status.textContent = 'The 3D view paused. Waiting for the graphics connection…';
    status.hidden = false;
  }

  function onContextRestored() {
    contextLost = false;
    requestRender();
  }

  const listeners = [
    ['pointerdown', onPointerDown], ['pointermove', onPointerMove],
    ['pointerup', onPointerEnd], ['pointercancel', onPointerEnd],
    ['lostpointercapture', onPointerEnd], ['pointerleave', onPointerLeave],
    ['blur', onBlur], ['keydown', onKeyDown], ['webglcontextlost', onContextLost],
    ['webglcontextrestored', onContextRestored],
  ];
  listeners.forEach(([name, listener]) => canvas.addEventListener(name, listener));
  document.addEventListener('visibilitychange', onVisibilityChange);
  reducedMotion.addEventListener('change', requestRender);

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  const intersectionObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) requestRender();
  }, { rootMargin: '100px' });
  intersectionObserver.observe(container);
  resize();

  const ready = (async () => {
    try {
      const response = await fetch(new URL('./assets/mug.stl', import.meta.url), { signal: abortController.signal });
      if (!response.ok) throw new Error(`STL request returned ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (disposed) return false;
      geometry = new STLLoader().parse(buffer);
      if (!geometry.attributes.position?.count) throw new Error('The STL contains no geometry.');
      geometry.computeBoundingBox();
      const originalBounds = geometry.boundingBox.clone();
      const height = originalBounds.max.z - originalBounds.min.z;
      if (!(height > 0)) throw new Error('The STL has invalid dimensions.');

      // The scan is upside down in Z-up coordinates. The central circular body
      // is centered on original X/Y=0; including the handle in a bounding-box
      // center would make the mug orbit rather than rotate on its own foot.
      geometry.translate(-(originalBounds.min.x + originalBounds.max.x) / 2, 0,
        -(originalBounds.min.z + originalBounds.max.z) / 2);
      geometry.rotateX(Math.PI / 2);
      const scale = 2.4 / height;
      geometry.scale(scale, scale, scale);
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      const mug = new THREE.Mesh(geometry, material);
      turntable.add(mug);
      container.dataset.triangles = String(geometry.attributes.position.count / 3);
      loaded = true;
      requestRender();
      return true;
    } catch (error) {
      if (disposed || error.name === 'AbortError') return false;
      container.dataset.error = 'load';
      status.textContent = 'The mug could not load. Refresh to try again, or explore the photographs.';
      status.hidden = false;
      console.error('Mug scan could not load:', error);
      return false;
    }
  })();

  function dispose() {
    if (disposed) return;
    disposed = true;
    abortController.abort();
    if (frame) cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    intersectionObserver.disconnect();
    listeners.forEach(([name, listener]) => canvas.removeEventListener(name, listener));
    document.removeEventListener('visibilitychange', onVisibilityChange);
    reducedMotion.removeEventListener('change', requestRender);
    geometry?.dispose();
    material.dispose();
    shadowGeometry.dispose();
    shadowMaterial.dispose();
    shadowTexture.dispose();
    renderer.dispose();
    canvas.remove();
    container.dataset.ready = 'false';
  }

  return { setYaw, reset, dispose, ready };
}
