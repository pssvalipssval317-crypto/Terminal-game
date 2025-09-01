/* script.js
   Real-sensor mission terminal (40 missions)
   NOTE: Must be served via HTTPS or localhost, and user must Allow permissions.
const output = document.getElementById("output");
function log(msg) { output.textContent = msg; }

// 1. Location
function askLocation() {
  navigator.geolocation.getCurrentPosition(
    pos => log("Location allowed ✅ Lat: " + pos.coords.latitude),
    err => log("Location denied ❌ " + err.message)
  );
}

// 2. Camera
function askCamera() {
  navigator.mediaDevices.getUserMedia({ video: true })
    .then(() => log("Camera allowed ✅"))
    .catch(err => log("Camera denied ❌ " + err));
}

// 3. Microphone
function askMicrophone() {
  navigator.mediaDevices.getUserMedia({ audio: true })
    .then(() => log("Microphone allowed ✅"))
    .catch(err => log("Microphone denied ❌ " + err));
}

// 4. Camera + Microphone
function askCamMic() {
  navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(() => log("Camera + Microphone allowed ✅"))
    .catch(err => log("Denied ❌ " + err));
}

// 5. Orientation
function askOrientation() {
  if (DeviceOrientationEvent && DeviceOrientationEvent.requestPermission) {
    DeviceOrientationEvent.requestPermission()
      .then(res => log("Orientation: " + res))
      .catch(err => log("Error ❌ " + err));
  } else {
    log("Orientation events will stream silently (if supported).");
  }
}

// 6. Clipboard
async function askClipboard() {
  try {
    await navigator.clipboard.writeText("Hello from your site!");
    const text = await navigator.clipboard.readText();
    log("Clipboard allowed ✅ Copied: " + text);
  } catch (err) {
    log("Clipboard denied ❌ " + err);
  }
}

// 7. Notification
function askNotification() {
  Notification.requestPermission()
    .then(res => log("Notification: " + res));
}

// 8. Fullscreen
function askFullscreen() {
  document.body.requestFullscreen()
    .then(() => log("Fullscreen enabled ✅"))
    .catch(err => log("Fullscreen denied ❌ " + err));
}

// 9. Wake Lock
async function askWakeLock() {
  try {
    const lock = await navigator.wakeLock.request("screen");
    log("Wake Lock allowed ✅ Screen will stay awake");
    lock.addEventListener("release", () => log("Wake Lock released"));
  } catch (err) {
    log("Wake Lock denied ❌ " + err);
  }
}

// 10. Bluetooth
async function askBluetooth() {
  try {
    await navigator.bluetooth.requestDevice({ acceptAllDevices: true });
    log("Bluetooth allowed ✅");
  } catch (err) {
    log("Bluetooth denied ❌ " + err);
  }
}

// 11. USB
async function askUSB() {
  try {
    await navigator.usb.requestDevice({ filters: [] });
    log("USB allowed ✅");
  } catch (err) {
    log("USB denied ❌ " + err);
  }
}

// 12. NFC
async function askNFC() {
  if ("nfc" in navigator) {
    try {
      await navigator.nfc.watch(msg => log("NFC data: " + msg));
      log("NFC allowed ✅");
    } catch (err) {
      log("NFC denied ❌ " + err);
    }
  } else {
    log("NFC not supported on this browser/device ❌");
  }
}


const output = document.getElementById('output');
const cmd = document.getElementById('cmd');
const runBtn = document.getElementById('runBtn');
const scoreEl = document.getElementById('score');
const permsEl = document.getElementById('perms');
const camVideo = document.getElementById('camVideo');
const camCanvas = document.getElementById('camCanvas');

let score = 0;
let cameraStream = null;
let micStream = null;
let audioContext = null;
let micAnalyser = null;
let micDataArray = null;
let motionActive = false;
let motionHandler = null;
let motionCounts = 0;
let lastMotionTimestamp = 0;
let faceDetectorAvailable = ('FaceDetector' in window);

// quick print
function println(s='') { output.textContent += s + '\n'; output.scrollTop = output.scrollHeight; }
function setScore(n) { score = n; scoreEl.textContent = score; }
function addScore(delta) { score += delta; setScore(score); }

// Request permissions for camera & mic; used on demand
async function ensureCamera() {
  if (cameraStream) return cameraStream;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    camVideo.srcObject = cameraStream;
    await camVideo.play().catch(()=>{}); // play during analysis
    updatePerms();
    return cameraStream;
  } catch (e) {
    println('Error: camera permission denied or unavailable.'); throw e;
  }
}

async function stopCamera() {
  if (!cameraStream) return;
  cameraStream.getTracks().forEach(t => t.stop());
  cameraStream = null;
  camVideo.srcObject = null;
  updatePerms();
}

async function ensureMic() {
  if (micStream) return micStream;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(micStream);
    micAnalyser = audioContext.createAnalyser();
    micAnalyser.fftSize = 1024;
    const bufferLength = micAnalyser.frequencyBinCount;
    micDataArray = new Uint8Array(bufferLength);
    source.connect(micAnalyser);
    updatePerms();
    return micStream;
  } catch (e) {
    println('Error: microphone permission denied or unavailable.'); throw e;
  }
}

function stopMic() {
  if (!micStream) return;
  micStream.getTracks().forEach(t => t.stop());
  micStream = null;
  if (audioContext) { audioContext.close(); audioContext = null; micAnalyser = null; micDataArray = null; }
  updatePerms();
}

function updatePerms() {
  const okCam = !!cameraStream;
  const okMic = !!micStream;
  permsEl.textContent = `camera:${okCam?'ok':'no'} mic:${okMic?'ok':'no'} faceAPI:${faceDetectorAvailable?'yes':'no'}`;
}

// ------------ sensor helpers ------------

// compute average brightness from camera for X ms
async function measureBrightness(durationMs=2000, sampleInterval=200) {
  try {
    await ensureCamera();
  } catch { return null; }
  const ctx = camCanvas.getContext('2d');
  camCanvas.width = camVideo.videoWidth || 320;
  camCanvas.height = camVideo.videoHeight || 240;
  const samples = Math.max(1, Math.floor(durationMs / sampleInterval));
  let total = 0, cnt = 0;
  for (let i=0;i<samples;i++){
    ctx.drawImage(camVideo, 0, 0, camCanvas.width, camCanvas.height);
    const img = ctx.getImageData(0,0, camCanvas.width, camCanvas.height).data;
    let sum=0;
    for (let p=0;p<img.length; p+=4){
      // luminance approx: 0.2126R + 0.7152G + 0.0722B
      sum += (0.2126*img[p] + 0.7152*img[p+1] + 0.0722*img[p+2]);
    }
    total += (sum / (camCanvas.width*camCanvas.height));
    cnt++;
    await new Promise(r => setTimeout(r, sampleInterval));
  }
  return total / cnt; // average luminance (0-255)
}

// measure sound level (RMS) for durationMs; returns avg dB-ish value
async function measureSoundLevel(durationMs=2000, sampleInterval=200) {
  try {
    await ensureMic();
  } catch { return null; }
  const analyser = micAnalyser;
  const data = micDataArray;
  const samples = Math.max(1, Math.floor(durationMs / sampleInterval));
  let total = 0, cnt = 0;
  for (let i=0;i<samples;i++){
    analyser.getByteTimeDomainData(data);
    let sum=0;
    for (let j=0;j<data.length;j++){
      const v = (data[j] - 128) / 128; // -1..1
      sum += v*v;
    }
    const rms = Math.sqrt(sum / data.length);
    total += rms;
    cnt++;
    await new Promise(r => setTimeout(r, sampleInterval));
  }
  return total / cnt; // relative RMS (0..~0.5)
}

// face detection using FaceDetector API if available
async function detectFace(timeoutMs=3000) {
  try {
    await ensureCamera();
  } catch { return { available:false };}
  if (!faceDetectorAvailable) return { available:false };
  const fd = new FaceDetector({ fastMode: true, maxDetectedFaces: 1 });
  const ctx = camCanvas.getContext('2d');
  camCanvas.width = camVideo.videoWidth || 320;
  camCanvas.height = camVideo.videoHeight || 240;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    ctx.drawImage(camVideo, 0, 0, camCanvas.width, camCanvas.height);
    try {
      const faces = await fd.detect(camCanvas);
      if (faces && faces.length>0) return { available:true, faces };
    } catch(e){ break; }
    await new Promise(r=>setTimeout(r,150));
  }
  return { available:true, faces:[] };
}

// device motion: count shakes / steps proxy
function startMotionCounting() {
  if (motionActive) return;
  motionCounts = 0;
  lastMotionTimestamp = 0;
  motionHandler = (ev) => {
    const accel = ev.accelerationIncludingGravity || ev.acceleration || {};
    const ax = accel.x || 0, ay = accel.y || 0, az = accel.z || 0;
    const mag = Math.sqrt(ax*ax + ay*ay + az*az);
    const t = Date.now();
    // threshold to detect a step/shake event
    if (mag > 12 && (!lastMotionTimestamp || t - lastMotionTimestamp > 300)) {
      motionCounts++;
      lastMotionTimestamp = t;
    }
  };
  // some browsers (iOS) require explicit permission
  if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
    DeviceMotionEvent.requestPermission().then(response => {
      if (response === 'granted') window.addEventListener('devicemotion', motionHandler);
    }).catch(()=>{});
  } else {
    window.addEventListener('devicemotion', motionHandler);
  }
  motionActive = true;
}

function stopMotionCounting() {
  if (!motionActive) return;
  window.removeEventListener('devicemotion', motionHandler);
  motionActive = false;
}

// orientation reading (alpha,beta,gamma)
function requestOrientationOnce(timeoutMs=2000) {
  return new Promise(resolve => {
    function handler(e){
      window.removeEventListener('deviceorientation', handler);
      resolve({alpha:e.alpha, beta:e.beta, gamma:e.gamma});
    }
    window.addEventListener('deviceorientation', handler);
    setTimeout(()=>{ window.removeEventListener('deviceorientation', handler); resolve(null); }, timeoutMs);
  });
}

// geolocation (current position)
function getGeoPosition(timeoutMs=5000) {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    const id = navigator.geolocation.getCurrentPosition(pos => { resolve(pos); }, err => { resolve(null); }, { timeout: timeoutMs });
  });
}

// utility: brief countdown display
async function countdown(msg, seconds=5) {
  for (let i = seconds; i >= 1; i--) {
    println(`  ${msg} ${i}...`);
    await new Promise(r => setTimeout(r, 900));
  }
}

// ------------ missions (40) using real sensors ------------
/*
 Each mission is an object: id, title, description, run(): returns true if success else false
*/

