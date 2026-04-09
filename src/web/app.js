// ── State ──────────────────────────────────────────────
// idle | recording | processing | playing
let state = "idle";
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let pcmWorkletNode = null;
let amplitudeInterval = null;
let analyser = null;
let micStream = null;

// ── DOM ────────────────────────────────────────────────
const pttBtn = document.getElementById("ptt-btn");
const pttHint = document.getElementById("ptt-hint");
const connDot = document.getElementById("conn-dot");
const connLabel = document.getElementById("conn-label");
const harnessLabel = document.getElementById("harness-label");
const transcriptContent = document.getElementById("transcript-content");
const transcriptScroll = document.getElementById("transcript-scroll");
const amplitudeBar = document.getElementById("amplitude-bar");
const amplitudeFill = document.getElementById("amplitude-fill");

const textForm = document.getElementById("text-form");
const textInput = document.getElementById("text-input");

// ── Init ───────────────────────────────────────────────
checkHealth();

pttBtn.addEventListener("click", handlePttClick);
textForm.addEventListener("submit", handleTextSubmit);

function setState(next) {
  state = next;
  document.body.className = `state-${next}`;
  pttBtn.className = next === "recording" ? "recording" : next === "processing" ? "processing" : "";
  pttHint.textContent =
    next === "idle" ? "tap to speak" :
    next === "recording" ? "" :
    next === "processing" ? "thinking..." :
    "";
}

// ── Health check ───────────────────────────────────────
async function checkHealth() {
  try {
    const res = await fetch("/health");
    const data = await res.json();
    connDot.className = "status-indicator connected";
    connLabel.textContent = "connected";
    harnessLabel.textContent = data.harness || "";
  } catch {
    connDot.className = "status-indicator error";
    connLabel.textContent = "offline";
  }
}

// ── Text submit handler ────────────────────────────────
async function handleTextSubmit(e) {
  e.preventDefault();
  const text = textInput.value.trim();
  if (!text || state !== "idle") return;

  // Unlock AudioContext from user gesture
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  textInput.value = "";
  addMessage("user", text);
  setState("processing");
  await sendText(text);
}

// ── PTT click handler ──────────────────────────────────
async function handlePttClick() {
  // Safari/iOS requires AudioContext to be created+resumed inside a user gesture.
  // We do it on every tap so it's always unlocked before playback starts.
  if (!audioContext || audioContext.state === "closed") {
    audioContext = new AudioContext();
  }
  if (audioContext.state === "suspended") {
    await audioContext.resume();
  }

  if (state === "idle") {
    await startRecording();
  } else if (state === "recording") {
    stopRecording();
  } else if (state === "playing") {
    stopPlayback();
    setState("idle");
  }
}

// ── Recording ──────────────────────────────────────────
async function startRecording() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        sampleRate: 48000,
      },
    });
  } catch (err) {
    addMessage("error", "Microphone access denied");
    return;
  }

  audioChunks = [];

  // Determine supported MIME type
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "audio/mp4";

  mediaRecorder = new MediaRecorder(micStream, { mimeType });

  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };

  mediaRecorder.onstop = () => {
    const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
    micStream.getTracks().forEach((t) => t.stop());
    stopAmplitude();
    sendAudio(blob);
  };

  mediaRecorder.start(100);
  setState("recording");
  startAmplitude(micStream);
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    setState("processing");
  }
}

// ── Amplitude visualization ────────────────────────────
function startAmplitude(stream) {
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);

  amplitudeBar.classList.add("active");
  amplitudeBar.classList.remove("playing");

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  amplitudeInterval = setInterval(() => {
    analyser.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    const pct = Math.min(100, (avg / 128) * 100);
    amplitudeFill.style.width = pct + "%";
  }, 50);
}

function stopAmplitude() {
  clearInterval(amplitudeInterval);
  amplitudeBar.classList.remove("active");
  amplitudeFill.style.width = "0%";
}

// ── Send audio to backend ──────────────────────────────
async function readSSEStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();

    let eventType = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ") && eventType) {
        handleSSE(eventType, JSON.parse(line.slice(6)));
        eventType = null;
      }
    }
  }

  if (buffer.trim()) {
    const lines = buffer.split("\n");
    let eventType = null;
    for (const line of lines) {
      if (line.startsWith("event: ")) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith("data: ") && eventType) {
        handleSSE(eventType, JSON.parse(line.slice(6)));
        eventType = null;
      }
    }
  }
}

async function finalizeTurn() {
  if (currentAssistantEl) {
    currentAssistantEl.classList.remove("streaming");
  }
  if (state !== "idle") {
    await waitForPlaybackEnd();
    setState("idle");
  }
}

async function sendAudio(blob) {
  const formData = new FormData();
  formData.append("audio", blob, "recording.webm");

  try {
    const res = await fetch("/api/v1/voice-turn", {
      method: "POST",
      body: formData,
    });
    if (!res.ok) {
      addMessage("error", `Server error: ${res.status}`);
      setState("idle");
      return;
    }
    await readSSEStream(res);
  } catch (err) {
    addMessage("error", "Connection lost");
  }
  await finalizeTurn();
}

async function sendText(text) {
  try {
    const res = await fetch("/api/v1/text-turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      addMessage("error", `Server error: ${res.status}`);
      setState("idle");
      return;
    }
    await readSSEStream(res);
  } catch (err) {
    addMessage("error", "Connection lost");
  }
  await finalizeTurn();
}

// ── SSE event handler ──────────────────────────────────
let currentAssistantEl = null;
let currentAssistantText = "";

