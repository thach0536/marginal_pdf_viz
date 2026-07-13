try {

// Configuration
const CONFIG = {
    segments: 150, // High resolution for smooth continuous surface
    animationDuration: 3,
};

// Math Utilities
function gaussian1D(x, mu, sigma) {
    return (1 / (sigma * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * Math.pow((x - mu) / sigma, 2));
}

// Distributions
const DISTRIBUTIONS = {
    'gaussian': {
        name: 'Gaussian Mixture',
        domainX: [-4, 4],
        domainZ: [-4, 4],
        joint: (x, z) => {
            const w1 = 0.6;
            const g1 = gaussian1D(x, -1, 1.2) * gaussian1D(z, -1, 1.2);
            const w2 = 0.4;
            const g2 = gaussian1D(x, 1.5, 0.8) * gaussian1D(z, 1.5, 0.8);
            return w1 * g1 + w2 * g2;
        },
        marginal: (x) => {
            const w1 = 0.6;
            const w2 = 0.4;
            return w1 * gaussian1D(x, -1, 1.2) + w2 * gaussian1D(x, 1.5, 0.8);
        },
        inDomain: (x, z) => true,
        getTz: (x, z) => (z + 4) / 8,
        heightScale: 8,
        gridSize: 8
    },
    'paraboloid': {
        name: 'Paraboloid',
        domainX: [-2.1, 2.1],
        domainZ: [-2.1, 2.1],
        joint: (x, z) => {
            const r2 = x*x + z*z;
            if (r2 > 4) return 0;
            return (1 / (8 * Math.PI)) * (4 - r2);
        },
        marginal: (x) => {
            if (x < -2 || x > 2) return 0;
            return (1 / (6 * Math.PI)) * Math.pow(4 - x*x, 1.5);
        },
        inDomain: (x, z) => (x*x + z*z <= 4.0),
        getTz: (x, z) => {
            if (x <= -2 || x >= 2) return 0;
            const bound = Math.sqrt(4 - x*x);
            if (bound < 0.0001) return 0;
            return (z + bound) / (2 * bound);
        },
        heightScale: 15,
        gridSize: 4.2
    }
};

// Color Mapping
function getColor(value, maxVal) {
    const t = Math.min(Math.max(value / maxVal, 0), 1);
    const color = new THREE.Color();
    color.setHSL(0.6 - t * 0.6, 1.0, 0.5); // Blue to Red
    return color;
}

// Three.js Setup
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0f172a);
scene.fog = new THREE.FogExp2(0x0f172a, 0.05);

function getCanvasWidth() {
    return Math.max(window.innerWidth - 400, 400);
}

const camera = new THREE.PerspectiveCamera(45, getCanvasWidth() / window.innerHeight, 0.1, 100);
camera.position.set(0, 10, 14);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(getCanvasWidth(), window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
container.appendChild(renderer.domElement);

const controls = new THREE.OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0, 0);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
dirLight.position.set(5, 10, 15);
scene.add(dirLight);

// Global State
const activeDistributions = [];

function createDistribution(distKey, offsetX, prefix) {
    const dist = DISTRIBUTIONS[distKey];
    const group = new THREE.Group();
    group.position.set(offsetX, 0, 0);
    
    // Axes and Grid
    const axesHelper = new THREE.AxesHelper(3);
    group.add(axesHelper);
    
    const gridHelper = new THREE.GridHelper(dist.gridSize, 20, 0x475569, 0x1e293b);
    gridHelper.position.y = -0.01;
    group.add(gridHelper);
    
    // Label
    const canvas = document.createElement('canvas');
    canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f8fafc';
    ctx.font = '24px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(dist.name, 128, 40);
    
    const labelTex = new THREE.CanvasTexture(canvas);
    const labelMat = new THREE.MeshBasicMaterial({ map: labelTex, transparent: true });
    const labelGeo = new THREE.PlaneGeometry(dist.gridSize, dist.gridSize * (64/256));
    const labelMesh = new THREE.Mesh(labelGeo, labelMat);
    labelMesh.position.set(0, -0.05, dist.gridSize/2 + 1);
    labelMesh.rotation.x = -Math.PI / 2;
    group.add(labelMesh);
    
    // Continuous Solid Volume using BoxGeometry
    // This creates top, bottom, and side faces!
    const baseGeo = new THREE.BoxGeometry(dist.gridSize, 1, dist.gridSize, CONFIG.segments, 1, CONFIG.segments);
    
    // Crop triangles outside the mathematical domain
    const positions = baseGeo.attributes.position;
    let indices;
    if (baseGeo.index) {
        indices = baseGeo.index.array;
    } else {
        indices = [];
        for (let i = 0; i < positions.count; i++) indices.push(i);
    }
    const newIndices = [];
    
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i+1];
        const c = indices[i+2];
        
        const ax = positions.getX(a), az = positions.getZ(a);
        const bx = positions.getX(b), bz = positions.getZ(b);
        const cx = positions.getX(c), cz = positions.getZ(c);
        
        if (dist.inDomain(ax, az) && dist.inDomain(bx, bz) && dist.inDomain(cx, cz)) {
            newIndices.push(a, b, c);
        }
    }
    baseGeo.setIndex(newIndices);
    baseGeo.clearGroups();
    
    const initPositions = new Float32Array(positions.count * 3);
    const targetPositions = new Float32Array(positions.count * 3);
    const initColors = new Float32Array(positions.count * 3);
    const targetColors = new Float32Array(positions.count * 3);
    
    let maxPdf = 0;
    for (let i = 0; i < positions.count; i++) {
        if (positions.getY(i) > 0) { // Only sample max from top vertices
            maxPdf = Math.max(maxPdf, dist.joint(positions.getX(i), positions.getZ(i)));
        }
    }
    
    const singleColor = new THREE.Color(0x3b82f6); // Solid blue for 2D plane
    
    for (let i = 0; i < positions.count; i++) {
        const x = positions.getX(i);
        const z = positions.getZ(i);
        const origY = positions.getY(i);
        
        let initY = 0;
        let targetY = 0;
        let c = new THREE.Color(0,0,0);
        
        const jointVal = dist.joint(x, z);
        
        if (origY > 0) {
            // Top Vertices: Take the height of the PDF
            initY = Math.max(jointVal * dist.heightScale, 0.005); // Tiny base to prevent degenerate faces
            
            // Target: Map to the filled area under the marginal PDF
            const tz = dist.getTz(x, z);
            targetY = tz * dist.marginal(x) * dist.heightScale;
            
            c = getColor(jointVal, maxPdf);
        } else {
            // Bottom Vertices: Rest flat on the ground
            initY = 0;
            targetY = 0; // Stays at ground level even when compressed
            
            // Slightly darker color for the bottom and sides
            c = getColor(jointVal, maxPdf).multiplyScalar(0.4);
        }
        
        positions.setY(i, initY);
        
        initPositions[i*3] = x;
        initPositions[i*3+1] = initY;
        initPositions[i*3+2] = z;
        
        targetPositions[i*3] = x;
        targetPositions[i*3+1] = targetY;
        targetPositions[i*3+2] = 0; // Compress along Z axis
        
        initColors[i*3] = c.r;
        initColors[i*3+1] = c.g;
        initColors[i*3+2] = c.b;
        
        targetColors[i*3] = singleColor.r;
        targetColors[i*3+1] = singleColor.g;
        targetColors[i*3+2] = singleColor.b;
    }
    
    baseGeo.setAttribute('color', new THREE.Float32BufferAttribute(initColors, 3));
    baseGeo.computeVertexNormals();
    
    const material = new THREE.MeshStandardMaterial({
        vertexColors: true,
        side: THREE.DoubleSide, // DoubleSide ensures it remains visible after flattening and rotating
        transparent: true,
        opacity: 0.95,
        roughness: 0.3,
        metalness: 0.1
    });
    
    const surface = new THREE.Mesh(baseGeo, material);
    group.add(surface);
    
    // Outline plane for Marginal PDF background
    const planeGeo = new THREE.PlaneGeometry(dist.gridSize, dist.heightScale * 3);
    const planeMat = new THREE.MeshBasicMaterial({ 
        color: 0xffffff, 
        side: THREE.DoubleSide, 
        transparent: true, 
        opacity: 0.05 
    });
    const projectionPlane = new THREE.Mesh(planeGeo, planeMat);
    projectionPlane.position.set(0, (dist.heightScale * 3) / 2, -0.05); 
    group.add(projectionPlane);
    
    scene.add(group);
    
    const distObj = {
        surface: surface,
        initPositions: initPositions,
        targetPositions: targetPositions,
        initColors: initColors,
        targetColors: targetColors,
        animState: { t: 0 },
        tween: null,
        btnAnimate: document.getElementById(`btn-animate-${prefix}`),
        btnReset: document.getElementById(`btn-reset-${prefix}`)
    };
    
    setupControls(distObj);
    activeDistributions.push(distObj);
}