// helper to create mission quickly
function mk(id, title, desc, runner) {
  return { id, title, desc, run: runner };
}

const missions = [
  // 1: darkness detection (camera brightness)
  mk('mission1', 'Dark room - camera brightness', 'Sit in a dark place. App will check ambient brightness via camera. Allow camera permission.',
    async () => {
      println('Measuring ambient brightness using camera...');
      const lum = await measureBrightness(2000, 250);
      if (lum === null) { println('Camera unavailable. Mission failed.'); return false; }
      println(`Avg luminance: ${lum.toFixed(1)} (0..255).`);
      // threshold: below ~30 ~ dark; adjust if needed
      if (lum < 35) { println('✅ Dark detected.'); return true; }
      else { println('❌ Too bright.'); return false; }
  }),

  // 2: silence detection (mic RMS)
  mk('mission2', 'Stay silent - microphone', 'Stay silent for 6 seconds. App checks microphone levels. Allow mic permission.',
    async () => {
      println('Measuring ambient sound — stay quiet...');
      const rms = await measureSoundLevel(6000, 250);
      if (rms === null) { println('Microphone unavailable. Mission failed.'); return false; }
      println(`Avg sound RMS: ${rms.toFixed(4)}.`);
      // threshold: below 0.01 ~ quiet environment; may vary per device
      if (rms < 0.015) { println('✅ Silence detected.'); return true; }
      else { println('❌ Too loud.'); return false; }
  }),

  // 3: hold still for 5s (motion low)
  mk('mission3','Hold still - motion sensor','Hold your device steady for 5 seconds. App inspects device motion (no big movement).',
    async () => {
      println('Measuring device motion for 5 seconds — keep device steady.');
      let moved = false;
      const handler = (ev) => {
        const a = ev.accelerationIncludingGravity || ev.acceleration || {};
        const mag = Math.sqrt((a.x||0)**2 + (a.y||0)**2 + (a.z||0)**2);
        if (mag > 3.5) moved = true;
      };
      // request permission if needed
      if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
        try {
          const res = await DeviceMotionEvent.requestPermission();
          if (res !== 'granted') { println('DeviceMotion permission denied.'); return false; }
        } catch(e) { println('DeviceMotion permission error.'); return false; }
      }
      window.addEventListener('devicemotion', handler);
      await new Promise(r=>setTimeout(r, 5200));
      window.removeEventListener('devicemotion', handler);
      if (!moved) { println('✅ Device held steady.'); return true; } else { println('❌ Movement detected.'); return false; }
  }),

  // 4: smile detection (face detector)
  mk('mission4','Smile detection - camera','Smile at the camera. FaceDetector API used when available (experimental).',
    async () => {
      if (!faceDetectorAvailable) { println('Face Detector API not available in this browser — cannot auto-detect smile.'); return false; }
      println('Looking for a face — please face the camera and smile when ready.');
      const res = await detectFace(4000);
      if (!res.available) { println('Face detection not supported.'); return false; }
      if (res.faces && res.faces.length>0) {
        println(`✅ Face detected (${res.faces.length}) — (smile detection not supported by API here).`);
        // FaceDetector doesn't provide expression; treat as pass if face present.
        return true;
      }
      println('❌ No face found.');
      return false;
  }),

  // 5: step proxy - count motion events (simulate 20 steps)
  mk('mission5','Walk 20 steps (proxy)','Walk (or step in place) until device registers ~20 motion peaks.',
    async () => {
      println('Start walking/moving to register ~20 strong motion events. You have 20 seconds.');
      startMotionCounting();
      motionCounts = 0;
      const waitMs = 20000;
      await new Promise(r => setTimeout(r, waitMs));
      stopMotionCounting();
      println(`Motion events detected: ${motionCounts}`);
      if (motionCounts >= 18) { println('✅ Steps proxy achieved.'); return true; }
      else { println('❌ Not enough movement counted.'); return false; }
  }),

  // 6: quick reaction (press Enter on prompt after GO)
  mk('mission6','Reaction Test','When the terminal prints GO, press Enter as fast as you can (measured).',
    async () => {
      println('Get ready...');
      await new Promise(r=>setTimeout(r, 1200));
      println('GO!');
      const start = Date.now();
      const r = await waitForUserEnter(4000);
      const dt = r ? (Date.now() - start) : Infinity;
      if (dt < 2000) { println(`✅ Reaction time ${dt}ms`); return true; } else { println('❌ Too slow or no input.'); return false; }
  }),

  // 7: color test - point camera at blue object
  mk('mission7','Color test (blue)','Point camera at a blue object for 3s. Avg luminance of blue channel will be measured.',
    async () => {
      println('Point camera at a blue object so blue pixels increase.');
      await ensureCamera().catch(()=>{ println('Camera unavailable'); return false; });
      const ctx = camCanvas.getContext('2d');
      camCanvas.width = camVideo.videoWidth || 320; camCanvas.height = camVideo.videoHeight || 240;
      let totalBlue = 0, samples=4;
      for (let i=0;i<samples;i++){
        ctx.drawImage(camVideo,0,0,camCanvas.width,camCanvas.height);
        const d = ctx.getImageData(0,0,camCanvas.width,camCanvas.height).data;
        let bsum=0;
        for (let p=0;p<d.length;p+=4) bsum += d[p+2];
        totalBlue += bsum/(camCanvas.width*camCanvas.height);
        await new Promise(r=>setTimeout(r,400));
      }
      const avgBlue = totalBlue / samples;
      println(`Avg blue intensity: ${avgBlue.toFixed(1)}`);
      if (avgBlue > 70) { println('✅ Blue object detected.'); return true; } else { println('❌ Blue not detected strongly.'); return false; }
  }),

  // 8: loud sound (clap)
  mk('mission8','Make loud sound (clap)','Make a loud sound — mic is measured for a short burst.',
    async () => {
      println('Get ready to clap in 2s, then clap loudly.');
      await new Promise(r=>setTimeout(r,2000));
      const rms = await measureSoundLevel(1500, 100);
      if (rms === null) { println('No mic.'); return false; }
      println(`Sound RMS: ${rms.toFixed(4)}`);
      if (rms > 0.08) { println('✅ Loud sound detected.'); return true; } else { println('❌ Sound too soft.'); return false; }
  }),

  // 9: face present (camera)
  mk('mission9','Face present','Point camera at yourself so a face is visible (detect via FaceDetector if available, else any camera image).',
    async () => {
      if (!faceDetectorAvailable) {
        // fallback: treat any camera usable as pass (best-effort)
        try { await ensureCamera(); println('FaceDetector not available — assuming face present if camera works.'); return true; } catch { println('Camera fail'); return false; }
      }
      println('Detecting face...');
      const res = await detectFace(3000);
      if (!res.available) { println('FaceDetector API not ready.'); return false; }
      if (res.faces && res.faces.length>0) { println('✅ Face found.'); return true; } else { println('❌ No face detected.'); return false; }
  }),

  // 10: ambient light sensor if available (will try Sensor API)
  mk('mission10','Ambient light sensor (if available)','Checks device ambient light sensor via generic sensor API (browser support varies).',
    async () => {
      if ('AmbientLightSensor' in window) {
        try {
          const sensor = new AmbientLightSensor();
          sensor.start();
          await new Promise(r=>setTimeout(r,900));
          const lux = sensor.illuminance;
          sensor.stop();
          println(`Ambient light: ${lux} lux`);
          if (lux < 50) { println('✅ Low ambient light.'); return true; } else { println('❌ Too bright.'); return false; }
        } catch(e) {
          println('AmbientLightSensor error or denied.');
          return false;
        }
      } else { println('AmbientLightSensor not supported — mission skipped.'); return false; }
  }),

  // 11: rotate phone (orientation)
  mk('mission11','Rotate phone (landscape)','Rotate your phone to landscape orientation.',
    async () => {
      println('Please rotate your device to landscape orientation and then press Enter.');
      const orient = await requestOrientationOnce(8000);
      if (!orient) { println('No orientation event read.'); return false; }
      // beta (tilt) or alpha/gamma indicate orientation; check gamma beyond threshold
      // This is a simple heuristic — if gamma magnitude > 45 it's landscape-ish
      if (Math.abs(orient.gamma || 0) > 40) { println('✅ Landscape orientation detected.'); return true; } else { println('❌ Not landscape yet.'); return false; }
  }),

  // 12: GPS location (permission)
  mk('mission12','Geolocation available','Allow geolocation; app will retrieve GPS coords.',
    async () => {
      const pos = await getGeoPosition(7000);
      if (!pos) { println('❌ Geolocation not available/denied.'); return false; }
      println(`✅ Location: lat ${pos.coords.latitude.toFixed(5)}, lon ${pos.coords.longitude.toFixed(5)}`);
      return true;
  }),

  // 13: flip screen (face-down detect via orientation)
  mk('mission13','Place phone face-down','Place phone face-down on table for 3 seconds.',
    async () => {
      println('Place the phone screen-down on surface for 3 seconds.');
      // try orientation beta/gamma as proxy
      const started = Date.now();
      let faceDownCount = 0;
      const handler = (e) => {
        // on many devices beta ~ -180..180; when face-down beta approx 180 or -180
        const b = e.beta || 0;
        if (Math.abs(Math.abs(b) - 180) < 30) faceDownCount++;
      };
      window.addEventListener('deviceorientation', handler);
      await new Promise(r=>setTimeout(r,3000));
      window.removeEventListener('deviceorientation', handler);
      if (faceDownCount > 0) { println('✅ Face-down detected.'); return true; } else { println('❌ Could not detect face-down.'); return false; }
  }),

  // 14: silent selfie (camera present + low sound)
  mk('mission14','Silent selfie','Show face to camera and stay silent for 3 seconds.',
    async () => {
      const faceRes = await (async ()=>{ if (faceDetectorAvailable) return await detectFace(2500); else { await ensureCamera().catch(()=>{}); return {available:false}; } })();
      const sound = await measureSoundLevel(2500,250).catch(()=>null);
      if (faceRes && faceRes.faces && faceRes.faces.length>0 && sound !== null && sound < 0.02) { println('✅ Silent selfie OK.'); return true; }
      println('❌ Silent selfie failed.'); return false;
  }),

  // 15: proximity via camera dark center (cover camera)
  mk('mission15','Cover camera','Cover the camera lens for 2 seconds (eg with finger).',
    async () => {
      println('Cover the camera lens now for 2 seconds.');
      const lumBefore = await measureBrightness(600, 200);
      const lumDuring = await measureBrightness(1200, 300);
      if (lumDuring !== null && lumDuring < (lumBefore || 100) * 0.2) { println('✅ Cover detected.'); return true; }
      println('❌ Cover not detected.'); return false;
  }),

  // 16: device shake
  mk('mission16','Shake device','Shake your device strongly for 3 seconds.',
    async () => {
      println('Shake your device now for 3 seconds.');
      startMotionCounting();
      motionCounts = 0;
      await new Promise(r=>setTimeout(r,3500));
      stopMotionCounting();
      println(`Shakes counted: ${motionCounts}`);
      if (motionCounts >= 4) { println('✅ Shake detected.'); return true; } else { println('❌ Not enough shake.'); return false; }
  }),

  // 17: flashlight test (bright region) - point camera at flashlight / bright phone torch
  mk('mission17','Point at bright light','Point camera at a bright light or turn on torch. Detect high luminance.',
    async () => {
      println('Point camera at a bright light source now.');
      const lum = await measureBrightness(1500, 200);
      if (lum !== null && lum > 120) { println('✅ Bright light detected.'); return true; }
      println('❌ No bright light detected.'); return false;
  }),

  // 18: whisper name (mic low)
  mk('mission18','Whisper name','Whisper your agent name (low volume), measured by mic.',
    async () => {
      println('Whisper now for 3 seconds.');
      const rms = await measureSoundLevel(3000, 200);
      if (rms !== null && rms > 0.01 && rms < 0.05) { println('✅ Whisper detected.'); return true; }
      println('❌ Whisper not detected / too loud.'); return false;
  }),

  // 19: count steps proxy (motionCounts >= 40)
  mk('mission19','Walk more (40 events)','Walk/move until 40 motion events detected (30s window).',
    async () => {
      println('Walk/move for up to 30 seconds to accumulate motion events.');
      startMotionCounting(); motionCounts = 0;
      await new Promise(r=>setTimeout(r,30000));
      stopMotionCounting();
      println(`Events: ${motionCounts}`);
      if (motionCounts >= 35) { println('✅ Movement goal reached.'); return true; } else { println('❌ Not enough movement.'); return false; }
  }),

  // 20: face blink (approx by detecting face absence after moment) — rough heuristic
  mk('mission20','Blink detection (heuristic)','Face appear and disappear quickly (blink) — heuristic pass if face disappears momentarily.',
    async () => {
      if (!faceDetectorAvailable) { println('FaceDetector not available — failed.'); return false; }
      println('Please look at camera and blink once.');
      const res1 = await detectFace(1200);
      await new Promise(r=>setTimeout(r,300));
      const res2 = await detectFace(1200);
      const present1 = res1.faces && res1.faces.length>0;
      const present2 = res2.faces && res2.faces.length>0;
      if (present1 && !present2) { println('✅ Blink-like disappearance detected.'); return true; } else { println('❌ Blink not detected.'); return false; }
  }),

  // 21: long silence (10s)
  mk('mission21','Long silence 10s','Stay silent for 10 seconds measured by mic.',
    async () => {
      println('Stay silent for 10 seconds.');
      const rms = await measureSoundLevel(10000, 250);
      if (rms !== null && rms < 0.015) { println('✅ Long silence detected.'); return true; } else { println('❌ Too noisy.'); return false; }
  }),

  // 22: loud shout
  mk('mission22','Shout loudly','Shout loudly (detect high RMS).',
    async () => {
      println('Shout now loudly.');
      const rms = await measureSoundLevel(2000, 100);
      if (rms !== null && rms > 0.12) { println('✅ Loud shout detected.'); return true; } else { println('❌ Not loud enough.'); return false; }
  }),

  // 23: camera face-left or face-right (orientation via face bounding box center)
  mk('mission23','Turn head left or right','Turn your head left or right while facing camera.',
    async () => {
      if (!faceDetectorAvailable) { println('No FaceDetector — mission failed.'); return false; }
      println('Turn your head left or right while looking at camera.');
      const res = await detectFace(3000);
      if (res.faces && res.faces[0]) {
        const box = res.faces[0].boundingBox;
        // boundingBox has x,y,w,h — check center x
        const cx = box.x + box.width/2;
        if (cx < camCanvas.width*0.3 || cx > camCanvas.width*0.7) { println('✅ Head turned detected.'); return true; }
      }
      println('❌ Head turn not detected.');
      return false;
  }),

  // 24: geo movement (move at least ~10 meters) - may be slow/unreliable
  mk('mission24','Move a short distance (GPS)','Move a short distance (requires GPS and waiting).',
    async () => {
      println('We will capture a location now. Then move ~10m and run again (5s wait here).');
      const p1 = await getGeoPosition(7000);
      if (!p1) { println('❌ Initial location not available.'); return false; }
      println(`Initial: ${p1.coords.latitude.toFixed(5)}, ${p1.coords.longitude.toFixed(5)}`);
      println('Move a short distance now (you have ~10 seconds).');
      await new Promise(r=>setTimeout(r,10000));
      const p2 = await getGeoPosition(7000);
      if (!p2) { println('❌ Second location not available.'); return false; }
      const dx = (p2.coords.latitude - p1.coords.latitude) * 111000;
      const dy = (p2.coords.longitude - p1.coords.longitude) * 111000 * Math.cos(p1.coords.latitude * Math.PI/180);
      const dist = Math.sqrt(dx*dx + dy*dy);
      println(`Moved approx ${Math.round(dist)} meters`);
      if (dist > 8) { println('✅ Movement detected.'); return true; } else { println('❌ Not moved enough.'); return false; }
  }),

  // 25: point camera at red object
  mk('mission25','Detect red object','Point camera at a red object for a short moment.',
    async () => {
      println('Point camera at a red object now.');
      await ensureCamera().catch(()=>{ println('No camera'); return false; });
      const ctx = camCanvas.getContext('2d');
      camCanvas.width = camVideo.videoWidth || 320; camCanvas.height = camVideo.videoHeight || 240;
      let totalRed = 0, samples=4;
      for (let i=0;i<samples;i++){
        ctx.drawImage(camVideo,0,0,camCanvas.width,camCanvas.height);
        const d = ctx.getImageData(0,0,camCanvas.width,camCanvas.height).data;
        let rsum=0;
        for (let p=0;p<d.length;p+=4) rsum += d[p];
        totalRed += rsum/(camCanvas.width*camCanvas.height);
        await new Promise(r=>setTimeout(r,300));
      }
      const avg = totalRed/samples;
      println(`Avg red intensity: ${avg.toFixed(1)}`);
      if (avg > 70) { println('✅ Red detected.'); return true; } else { println('❌ Red not detected.'); return false; }
  }),

  // 26: screen covered then uncovered quickly
  mk('mission26','Cover then uncover camera','Cover camera for 1s then uncover quickly.',
    async () => {
      println('Cover the camera for 1 second then uncover.');
      const lum1 = await measureBrightness(600,200);
      await new Promise(r=>setTimeout(r,1200));
      const lum2 = await measureBrightness(600,200);
      if (lum1 !== null && lum2 !== null && lum1 > lum2 * 2) { println('✅ Cover/uncover detected.'); return true; }
      println('❌ Cover pattern not detected.'); return false;
  }),

  // 27: point mic at music (detect sustained sound)
  mk('mission27','Play music for 5s','Play a short music/audio loudly near the mic.',
    async () => {
      println('Play some music for ~4 seconds or play a ringtone.');
      const rms = await measureSoundLevel(4000,200);
      if (rms !== null && rms > 0.06) { println('✅ Music detected.'); return true; } else { println('❌ No strong audio detected.'); return false; }
  }),

  // 28: rotate fast (gyro)
  mk('mission28','Rotate device quickly','Rotate/flip device quickly to generate orientation change.',
    async () => {
      println('Rotate device quickly now.');
      const a1 = await requestOrientationOnce(1200);
      await new Promise(r=>setTimeout(r,1000));
      const a2 = await requestOrientationOnce(1200);
      if (a1 && a2) {
        const dAng = Math.abs((a2.alpha||0) - (a1.alpha||0));
        if (dAng > 40) { println('✅ Rotation detected.'); return true; }
      }
      println('❌ Rotation not detected.'); return false;
  }),

  // 29: point camera at QR-like high-contrast (we'll detect edge density)
  mk('mission29','High-contrast pattern','Point camera to a high-contrast pattern (like a QR or black/white).',
    async () => {
      println('Point camera at a black/white high-contrast pattern now.');
      await ensureCamera().catch(()=>{ println('No camera'); return false; });
      const ctx = camCanvas.getContext('2d');
      camCanvas.width = camVideo.videoWidth || 320; camCanvas.height = camVideo.videoHeight || 240;
      ctx.drawImage(camVideo,0,0,camCanvas.width,camCanvas.height);
      const d = ctx.getImageData(0,0,camCanvas.width,camCanvas.height).data;
      // compute simple contrast metric: count pixels near extremes
      let dark=0, bright=0;
      for (let i=0;i<d.length;i+=4){
        const lum = 0.2126*d[i] + 0.7152*d[i+1] + 0.0722*d[i+2];
        if (lum < 40) dark++;
        if (lum > 215) bright++;
      }
      const ratio = (dark + bright) / (camCanvas.width*camCanvas.height);
      println(`Contrast ratio: ${(ratio*100).toFixed(1)}%`);
      if (ratio > 0.18) { println('✅ High contrast detected.'); return true; } else { println('❌ Not enough contrast.'); return false; }
  }),

  // 30: point camera at green object
  mk('mission30','Detect green','Point camera at a green object for 2 seconds.',
    async () => {
      println('Point camera at a green object now.');
      const ctx = camCanvas.getContext('2d');
      camCanvas.width = camVideo.videoWidth || 320; camCanvas.height = camVideo.videoHeight || 240;
      let totalG = 0, s=3;
      for (let i=0;i<s;i++){
        ctx.drawImage(camVideo,0,0,camCanvas.width,camCanvas.height);
        const d = ctx.getImageData(0,0,camCanvas.width,camCanvas.height).data;
        let gsum=0;
        for (let p=0;p<d.length;p+=4) gsum += d[p+1];
        totalG += gsum/(camCanvas.width*camCanvas.height);
        await new Promise(r=>setTimeout(r,350));
      }
      const avgG = totalG/s;
      println(`Avg green intensity: ${avgG.toFixed(1)}`);
      if (avgG > 70) { println('✅ Green detected.'); return true; } else { println('❌ Green not detected.'); return false; }
  }),

  // 31: long exposure - cover camera for 5s
  mk('mission31','Cover camera long','Cover camera for about 5 seconds and then uncover.',
    async () => {
      println('Cover the camera for 5 seconds now.');
      const lum = await measureBrightness(5200,400);
      if (lum !== null && lum < 25) { println('✅ Long cover detected.'); return true; }
      println('❌ Could not confirm long cover.'); return false;
  }),

  // 32: face smile (heuristic by measuring mouth area change is complex) -> we use presence
  mk('mission32','Smile (best-effort)','Try to smile; face presence used as proxy (limited).',
    async () => {
      if (!faceDetectorAvailable) { println('No face detector available'); return false; }
      println('Smile at camera for 3 seconds.');
      const r = await detectFace(3000);
      if (r.faces && r.faces.length>0) { println('✅ Face detected (smile heuristic pass).'); return true; }
      println('❌ No face detected.'); return false;
  }),

  // 33: mic pattern - two claps (detect two spikes)
  mk('mission33','Two claps','Produce two claps separated by ~300-1200ms.',
    async () => {
      println('Prepare to clap twice (two short loud sounds).');
      const rmsSamples = [];
      try { await ensureMic(); } catch(e){ println('Mic not available'); return false; }
      const totalMs = 3000, interval = 100;
      const analyser = micAnalyser, data = micDataArray;
      const steps = totalMs / interval;
      for (let i=0;i<steps;i++){
        analyser.getByteTimeDomainData(data);
        let sum=0;
        for (let j=0;j<data.length;j++){ const v=(data[j]-128)/128; sum+=v*v; }
        const rms = Math.sqrt(sum / data.length);
        rmsSamples.push(rms);
        await new Promise(r=>setTimeout(r, interval));
      }
      // detect peaks above threshold
      const peaks = rmsSamples.filter(x => x > 0.08).length;
      println(`Peaks counted: ${peaks}`);
      if (peaks >= 2) { println('✅ Two claps detected.'); return true; } else { println('❌ Not enough claps detected.'); return false; }
  }),

  // 34: flashlight blink (turn phone torch on/off quickly) - detect bright spikes
  mk('mission34','Torch blink','Turn phone torch on/off to create a bright spike.',
    async () => {
      println('Turn on/off your torch to create a bright spike.');
      const before = await measureBrightness(800,200);
      const spike = await measureBrightness(1200,150);
      if (spike !== null && spike > (before || 20) * 1.8) { println('✅ Bright spike detected.'); return true; }
      println('❌ No bright spike detected.'); return false;
  }),

  // 35: slow rotation (turn phone slowly)
  mk('mission35','Slow rotation','Slowly rotate device 180 degrees.',
    async () => {
      println('Slowly rotate device 180 degrees now.');
      const o1 = await requestOrientationOnce(1200);
      await new Promise(r=>setTimeout(r,2000));
      const o2 = await requestOrientationOnce(1200);
      if (o1 && o2 && Math.abs((o2.beta||0)-(o1.beta||0))>70) { println('✅ Rotation detected.'); return true; }
      println('❌ Rotation not detected.'); return false;
  }),

  // 36: ambient sound pattern (whistle)
  mk('mission36','Whistle','Whistle a short tune (high frequency) for 2 seconds.',
    async () => {
      println('Whistle now for ~2 seconds.');
      const rms = await measureSoundLevel(2000,100);
      // whistle tends to have smaller RMS but higher freq - we only check medium loudness
      if (rms !== null && rms > 0.03) { println('✅ Sound detected (whistle/proxy).'); return true; } else { println('❌ No whistle detected.'); return false; }
  }),

  // 37: multiple face positions (turn head left then right)
  mk('mission37','Head left then right','Turn head left (detect), then right (detect), within 6s.',
    async () => {
      if (!faceDetectorAvailable) { println('No FaceDetector — fail.'); return false; }
      println('First look center, then turn left, then right within 6 seconds.');
      const left = await (async ()=>{
        const r = await detectFace(2000);
        if (!r.faces || r.faces.length==0) return false;
        const cx = r.faces[0].boundingBox.x + r.faces[0].boundingBox.width/2;
        return cx < (camCanvas.width*0.4);
      })();
      await new Promise(r=>setTimeout(r,500));
      const right = await (async ()=>{
        const r = await detectFace(2000);
        if (!r.faces || r.faces.length==0) return false;
        const cx = r.faces[0].boundingBox.x + r.faces[0].boundingBox.width/2;
        return cx > (camCanvas.width*0.6);
      })();
      if (left && right) { println('✅ Left and right head turns detected.'); return true; }
      println('❌ Could not detect both head sides.'); return false;
  }),

  // 38: long clap + silence sequence
  mk('mission38','Clap then silence','Clap once loudly, then stay silent for 4s.',
    async () => {
      println('Clap loudly now, then stay silent.');
      const clap = await measureSoundLevel(1200,120);
      await new Promise(r=>setTimeout(r,200));
      const silence = await measureSoundLevel(4000,200);
      if (clap !== null && clap > 0.08 && silence !== null && silence < 0.02) { println('✅ Clap then silence detected.'); return true; }
      println('❌ Pattern not detected.'); return false;
  }),

  // 39: rapid steps proxy (short burst motion)
  mk('mission39','Rapid steps (burst)','Run on spot for 8 seconds (counted by motion peaks).',
    async () => {
      println('Run on the spot for 8 seconds.');
      startMotionCounting(); motionCounts = 0;
      await new Promise(r=>setTimeout(r,8000));
      stopMotionCounting();
      println(`Events: ${motionCounts}`);
      if (motionCounts >= 8) { println('✅ Burst movement detected.'); return true; }
      println('❌ Not enough burst movement.'); return false;
  }),

  // 40: final confirm: camera + mic + motion all okay (composite)
  mk('mission40','Final composite','Final mission: quick camera check, quick mic shout, small shake — composite pass if all OK.',
    async () => {
      println('Final composite: look at camera, shout once, then shake quickly.');
      const faceRes = await (faceDetectorAvailable ? detectFace(2000) : Promise.resolve({available:false}));
      const micR = await measureSoundLevel(1200,100);
      startMotionCounting(); motionCounts = 0;
      await new Promise(r=>setTimeout(r,2200));
      stopMotionCounting();
      const faceOk = faceRes && faceRes.faces && faceRes.faces.length>0;
      const micOk = micR !== null && micR > 0.08;
      const moveOk = motionCounts >= 2;
      println(`face:${faceOk} mic:${(micR||0).toFixed(3)} move:${motionCounts}`);
      if (faceOk && micOk && moveOk) { println('🎉✅ Final composite mission success!'); return true; }
      println('❌ Final composite failed.');
      return false;
  })
];

