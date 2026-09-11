// Illustrative procedural motion; never used as recorded simulation evidence.
import * as T from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
export function heroMarkup(): string {
    return `<figure class="robot-study" aria-label="Illustrative humanoid robot motion study">
    <div class="study-heading"><span>FIG. 01 / HUMANOID STUDY</span><span class="study-live"><i></i>FORM + MOTION</span></div>
    <div class="study-stage">
      <svg class="study-fallback" viewBox="0 0 460 480" aria-hidden="true">
        <g fill="none" stroke="#c6c0b5"><ellipse cx="230" cy="412" rx="155" ry="40"/><path d="M48 412h364M230 50v398" stroke-dasharray="4 6"/></g>
        <g fill="#eeebe4" stroke="#77736b" stroke-width="2" stroke-linejoin="round"><rect x="201" y="62" width="58" height="63" rx="20"/><path d="M207 136h46l24 28-15 97h-64l-15-97z"/><rect x="210" y="259" width="40" height="28" rx="8"/><path d="m187 158-25 5-19 77 20 5 24-56m86-31 25 5 19 77-20 5-24-56M150 248l-9 68 17 2 11-68m131-2 9 68-17 2-11-68M200 285l-9 62 25 3 11-63m7 0 11 63 25-3-9-62M193 356l-7 55h31l1-56m28 0 1 56h31l-7-55"/></g>
        <path d="M212 87h36" stroke="#403f3a" stroke-width="12" stroke-linecap="round"/><circle cx="231" cy="185" r="7" fill="#bb703a"/>
      </svg><div class="study-render" aria-hidden="true"></div>
      <span class="study-annotation study-annotation-top">01 — articulated form</span><span class="study-annotation study-annotation-bottom">02 — balance in motion</span>
    </div>
    <div class="study-controls"><div class="study-modes" role="group" aria-label="Robot appearance"><button type="button" data-study-mode="solid" aria-pressed="true">Solid</button><button type="button" data-study-mode="sketch" aria-pressed="false">Sketch</button></div><button type="button" class="study-pause" aria-label="Pause robot animation">Pause <span aria-hidden="true">Ⅱ</span></button></div>
    <figcaption>Procedural motion study · illustrative, not a simulation replay</figcaption>
  </figure>`;
}
let cleanup: (() => void) | undefined;
// Greet once per page load, rather than every time the visitor returns from a finding.
let greeted = false;
export function disposeHero(): void { cleanup?.(); cleanup = undefined; }
export function mountHero(root: HTMLElement): void {
    disposeHero();
    const host = root.querySelector<HTMLElement>('.study-render'), figure = root.querySelector<HTMLElement>('.robot-study');
    if (!host || !figure)
        return;
    const pause = figure.querySelector<HTMLButtonElement>('.study-pause')!;
    const modes = [...figure.querySelectorAll<HTMLButtonElement>('[data-study-mode]')];
    let renderer: T.WebGLRenderer;
    try {
        renderer = new T.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' });
    }
    catch {
        pause.disabled = true;
        modes.forEach(b => b.disabled = true);
        return;
    }
    renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
    renderer.setClearColor(0, 0);
    renderer.outputColorSpace = T.SRGBColorSpace;
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = T.PCFSoftShadowMap;
    host.append(renderer.domElement);
    figure.classList.add('study-ready');
    const scene = new T.Scene(), camera = new T.PerspectiveCamera(30, 1, .1, 50);
    // The replay changes the global default to z-up. Keep this study explicitly y-up.
    camera.up.set(0, 1, 0);
    camera.position.set(3, 2.45, 6);
    camera.lookAt(0, 1.65, 0);
    scene.add(new T.HemisphereLight(0xffffff, 0x817765, 2.8));
    const light = new T.DirectionalLight(0xfff4df, 4.2);
    light.position.set(-3, 6, 5);
    light.castShadow = true;
    light.shadow.mapSize.set(1024, 1024);
    Object.assign(light.shadow.camera, { left: -3, right: 3, top: 4, bottom: -3, near: .1, far: 15 });
    light.shadow.normalBias = .035;
    light.shadow.bias = -.0001;
    scene.add(light);
    const rim = new T.DirectionalLight(0xe6eeff, 2.5);
    rim.position.set(4, 3, -4);
    scene.add(rim);
    const shell = new T.MeshStandardMaterial({ color: 0xd9d5ca, roughness: .38, metalness: .32 });
    const joint = new T.MeshStandardMaterial({ color: 0x333735, roughness: .58, metalness: .45 });
    const accent = new T.MeshStandardMaterial({ color: 0xb87544, roughness: .42, metalness: .4 });
    const visor = new T.MeshStandardMaterial({ color: 0x202724, roughness: .22, metalness: .6 });
    const materials = [shell, joint, accent, visor], geometries = new Set<T.BufferGeometry>();
    function mesh(g: T.BufferGeometry, m: T.Material, p: T.Object3D, x = 0, y = 0, z = 0): T.Mesh {
        geometries.add(g);
        const o = new T.Mesh(g, m);
        o.position.set(x, y, z);
        o.castShadow = true;
        p.add(o);
        return o;
    }
    function box(p: T.Object3D, w: number, h: number, d: number, m: T.Material, x = 0, y = 0, z = 0, r = .05): T.Mesh { return mesh(new RoundedBoxGeometry(w, h, d, 3, r), m, p, x, y, z); }
    function ball(p: T.Object3D, r: number, x = 0, y = 0, z = 0): void { mesh(new T.SphereGeometry(r, 20, 12), joint, p, x, y, z); }
    function pivot(p: T.Object3D, x: number, y: number, z = 0): T.Group { const g = new T.Group(); g.position.set(x, y, z); p.add(g); return g; }
    const robot = new T.Group();
    scene.add(robot);
    const hips = pivot(robot, 0, 1.59);
    box(hips, .57, .24, .34, joint);
    box(hips, .63, .18, .38, shell, 0, .045);
    const torso = pivot(hips, 0, .15);
    box(torso, .62, .56, .35, shell, 0, .37, 0, .1);
    box(torso, .77, .23, .39, shell, 0, .63, 0, .09);
    box(torso, .32, .25, .29, joint, 0, .025, 0, .035);
    for (let i = 0; i < 3; i++)
        box(torso, .3, .025, .31, shell, 0, -.01 + i * .065, 0, .01);
    box(torso, .38, .21, .025, accent, 0, .57, .204, .03);
    for (let i = 0; i < 3; i++)
        box(torso, .15, .014, .014, joint, 0, .57 + i * .035, .222, .005);
    ball(torso, .115, 0, .83);
    const head = pivot(torso, 0, .98);
    box(head, .35, .4, .33, shell, 0, 0, 0, .095);
    box(head, .31, .105, .04, visor, 0, .035, .16, .03);
    box(head, .1, .018, .012, accent, .065, .035, .188, .004);
    for (const side of [-1, 1])
        mesh(new T.CylinderGeometry(.083, .083, .05, 24), joint, head, side * .188).rotation.z = Math.PI / 2;
    const arms: {
        shoulder: T.Group;
        elbow: T.Group;
        wrist: T.Group;
    }[] = [], legs: {
        hip: T.Group;
        knee: T.Group;
        ankle: T.Group;
    }[] = [];
    for (const side of [-1, 1]) {
        const shoulder = pivot(torso, side * .47, .63);
        ball(shoulder, .13);
        box(shoulder, .22, .21, .27, shell, side * .025, -.03, 0, .075);
        box(shoulder, .175, .4, .2, shell, 0, -.3, 0, .065);
        const elbow = pivot(shoulder, 0, -.55);
        ball(elbow, .105);
        box(elbow, .2, .37, .22, shell, 0, -.25, .01, .065);
        box(elbow, .115, .14, .02, accent, 0, -.27, .126, .025);
        const wrist = pivot(elbow, 0, -.49);
        ball(wrist, .075);
        box(wrist, .15, .17, .105, joint, 0, -.1, 0, .035);
        for (let i = 0; i < 3; i++)
            box(wrist, .035, .115, .06, shell, (i - 1) * .049, -.23, .008, .015);
        box(wrist, .05, .12, .06, shell, side * .105, -.13, .035, .02).rotation.z = side * .4;
        arms.push({ shoulder, elbow, wrist });
        const hip = pivot(hips, side * .205, -.13);
        ball(hip, .13);
        box(hip, .245, .53, .27, shell, 0, -.34, 0, .075);
        box(hip, .06, .25, .02, accent, side * .068, -.3, .147, .018);
        const knee = pivot(hip, 0, -.68);
        ball(knee, .112);
        box(knee, .22, .16, .12, shell, 0, 0, .105, .045);
        box(knee, .2, .47, .23, shell, 0, -.31, 0, .06);
        const ankle = pivot(knee, 0, -.57);
        ball(ankle, .087);
        box(ankle, .26, .135, .47, shell, 0, -.095, .09, .045);
        box(ankle, .27, .04, .46, joint, 0, -.167, .09, .015);
        hip.rotation.z = -side * .04;
        legs.push({ hip, knee, ankle });
    }
    const floorMat = new T.ShadowMaterial({ opacity: .12 });
    const floor = mesh(new T.PlaneGeometry(20, 20), floorMat, scene, 0, .005);
    floor.rotation.x = -Math.PI / 2;
    floor.castShadow = false;
    floor.receiveShadow = true;
    const grid = new T.GridHelper(4.5, 18, 0xc5c0b7, 0xe1ddd4);
    grid.position.y = -.005;
    scene.add(grid);
    const ringMat = new T.MeshBasicMaterial({ color: 0xb8afa0, side: T.DoubleSide, transparent: true, opacity: .6 });
    const ring = mesh(new T.RingGeometry(1.59, 1.598, 128), ringMat, scene);
    ring.rotation.x = -Math.PI / 2;
    ring.castShadow = false;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let greetingEnabled = !greeted && !reduced.matches;
    let paused = reduced.matches, visible = true, disposed = false, raf = 0, elapsed = 0, previous = 0, pointerX = 0, yaw = 0;
    function draw(): void {
        const sway = Math.sin(elapsed * .85);
        hips.rotation.z = sway * .028;
        torso.rotation.z = -sway * .045;
        torso.rotation.y = Math.sin(elapsed * .45) * .035;
        head.rotation.y = Math.sin(elapsed * .42) * .13;
        for (let i = 0; i < 2; i++) {
            const side = i === 0 ? -1 : 1;
            arms[i].shoulder.rotation.x = .08 + Math.sin(elapsed * .85 + side) * .075;
            arms[i].shoulder.rotation.z = side * (.15 + sway * .025);
            arms[i].elbow.rotation.x = -.22 + Math.sin(elapsed * .85 + side) * .055;
            arms[i].elbow.rotation.z = 0;
            arms[i].wrist.rotation.z = 0;
            legs[i].hip.rotation.x = -.045 + Math.sin(elapsed * .85 + side) * .018;
            legs[i].knee.rotation.x = .1;
            legs[i].ankle.rotation.x = -.055;
        }
        // Ease the right arm up, give three small waves, then blend back into the idle pose.
        // Uses the animation clock so pausing, a hidden tab, or scrolling offscreen also pauses
        // the greeting. No timers or additional animation loops survive navigation.
        if (greetingEnabled && elapsed < 3.8) {
            const lift = T.MathUtils.smoothstep(elapsed, .25, 1.05);
            const lower = 1 - T.MathUtils.smoothstep(elapsed, 2.95, 3.8);
            const blend = lift * lower;
            const waveWindow = T.MathUtils.smoothstep(elapsed, 1.05, 1.3)
                * (1 - T.MathUtils.smoothstep(elapsed, 2.7, 2.95));
            const wave = Math.sin((elapsed - 1.05) * Math.PI * 3.2) * waveWindow;
            const arm = arms[1];
            arm.shoulder.rotation.z = T.MathUtils.lerp(arm.shoulder.rotation.z, .95, blend);
            arm.shoulder.rotation.x = T.MathUtils.lerp(arm.shoulder.rotation.x, -.18, blend);
            arm.elbow.rotation.x = T.MathUtils.lerp(arm.elbow.rotation.x, 0, blend);
            arm.elbow.rotation.z = (1.8 + wave * .16) * blend;
            arm.wrist.rotation.z = wave * .25 * blend;
            head.rotation.z = -.055 * blend;
            if (blend > 0) greeted = true;
        } else {
            head.rotation.z = 0;
        }
        yaw += (pointerX * .23 - yaw) * .055;
        robot.rotation.y = -.18 + yaw;
        renderer.render(scene, camera);
    }
    function frame(now: number): void { raf = 0; if (disposed || paused || !visible || document.hidden) {
        previous = 0;
        return;
    } if (previous)
        elapsed += Math.min((now - previous) / 1000, .05); previous = now; draw(); raf = requestAnimationFrame(frame); }
    function sync(): void {
        pause.innerHTML = paused ? 'Play <span aria-hidden="true">▷</span>' : 'Pause <span aria-hidden="true">Ⅱ</span>';
        pause.setAttribute('aria-label', paused ? 'Play robot animation' : 'Pause robot animation');
        cancelAnimationFrame(raf);
        raf = 0;
        previous = 0;
        if (!paused && visible && !document.hidden && !disposed)
            raf = requestAnimationFrame(frame);
    }
    const onPause = () => { paused = !paused; sync(); };
    const onMotion = () => {
        paused = reduced.matches;
        if (reduced.matches) { greetingEnabled = false; draw(); }
        sync();
    };
    const onPointer = (e: PointerEvent) => {
        if (e.pointerType === 'touch' || reduced.matches || paused) return;
        const bounds = host.getBoundingClientRect();
        pointerX = (e.clientX - bounds.left) / bounds.width * 2 - 1;
    };
    const onLeave = () => { pointerX = 0; };
    const onMode = (e: Event) => {
        const sketch = (e.currentTarget as HTMLElement).dataset.studyMode === 'sketch';
        materials.forEach(material => { material.wireframe = sketch; });
        modes.forEach(button => button.setAttribute('aria-pressed', String((button.dataset.studyMode === 'sketch') === sketch)));
        draw();
    };
    pause.addEventListener('click', onPause);
    modes.forEach(b => b.addEventListener('click', onMode));
    host.addEventListener('pointermove', onPointer);
    host.addEventListener('pointerleave', onLeave);
    reduced.addEventListener('change', onMotion);
    document.addEventListener('visibilitychange', sync);
    const resize = new ResizeObserver(() => {
        const width = host.clientWidth, height = host.clientHeight;
        if (!width || !height || disposed) return;
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
        draw();
    });
    resize.observe(host);
    const intersection = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; sync(); });
    intersection.observe(figure);
    const lost = (e: Event) => { e.preventDefault(); disposeHero(); };
    renderer.domElement.addEventListener('webglcontextlost', lost);
    draw();
    sync();
    cleanup = () => {
        disposed = true;
        cancelAnimationFrame(raf);
        resize.disconnect();
        intersection.disconnect();
        pause.removeEventListener('click', onPause);
        modes.forEach(b => b.removeEventListener('click', onMode));
        host.removeEventListener('pointermove', onPointer);
        host.removeEventListener('pointerleave', onLeave);
        reduced.removeEventListener('change', onMotion);
        document.removeEventListener('visibilitychange', sync);
        renderer.domElement.removeEventListener('webglcontextlost', lost);
        geometries.forEach(g => g.dispose());
        materials.forEach(m => m.dispose());
        floorMat.dispose();
        ringMat.dispose();
        grid.geometry.dispose();
        (Array.isArray(grid.material) ? grid.material : [grid.material]).forEach(m => m.dispose());
        light.shadow.map?.dispose();
        renderer.forceContextLoss();
        renderer.dispose();
        renderer.domElement.remove();
        figure.classList.remove('study-ready');
        pause.disabled = true;
        modes.forEach(b => b.disabled = true);
    };
}
