// Neon City — GTA-style 3D open world. Three.js r160 (CDN, jsDelivr fallback).
// Plain static page, all art made in code. Third-person on foot + drivable car,
// deliveries, cash pickups, traffic, pedestrians, minimap, particles, shadows.
(function () {
  'use strict';

  var WIN_MONEY = 5000;
  var DELIVERY_PAY = 1000;
  var STREET = [-130, -78, -26, 26, 78, 130];
  var PITCH = 52, BLOCK = 40;

  var canvas = document.getElementById('game');
  var mini = document.getElementById('minimap');
  var mctx = mini.getContext('2d');
  var overlay = document.getElementById('overlay');
  var panelTitle = document.getElementById('panel-title');
  var panelText = document.getElementById('panel-text');
  var startBtn = document.getElementById('start-btn');
  var toastEl = document.getElementById('toast');
  var promptEl = document.getElementById('prompt');
  var moneyEl = document.getElementById('hud-money');
  var delivEl = document.getElementById('hud-deliveries');
  var hpEl = document.getElementById('hud-hp');
  var speedEl = document.getElementById('hud-speed');
  var sensInput = document.getElementById('set-sens');
  var sensVal = document.getElementById('sens-val');
  var volInput = document.getElementById('set-vol');
  var volVal = document.getElementById('vol-val');
  var qualityInput = document.getElementById('set-quality');

  var state = 'title'; // title | playing | paused | won | over
  var money = 0, deliveries = 0, hp = 100, best = 0;
  try { best = parseInt(localStorage.getItem('neon-city-best') || '0', 10) || 0; } catch (e) { best = 0; }
  var muted = false;
  var sens = 1, volume = 0.8, quality = 'auto';
  try {
    sens = parseFloat(localStorage.getItem('neon-city-sens') || '1') || 1;
    volume = parseFloat(localStorage.getItem('neon-city-vol') || '0.8');
    quality = localStorage.getItem('neon-city-quality') || 'auto';
  } catch (e) {}
  sensInput.value = sens; sensVal.textContent = sens.toFixed(1) + 'x';
  volInput.value = volume; volVal.textContent = Math.round(volume * 100) + '%';
  qualityInput.value = quality;

  var isMobile = window.innerWidth < 768 || ('ontouchstart' in window);
  var highQ = quality === 'high' || (quality === 'auto' && !isMobile);

  var keys = {};
  var camYaw = Math.PI, camPitch = 0.32; // behind player, looking north
  var carrying = false;
  var crashCooldown = 0, hurtCooldown = 0, toastTimer = null;
  var touchMove = { active: false, id: null, dx: 0, dy: 0, sx: 0, sy: 0 };

  // ---------- audio ----------
  var audioCtx = null, engineOsc = null, engineGain = null;
  function beep(freq, dur, type, vol) {
    if (muted) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume();
      var o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = type || 'sine'; o.frequency.value = freq;
      g.gain.value = (vol || 0.07) * volume;
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + dur);
    } catch (e) {}
  }
  function engineStart() {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (engineOsc) return;
      engineOsc = audioCtx.createOscillator(); engineGain = audioCtx.createGain();
      engineOsc.type = 'sawtooth'; engineOsc.frequency.value = 50;
      engineGain.gain.value = 0.0;
      engineOsc.connect(engineGain); engineGain.connect(audioCtx.destination);
      engineOsc.start();
    } catch (e) {}
  }
  function engineUpdate(speed, inCar) {
    if (!engineOsc || !engineGain) return;
    var target = (state === 'playing' && inCar && !muted) ? 0.02 + Math.min(0.05, speed * 0.0012) : 0;
    engineGain.gain.value += (target - engineGain.gain.value) * 0.1;
    engineOsc.frequency.value = 45 + speed * 2.2;
  }

  // ---------- three setup ----------
  var renderer, scene, camera, sun;
  var colliders = [];
  var traffic = [], peds = [], cashDrops = [];
  var player, heroCar, playerMesh, carMesh;
  var pickupMarker, destMarker, beaconLight;
  var particles, pData;
  var clock = null;

  function canvasTexture(w, h, draw) {
    var c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    var t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  function buildingTexture(base, litRatio) {
    return canvasTexture(128, 256, function (g, w, h) {
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      for (var y = 8; y < h - 8; y += 18) {
        for (var x = 8; x < w - 8; x += 16) {
          var lit = Math.random() < litRatio;
          g.fillStyle = lit ? (Math.random() < 0.7 ? '#ffd166' : '#7ee7ff') : '#10131f';
          g.fillRect(x, y, 10, 12);
        }
      }
      g.fillStyle = 'rgba(255,255,255,0.08)'; g.fillRect(0, 0, w, 4);
    });
  }
  function groundTexture() {
    return canvasTexture(1024, 1024, function (g, w, h) {
      var S = w / 320; // px per world unit, world -160..160
      var X = function (v) { return (v + 160) * S; };
      g.fillStyle = '#232634'; g.fillRect(0, 0, w, h); // sidewalk base
      // blocks
      g.fillStyle = '#2e3247';
      for (var bx = -2; bx <= 2; bx++) for (var bz = -2; bz <= 2; bz++) {
        g.fillRect(X(bx * PITCH - BLOCK / 2), X(bz * PITCH - BLOCK / 2), BLOCK * S, BLOCK * S);
      }
      // roads
      g.fillStyle = '#12131c';
      STREET.forEach(function (s) {
        g.fillRect(0, X(s - 6), w, 12 * S);
        g.fillRect(X(s - 6), 0, 12 * S, h);
      });
      // lane dashes
      g.fillStyle = '#e8c33a';
      STREET.forEach(function (s) {
        for (var d = -150; d < 160; d += 16) {
          g.fillRect(X(d), X(s - 0.5), 8 * S, 1 * S);
          g.fillRect(X(s - 0.5), X(d), 1 * S, 8 * S);
        }
      });
      // crosswalks
      g.fillStyle = 'rgba(255,255,255,0.75)';
      STREET.forEach(function (sx) { STREET.forEach(function (sz) {
        for (var i = -2; i <= 2; i++) {
          g.fillRect(X(sx + i * 2.4 - 1), X(sz - 6), 2 * S, 3 * S);
          g.fillRect(X(sx + i * 2.4 - 1), X(sz + 3), 2 * S, 3 * S);
        }
      }); });
    });
  }
  function skyTexture() {
    return canvasTexture(64, 512, function (g, w, h) {
      var gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#05051a'); gr.addColorStop(0.55, '#1b1445');
      gr.addColorStop(0.78, '#7a2a6d'); gr.addColorStop(0.92, '#ff7e5f'); gr.addColorStop(1, '#2a1a3a');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
  }

  function makeCar(color, hero) {
    var grp = new THREE.Group();
    var paint = new THREE.MeshStandardMaterial({ color: color, metalness: 0.75, roughness: 0.3 });
    var body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.65, 4.4), paint);
    body.position.y = 0.55; body.castShadow = true; grp.add(body);
    var cabin = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.6, 2.1),
      new THREE.MeshStandardMaterial({ color: 0x0d1526, metalness: 0.4, roughness: 0.15 }));
    cabin.position.set(0, 1.15, -0.3); cabin.castShadow = true; grp.add(cabin);
    var wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 14);
    var wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.9 });
    [[-0.95, 1.45], [0.95, 1.45], [-0.95, -1.45], [0.95, -1.45]].forEach(function (p) {
      var wh = new THREE.Mesh(wheelGeo, wheelMat);
      wh.rotation.z = Math.PI / 2; wh.position.set(p[0], 0.42, p[1]); wh.castShadow = true;
      grp.add(wh);
    });
    var hl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.1),
      new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2b0, emissiveIntensity: 2 }));
    hl.position.set(0, 0.6, 2.22); grp.add(hl);
    var tl = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.18, 0.1),
      new THREE.MeshStandardMaterial({ color: 0x660000, emissive: 0xff2222, emissiveIntensity: 1.6 }));
    tl.position.set(0, 0.6, -2.22); grp.add(tl);
    if (hero) {
      var stripe = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.05, 4.42),
        new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.6, roughness: 0.3 }));
      stripe.position.y = 0.9; grp.add(stripe);
    }
    return grp;
  }
  function makePerson(shirt, pants) {
    var grp = new THREE.Group();
    var body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.9, 0.4),
      new THREE.MeshStandardMaterial({ color: shirt, roughness: 0.8 }));
    body.position.y = 1.15; body.castShadow = true; grp.add(body);
    var head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 10),
      new THREE.MeshStandardMaterial({ color: 0xe8b98a, roughness: 0.7 }));
    head.position.y = 1.85; head.castShadow = true; grp.add(head);
    var legMat = new THREE.MeshStandardMaterial({ color: pants, roughness: 0.9 });
    var l1 = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.7, 0.3), legMat);
    l1.position.set(-0.18, 0.35, 0); grp.add(l1);
    var l2 = l1.clone(); l2.position.x = 0.18; grp.add(l2);
    grp.userData.legs = [l1, l2];
    return grp;
  }
  function makeTree(x, z) {
    var grp = new THREE.Group();
    var trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.24, 1.6, 8),
      new THREE.MeshStandardMaterial({ color: 0x5a3a22, roughness: 1 }));
    trunk.position.y = 0.8; trunk.castShadow = true; grp.add(trunk);
    var top = new THREE.Mesh(new THREE.ConeGeometry(1.3, 3.2, 8),
      new THREE.MeshStandardMaterial({ color: 0x1f7a44, roughness: 0.9 }));
    top.position.y = 3; top.castShadow = true; grp.add(top);
    grp.position.set(x, 0, z); scene.add(grp);
  }

  function addCollider(x, z, hx, hz) { colliders.push({ minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz }); }
  function collideCircle(pos, r) {
    // returns true if pushed (hit a building)
    var hit = false;
    for (var i = 0; i < colliders.length; i++) {
      var c = colliders[i];
      var cx = Math.max(c.minX, Math.min(pos.x, c.maxX));
      var cz = Math.max(c.minZ, Math.min(pos.z, c.maxZ));
      var dx = pos.x - cx, dz = pos.z - cz, d2 = dx * dx + dz * dz;
      if (d2 < r * r) {
        hit = true;
        if (d2 > 0.0001) {
          var d = Math.sqrt(d2);
          pos.x = cx + (dx / d) * r; pos.z = cz + (dz / d) * r;
        } else {
          pos.x = c.maxX + r; // inside: push out east
        }
      }
    }
    pos.x = Math.max(-150, Math.min(150, pos.x));
    pos.z = Math.max(-150, Math.min(150, pos.z));
    return hit;
  }

  function buildCity() {
    var ground = new THREE.Mesh(new THREE.PlaneGeometry(320, 320),
      new THREE.MeshStandardMaterial({ map: groundTexture(), roughness: 0.95 }));
    ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; scene.add(ground);

    var texs = [buildingTexture('#3a3f5c', 0.55), buildingTexture('#4a3550', 0.5), buildingTexture('#2f4a5c', 0.6)];
    for (var bx = -2; bx <= 2; bx++) for (var bz = -2; bz <= 2; bz++) {
      var cx = bx * PITCH, cz = bz * PITCH;
      var two = Math.random() < 0.5;
      var parts = two ? [{ dx: -9.5, w: 17 }, { dx: 9.5, w: 17 }] : [{ dx: 0, w: 36 }];
      parts.forEach(function (pt) {
        var hgt = 12 + Math.random() * 34;
        var tex = texs[Math.floor(Math.random() * texs.length)];
        var mat = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: tex, emissiveIntensity: 0.35 });
        var b = new THREE.Mesh(new THREE.BoxGeometry(pt.w, hgt, 36), mat);
        b.position.set(cx + pt.dx, hgt / 2, cz);
        b.castShadow = true; b.receiveShadow = true;
        scene.add(b);
        addCollider(cx + pt.dx, cz, pt.w / 2, 18);
        // rooftop antenna / AC box
        if (Math.random() < 0.6) {
          var box = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 2),
            new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.9 }));
          box.position.set(cx + pt.dx, hgt + 0.6, cz); scene.add(box);
        }
      });
    }
    // trees + props on sidewalks
    for (var t = 0; t < 26; t++) {
      var tx = (Math.floor(Math.random() * 5) - 2) * PITCH + (Math.random() < 0.5 ? -22 : 22);
      var tz = (Math.floor(Math.random() * 5) - 2) * PITCH + (Math.random() < 0.5 ? -22 : 22);
      makeTree(tx, tz);
    }
    // streetlights at intersections
    var lampPos = [];
    STREET.forEach(function (sx) { STREET.forEach(function (sz) {
      if (Math.abs(sx) > 100 || Math.abs(sz) > 100) return;
      lampPos.push([sx + 7, sz + 7]);
    }); });
    lampPos.forEach(function (p) {
      var pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 6, 8),
        new THREE.MeshStandardMaterial({ color: 0x333344, roughness: 0.6, metalness: 0.6 }));
      pole.position.set(p[0], 3, p[1]); pole.castShadow = true; scene.add(pole);
      var bulb = new THREE.Mesh(new THREE.SphereGeometry(0.28, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0xffd9a0, emissive: 0xffb85c, emissiveIntensity: 3 }));
      bulb.position.set(p[0], 6.1, p[1]); scene.add(bulb);
    });
    // a few real point lights near the centre so night glows
    [[26, 26], [-26, -26], [26, -78], [-78, 26]].forEach(function (p) {
      var pl = new THREE.PointLight(0xffb85c, 60, 55, 1.8);
      pl.position.set(p[0], 7, p[1]); scene.add(pl);
    });
  }

  function initParticles() {
    var N = 400;
    var pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
    pData = [];
    for (var i = 0; i < N; i++) { pData.push({ life: 0, vx: 0, vy: 0, vz: 0 }); pos[i * 3 + 1] = -100; }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    particles = new THREE.Points(geo, new THREE.PointsMaterial({ size: 0.7, vertexColors: true, transparent: true, opacity: 0.95, depthWrite: false }));
    particles.frustumCulled = false;
    scene.add(particles);
  }
  function burst(x, y, z, color, n, speed) {
    if (!particles) return;
    var pos = particles.geometry.attributes.position.array;
    var col = particles.geometry.attributes.color.array;
    var c = new THREE.Color(color);
    var placed = 0;
    for (var i = 0; i < pData.length && placed < n; i++) {
      if (pData[i].life > 0) continue;
      pData[i].life = 0.5 + Math.random() * 0.5;
      var a = Math.random() * Math.PI * 2, up = Math.random() * 0.8 + 0.2;
      pData[i].vx = Math.cos(a) * speed; pData[i].vz = Math.sin(a) * speed; pData[i].vy = up * speed;
      pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;
      col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      placed++;
    }
    particles.geometry.attributes.position.needsUpdate = true;
    particles.geometry.attributes.color.needsUpdate = true;
  }
  function updateParticles(dt) {
    if (!particles) return;
    var pos = particles.geometry.attributes.position.array;
    for (var i = 0; i < pData.length; i++) {
      if (pData[i].life <= 0) continue;
      pData[i].life -= dt;
      pos[i * 3] += pData[i].vx * dt; pos[i * 3 + 1] += pData[i].vy * dt; pos[i * 3 + 2] += pData[i].vz * dt;
      pData[i].vy -= 6 * dt;
      if (pData[i].life <= 0) pos[i * 3 + 1] = -100;
    }
    particles.geometry.attributes.position.needsUpdate = true;
  }

  function randomStreetPoint() {
    var s = STREET[Math.floor(Math.random() * STREET.length)];
    var t = STREET[Math.floor(Math.random() * STREET.length)];
    return { x: s, z: t };
  }
  function makeBeacon(color) {
    var grp = new THREE.Group();
    var cyl = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 14, 20, 1, true),
      new THREE.MeshBasicMaterial({ color: color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    cyl.position.y = 7; grp.add(cyl);
    var ring = new THREE.Mesh(new THREE.TorusGeometry(2.2, 0.18, 8, 32),
      new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 2 }));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.3; grp.add(ring);
    var cone = new THREE.Mesh(new THREE.ConeGeometry(0.9, 2, 4),
      new THREE.MeshStandardMaterial({ color: color, emissive: color, emissiveIntensity: 2 }));
    cone.position.y = 5; cone.rotation.y = Math.PI / 4; grp.add(cone);
    grp.userData.cone = cone;
    return grp;
  }
  function placePickup() {
    var p = randomStreetPoint();
    pickupMarker.position.set(p.x + 4, 0, p.z + 4);
    pickupMarker.visible = true; destMarker.visible = false;
  }
  function placeDest() {
    var p = randomStreetPoint();
    destMarker.position.set(p.x - 4, 0, p.z - 4);
    destMarker.visible = true;
  }

  function toast(msg, ms) {
    toastEl.textContent = msg; toastEl.style.opacity = '1';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.style.opacity = '0'; }, ms || 2600);
  }

  function init() {
    renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
    renderer.setSize(canvas.clientWidth || 960, canvas.clientHeight || 540, false);
    renderer.setPixelRatio(highQ ? Math.min(window.devicePixelRatio || 1, 2) : 1);
    renderer.shadowMap.enabled = highQ;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.1;

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x1a1030, 60, 260);
    camera = new THREE.PerspectiveCamera(65, 16 / 9, 0.1, 900);

    // sky dome + stars
    var sky = new THREE.Mesh(new THREE.SphereGeometry(420, 24, 16),
      new THREE.MeshBasicMaterial({ map: skyTexture(), side: THREE.BackSide, fog: false }));
    scene.add(sky);
    var starGeo = new THREE.BufferGeometry();
    var starPos = new Float32Array(600 * 3);
    for (var s = 0; s < 600; s++) {
      var th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI * 0.45;
      starPos[s * 3] = 390 * Math.sin(ph) * Math.cos(th);
      starPos[s * 3 + 1] = 390 * Math.cos(ph) + 10;
      starPos[s * 3 + 2] = 390 * Math.sin(ph) * Math.sin(th);
    }
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0xffffff, size: 1.4, sizeAttenuation: false, fog: false })));

    scene.add(new THREE.HemisphereLight(0x8a7bff, 0x1a1420, 0.75));
    sun = new THREE.DirectionalLight(0xffd9a0, 1.6);
    sun.position.set(120, 170, 60);
    sun.castShadow = highQ;
    sun.shadow.mapSize.set(highQ ? 2048 : 1024, highQ ? 2048 : 1024);
    sun.shadow.camera.left = -160; sun.shadow.camera.right = 160;
    sun.shadow.camera.top = 160; sun.shadow.camera.bottom = -160;
    sun.shadow.camera.far = 500; sun.shadow.bias = -0.0004;
    scene.add(sun);
    // moon-ish fill
    var moon = new THREE.DirectionalLight(0x7e9bff, 0.35);
    moon.position.set(-80, 120, -100); scene.add(moon);

    buildCity();
    initParticles();

    // hero car + player
    carMesh = makeCar(0xff2d78, true);
    carMesh.position.set(10, 0, 26); carMesh.rotation.y = Math.PI / 2;
    scene.add(carMesh);
    heroCar = { mesh: carMesh, pos: carMesh.position, yaw: Math.PI / 2, speed: 0, steer: 0 };
    playerMesh = makePerson(0x22d3ee, 0x1e293b);
    playerMesh.position.set(0, 0, 26);
    scene.add(playerMesh);
    player = { mesh: playerMesh, pos: playerMesh.position, yaw: Math.PI, vy: 0, onGround: true, inCar: false, walkPhase: 0 };

    // traffic
    var nTraffic = highQ ? 10 : 6;
    var colors = [0xff5533, 0x33aaff, 0xffcc33, 0xaa66ff, 0x33dd88, 0xdddddd];
    for (var i = 0; i < nTraffic; i++) {
      var horiz = i % 2 === 0;
      var street = STREET[Math.floor(Math.random() * STREET.length)];
      var dir = Math.random() < 0.5 ? 1 : -1;
      var m = makeCar(colors[i % colors.length], false);
      scene.add(m);
      traffic.push({ mesh: m, horiz: horiz, fixed: street + (dir > 0 ? 3 : -3), dir: dir,
        coord: -140 + Math.random() * 280, speed: 8 + Math.random() * 6 });
    }
    // pedestrians
    var nPeds = highQ ? 12 : 6;
    var shirts = [0xff6b6b, 0x51cf66, 0xffe066, 0xcc5de8, 0xffffff, 0xff922b];
    for (var j = 0; j < nPeds; j++) {
      var pm = makePerson(shirts[j % shirts.length], 0x222233);
      pm.position.set((Math.random() - 0.5) * 200, 0, (Math.random() - 0.5) * 200);
      scene.add(pm);
      peds.push({ mesh: pm, target: randomWalkTarget(), speed: 1.2 + Math.random() * 0.8, phase: Math.random() * 6 });
    }
    // cash drops
    for (var k = 0; k < 12; k++) {
      var gold = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9),
        new THREE.MeshStandardMaterial({ color: 0xffd166, metalness: 0.9, roughness: 0.2, emissive: 0x664400, emissiveIntensity: 0.8 }));
      var cp = randomStreetPoint();
      gold.position.set(cp.x + (Math.random() - 0.5) * 10, 1.2, cp.z + (Math.random() - 0.5) * 10);
      scene.add(gold);
      cashDrops.push({ mesh: gold, taken: false });
    }
    // beacons
    pickupMarker = makeBeacon(0xff2d78); scene.add(pickupMarker);
    destMarker = makeBeacon(0x37e08b); scene.add(destMarker);
    beaconLight = new THREE.PointLight(0xff2d78, 40, 30, 1.8);
    beaconLight.position.set(0, 5, 0); scene.add(beaconLight);
    placePickup();

    clock = new THREE.Clock();
    updateHud();
    requestAnimationFrame(loop);
  }
  function randomWalkTarget() {
    for (var i = 0; i < 8; i++) {
      var x = (Math.random() - 0.5) * 240, z = (Math.random() - 0.5) * 240;
      var bad = false;
      for (var j = 0; j < colliders.length; j++) {
        var c = colliders[j];
        if (x > c.minX - 1 && x < c.maxX + 1 && z > c.minZ - 1 && z < c.maxZ + 1) { bad = true; break; }
      }
      if (!bad) return { x: x, z: z };
    }
    return { x: 0, z: 26 };
  }

  function dist2(ax, az, bx, bz) { var dx = ax - bx, dz = az - bz; return Math.sqrt(dx * dx + dz * dz); }

  function enterCar() {
    if (player.inCar) return;
    if (dist2(player.pos.x, player.pos.z, heroCar.pos.x, heroCar.pos.z) > 5) return;
    player.inCar = true; playerMesh.visible = false;
    toast('You are driving! Deliver the pink pickup, then the green drop-off.');
    beep(440, 0.12, 'square', 0.08);
  }
  function exitCar() {
    if (!player.inCar) return;
    player.inCar = false; playerMesh.visible = true;
    heroCar.speed = 0;
    var side = { x: heroCar.pos.x + Math.cos(heroCar.yaw) * 3, z: heroCar.pos.z - Math.sin(heroCar.yaw) * 3 };
    player.pos.set(side.x, 0, side.z);
    player.yaw = heroCar.yaw;
    beep(330, 0.1, 'square', 0.07);
  }
  function toggleCar() { if (player.inCar) exitCar(); else enterCar(); }

  function reset() {
    money = 0; deliveries = 0; hp = 100; carrying = false;
    player.inCar = false; playerMesh.visible = true;
    player.pos.set(0, 0, 26); player.vy = 0; player.yaw = Math.PI;
    heroCar.pos.set(10, 0, 26); heroCar.yaw = Math.PI / 2; heroCar.speed = 0;
    carMesh.rotation.y = heroCar.yaw;
    cashDrops.forEach(function (c) { c.taken = false; c.mesh.visible = true; });
    placePickup();
    updateHud();
  }
  function startGame() {
    reset();
    state = 'playing';
    overlay.hidden = true;
    startBtn.textContent = 'Play Again';
    engineStart();
    beep(520, 0.12, 'square', 0.07);
    toast('Find the pink beacon — drive or walk to it!');
  }
  function endGame(won) {
    state = won ? 'won' : 'over';
    if (money > best) { best = money; try { localStorage.setItem('neon-city-best', String(best)); } catch (e) {} }
    panelTitle.textContent = won ? 'YOU WIN!' : 'GAME OVER';
    panelText.innerHTML = won
      ? 'You earned $' + money + ' in Neon City.<br>Deliveries: ' + deliveries + '/5 &nbsp;•&nbsp; Best: $' + best + '<br>Press Play Again to cruise once more.'
      : 'Your ride is wrecked.<br>Money: $' + money + ' &nbsp;•&nbsp; Deliveries: ' + deliveries + '/5 &nbsp;•&nbsp; Best: $' + best + '<br>Press Play Again to try again.';
    overlay.hidden = false;
    if (won) { beep(660, 0.15, 'sine', 0.09); setTimeout(function () { beep(990, 0.25, 'sine', 0.09); }, 160); }
    else beep(140, 0.4, 'sawtooth', 0.09);
  }
  function updateHud() {
    moneyEl.textContent = '$' + money;
    delivEl.textContent = 'Deliveries: ' + deliveries + '/5';
    hpEl.textContent = 'HP: ' + Math.max(0, Math.ceil(hp));
    var sp = player.inCar ? Math.abs(heroCar.speed) * 2.2 : 0;
    speedEl.textContent = Math.round(sp) + ' mph';
  }

  function updatePlayer(dt) {
    var fwd = 0, strafe = 0;
    if (keys.w || keys.ArrowUp) fwd += 1;
    if (keys.s || keys.ArrowDown) fwd -= 1;
    if (keys.a || keys.ArrowLeft) strafe -= 1;
    if (keys.d || keys.ArrowRight) strafe += 1;
    if (touchMove.active) { fwd += -touchMove.dy; strafe += touchMove.dx; }
    var sprint = keys.Shift ? 1.6 : 1;
    var speed = 6 * sprint;
    if (fwd || strafe) {
      var len = Math.sqrt(fwd * fwd + strafe * strafe);
      fwd /= len; strafe /= len;
      var ca = Math.sin(camYaw), cb = Math.cos(camYaw);
      // camera looks along -forward; move relative to camera yaw
      var mx = (-cb * fwd + ca * strafe), mz = (ca * fwd + cb * strafe);
      // forward on screen = away from camera: use camYaw basis
      var fx = -Math.sin(camYaw), fz = -Math.cos(camYaw);
      var rx = -fz, rz = fx;
      mx = fx * fwd + rx * strafe; mz = fz * fwd + rz * strafe;
      player.pos.x += mx * speed * dt;
      player.pos.z += mz * speed * dt;
      player.yaw = Math.atan2(mx, mz);
      player.walkPhase += dt * 11;
      collideCircle(player.pos, 0.7);
    }
    // jump / gravity
    if (keys[' '] && player.onGround) { player.vy = 8.5; player.onGround = false; beep(300, 0.08, 'sine', 0.05); }
    if (!player.onGround) {
      player.vy -= 22 * dt;
      player.pos.y += player.vy * dt;
      if (player.pos.y <= 0) { player.pos.y = 0; player.vy = 0; player.onGround = true; }
    }
    playerMesh.rotation.y = player.yaw;
    var legs = playerMesh.userData.legs;
    var swing = (fwd || strafe) ? Math.sin(player.walkPhase) * 0.5 : 0;
    legs[0].rotation.x = swing; legs[1].rotation.x = -swing;
    // traffic hits on foot
    if (hurtCooldown > 0) hurtCooldown -= dt;
    for (var i = 0; i < traffic.length; i++) {
      var t = traffic[i];
      if (dist2(player.pos.x, player.pos.z, t.mesh.position.x, t.mesh.position.z) < 2.2 && hurtCooldown <= 0) {
        hurtCooldown = 1; hp -= 12; burst(player.pos.x, 1.5, player.pos.z, 0xff5555, 16, 6);
        beep(120, 0.25, 'sawtooth', 0.09); updateHud();
        if (hp <= 0) { hp = 0; updateHud(); endGame(false); return; }
      }
    }
  }

  function updateCar(dt) {
    var accel = 0, steerIn = 0;
    if (keys.w || keys.ArrowUp) accel += 1;
    if (keys.s || keys.ArrowDown) accel -= 1;
    if (keys.a || keys.ArrowLeft) steerIn += 1;
    if (keys.d || keys.ArrowRight) steerIn -= 1;
    if (touchMove.active) { accel += -touchMove.dy; steerIn += touchMove.dx; }
    var boost = keys.Shift ? 1.35 : 1;
    var maxSpeed = 26 * boost;
    if (accel > 0) heroCar.speed += 15 * dt;
    else if (accel < 0) heroCar.speed -= (heroCar.speed > 0.5 ? 22 : 9) * dt;
    else heroCar.speed -= heroCar.speed * 1.4 * dt;
    if (keys[' ']) heroCar.speed -= heroCar.speed * 3.5 * dt; // handbrake
    heroCar.speed = Math.max(-10, Math.min(maxSpeed, heroCar.speed));
    var steerTarget = steerIn * 0.55 * Math.min(1, Math.abs(heroCar.speed) / 8);
    heroCar.steer += (steerTarget - heroCar.steer) * Math.min(1, dt * 8);
    if (Math.abs(heroCar.speed) > 0.2) heroCar.yaw += heroCar.steer * dt * (heroCar.speed > 0 ? 1 : -1) * 1.6;
    var fx = Math.sin(heroCar.yaw), fz = Math.cos(heroCar.yaw);
    var nx = heroCar.pos.x + fx * heroCar.speed * dt;
    var nz = heroCar.pos.z + fz * heroCar.speed * dt;
    var before = { x: heroCar.pos.x, z: heroCar.pos.z };
    heroCar.pos.x = nx; heroCar.pos.z = nz;
    if (collideCircle(heroCar.pos, 1.9)) {
      var impact = Math.abs(heroCar.speed);
      heroCar.pos.x = before.x; heroCar.pos.z = before.z;
      if (impact > 7 && crashCooldown <= 0) {
        crashCooldown = 0.9; hp -= Math.round((impact - 7) * 1.6);
        burst(heroCar.pos.x, 1, heroCar.pos.z, 0xffaa33, 22, 8);
        beep(110, 0.3, 'sawtooth', 0.1); toast('Crash! HP ' + Math.max(0, hp));
        updateHud();
        if (hp <= 0) { hp = 0; updateHud(); endGame(false); return; }
      }
      heroCar.speed *= -0.25;
    }
    if (crashCooldown > 0) crashCooldown -= dt;
    carMesh.rotation.y = heroCar.yaw;
    // wheel spin visual: tilt body slightly with steer
    carMesh.rotation.z = -heroCar.steer * 0.06;
    // exhaust puffs when accelerating
    if (accel > 0 && Math.random() < 0.35) {
      burst(heroCar.pos.x - fx * 2.2, 0.5, heroCar.pos.z - fz * 2.2, 0x888888, 2, 1.5);
    }
  }

  function updateWorld(dt, t) {
    // traffic
    traffic.forEach(function (tr) {
      tr.coord += tr.dir * tr.speed * dt;
      if (tr.coord > 145) tr.coord = -145;
      if (tr.coord < -145) tr.coord = 145;
      if (tr.horiz) { tr.mesh.position.set(tr.coord, 0, tr.fixed); tr.mesh.rotation.y = tr.dir > 0 ? Math.PI / 2 : -Math.PI / 2; }
      else { tr.mesh.position.set(tr.fixed, tr.coord, 0); tr.mesh.rotation.y = tr.dir > 0 ? 0 : Math.PI; }
    });
    // pedestrians wander
    peds.forEach(function (p) {
      var dx = p.target.x - p.mesh.position.x, dz = p.target.z - p.mesh.position.z;
      var d = Math.sqrt(dx * dx + dz * dz);
      if (d < 1.5) { p.target = randomWalkTarget(); return; }
      p.mesh.position.x += (dx / d) * p.speed * dt;
      p.mesh.position.z += (dz / d) * p.speed * dt;
      p.mesh.rotation.y = Math.atan2(dx, dz);
      p.phase += dt * 7;
      var legs = p.mesh.userData.legs;
      legs[0].rotation.x = Math.sin(p.phase) * 0.45; legs[1].rotation.x = -Math.sin(p.phase) * 0.45;
      collideCircle(p.mesh.position, 0.6);
    });
    // cash drops spin + collect
    var focus = player.inCar ? heroCar.pos : player.pos;
    cashDrops.forEach(function (c) {
      if (c.taken) return;
      c.mesh.rotation.y += dt * 2.5;
      c.mesh.position.y = 1.2 + Math.sin(t * 2 + c.mesh.position.x) * 0.25;
      if (dist2(focus.x, focus.z, c.mesh.position.x, c.mesh.position.z) < 2.6) {
        c.taken = true; c.mesh.visible = false;
        money += 100; burst(c.mesh.position.x, 1.5, c.mesh.position.z, 0xffd166, 18, 5);
        beep(880, 0.1, 'sine', 0.07); setTimeout(function () { beep(1320, 0.09, 'sine', 0.06); }, 70);
        toast('+$100 cash!'); updateHud();
        if (money >= WIN_MONEY) { endGame(true); }
      }
    });
    // beacons bob + spin
    [pickupMarker, destMarker].forEach(function (m) {
      if (!m.visible) return;
      m.userData.cone.rotation.y += dt * 2;
      m.userData.cone.position.y = 5 + Math.sin(t * 3) * 0.5;
    });
    // delivery pickup / dropoff
    if (!carrying && pickupMarker.visible && dist2(focus.x, focus.z, pickupMarker.position.x, pickupMarker.position.z) < 4.5) {
      carrying = true; pickupMarker.visible = false; placeDest();
      beaconLight.color.setHex(0x37e08b);
      beep(660, 0.12, 'sine', 0.08); toast('Package picked up! Get to the green beacon.');
    } else if (carrying && destMarker.visible && dist2(focus.x, focus.z, destMarker.position.x, destMarker.position.z) < 5) {
      carrying = false; destMarker.visible = false;
      money += DELIVERY_PAY; deliveries += 1;
      burst(destMarker.position.x, 2, destMarker.position.z, 0x37e08b, 26, 6);
      beep(660, 0.12, 'sine', 0.09); setTimeout(function () { beep(990, 0.18, 'sine', 0.09); }, 120);
      toast('Delivery done! +$1,000'); updateHud();
      if (money >= WIN_MONEY || deliveries >= 5) { endGame(true); return; }
      placePickup(); beaconLight.color.setHex(0xff2d78);
    }
    // beacon light follows active marker
    var active = carrying ? destMarker : pickupMarker;
    if (active.visible) beaconLight.position.set(active.position.x, 5, active.position.z);
    // prompt near car
    if (!player.inCar && dist2(player.pos.x, player.pos.z, heroCar.pos.x, heroCar.pos.z) < 5) {
      promptEl.textContent = 'Press E to get in the car';
      promptEl.style.display = 'block';
    } else if (player.inCar) {
      promptEl.textContent = 'E to get out • Shift to boost • Space handbrake';
      promptEl.style.display = 'block';
    } else promptEl.style.display = 'none';
    updateParticles(dt);
    engineUpdate(player.inCar ? Math.abs(heroCar.speed) : 0, player.inCar);
  }

  function updateCamera(dt) {
    var target = player.inCar ? heroCar.pos : player.pos;
    var ty = player.inCar ? 2 : 1.8;
    var dist = player.inCar ? 11.5 : 8;
    var desired = {
      x: target.x + Math.sin(camYaw) * dist,
      y: ty + Math.sin(camPitch) * dist + 2.2,
      z: target.z + Math.cos(camYaw) * dist
    };
    var k = 1 - Math.pow(0.0001, dt);
    camera.position.x += (desired.x - camera.position.x) * k;
    camera.position.y += (desired.y - camera.position.y) * k;
    camera.position.z += (desired.z - camera.position.z) * k;
    camera.lookAt(target.x, ty, target.z);
    // car camera follows car heading when driving fast
    if (player.inCar && Math.abs(heroCar.speed) > 6) {
      var want = heroCar.yaw + Math.PI;
      var diff = want - camYaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      camYaw += diff * Math.min(1, dt * 1.2);
    }
  }

  function drawMinimap() {
    var S = 150 / 320;
    var X = function (v) { return (v + 160) * S; };
    mctx.fillStyle = 'rgba(8,8,20,0.9)'; mctx.fillRect(0, 0, 150, 150);
    mctx.fillStyle = '#3a3f5c';
    for (var bx = -2; bx <= 2; bx++) for (var bz = -2; bz <= 2; bz++) {
      mctx.fillRect(X(bx * PITCH - BLOCK / 2), X(bz * PITCH - BLOCK / 2), BLOCK * S, BLOCK * S);
    }
    cashDrops.forEach(function (c) {
      if (c.taken) return;
      mctx.fillStyle = '#ffd166'; mctx.fillRect(X(c.mesh.position.x) - 1.5, X(c.mesh.position.z) - 1.5, 3, 3);
    });
    var active = carrying ? destMarker : pickupMarker;
    if (active.visible) {
      mctx.fillStyle = carrying ? '#37e08b' : '#ff2d78';
      mctx.beginPath(); mctx.arc(X(active.position.x), X(active.position.z), 5, 0, Math.PI * 2); mctx.fill();
    }
    mctx.fillStyle = '#ffd166';
    mctx.fillRect(X(heroCar.pos.x) - 2, X(heroCar.pos.z) - 2, 4, 4);
    mctx.fillStyle = '#37e08b';
    mctx.save();
    mctx.translate(X(player.pos.x), X(player.pos.z));
    mctx.rotate(Math.atan2(Math.sin(player.inCar ? heroCar.yaw : player.yaw), Math.cos(player.inCar ? heroCar.yaw : player.yaw)) - Math.PI / 2);
    mctx.beginPath(); mctx.moveTo(0, -6); mctx.lineTo(4, 5); mctx.lineTo(-4, 5); mctx.closePath(); mctx.fill();
    mctx.restore();
  }

  var last = 0, hudTimer = 0;
  function loop(ts) {
    requestAnimationFrame(loop);
    var dt = Math.min(0.05, (ts - last) / 1000 || 0.016);
    last = ts;
    if (!clock) return;
    var t = clock.getElapsedTime();
    if (state === 'playing') {
      if (player.inCar) updateCar(dt); else updatePlayer(dt);
      if (state === 'playing') updateWorld(dt, t);
    }
    updateCamera(dt);
    hudTimer += dt;
    if (hudTimer > 0.15) { hudTimer = 0; updateHud(); drawMinimap(); }
    renderer.render(scene, camera);
  }

  // ---------- input ----------
  window.addEventListener('keydown', function (e) {
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    keys[k] = true;
    if (e.key === 'Enter' || e.key === ' ') {
      if (state === 'title' || state === 'won' || state === 'over') { e.preventDefault(); startGame(); return; }
    }
    if (e.key === ' ') { e.preventDefault(); if (state === 'playing' && !player.inCar && player.onGround) { /* jump handled in update */ } }
    if (e.key === 'e' || e.key === 'E') { if (state === 'playing') toggleCar(); }
    if (e.key === 'p' || e.key === 'P') {
      if (state === 'playing') { state = 'paused'; panelTitle.textContent = 'PAUSED'; panelText.textContent = 'Press P or Play to keep cruising.'; startBtn.textContent = 'Resume'; overlay.hidden = false; }
      else if (state === 'paused') { state = 'playing'; overlay.hidden = true; }
    }
    if (e.key === 'm' || e.key === 'M') muted = !muted;
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].indexOf(e.key) >= 0) e.preventDefault();
  });
  window.addEventListener('keyup', function (e) {
    var k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    keys[k] = false;
  });
  // mouse drag look
  var dragging = false, lastMX = 0, lastMY = 0;
  canvas.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') return;
    dragging = true; lastMX = e.clientX; lastMY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', function (e) {
    if (!dragging) return;
    camYaw -= (e.clientX - lastMX) * 0.004 * sens;
    camPitch = Math.max(-0.1, Math.min(0.9, camPitch + (e.clientY - lastMY) * 0.003 * sens));
    lastMX = e.clientX; lastMY = e.clientY;
  });
  canvas.addEventListener('pointerup', function () { dragging = false; });
  // touch look on right half of canvas
  var lookTouch = null;
  canvas.addEventListener('touchstart', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      var r = canvas.getBoundingClientRect();
      if (t.clientX - r.left > r.width / 2 && !lookTouch) lookTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
    }
  }, { passive: true });
  canvas.addEventListener('touchmove', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      var t = e.changedTouches[i];
      if (lookTouch && t.identifier === lookTouch.id) {
        camYaw -= (t.clientX - lookTouch.x) * 0.006 * sens;
        camPitch = Math.max(-0.1, Math.min(0.9, camPitch + (t.clientY - lookTouch.y) * 0.004 * sens));
        lookTouch.x = t.clientX; lookTouch.y = t.clientY;
      }
    }
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', function (e) {
    for (var i = 0; i < e.changedTouches.length; i++) {
      if (lookTouch && e.changedTouches[i].identifier === lookTouch.id) lookTouch = null;
    }
  });
  // virtual stick
  var stick = document.getElementById('stick');
  var knob = document.getElementById('stick-knob');
  function stickPos(e) {
    var r = stick.getBoundingClientRect();
    var dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
    var dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
    var len = Math.sqrt(dx * dx + dy * dy);
    if (len > 1) { dx /= len; dy /= len; }
    touchMove.dx = dx; touchMove.dy = dy;
    knob.style.left = (35 + dx * 32) + 'px'; knob.style.top = (35 + dy * 32) + 'px';
  }
  stick.addEventListener('pointerdown', function (e) {
    touchMove.active = true; touchMove.id = e.pointerId;
    stick.setPointerCapture(e.pointerId); stickPos(e);
  });
  stick.addEventListener('pointermove', function (e) { if (touchMove.active) stickPos(e); });
  function stickEnd() { touchMove.active = false; touchMove.dx = 0; touchMove.dy = 0; knob.style.left = '35px'; knob.style.top = '35px'; }
  stick.addEventListener('pointerup', stickEnd);
  stick.addEventListener('pointercancel', stickEnd);
  document.getElementById('btn-car').addEventListener('click', function () { if (state === 'playing') toggleCar(); });
  document.getElementById('btn-jump').addEventListener('click', function () {
    if (state === 'playing' && !player.inCar && player.onGround) { player.vy = 8.5; player.onGround = false; }
  });
  startBtn.addEventListener('click', function () {
    if (state === 'paused') { state = 'playing'; overlay.hidden = true; return; }
    startGame();
  });
  sensInput.addEventListener('input', function () {
    sens = parseFloat(sensInput.value); sensVal.textContent = sens.toFixed(1) + 'x';
    try { localStorage.setItem('neon-city-sens', String(sens)); } catch (e) {}
  });
  volInput.addEventListener('input', function () {
    volume = parseFloat(volInput.value); volVal.textContent = Math.round(volume * 100) + '%';
    try { localStorage.setItem('neon-city-vol', String(volume)); } catch (e) {}
  });
  qualityInput.addEventListener('change', function () {
    quality = qualityInput.value;
    try { localStorage.setItem('neon-city-quality', quality); } catch (e) {}
    toast('Quality set to ' + quality + ' — applies on next load.');
  });
  window.addEventListener('resize', function () {
    if (!renderer) return;
    camera.aspect = canvas.clientWidth / (canvas.clientHeight || 1);
    camera.updateProjectionMatrix();
    renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
  });

  // ---------- boot with CDN fallback ----------
  function boot() {
    if (typeof THREE !== 'undefined') { init(); return; }
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js';
    s.onload = function () {
      if (typeof THREE !== 'undefined') init();
      else document.getElementById('load-error').hidden = false;
    };
    s.onerror = function () { document.getElementById('load-error').hidden = false; };
    document.head.appendChild(s);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