// ---- UI & command handling ----

println('Lambda Terminal — Real Mission Mode');
println('IMPORTANT: Serve via HTTPS or localhost. You will be asked to allow camera and microphone.');
println('');

function listMissions() {
  println('Missions:');
  missions.forEach(m => println(`  ${m.id} — ${m.title}`));
}

async function runMissionById(id) {
  const m = missions.find(x => x.id === id);
  if (!m) { println('Mission not found.'); return; }
  println(`--- ${m.id} : ${m.title} ---`);
  println(m.desc || '');
  try {
    const ok = await m.run();
    if (ok) { println(`Reward: +10`); addScore(10); }
    else {
      const pen = (m.id === 'mission40') ? -10 : -5;
      println(`Punishment: ${pen}`);
      addScore(pen);
    }
  } catch (e) {
    println('Mission error: ' + (e && e.message ? e.message : e));
  }
  println(`Score now: ${score}`);
}

// wait for user to press Enter quickly (used in mission)
function waitForUserEnter(timeout=5000) {
  return new Promise(resolve => {
    let done = false;
    function handler(e) {
      if (e.key === 'Enter') {
        cleanup();
        done = true;
        resolve(true);
      }
    }
    function btnHandler(){ cleanup(); done = true; resolve(true); }
    function cleanup(){ cmd.removeEventListener('keydown', handler); runBtn.removeEventListener('click', btnHandler); }
    cmd.addEventListener('keydown', handler);
    runBtn.addEventListener('click', btnHandler);
    setTimeout(()=>{ if (!done) { cleanup(); resolve(false); } }, timeout);
  });
}