function updateGeometry(dist) {
    const t = dist.animState.t;
    const positions = dist.surface.geometry.attributes.position;
    const colors = dist.surface.geometry.attributes.color;
    
    for (let i = 0; i < positions.count; i++) {
        const initX = dist.initPositions[i * 3];
        const initY = dist.initPositions[i * 3 + 1];
        const initZ = dist.initPositions[i * 3 + 2];
        
        const targetX = dist.targetPositions[i * 3];
        const targetY = dist.targetPositions[i * 3 + 1];
        const targetZ = dist.targetPositions[i * 3 + 2];
        
        positions.setX(i, THREE.MathUtils.lerp(initX, targetX, t));
        positions.setY(i, THREE.MathUtils.lerp(initY, targetY, t));
        positions.setZ(i, THREE.MathUtils.lerp(initZ, targetZ, t));
        
        const initR = dist.initColors[i * 3];
        const initG = dist.initColors[i * 3 + 1];
        const initB = dist.initColors[i * 3 + 2];
        
        const targetR = dist.targetColors[i * 3];
        const targetG = dist.targetColors[i * 3 + 1];
        const targetB = dist.targetColors[i * 3 + 2];
        
        colors.setX(i, THREE.MathUtils.lerp(initR, targetR, t));
        colors.setY(i, THREE.MathUtils.lerp(initG, targetG, t));
        colors.setZ(i, THREE.MathUtils.lerp(initB, targetB, t));
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    dist.surface.geometry.computeVertexNormals();
}

function setupControls(dist) {
    dist.btnAnimate.addEventListener('click', () => {
        if (dist.tween) dist.tween.kill();
        dist.btnAnimate.disabled = true;
        dist.btnReset.disabled = false;
        
        dist.tween = gsap.to(dist.animState, {
            t: 1,
            duration: CONFIG.animationDuration,
            ease: "power2.inOut",
            onUpdate: () => updateGeometry(dist)
        });
    });

    dist.btnReset.addEventListener('click', () => {
        if (dist.tween) dist.tween.kill();
        dist.btnReset.disabled = true;
        dist.btnAnimate.disabled = false;
        
        dist.tween = gsap.to(dist.animState, {
            t: 0,
            duration: CONFIG.animationDuration,
            ease: "power2.inOut",
            onUpdate: () => updateGeometry(dist)
        });
    });
}

// Window Resize Handling
window.addEventListener('resize', () => {
    const newWidth = getCanvasWidth();
    camera.aspect = newWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(newWidth, window.innerHeight);
});

// Render Loop
function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
}

// Create both distributions side by side, slightly closer
createDistribution('gaussian', -4.5, 'gaussian');
createDistribution('paraboloid', 4.5, 'paraboloid');

animate();

} catch (e) {
    const errDiv = document.createElement('div');
    errDiv.style.position = 'absolute';
    errDiv.style.top = '10px';
    errDiv.style.right = '10px';
    errDiv.style.backgroundColor = 'rgba(255,0,0,0.9)';
    errDiv.style.color = 'white';
    errDiv.style.padding = '20px';
    errDiv.style.zIndex = '9999';
    errDiv.style.maxWidth = '800px';
    errDiv.innerHTML = '<strong>' + e.name + ': ' + e.message + '</strong><br><pre>' + e.stack + '</pre>';
    document.body.appendChild(errDiv);
}
