// Video preview bar: plays video assets in-panel with play/pause, volume,
// timeline scrubbing, live pitch (Jungle) and reverse (backward seek).
//
// The clicked card's own thumbnail <video> is used as the playback element
// when available - a single decoder, no stutter, and the card is naturally
// frame-synced. The hidden <video> inside the bar is only a fallback.
// Jungle is a global from js/jungle.js.

import { generateWaveform } from './audioPreview.js';

const fs = window.require('fs');
const path = window.require('path');
const os = window.require('os');
const { execFile } = window.require('child_process');

const extensionDir = decodeURIComponent(path.dirname(window.location.pathname.replace(/^\//, '')));
const FFMPEG_PATH = path.join(extensionDir, 'vendor', 'ffmpeg', 'ffmpeg.exe');

// Waveform bars cache keyed by asset path (survives re-clicks in a session)
const _videoWaveformCache = new Map();

const VideoPreview = {
    el: null,
    video: null,        // active playback element (card thumb or fallback)
    _barVideo: null,    // hidden fallback element inside the bar
    canvas: null,
    ctx: null,
    audioCtx: null,
    mediaSource: null,
    jungle: null,
    gainNode: null,

    asset: null,
    isPlaying: false,
    pitch: 1.0,
    speed: 1.0,
    keepPitch: true,
    volume: 0.8,

    _waveformData: null,
    _wfBase: null,
    _wfPlayed: null,

    _reverseSource: null,
    _reversedCache: null,
    _reversedFor: null,
    _reverseStartCtxTime: 0,
    _reverseStartVideoPos: 0,

    _animationId: null,
    _lastTs: 0,
    isDragging: false,
    wasPlaying: false,

    // Alias used by main.js hover guards
    get playbackEl() {
        return this.video;
    },

    init() {
        this.el = document.getElementById('videoPreviewBar');
        if (!this.el) return;

        this._barVideo = document.getElementById('videoPreviewElement');
        this.video = this._barVideo;
        this.canvas = document.getElementById('videoTimelineCanvas');
        this.closeBtn = document.getElementById('videoPreviewClose');
        this.playBtn = document.getElementById('videoPlayBtn');
        this.replayBtn = document.getElementById('videoReplayBtn');
        this.volumeSlider = document.getElementById('videoVolumeSlider');
        this.pitchSlider = document.getElementById('videoPitchSlider');
        this.pitchValue = document.getElementById('videoPitchValue');
        this.speedSlider = document.getElementById('videoSpeedSlider');
        this.speedValue = document.getElementById('videoSpeedValue');
        this.keepPitchCheck = document.getElementById('videoKeepPitch');
        this.reverseCheck = document.getElementById('videoReverseCheck');
        this.timeCurrent = document.getElementById('videoCurrentTime');

        this.playIcon = this.playBtn.querySelector('.play-icon');
        this.pauseIcon = this.playBtn.querySelector('.pause-icon');
        this.ctx = this.canvas.getContext('2d');

        window.addEventListener('resize', () => {
            if (this.el.classList.contains('visible')) {
                this.resizeCanvas();
                this.draw();
            }
        });

        this.setupListeners();
    },

    setupListeners() {
        this.closeBtn.onclick = () => this.hide();
        this.playBtn.onclick = () => this.togglePlay();

        if (this.replayBtn) {
            this.replayBtn.onclick = () => {
                this.seek(0);
                if (!this.isPlaying) this.play();
            };
        }

        this.volumeSlider.oninput = (e) => {
            this.volume = parseFloat(e.target.value);
            if (this.gainNode && this.audioCtx) {
                this.gainNode.gain.setTargetAtTime(this.volume, this.audioCtx.currentTime, 0.01);
            }
        };

        // Double-click the slider to reset it to the default (0.8)
        this.volumeSlider.ondblclick = () => {
            this.volume = 0.8;
            this.volumeSlider.value = 0.8;
            if (this.gainNode && this.audioCtx) {
                this.gainNode.gain.setTargetAtTime(this.volume, this.audioCtx.currentTime, 0.01);
            }
        };

        this.pitchSlider.oninput = (e) => {
            this.pitch = parseFloat(e.target.value);
            if (this.pitchValue) this.pitchValue.textContent = this.pitch.toFixed(1) + 'x';
            this.applyPitch();
            this._restartReverseIfActive();
        };
        // Double-click the slider to reset it to 1.0x
        this.pitchSlider.ondblclick = () => {
            this.pitch = 1.0;
            this.pitchSlider.value = 1.0;
            if (this.pitchValue) this.pitchValue.textContent = '1.0x';
            this.applyPitch();
            this._restartReverseIfActive();
        };

        if (this.speedSlider) {
            this.speedSlider.oninput = (e) => {
                this.speed = parseFloat(e.target.value);
                if (this.speedValue) this.speedValue.textContent = this.speed.toFixed(1) + 'x';
                this.applySpeed();
            };
            this.speedSlider.ondblclick = () => {
                this.speed = 1.0;
                this.speedSlider.value = 1.0;
                if (this.speedValue) this.speedValue.textContent = '1.0x';
                this.applySpeed();
            };
        }

        if (this.keepPitchCheck) {
            this.keepPitchCheck.onchange = () => {
                this.keepPitch = this.keepPitchCheck.checked;
                this.applySpeed();
            };
        }

        if (this.reverseCheck) {
            this.reverseCheck.onchange = () => {
                if (!this.isPlaying) return;
                const el = this.video;
                if (this.isReversed()) {
                    // Entering reverse: pause native video, play the reversed
                    // audio track (same model as the audio bar) and seek the
                    // video backward in sync with the audio clock
                    try { el.pause(); } catch (e) {}
                    el.muted = true;
                    this._lastTs = 0;
                    this._startReverseAudio(el.duration ? Math.min(el.currentTime, el.duration) : 0);
                    this.startAnimationLoop();
                } else {
                    // Leaving reverse: stop reversed audio, resume native
                    this._stopReverseAudio();
                    el.muted = false;
                    this._lastTs = 0;
                    this.startAnimationLoop();
                    const p = el.play();
                    if (p && typeof p.catch === 'function') p.catch(() => {});
                }
            };
        }

        // Timeline scrubbing
        const handleSeek = (e) => {
            if (!this.video || !this.video.duration) return;
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const ratio = Math.max(0, Math.min(1, x / rect.width));
            this.seek(ratio);
        };

        this.canvas.addEventListener('mousedown', (e) => {
            this.isDragging = true;
            this.wasPlaying = this.isPlaying;
            if (this.isPlaying) this.pause();
            handleSeek(e);
        });

        window.addEventListener('mousemove', (e) => {
            if (this.isDragging) handleSeek(e);
        });

        window.addEventListener('mouseup', () => {
            if (this.isDragging) {
                this.isDragging = false;
                if (this.wasPlaying) this.play();
            }
        });
    },

    isReversed() {
        return !!(this.reverseCheck && this.reverseCheck.checked);
    },

    /**
     * Bind the ended handler once per element.
     */
    _bindEnded(el) {
        if (el._vtEndedBound) return;
        el._vtEndedBound = true;
        el.addEventListener('ended', () => {
            if (this.isPlaying && !this.isReversed()) {
                this.isPlaying = false;
                this.updatePlayBtn();
                this.stopAnimationLoop();
                this.draw();
                this.updateTimeDisplay();
            }
        });
    },

    /**
     * Route the given element's audio through WebAudio (gain + optional
     * Jungle pitch). MediaElementSource can only be created once per
     * element, so it is cached on the element itself.
     */
    ensureAudioGraph(el) {
        try {
            if (!this.audioCtx) {
                this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (!el._vtSourceNode) {
                try {
                    el._vtSourceNode = this.audioCtx.createMediaElementSource(el);
                } catch (e) {
                    el._vtSourceNode = null;
                }
            }
            if (!this.gainNode) {
                this.gainNode = this.audioCtx.createGain();
                this.gainNode.gain.value = this.volume;
                this.gainNode.connect(this.audioCtx.destination);
            }
            if (!this.jungle) {
                this.jungle = new Jungle(this.audioCtx);
            }
            this.mediaSource = el._vtSourceNode;
            this.applyPitch();
        } catch (err) {
            console.error('[VT] Video audio graph failed:', err);
        }
    },

    /**
     * Connect the current mediaSource either directly to the gain node
     * (pitch 1.0 - no CPU cost) or through the Jungle pitch shifter.
     */
    applyPitch() {
        if (!this.mediaSource || !this.gainNode) {
            // Graph unavailable - fall back to the native pitch control
            try {
                if (this.video && 'preservesPitch' in this.video) {
                    this.video.preservesPitch = this.keepPitch;
                }
            } catch (e) {}
            return;
        }
        // Speed pitch is handled natively (preservesPitch time-stretch -
        // the clean mechanism the first speed build used); the checkbox
        // toggles it. Jungle applies the pitch slider only. Only when the
        // browser lacks preservesPitch do we fall back to compensating
        // the rate shift through the graph.
        const supportsNative = this.video && ('preservesPitch' in this.video);
        if (supportsNative) {
            try { this.video.preservesPitch = this.keepPitch; } catch (e) {}
        }
        const comp = supportsNative
            ? Math.log2(this.pitch)
            : Math.log2(this.pitch) - (this.keepPitch ? Math.log2(this.speed) : 0);
        const useJungle = Math.abs(comp) > 0.01 && !!this.jungle;
        try { this.mediaSource.disconnect(); } catch (e) {}
        if (useJungle) {
            if (!this._jungleOutConnected) {
                this.jungle.output.connect(this.gainNode);
                this._jungleOutConnected = true;
            }
            this.mediaSource.connect(this.jungle.input);
            this.jungle.setPitchOffset(comp);
        } else {
            this.mediaSource.connect(this.gainNode);
        }
    },

    resizeCanvas() {
        if (!this.canvas) return;
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        if (this._waveformData) this._renderWaveformCanvases();
    },

    async show(asset) {
        if (this.asset && this.asset.id === asset.id && this.el.classList.contains('visible')) {
            return;
        }

        this.asset = asset;
        const nameEl = document.getElementById('videoPreviewName');
        if (nameEl) { nameEl.textContent = asset.name; nameEl.title = asset.name; }
        this.el.title = asset.name;

        this.stop();
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Show UI
        this.el.classList.remove('hidden');
        this.el.style.display = 'flex';
        requestAnimationFrame(() => {
            this.el.classList.add('visible');
            this.resizeCanvas();
        });

        // Pick the playback element: the card's own thumbnail video if it
        // exists (single decoder + visible sync), otherwise the hidden bar
        // fallback element.
        const src = 'file:///' + asset.path.replace(/\\/g, '/');
        const cardVideo = document.querySelector(
            '.asset-card[data-asset-id="' + asset.id + '"] .asset-preview'
        );
        const el = cardVideo || this._barVideo;
        this.video = el;
        this._bindEnded(el);

        // Normalize for comparison: the .src getter returns an absolute
        // URL, so compare case-insensitively on the path part only.
        const sameSrc = el.src && el.src.replace(/\\/g, '/').toLowerCase()
            .endsWith(src.replace('file:///', '').toLowerCase());
        try { el.preload = 'auto'; } catch (e) {}
        if (!sameSrc) el.src = src;
        if (cardVideo) {
            // Card thumbs normally loop muted - take them over
            el.loop = false;
        }
        el.muted = false;

        // Start from the beginning - the card thumb sits at the 25%
        // thumbnail position (or wherever a hover preview left it)
        try { el.currentTime = 0; } catch (e) {}

        // Fresh waveform for this asset (async extract + cached)
        this._waveformData = null;
        this._wfBase = null;
        this._wfPlayed = null;
        this._loadWaveform(asset);

        // Wire audio through WebAudio for pitch/volume
        this.ensureAudioGraph(el);

        if (this.pitchValue) this.pitchValue.textContent = this.pitch.toFixed(1) + 'x';
        if (this.speedValue) this.speedValue.textContent = this.speed.toFixed(1) + 'x';
        if (this.keepPitchCheck) this.keepPitchCheck.checked = this.keepPitch;
        try {
            el.playbackRate = this.speed;
        } catch (e) {}
        this.updateTimeDisplay();
        this.draw();
    },

    async showAndPlay(asset) {
        const sameVisible = this.asset && this.asset.id === asset.id &&
            this.el && this.el.classList.contains('visible');
        if (sameVisible && this.isPlaying) {
            this.pause();
            return;
        }
        await this.show(asset);
        this.play();
    },

    hide() {
        this.stop();
        this.el.classList.remove('visible');
        setTimeout(() => {
            this.el.classList.add('hidden');
            this.el.style.display = 'none';
        }, 300);
        this.asset = null;
    },

    stop() {
        const el = this.video;
        if (el) {
            try { el.pause(); } catch (e) {}
        }
        this._stopReverseAudio();
        this.isPlaying = false;
        this._lastTs = 0;
        this._lastUiTs = 0;
        this.updatePlayBtn();
        this.stopAnimationLoop();

        // Restore a card thumbnail element to its idle state
        if (el && el !== this._barVideo) {
            el.muted = true;
            el.loop = true;
            try { el.playbackRate = 1.0; } catch (e) {}
            try { el.currentTime = el.duration ? el.duration * 0.25 : 0; } catch (e) {}
            if (el._vtSourceNode) {
                try { el._vtSourceNode.disconnect(); } catch (e) {}
            }
            this.mediaSource = null;
        } else if (el) {
            el.muted = false;
        }
        this.video = this._barVideo;

        this.draw();
        this.updateTimeDisplay();
    },

    togglePlay() {
        if (this.isPlaying) this.pause();
        else this.play();
    },

    play() {
        const el = this.video;
        if (!el) return;
        this.ensureAudioGraph(el);
        if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();

        const isRev = this.isReversed();

        const startPlayback = () => {
            if (isRev) {
                // Reverse: muted native video + reversed audio via WebAudio
                // (same experience as the audio bar's reverse)
                el.muted = true;
                if (el.duration && el.currentTime <= 0) el.currentTime = el.duration;
                this._startReverseAudio(el.duration ? Math.min(el.currentTime || el.duration, el.duration) : 0);
            } else {
                el.muted = false;
                const p = el.play();
                if (p && typeof p.catch === 'function') p.catch(() => {});
            }
        };

        this.isPlaying = true;
        if (el.readyState >= 1) {
            // Metadata already available
            startPlayback();
        } else {
            // First click on a fresh file: wait for metadata instead of
            // silently doing nothing
            const once = () => {
                el.removeEventListener('loadedmetadata', once);
                if (this.isPlaying) startPlayback();
            };
            el.addEventListener('loadedmetadata', once);
        }

        this._lastTs = 0;
        this.updatePlayBtn();
        this.startAnimationLoop();
    },

    pause() {
        const el = this.video;
        if (el) {
            try { el.pause(); } catch (e) {}
        }
        if (this._reverseSource) {
            try { el.currentTime = this._currentReverseVideoPos(); } catch (e) {}
            this._stopReverseAudio();
        }
        this.isPlaying = false;
        this.updatePlayBtn();
        this.stopAnimationLoop();
    },

    seek(ratio) {
        if (!this.video || !this.video.duration) return;
        this.video.currentTime = ratio * this.video.duration;
        if (this.isPlaying && this.isReversed()) {
            this._startReverseAudio(this.video.currentTime);
        }
        this.draw();
        this.updateTimeDisplay();
    },

    startAnimationLoop() {
        if (this._animationId) cancelAnimationFrame(this._animationId);
        const loop = () => {
            if (!this.isPlaying) return;

            if (this.isReversed()) {
                if (this._reverseSource && this.audioCtx) {
                    // Drive the video from the reversed audio's clock -
                    // the same reverse timing model as the audio bar
                    const t = this._currentReverseVideoPos();
                    if (t <= 0) {
                        try { this.video.currentTime = 0; } catch (e) {}
                        this._stopReverseAudio();
                        this.isPlaying = false;
                        this.updatePlayBtn();
                        this.draw();
                        this.updateTimeDisplay();
                        return;
                    }
                    if (Math.abs(this.video.currentTime - t) > 0.02 * (this._reverseRate || 1)) {
                        try { this.video.currentTime = t; } catch (e) {}
                    }
                } else {
                    // Fallback: no extracted audio - manual backward seek
                    if (!this._lastTs) this._lastTs = performance.now();
                    const now = performance.now();
                    const dt = (now - this._lastTs) / 1000;
                    this._lastTs = now;
                    let t = this.video.currentTime - dt;
                    if (t <= 0) {
                        this.video.currentTime = 0;
                        this.isPlaying = false;
                        this.updatePlayBtn();
                        this.draw();
                        this.updateTimeDisplay();
                        return;
                    }
                    this.video.currentTime = t;
                }
            } else {
                this._lastTs = 0;
            }

            // Full-rate UI like the audio bar - two blits + a text update.
            // At speed > 1 the decoder works harder, so drop redraws to
            // ~30Hz there and give the CPU back to video decoding.
            const minUiMs = this.speed > 1 ? 33 : 0;
            const now = performance.now();
            if (now - (this._lastUiTs || 0) >= minUiMs) {
                this._lastUiTs = now;
                this.draw();
                this.updateTimeDisplay();
            }
            this._animationId = requestAnimationFrame(loop);
        };
        this._animationId = requestAnimationFrame(loop);
    },

    stopAnimationLoop() {
        if (this._animationId) {
            cancelAnimationFrame(this._animationId);
            this._animationId = null;
        }
    },

    updatePlayBtn() {
        if (!this.playIcon || !this.pauseIcon) return;
        this.playIcon.style.display = this.isPlaying ? 'none' : '';
        this.pauseIcon.style.display = this.isPlaying ? '' : 'none';
    },

    updateTimeDisplay() {
        if (!this.timeCurrent) return;
        const cur = this.video && this.video.currentTime ? this.video.currentTime : 0;
        const m = Math.floor(cur / 60);
        const s = Math.floor(cur % 60);
        const cs = Math.floor((cur % 1) * 100);
        this.timeCurrent.textContent =
            String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(cs).padStart(2, '0');
    },

    /**
     * Extract the video's audio track with ffmpeg (subprocess - never
     * blocks the UI), build waveform bars from the small temp wav and
     * cache them by asset path. Falls back to the plain progress track
     * when there is no audio or ffmpeg is missing.
     */
    async _loadWaveform(asset) {
        const key = asset.path;
        const cached = _videoWaveformCache.get(key);
        if (cached) {
            if (this.asset && this.asset.path === key) this._setWaveform(cached);
            return;
        }
        try {
            if (!fs.existsSync(FFMPEG_PATH)) return;
            const tempDir = path.join(os.homedir(), 'AppData', 'Roaming', 'VibeTools', 'temp');
            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
            const tempPath = path.join(tempDir, 'vwave_' + Date.now() + '.wav');
            await new Promise((resolve, reject) => {
                execFile(FFMPEG_PATH, ['-y', '-i', asset.path, '-ac', '2', '-ar', '44100', '-f', 'wav', tempPath], { windowsHide: true },
                    (err) => { err ? reject(err) : resolve(); });
            });
            const data = await generateWaveform(tempPath, 200);
            // Also decode the wav in memory - needed for reversed playback
            // (the audio bar keeps its buffer around for the same reason)
            let audioBuffer = null;
            try {
                if (!this.audioCtx) {
                    this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                }
                const raw = fs.readFileSync(tempPath);
                const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
                audioBuffer = await this.audioCtx.decodeAudioData(ab);
            } catch (e) {}
            try { fs.unlinkSync(tempPath); } catch (e) {}
            // generateWaveform returns random fallback bars with duration 0
            if (!data || !data.duration) return;
            const entry = { bars: data.bars, duration: data.duration, audioBuffer: audioBuffer };
            _videoWaveformCache.set(key, entry);
            if (this.asset && this.asset.path === key) this._setWaveform(entry);
        } catch (e) {
            // No audio track / ffmpeg failed - plain progress bar fallback
        }
    },

    _setWaveform(data) {
        this._waveformData = data;
        this._reversedCache = null;
        this._reversedFor = null;
        this._renderWaveformCanvases();
        this.draw();
    },

    _getReversedBuffer(buffer) {
        if (this._reversedFor === buffer && this._reversedCache) return this._reversedCache;
        const ctx = this.audioCtx;
        const rev = ctx.createBuffer(buffer.numberOfChannels, buffer.length, buffer.sampleRate);
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const srcData = buffer.getChannelData(ch);
            const dstData = rev.getChannelData(ch);
            for (let i = 0; i < srcData.length; i++) {
                dstData[i] = srcData[srcData.length - 1 - i];
            }
        }
        this._reversedFor = buffer;
        this._reversedCache = rev;
        return rev;
    },

    _currentReverseVideoPos() {
        if (!this._reverseSource || !this.audioCtx) {
            return this.video ? this.video.currentTime : 0;
        }
        const elapsed = (this.audioCtx.currentTime - this._reverseStartCtxTime) * (this._reverseRate || 1);
        return Math.max(0, this._reverseStartVideoPos - elapsed);
    },

    /**
     * Play the reversed audio track via WebAudio from the mirrored
     * offset - the same reverse model as the audio bar. The animation
     * loop follows the audio clock to seek the muted video element.
     */
    _startReverseAudio(fromVideoPos) {
        this._stopReverseAudio();
        const buf = this._waveformData && this._waveformData.audioBuffer;
        if (!buf || !this.audioCtx) return; // no audio track - silent dt fallback
        if (this.audioCtx.state === 'suspended') this.audioCtx.resume();
        if (!this.gainNode) {
            this.gainNode = this.audioCtx.createGain();
            this.gainNode.gain.value = this.volume;
            this.gainNode.connect(this.audioCtx.destination);
        }
        const dur = buf.duration;
        const mirrored = Math.max(0, Math.min(dur, dur - fromVideoPos));
        const src = this.audioCtx.createBufferSource();
        src.buffer = this._getReversedBuffer(buf);
        src.playbackRate.value = this.speed;
        this._reverseRate = this.speed;
        const comp = Math.log2(this.pitch) - (this.keepPitch ? Math.log2(this.speed) : 0);
        const useJungle = Math.abs(comp) > 0.01 && !!this.jungle;
        if (useJungle) {
            if (!this._jungleOutConnected) {
                this.jungle.output.connect(this.gainNode);
                this._jungleOutConnected = true;
            }
            src.connect(this.jungle.input);
            this.jungle.setPitchOffset(comp);
        } else {
            src.connect(this.gainNode);
        }
        this._reverseSource = src;
        this._reverseStartCtxTime = this.audioCtx.currentTime;
        this._reverseStartVideoPos = fromVideoPos;
        src.onended = () => {
            if (this._reverseSource !== src) return;
            this._reverseSource = null;
            if (this.isPlaying && this.isReversed()) {
                try { this.video.currentTime = 0; } catch (e) {}
                this.isPlaying = false;
                this.updatePlayBtn();
                this.stopAnimationLoop();
                this.draw();
                this.updateTimeDisplay();
            }
        };
        src.start(0, mirrored);
    },

    _stopReverseAudio() {
        if (!this._reverseSource) return;
        try { this._reverseSource.onended = null; this._reverseSource.stop(); } catch (e) {}
        try { this._reverseSource.disconnect(); } catch (e) {}
        this._reverseSource = null;
    },

    _restartReverseIfActive() {
        if (!this.isPlaying || !this.isReversed() || !this._reverseSource) return;
        this._startReverseAudio(this._currentReverseVideoPos());
    },

    applySpeed() {
        if (this.video) {
            try { this.video.playbackRate = this.speed; } catch (e) {}
        }
        this.applyPitch();
        this._restartReverseIfActive();
    },

    /**
     * Pre-render the waveform into two offscreen canvases (unplayed /
     * played). Per-frame drawing then costs two blits instead of ~200
     * strokes with shadows - no stutter during video playback.
     */
    _renderWaveformCanvases() {
        this._wfBase = null;
        this._wfPlayed = null;
        if (!this._waveformData || !this.canvas) return;
        if (this.el && this.el.classList.contains('waveform-off')) return;
        const width = this.canvas.width;
        const height = this.canvas.height;
        if (!width || !height) return;
        // Same palette as the audio bar's draw() in audioPreview.js
        const accentColor = '#818cf8';
        const bars = this._waveformData.bars;
        const totalBarWidth = width / bars.length;
        const barWidth = Math.max(1.5, totalBarWidth * 0.6);
        const make = (color, glow) => {
            const c = document.createElement('canvas');
            c.width = width;
            c.height = height;
            const g = c.getContext('2d');
            g.lineCap = 'round';
            g.lineWidth = barWidth;
            if (glow) {
                g.shadowColor = color;
                g.shadowBlur = 2;
            }
            const centerY = height / 2;
            for (let i = 0; i < bars.length; i++) {
                const barHeight = Math.max(2, bars[i] * height * 0.8);
                const x = (i * totalBarWidth) + (totalBarWidth / 2);
                g.strokeStyle = color;
                g.beginPath();
                g.moveTo(x, centerY - barHeight / 2);
                g.lineTo(x, centerY + barHeight / 2);
                g.stroke();
            }
            return c;
        };
        this._wfBase = make('rgba(255, 255, 255, 0.2)', false);
        this._wfPlayed = make(accentColor, true);
    },

    draw() {
        if (!this.canvas || !this.ctx) return;
        const width = this.canvas.width;
        const height = this.canvas.height;
        const ctx = this.ctx;

        ctx.clearRect(0, 0, width, height);

        const duration = this.video && this.video.duration ? this.video.duration : 0;
        const cur = this.video && this.video.currentTime ? this.video.currentTime : 0;
        const progress = duration ? cur / duration : 0;

        if (this._wfBase && this._wfPlayed) {
            // Two pre-rendered layers - two drawImage calls per frame
            ctx.drawImage(this._wfBase, 0, 0);
            if (progress > 0) {
                ctx.save();
                ctx.beginPath();
                ctx.rect(0, 0, width * progress, height);
                ctx.clip();
                ctx.drawImage(this._wfPlayed, 0, 0);
                ctx.restore();
                // Playhead only when something is played (same as audio bar)
                ctx.fillStyle = '#fff';
                ctx.fillRect(progress * width - 1, 0, 2, height);
            }
            return;
        }

        // Fallback: thin progress strip (waveform disabled or still loading)
        ctx.fillStyle = 'rgba(255, 255, 255, 0.06)';
        const trackH = 4;
        const trackY = (height - trackH) / 2;
        ctx.fillRect(0, trackY, width, trackH);
        if (progress > 0) {
            ctx.fillStyle = '#818cf8';
            ctx.fillRect(0, trackY, width * progress, trackH);
            ctx.fillStyle = '#fff';
            ctx.fillRect(progress * width - 1, trackY - 4, 2, trackH + 8);
        }
    },

    isOpen() {
        return !!(this.el && this.el.classList.contains('visible'));
    }
};

export { VideoPreview };