async function execLine(line) {
  if (!line) return;
  println('λ> ' + line);
  const parts = line.trim().split(/\s+/);
  const c = parts[0].toLowerCase();
  if (c === 'help') {
    println('Commands: help, missions, mission1..mission40, score, clear, allow, stopcam, stopmic');
    return;
  }
  if (c === 'missions') { listMissions(); return; }
  if (c === 'score') { println(`Score: ${score}`); return; }
  if (c === 'clear') { output.textContent = ''; return; }
  if (c === 'allow') {
    // trigger permission prompts for camera+mic
    try { await ensureCamera(); } catch(e){ println('Camera not allowed'); }
    try { await ensureMic(); } catch(e){ println('Mic not allowed'); }
    return;
  }
  if (c === 'stopcam') { await stopCamera(); println('Camera stopped.'); return; }
  if (c === 'stopmic') { stopMic(); println('Mic stopped.'); return; }

  if (/^mission\d+$/.test(c)) {
    await runMissionById(c);
    return;
  }
  println("Unknown command. Type 'missions' to list.");
}

cmd.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const v = cmd.value.trim();
    cmd.value = '';
    await execLine(v);
  }
});
runBtn.addEventListener('click', async () => { const v = cmd.value.trim(); cmd.value = ''; await execLine(v); });

// init
setScore(0);
updatePerms();
listMissions();
println('');
println('Type "allow" to pre-grant camera & mic permissions (you will be prompted).');
println('Then run missions with mission1 ... mission40.');