function handleSSE(event, data) {
  switch (event) {
    case "transcript":
      addMessage("user", data.text);
      break;

    case "text_delta":
      if (!currentAssistantEl) {
        currentAssistantEl = addMessage("assistant", "", true);
        currentAssistantText = "";
      }
      currentAssistantText += data.text;
      currentAssistantEl.querySelector(".msg-text").textContent = currentAssistantText;
      scrollToBottom();
      break;

    case "assistant_message":
      // Final complete message — update if streaming, or add new
      if (currentAssistantEl) {
        currentAssistantEl.querySelector(".msg-text").textContent = data.text;
        currentAssistantEl.classList.remove("streaming");
      }
      break;

    case "tool_call":
      // Finalize the current assistant message before showing the tool call
      if (currentAssistantEl) {
        currentAssistantEl.classList.remove("streaming");
        currentAssistantEl = null;
        currentAssistantText = "";
      }
      addMessage("tool-call", data.name);
      break;

    case "audio_chunk":
      playPcmChunk(data.base64, data.mimeType);
      if (state === "processing") {
        setState("playing");
        amplitudeBar.classList.add("active", "playing");
      }
      break;

    case "error":
    case "tts_error":
      addMessage("error", data.message);
      break;

    case "done":
      if (currentAssistantEl) {
        currentAssistantEl.classList.remove("streaming");
      }
      currentAssistantEl = null;
      currentAssistantText = "";
      break;
  }
}

// ── Transcript rendering ───────────────────────────────
function addMessage(type, text, streaming = false) {
  // Remove empty state if present
  const emptyState = transcriptContent.querySelector(".empty-state");
  if (emptyState) emptyState.remove();

  const el = document.createElement("div");
  el.className = `msg ${type}${streaming ? " streaming" : ""}`;

  if (type === "user") {
    el.innerHTML = `<span class="msg-label">you</span><span class="msg-text"></span>`;
    el.querySelector(".msg-text").textContent = text;
  } else if (type === "assistant") {
    el.innerHTML = `<span class="msg-label">overwatch</span><span class="msg-text"></span>`;
    el.querySelector(".msg-text").textContent = text;
  } else if (type === "tool-call") {
    el.textContent = `> ${text}`;
  } else if (type === "error") {
    el.textContent = text;
  }

  transcriptContent.appendChild(el);
  scrollToBottom();
  return el;
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    transcriptScroll.scrollTop = transcriptScroll.scrollHeight;
  });
}

// ── PCM Audio Playback ─────────────────────────────────
const PCM_SAMPLE_RATE = 24000;
let nextPlayTime = 0;
let lastSourceNode = null;
let playbackEndResolve = null;
let isPlaybackActive = false;

function playPcmChunk(base64, mimeType) {
  if (!audioContext || audioContext.state !== "running") {
    console.warn("[pcm] AudioContext not ready, dropping chunk");
    return;
  }

  // Parse sample rate from mimeType if present
  let srcRate = PCM_SAMPLE_RATE;
  const rateMatch = mimeType && mimeType.match(/rate=(\d+)/);
  if (rateMatch) srcRate = parseInt(rateMatch[1], 10);

  // Decode base64 → aligned bytes → float32
  const raw = atob(base64);
  const rawLen = raw.length;
  const alignedLen = rawLen - (rawLen % 2);
  const arrayBuf = new ArrayBuffer(alignedLen);
  const view = new DataView(arrayBuf);
  for (let i = 0; i < alignedLen; i++) {
    view.setUint8(i, raw.charCodeAt(i));
  }
  const numSamples = alignedLen / 2;
  const float32 = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    float32[i] = view.getInt16(i * 2, true) / 32768;
  }

  // Schedule this chunk for gapless playback
  const buffer = audioContext.createBuffer(1, float32.length, srcRate);
  buffer.copyToChannel(float32, 0);

  const source = audioContext.createBufferSource();
  source.buffer = buffer;
  source.connect(audioContext.destination);

  if (!isPlaybackActive || nextPlayTime < audioContext.currentTime) {
    nextPlayTime = audioContext.currentTime;
  }
  isPlaybackActive = true;

  source.start(nextPlayTime);
  nextPlayTime += buffer.duration;

  // Track the last source so we know when playback ends
  lastSourceNode = source;
  source.onended = () => {
    if (lastSourceNode === source) {
      // This was the last chunk — playback done
      setTimeout(() => {
        // Small delay to check if more chunks arrived
        if (lastSourceNode === source) {
          isPlaybackActive = false;
          amplitudeBar.classList.remove("active", "playing");
          if (playbackEndResolve) {
            playbackEndResolve();
            playbackEndResolve = null;
          }
        }
      }, 100);
    }
  };
}

function waitForPlaybackEnd() {
  if (!isPlaybackActive) return Promise.resolve();
  return new Promise((resolve) => {
    playbackEndResolve = resolve;
  });
}

function stopPlayback() {
  isPlaybackActive = false;
  nextPlayTime = 0;
  lastSourceNode = null;
  amplitudeBar.classList.remove("active", "playing");
  // Close the AudioContext to kill all scheduled audio sources.
  // A new one will be created on the next user tap.
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close();
    audioContext = null;
  }
  if (playbackEndResolve) {
    playbackEndResolve();
    playbackEndResolve = null;
  }
}

// ── Initial empty state ────────────────────────────────
transcriptContent.innerHTML = `
  <div class="empty-state">
    <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
      <rect x="9" y="1" width="6" height="12" rx="3"></rect>
      <path d="M19 10v1a7 7 0 0 1-14 0v-1"></path>
      <line x1="12" y1="19" x2="12" y2="23"></line>
    </svg>
    <span>tap the button to start a voice turn</span>
  </div>
`;
