/**
 * VibeTools - Main JavaScript
 * Handles UI logic, drag & drop, and communication with ExtendScript
 */

import { addLog } from './log.js';
import { AudioPreview, generateWaveform, setupStaticWaveform } from './audioPreview.js';
import { VideoPreview } from './videoPreview.js';

// Node.js modules (available in CEP)
const fs = window.require('fs');
const path = window.require('path');
const os = window.require('os');
const { execFileSync } = window.require('child_process');

// Get extension directory for proper require paths (decode URL encoding)
const extensionDir = decodeURIComponent(path.dirname(window.location.pathname.replace(/^\//, '')));
const WM_CMD_EXE = path.join(extensionDir, 'support_files', 'VT_WMCommand.exe');

// Move OS keyboard focus from the CEP panel (Chromium child owned by the
// CEPHtmlEngine process) to the Premiere main window. The host DLL's
// copy/paste commands use SendInput (synthetic Ctrl+C/V) which go to the
// OS-focused window - when the panel has focus after a click/double-click
// the keystrokes never reach Premiere. Same approach as AtomX's
// pprsequencer.exe: find window of class "Premiere Pro", SetForegroundWindow,
// SetFocus (via AttachThreadInput, plain SetFocus fails cross-thread).
function runFocusFix() {
    try {
        const out = execFileSync(WM_CMD_EXE, ['focusfix'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const lastLine = String(out || '').trim().split('\n').pop();
        addLog('focusfix: ' + lastLine);
        return true;
    } catch (ex) {
        const outMsg = ex && ex.stdout ? String(ex.stdout).trim().split('\n').pop() : (ex && ex.message ? ex.message : String(ex));
        if (ex && ex.status === 7) {
            addLog('focusfix: ' + outMsg + ' (will rely on current focus / nest fallback)');
            return false;
        }
        addLog('focusfix failed: ' + outMsg, 'warning');
        return false;
    }
}

// Capture the current OS focus HWND if it is the Premiere timeline, so
// focusfix can restore it later without moving focus to the main frame
// (which does not enable copy/paste). Exit 7 = focus is not on timeline,
// informational only.
function rememberTimelineFocus() {
    try {
        const out = execFileSync(WM_CMD_EXE, ['rememberfocus'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
        const lastLine = String(out || '').trim().split('\n').pop();
        addLog('rememberfocus: ' + lastLine);
    } catch (ex) {
        const outMsg = ex && ex.stdout ? String(ex.stdout).trim().split('\n').pop() : (ex && ex.message ? ex.message : String(ex));
        if (ex && ex.status === 7) {
            addLog('rememberfocus: ' + outMsg);
        } else {
            addLog('rememberfocus failed: ' + outMsg, 'warning');
        }
    }
}

// CEP Interface
const csInterface = new CSInterface();

// Asset storage path
const ASSETS_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'VibeTools', 'assets');
const PRESETS_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'VibeTools', 'presets');

// UI Elements
const assetGrid = document.getElementById('assetGrid');

const emptyState = document.getElementById('emptyState');
const saveAssetBtn = document.getElementById('saveAssetBtn');
const saveDialog = document.getElementById('saveDialog');
const assetNameInput = document.getElementById('assetName');
const cancelSaveBtn = document.getElementById('cancelSave');
const confirmSaveBtn = document.getElementById('confirmSave');
const statusText = document.getElementById('statusText');
const debugLog = document.getElementById('debugLog');
const clearLogBtn = document.getElementById('clearLog');
const testCmdsBtn = document.getElementById('testCmds');
const reloadScriptsBtn = document.getElementById('reloadScripts');
const scriptVersionEl = document.getElementById('scriptVersion');
const assetTypeSelect = document.getElementById('assetType');
const categorySidebar = document.getElementById('categorySidebar');

// Must match VT_SCRIPT_VERSION at the top of jsx/hostscript.jsx. Premiere caches
// ExtendScript aggressively, so a mismatch almost always means the host script
// on disk was edited but the engine is still serving an old copy. Bump both.
const EXPECTED_SCRIPT_VERSION = '3.9.12';

// Asset list
let assets = [];

// Category state. v3.9.6: the panel reopens on the category that was last
// selected, not always on All.
const SELECTED_CATEGORY_KEY = 'vt_selected_category';
function readSavedCategory() {
    let saved = null;
    try { saved = localStorage.getItem(SELECTED_CATEGORY_KEY); } catch (e) { saved = null; }
    if (!saved) return 'all';
    // Only accept a category that still has a tile in this version of the panel
    return document.querySelector('.category-tile[data-category="' + saved + '"]') ? saved : 'all';
}
function saveSelectedCategory(category) {
    try { localStorage.setItem(SELECTED_CATEGORY_KEY, category); } catch (e) { /* storage unavailable */ }
}
let selectedCategory = readSavedCategory();
let searchFilter = ''; // Search filter text
// Stored lists can be corrupted (or storage unavailable) - never let that
// stop the panel from loading.
function readStoredList(key) {
    try {
        const v = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(v) ? v : [];
    } catch (e) {
        return [];
    }
}
let recentAssets = readStoredList('vt_recent_assets');
const MAX_RECENT = 10;

// Context menu state
let contextMenuAsset = null;
const contextMenu = document.getElementById('contextMenu');
const previewPicker = document.getElementById('previewPicker');

// Multi-select state
let selectedAssetIds = new Set();
let lastSelectedAssetId = null;

// Dropdown and import state
const saveDropdownMenu = document.getElementById('saveDropdownMenu');
const saveDropdownToggle = document.getElementById('saveDropdownToggle');
const importPicker = document.getElementById('importPicker');
let pendingImportFiles = []; // File paths waiting for category selection (batch supported)
let _hoverVideoEl = null;    // At most ONE hover-preview video decodes at a time

// Temp directory for .vtbk files
const VTBK_TEMP_DIR = path.join(os.tmpdir(), 'VibeTools');

// Permanent folder for audio that was dropped with pitch/reverse applied. The
// processed render is otherwise temporary, and Premiere keeps referencing the
// dropped clip's source file - storing it here (not %TEMP%) avoids "missing media".
const DROPPED_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'VibeTools', 'dropped');

// Event pausing - blocks evalScript calls during critical drag-drop operations
window._vtBusy = false;
function setVtBusy(busy) {
    window._vtBusy = busy;
    if (busy) {
        addLog('VT_BUSY: ON - blocking evalScript', 'info');
    } else {
        addLog('VT_BUSY: OFF', 'info');
    }
}
function isVtBusy() { return window._vtBusy; }

/**
 * Play a beep sound for notifications
 * @param {number} frequency - Frequency in Hz (default 440 = A4)
 * @param {number} duration - Duration in ms (default 150)
 * @param {string} type - 'start' or 'success'
 */
function playBeep(type = 'start') {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = ctx.createOscillator();
        const gainNode = ctx.createGain();

        oscillator.connect(gainNode);
        gainNode.connect(ctx.destination);

        if (type === 'start') {
            // Warning beep - two quick low tones
            oscillator.frequency.value = 440;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.3;
            oscillator.start();
            oscillator.stop(ctx.currentTime + 0.1);
        } else if (type === 'success') {
            // Success beep - ascending two-tone
            oscillator.frequency.value = 523; // C5
            oscillator.type = 'sine';
            gainNode.gain.value = 0.3;
            oscillator.start();
            oscillator.frequency.setValueAtTime(659, ctx.currentTime + 0.1); // E5
            oscillator.stop(ctx.currentTime + 0.2);
        } else if (type === 'error') {
            // Error beep - low descending
            oscillator.frequency.value = 300;
            oscillator.type = 'sine';
            gainNode.gain.value = 0.3;
            oscillator.start();
            oscillator.frequency.setValueAtTime(200, ctx.currentTime + 0.15);
            oscillator.stop(ctx.currentTime + 0.3);
        }
    } catch (e) {
        // Ignore audio errors
    }
}

/**
 * Get preview file path for an asset (same name but .mp4 extension)
 */
function getPreviewPath(assetPath) {
    // Replace any extension with .mp4 (auto-generated by VT_saveAssetNative)
    return assetPath.replace(/\.[^.]+$/, '.mp4');
}

/**
 * Check if file is an audio file by extension
 */
function isAudioFile(filePath) {
    return /\.(mp3|wav|ogg|aac|m4a|flac|aiff)$/i.test(filePath);
}
/**
 * Check if a file is a playable video format.
 */
function isVideoFile(filePath) {
    if (!filePath) return false;
    const ext = path.extname(filePath).toLowerCase();
    return ['.mp4', '.mov', '.webm', '.avi', '.mkv', '.m4v'].includes(ext);
}

/**
 * Check if file is a MOGRT file by extension
 */
function isMogrtFile(filePath) {
    return /\.mogrt$/i.test(filePath);
}

/**
 * Check if file is an image by extension
 */
function isImageFile(filePath) {
    return /\.(png|jpe?g|gif|tiff?|webp|bmp|psd|ai)$/i.test(filePath);
}

/**
 * Image formats the panel browser can render as a card preview
 */
function isImagePreviewable(filePath) {
    return /\.(png|jpe?g|gif|webp|bmp)$/i.test(filePath);
}

/**
 * Check if asset is video-based (for timeline placement)
 */
function isVideoAsset(asset) {
    // If it's external, check the file extension
    if (asset.isExternal) {
        return !isAudioFile(asset.path);
    }
    // For .prproj assets, check the type field
    return asset.type !== 'audio';
}

/**
 * Check if preview exists for asset (only for video assets, not audio/mogrt)
 */
const previewCache = new Map();

function hasPreview(asset) {
    // No media file = no preview (defensive)
    if (!asset.path) return false;
    // Audio files and MOGRT files don't have video preview
    if (asset.isExternal && isAudioFile(asset.path)) {
        return false;
    }
    if (isMogrtFile(asset.path)) {
        return false;
    }

    const key = asset.id || asset.path;
    if (previewCache.has(key)) return previewCache.get(key);

    const previewPath = getPreviewPath(asset.path);
    const exists = fs.existsSync(previewPath);
    previewCache.set(key, exists);
    return exists;
}

function invalidatePreviewCache(assetId) {
    previewCache.delete(assetId);
}

/**
 * In-memory favorites cache avoids repeated localStorage reads
 */
let favoritesCache = null;

function getFavoritesSet() {
    if (favoritesCache === null) {
        favoritesCache = new Set(readStoredList('vt_favorites'));
    }
    return favoritesCache;
}

function invalidateFavoritesCache() {
    favoritesCache = null;
}

/**
 * Audio context for waveform generation
 */

/**
 * Create a .vtbk file for drag & drop
 * This creates a native Premiere importer file that will be used as placeholder
 * @param {object} asset - The asset being dragged
 * @returns {string|null} Path to created .vtbk file, or null on error
 */
function createVtbkFile(asset) {
    try {
        // Ensure temp directory exists
        if (!fs.existsSync(VTBK_TEMP_DIR)) {
            fs.mkdirSync(VTBK_TEMP_DIR, { recursive: true });
        }
        // Audio: drop a vt_drag_* placeholder file. The name lets VT_findPlaceholder
        // locate the dropped clip after dragend, so replacePlaceholderWithAsset can
        // swap it for the (pitched, once ffmpeg finishes) audio at the drop position.
        // Stored in DROPPED_DIR (permanent), so even if the swap doesn't run it never
        // becomes "missing media" (unlike the old %TEMP% copy that got cleaned up).
        if (isAudioFile(asset.path)) {
            let srcPath = asset.path;
            if (typeof AudioPreview !== 'undefined' && AudioPreview.asset &&
                AudioPreview.asset.id === asset.id && AudioPreview.processedAudioPath) {
                srcPath = AudioPreview.processedAudioPath;
            }
            if (!fs.existsSync(DROPPED_DIR)) fs.mkdirSync(DROPPED_DIR, { recursive: true });
            const ext = path.extname(srcPath);
            const placeholderPath = path.join(DROPPED_DIR, 'vt_drag_' + Date.now() + ext);
            fs.copyFileSync(srcPath, placeholderPath);
            return placeholderPath;
        }

        // Read asset metadata to get duration info
        let frameRate = 30000;
        let frameRateDivisor = 1001;
        let frameCount = 30;
        let hasVideo = true;
        let hasAudio = true;

        // Try to read from asset metadata
        if (asset.metadata) {
            if (asset.metadata.frameRate) frameRate = asset.metadata.frameRate;
            if (asset.metadata.frameRateDivisor) frameRateDivisor = asset.metadata.frameRateDivisor;
            if (asset.metadata.frameCount) frameCount = asset.metadata.frameCount;
            if (asset.metadata.hasVideo !== undefined) hasVideo = asset.metadata.hasVideo;
            if (asset.metadata.hasAudio !== undefined) hasAudio = asset.metadata.hasAudio;
        }

        if (isAudioFile(asset.path)) {
            hasVideo = false;
        }

        // Create .vtbk content (JSON format)
        const vtbkContent = {
            streams: [{
                hasVideo: hasVideo,
                hasAudio: hasAudio,
                videoFrameRate: frameRate,
                videoFrameRateDivisor: frameRateDivisor,
                videoFrameCount: frameCount
            }],
            _vtAssetId: asset.id || 1,
            _vtAssetName: asset.name || 'VT Asset',
            _vtAssetPath: asset.path || ''
        };

        // Write to a FIXED temp file path - Premiere deduplicates imports by path,
        // so dropping the same placeholder again reuses the existing project item
        // instead of creating a new one (AtomX-style: at most ONE placeholder item).
        // Premiere may hold a file lock after importing the previous placeholder,
        // so retry with delete + short wait before giving up.
        const vtbkPath = path.join(VTBK_TEMP_DIR, 'vt_placeholder.vtbk');
        const vtbkJson = JSON.stringify(vtbkContent);
        let written = false;
        for (let attempt = 0; attempt < 3 && !written; attempt++) {
            try {
                fs.writeFileSync(vtbkPath, vtbkJson, 'utf8');
                written = true;
            } catch (writeErr) {
                if (attempt < 2) {
                    try { fs.unlinkSync(vtbkPath); } catch (unlinkErr) { /* file may not exist or still locked */ }
                    // Busy-wait via Atomics is not available in CEP; use a sync sleep hack
                    const sleepUntil = Date.now() + 150;
                    while (Date.now() < sleepUntil) { /* spin */ }
                } else {
                    // Last resort: unique filename so the drag can still proceed
                    const uniquePath = path.join(VTBK_TEMP_DIR, 'vt_placeholder_' + Date.now() + '.vtbk');
                    try {
                        fs.writeFileSync(uniquePath, vtbkJson, 'utf8');
                        console.warn('vtbk retry: wrote to unique path', uniquePath, 'original error:', writeErr.message);
                        return uniquePath;
                    } catch (finalErr) {
                        console.error('Error creating .vtbk file (all retries failed):', finalErr.message, 'first error:', writeErr.message);
                        return null;
                    }
                }
            }
        }
        return written ? vtbkPath : null;
    } catch (e) {
        console.error('Error creating .vtbk file:', e.message || e);
        return null;
    }
}

/**
 * Initialize Settings Module
 */
function initSettings() {
    const settingsBtn = document.getElementById('settingsBtn');
    const settingsDialog = document.getElementById('settingsDialog');
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    const settingDebugPanel = document.getElementById('settingDebugPanel');
    const settingAutoPlayAudio = document.getElementById('settingAutoPlayAudio');
    const settingShowCardMeta = document.getElementById('settingShowCardMeta');
    const settingShowPreviewDim = document.getElementById('settingShowPreviewDim');
    const settingWaveformHeight = document.getElementById('settingWaveformHeight');
    const settingSubcatFilterSize = document.getElementById('settingSubcatFilterSize');
    const settingSidebarIconGap = document.getElementById('settingSidebarIconGap');
    const settingPresetSoundDisabled = document.getElementById('settingPresetSoundDisabled');
    const settingAssetSoundDisabled = document.getElementById('settingAssetSoundDisabled');
    const debugPanel = document.getElementById('debugPanel');

    // Functions
    function openSettings() {
        if (settingsDialog) {
            settingsDialog.style.display = 'flex';
            // Slight delay for animation if needed
            requestAnimationFrame(() => {
                settingsDialog.classList.add('open');
            });
        }
    }

    function closeSettings() {
        if (settingsDialog) {
            settingsDialog.classList.remove('open');
            setTimeout(() => {
                settingsDialog.style.display = 'none';
            }, 200); // match transition
        }
    }

    function toggleDebugVisibility(show) {
        if (debugPanel) {
            if (show) {
                debugPanel.style.display = 'flex';
            } else {
                debugPanel.style.display = 'none';
            }
        }
        localStorage.setItem('vt_show_debug', show);
    }

    // Initialize state
    const showDebug = localStorage.getItem('vt_show_debug') !== 'false';
    if (settingDebugPanel) {
        settingDebugPanel.checked = showDebug;
        toggleDebugVisibility(showDebug);
    }
    if (settingAutoPlayAudio) {
        settingAutoPlayAudio.checked = localStorage.getItem('vt_auto_play_audio') === 'true';
    }
    if (settingShowCardMeta) {
        // Default: shown (only hidden when explicitly set to 'false')
        settingShowCardMeta.checked = localStorage.getItem('vt_show_card_meta') !== 'false';
        applyCardMetaVisibility(settingShowCardMeta.checked);
    }
    if (settingShowPreviewDim) {
        // Default: dim hidden (checked = restore original dim + title)
        settingShowPreviewDim.checked = localStorage.getItem('vt_show_preview_dim') === 'true';
        applyPreviewDimVisibility(settingShowPreviewDim.checked);
    }
    if (settingPresetSoundDisabled) {
        settingPresetSoundDisabled.checked = localStorage.getItem('vt_preset_sound_disabled') === 'true';
    }
    if (settingAssetSoundDisabled) {
        settingAssetSoundDisabled.checked = localStorage.getItem('vt_asset_sound_disabled') === 'true';
    }
    if (settingWaveformHeight) {
        const savedWaveH = parseInt(localStorage.getItem('vt_waveform_height') || '40', 10);
        const waveH = (isNaN(savedWaveH) ? 40 : Math.min(100, Math.max(0, savedWaveH)));
        settingWaveformHeight.value = waveH;
        applyWaveformHeight(waveH);
        const waveHValueEl = document.getElementById('settingWaveformHeightValue');
        if (waveHValueEl) waveHValueEl.textContent = waveH === 0 ? 'Off' : waveH + ' px';
    }
    if (settingSubcatFilterSize) {
        const savedChipSize = parseInt(localStorage.getItem('vt_subcat_chip_size') || '11', 10);
        const chipSize = (isNaN(savedChipSize) ? 11 : Math.min(20, Math.max(8, savedChipSize)));
        settingSubcatFilterSize.value = chipSize;
        applySubcatFilterSize(chipSize);
        const chipSizeValueEl = document.getElementById('settingSubcatFilterSizeValue');
        if (chipSizeValueEl) chipSizeValueEl.textContent = chipSize + ' px';
    }

    if (settingSidebarIconGap) {
        const gap = readSidebarIconGap();
        settingSidebarIconGap.value = gap;
        applySidebarIconGap(gap);
        const gapValueEl = document.getElementById('settingSidebarIconGapValue');
        if (gapValueEl) gapValueEl.textContent = gap + ' px';
    }

    // Event Listeners
    // Use document delegation for settingsBtn since it might be recreated by switchModule
    document.addEventListener('click', function (e) {
        const btn = e.target.closest('#settingsBtn');
        if (btn) {
            openSettings();
        }
    });

    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', closeSettings);
    }

    if (settingsDialog) {
        settingsDialog.addEventListener('click', function (e) {
            if (e.target === settingsDialog) closeSettings();
        });
    }

    if (settingDebugPanel) {
        settingDebugPanel.addEventListener('change', function () {
            toggleDebugVisibility(this.checked);
        });
    }

    if (settingAutoPlayAudio) {
        settingAutoPlayAudio.addEventListener('change', function () {
            localStorage.setItem('vt_auto_play_audio', this.checked);
        });
    }

    if (settingShowCardMeta) {
        settingShowCardMeta.addEventListener('change', function () {
            localStorage.setItem('vt_show_card_meta', this.checked);
            applyCardMetaVisibility(this.checked);
        });
    }

    if (settingShowPreviewDim) {
        settingShowPreviewDim.addEventListener('change', function () {
            localStorage.setItem('vt_show_preview_dim', this.checked);
            applyPreviewDimVisibility(this.checked);
        });
    }

    if (settingPresetSoundDisabled) {
        settingPresetSoundDisabled.addEventListener('change', function () {
            localStorage.setItem('vt_preset_sound_disabled', this.checked);
        });
    }

    if (settingAssetSoundDisabled) {
        settingAssetSoundDisabled.addEventListener('change', function () {
            localStorage.setItem('vt_asset_sound_disabled', this.checked);
        });
    }

    if (settingWaveformHeight) {
        settingWaveformHeight.addEventListener('input', function () {
            const raw = parseInt(this.value, 10);
            const px = isNaN(raw) ? 40 : raw;
            const waveHValueEl = document.getElementById('settingWaveformHeightValue');
            if (waveHValueEl) waveHValueEl.textContent = px === 0 ? 'Off' : px + ' px';
            applyWaveformHeight(px);
        });
        settingWaveformHeight.addEventListener('change', function () {
            localStorage.setItem('vt_waveform_height', this.value);
        });
    }

    if (settingSubcatFilterSize) {
        settingSubcatFilterSize.addEventListener('input', function () {
            const raw = parseInt(this.value, 10);
            const px = isNaN(raw) ? 11 : raw;
            const chipSizeValueEl = document.getElementById('settingSubcatFilterSizeValue');
            if (chipSizeValueEl) chipSizeValueEl.textContent = px + ' px';
            applySubcatFilterSize(px);
        });
        settingSubcatFilterSize.addEventListener('change', function () {
            localStorage.setItem('vt_subcat_chip_size', this.value);
        });
    }

    if (settingSidebarIconGap) {
        settingSidebarIconGap.addEventListener('input', function () {
            const px = clampSidebarIconGap(parseInt(this.value, 10));
            const gapValueEl = document.getElementById('settingSidebarIconGapValue');
            if (gapValueEl) gapValueEl.textContent = px + ' px';
            applySidebarIconGap(px);
        });
        settingSidebarIconGap.addEventListener('change', function () {
            try { localStorage.setItem('vt_sidebar_icon_gap', clampSidebarIconGap(parseInt(this.value, 10))); } catch (e) { /* storage unavailable */ }
        });
    }
}

/**
 * Empty space between the category icons in the sidebar. One value for every
 * gap, so the icons are evenly spaced; the group separator is only a line and
 * adds nothing of its own.
 */
const SIDEBAR_ICON_GAP_DEFAULT = 10;
function clampSidebarIconGap(px) {
    if (isNaN(px)) return SIDEBAR_ICON_GAP_DEFAULT;
    return Math.min(30, Math.max(0, px));
}
function readSidebarIconGap() {
    let raw = null;
    try { raw = localStorage.getItem('vt_sidebar_icon_gap'); } catch (e) { raw = null; }
    if (raw === null || raw === '') return SIDEBAR_ICON_GAP_DEFAULT;
    return clampSidebarIconGap(parseInt(raw, 10));
}
function applySidebarIconGap(px) {
    const gap = clampSidebarIconGap(px);
    document.documentElement.style.setProperty('--sidebar-icon-gap', gap + 'px');
    if (!categorySidebar) return;
    // Set it on the elements as well: CEP serves the panel's stylesheet from
    // its own cache and can hand out an older copy after a restart, and an
    // inline style wins over whichever copy is live (v3.9.6).
    categorySidebar.querySelectorAll('.category-tile').forEach(function (t) {
        t.style.marginBottom = gap + 'px';
    });
    categorySidebar.querySelectorAll('.sidebar-divider').forEach(function (d) {
        d.style.height = '0';
        d.style.margin = '0';
        d.style.background = 'none';
    });
}

/**
 * Whether clicking an audio/video asset should immediately start playback.
 */
function isAutoPlayAudioEnabled() {
    return localStorage.getItem('vt_auto_play_audio') === 'true';
}

/**
 * Whether preset save/apply sounds are muted.
 */
function isPresetSoundDisabled() {
    return localStorage.getItem('vt_preset_sound_disabled') === 'true';
}
function isAssetSoundDisabled() {
    return localStorage.getItem('vt_asset_sound_disabled') === 'true';
}

/**
 * Show/hide the "TYPE В· Subcategory" meta line under asset previews.
 * Toggles a class on the grid so cached cards update instantly.
 */
function applyCardMetaVisibility(show) {
    if (assetGrid) {
        assetGrid.classList.toggle('hide-card-meta', !show);
    }
}

/**
 * Show/hide the dark dim gradient + title overlay on cards with real
 * previews (video files). Off by default; a selected/playing card
 * always hides the overlay regardless of this setting.
 */
function applyPreviewDimVisibility(show) {
    if (assetGrid) {
        assetGrid.classList.toggle('show-preview-dim', show);
    }
}

/**
 * Adjust the height of the waveform row inside the audio preview bar.
 */
function applyWaveformHeight(px) {
    const off = !px;
    // Off state: keep a slim strip so the progress line still shows
    const effective = off ? 14 : px;
    ['audioPreviewBar', 'videoPreviewBar'].forEach(function (id) {
        const bar = document.getElementById(id);
        if (bar) {
            bar.style.setProperty('--waveform-height', effective + 'px');
            bar.classList.toggle('waveform-off', off);
        }
    });
}

/**
 * Adjust the font size of the subcategory filter chips via a CSS variable,
 * so it survives the filter bar's innerHTML rebuilds on every render.
 */
function applySubcatFilterSize(px) {
    document.documentElement.style.setProperty('--filter-chip-size', px + 'px');
}

/**
 * Aspect ratio helpers - the 16:9 / 9:16 choice is stored per category
 * ("group"), e.g. video can be 9:16 while audio stays 16:9.
 */
function getCategoryAspect(category) {
    return localStorage.getItem('vt_aspect_' + category) || '16:9';
}

function setCategoryAspect(category, aspect) {
    localStorage.setItem('vt_aspect_' + category, aspect);
}

/**
 * Apply the stored aspect of a category to the grid and sync the
 * toolbar buttons' active state.
 */
function applyCategoryAspect(category) {
    const aspect = getCategoryAspect(category);
    document.documentElement.style.setProperty('--card-aspect', aspect === '9:16' ? '9/16' : '16/9');
    document.querySelectorAll('.aspect-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.aspect === aspect);
    });
}

/**
 * Zoom helpers - the card size slider is stored per category ("group")
 * too, so every group can keep its own layout.
 */
const ZOOM_SNAP_WIDTHS = {
    1: '110px', // Small
    2: '160px', // Medium
    3: '100%'   // Full width (1 column)
};

function getCategoryZoom(category) {
    // Legacy global step seeds groups that were never set individually
    return localStorage.getItem('vt_zoom_step_' + category)
        || localStorage.getItem('vt_zoom_step')
        || '2';
}

function setCategoryZoom(category, step) {
    localStorage.setItem('vt_zoom_step_' + category, step);
}

/**
 * Apply the stored zoom of a category to the grid and sync the slider.
 */
function applyCategoryZoom(category) {
    const step = getCategoryZoom(category);
    const zoomSlider = document.getElementById('zoomSlider');
    if (zoomSlider) zoomSlider.value = step;
    assetGrid.style.setProperty('--card-min-width', ZOOM_SNAP_WIDTHS[step] || ZOOM_SNAP_WIDTHS[2]);
}

/**
 * Initialize the panel
 */
function init() {

    // Register undo-group collapse listener (event-driven, no polling)
    registerUndoEventListener();

    // Ensure assets directory exists
    ensureAssetsDir();

    // Clean up temporary files
    cleanupTempFiles();

    // Finish deletes whose files were still locked, and remove leftovers of
    // deletes that failed in older versions (v3.9.6)
    try { retryPendingDeletes(); sweepOrphanAssetFiles(); } catch (e) { /* non-fatal */ }

    // Load existing assets
    loadAssets();

    // Load effect presets
    loadPresets();

    // Setup event listeners
    setupEventListeners();
    setupEventListenersContinued();
    initSettings(); // Initialize Settings Module

    // Restore active module state (triggers toolbar setup).
    // Skipped for 'assets' because index.html already ships in exactly that
    // state - the synthetic click would only re-run loadAssets(), scanning the
    // whole assets directory a second time on every panel open. Mirrors the
    // same guard in setupEventListenersContinued().
    setTimeout(() => {
        const activeModule = localStorage.getItem('vt_active_module') || 'assets';
        if (activeModule === 'assets') return;
        const tab = document.querySelector(`.module-tab[data-module="${activeModule}"]`);
        if (tab) {
            tab.click();
        }
    }, 50);

    // Warm-up ExtendScript to prevent first-call crash after Premiere restart
    warmUpExtendScript();

    // Initialize Audio Preview Bar
    if (AudioPreview) AudioPreview.init();
    if (VideoPreview) VideoPreview.init();

    setStatus('Ready');
}

/**
 * Warm-up ExtendScript engine to prevent first-call crash
 * This forces initialization of DLL and all dependencies before first real use
 * Includes auto-retry logic with delays in case Premiere isn't fully ready
 * 
 * IMPORTANT: When Premiere starts with the panel already open (from previous session),
 * the ExtendScript engine may not be fully initialized. We need to wait longer
 * and verify $.global is accessible before attempting to use DLL.
 */
async function warmUpExtendScript() {
    addLog('Warming up ExtendScript...', 'info');

    const scriptPath = extensionDir + '/jsx/hostscript.jsx';
    const maxRetries = 5;  // Increased from 3 to handle startup race condition
    const delays = [1000, 1500, 2000, 3000, 5000]; // Longer delays, especially first one

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            // CRITICAL: Wait longer on first attempt to let Premiere/ExtendScript fully initialize
            // This is especially important when panel was open when Premiere was closed
            // and auto-loads on next Premiere start
            if (attempt === 0) {
                addLog('Waiting for ExtendScript engine to initialize...', 'info');
                await new Promise(resolve => setTimeout(resolve, 1500)); // Increased from 300ms to 1.5s
            }

            // 1. Force script load
            const loadResult = await evalScriptAsync('$.evalFile("' + scriptPath.replace(/\\/g, '/') + '")');

            // Check if load actually worked by testing a simple function
            const versionCheck = await evalScriptAsync('VT_getVersion()');

            if (versionCheck && versionCheck.indexOf('EvalScript error') === -1) {
                // Script loaded successfully! Parse the version
                try {
                    const vData = JSON.parse(versionCheck);
                    addLog('ExtendScript version: ' + vData.version);
                    checkScriptVersion(vData.version);
                } catch (e) {
                    addLog('ExtendScript loaded (version parse failed)');
                }
            } else {
                throw new Error('Script load returned error: ' + versionCheck);
            }

            // 2. CRITICAL: Check that $.global is accessible (may fail on cold start)
            addLog('Checking $.global accessibility...');
            const globalCheck = await evalScriptAsync('typeof $.global');
            if (globalCheck === 'undefined' || globalCheck.indexOf('EvalScript error') !== -1) {
                throw new Error('$.global not ready yet: ' + globalCheck);
            }
            addLog('$.global accessible: ' + globalCheck);

            // 3. Test DLL path first
            const dllPathTest = await evalScriptAsync('VT_testDllPath()');
            addLog('DLL path test: ' + dllPathTest);

            // 4. Initialize DLL  
            const dllResult = await evalScriptAsync('VT_initExtObj()');
            addLog('DLL init: ' + dllResult);

            // 5. If DLL failed, force clear $.global.VT_ExtObj and retry
            if (dllResult !== 'true') {
                addLog('DLL init failed, trying force reload...', 'info');
                // Force clear and retry - use try/catch wrapper to handle $.global issues
                await evalScriptAsync('try { $.global.VT_ExtObj = null; } catch(e) { }');
                const retryResult = await evalScriptAsync('VT_initExtObj()');
                addLog('DLL init retry: ' + retryResult);
            }

            // 5. Warmup: force-compile critical paths (JSON, Time, sequence access, DLL)
            // This ensures all code paths are JIT-compiled before first real use
            addLog('Warming up critical paths...');
            const criticalPathsResult = await evalScriptAsync('VT_warmupCriticalPaths()');
            addLog('Critical paths warmup: ' + criticalPathsResult);

            // Success! Exit the retry loop
            return;

        } catch (e) {
            addLog('Warmup attempt ' + (attempt + 1) + ' failed: ' + e.message, 'error');

            if (attempt < maxRetries) {
                const delay = delays[attempt];
                addLog('Retrying in ' + delay + 'ms... (attempt ' + (attempt + 2) + '/' + (maxRetries + 1) + ')', 'info');
                await new Promise(resolve => setTimeout(resolve, delay));
            } else {
                addLog('All warmup attempts failed. Click "Reload Scripts" to retry manually.', 'error');
            }
        }
    }
}

/**
 * Ensure assets directory exists
 */
function ensureAssetsDir() {
    try {
        if (!fs.existsSync(ASSETS_DIR)) {
            fs.mkdirSync(ASSETS_DIR, { recursive: true });
        }
    } catch (e) {
        console.error('Error creating assets directory:', e);
    }
}

/**
 * Initialize custom select component
 */
function initCustomSelect() {
    const container = document.querySelector('.custom-select-container');
    const trigger = document.getElementById('customAssetType');
    const optionsContainer = document.getElementById('customAssetOptions');
    const hiddenInput = document.getElementById('assetType');
    const typeLabel = trigger.querySelector('.type-label');
    const typeIconWrapper = trigger.querySelector('.type-icon');

    if (!container || !trigger || !optionsContainer || !hiddenInput) return;

    // Populate options if empty
    if (optionsContainer.children.length === 0) {
        const types = [
            { value: 'video', label: 'Video' },
            { value: 'transition', label: 'Transition' },
            { value: 'effect', label: 'Effect' },
            { value: 'text', label: 'Text' },
            { value: 'audio', label: 'Audio' },
            { value: 'overlay', label: 'Overlay' },
            { value: 'background', label: 'Background' },
            { value: 'mogrt', label: 'MOGRT' },
            { value: 'other', label: 'Other' }
        ];

        types.forEach(type => {
            const div = document.createElement('div');
            div.className = 'custom-option';
            div.dataset.value = type.value;

            // Use strict matching for icons
            const iconHtml = ASSET_TYPE_ICONS[type.value] || ASSET_TYPE_ICONS['other'];

            div.innerHTML = `
                    <span class="type-icon">${iconHtml}</span>
                    <span class="type-label">${type.label}</span>
                `;

            div.addEventListener('click', function (e) {
                e.stopPropagation();
                // Update hidden input
                hiddenInput.value = type.value;

                // Update subcategories based on type
                if (typeof populateSubcategories === 'function') {
                    populateSubcategories(type.value);
                }

                // Update trigger UI
                typeLabel.textContent = type.label;
                typeIconWrapper.innerHTML = iconHtml;

                // Update selection state
                document.querySelectorAll('.custom-option').forEach(opt => opt.classList.remove('selected'));
                div.classList.add('selected');

                // Close dropdown
                container.classList.remove('open');
            });

            optionsContainer.appendChild(div);
        });
    }

    // Toggle dropdown
    trigger.onclick = function (e) {
        e.stopPropagation();
        // Close other dropdowns if any (like save menu)
        document.querySelectorAll('.dropdown-menu.show').forEach(m => m.classList.remove('show'));
        container.classList.toggle('open');
    };

    // Close when clicking outside
    document.addEventListener('click', function (e) {
        if (!container.contains(e.target)) {
            container.classList.remove('open');
        }
    });

    // Set initial state based on hidden input
    const currentVal = hiddenInput.value || 'video';
    const initialOption = optionsContainer.querySelector(`[data-value="${currentVal}"]`);
    if (initialOption) {
        typeLabel.textContent = initialOption.querySelector('.type-label').textContent;
        typeIconWrapper.innerHTML = initialOption.querySelector('.type-icon').innerHTML;
        initialOption.classList.add('selected');
    }
}

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // Save button
    saveAssetBtn.addEventListener('click', showSaveDialog);

    // Dialog buttons
    cancelSaveBtn.addEventListener('click', hideSaveDialog);
    confirmSaveBtn.addEventListener('click', confirmSaveAsset);

    // Enter key in input
    assetNameInput.addEventListener('keypress', function (e) {
        if (e.key === 'Enter') {
            confirmSaveAsset();
        }
    });

    // Click outside dialog to close - Disabled
    /* saveDialog.addEventListener('click', function (e) {
        if (e.target === saveDialog) {
            hideSaveDialog();
        }
    }); */

    // Initialize toolbar events (called on init and after module switch)
    initToolbarEvents();
}

/**
 * Initialize/reinitialize toolbar event listeners
 * Called on startup and when switching back to Assets module
 */
function initToolbarEvents() {
    // Save button
    const saveBtn = document.getElementById('saveAssetBtn');
    if (saveBtn) {
        saveBtn.onclick = showSaveDialog;
    }

    // Dropdown toggle
    const dropdownToggle = document.getElementById('saveDropdownToggle');
    const dropdownMenu = document.getElementById('saveDropdownMenu');

    if (dropdownToggle && dropdownMenu) {
        // Function to handle toggle
        const toggleMenu = function (e) {
            e.stopPropagation();
            // Toggle show class
            const isShown = dropdownMenu.classList.contains('show');

            // Close all other dropdowns first (if any)
            document.querySelectorAll('.dropdown-menu.show').forEach(m => {
                if (m !== dropdownMenu) m.classList.remove('show');
            });

            if (isShown) {
                dropdownMenu.classList.remove('show');
            } else {
                dropdownMenu.classList.add('show');
            }
        };

        dropdownToggle.onclick = toggleMenu;
    }

    // Menu items
    const menuSave = document.getElementById('menuSave');
    if (menuSave) {
        menuSave.onclick = function () {
            dropdownMenu?.classList.remove('show');
            showSaveDialog();
        };
    }

    const menuImport = document.getElementById('menuImport');
    const importPickerEl = document.getElementById('importPicker');
    if (menuImport && importPickerEl) {
        menuImport.onclick = function () {
            dropdownMenu?.classList.remove('show');
            importPickerEl.click();
        };
    }

    // Presets dropdown
    const presetsBtn = document.getElementById('presetsBtn');
    const presetsMenu = document.getElementById('presetsMenu');
    if (presetsBtn && presetsMenu) {
        presetsBtn.onclick = async function (e) {
            e.stopPropagation();
            const isShown = presetsMenu.classList.contains('show');
            document.querySelectorAll('.dropdown-menu.show').forEach(function (m) {
                if (m !== presetsMenu) m.classList.remove('show');
            });
            presetsMenu.classList.toggle('show', !isShown);
            if (!isShown) {
                await refreshCurrentClipKey();
                loadPresets();
                syncPresetOptionChips();
                const pi = document.getElementById('presetNameInput');
                if (pi) setTimeout(function () { pi.focus(); }, 50);
                // Follow the timeline selection while the menu is open, so the
                // list always matches the clip that is selected now (v3.9.4)
                if (!window._vtPresetPoll) {
                    window._vtPresetPoll = setInterval(async function () {
                        if (!presetsMenu.classList.contains('show')) {
                            clearInterval(window._vtPresetPoll);
                            window._vtPresetPoll = null;
                            return;
                        }
                        if (isVtBusy() || window._vtInserting) return;
                        const before = currentClipKey;
                        await refreshCurrentClipKey();
                        if (currentClipKey !== before) renderPresetList();
                    }, 1200);
                }
            }
        };

        document.querySelectorAll('.preset-opt').forEach(function (b) {
            b.onclick = function (e) {
                e.stopPropagation();
                const on = b.getAttribute('aria-pressed') !== 'true';
                b.setAttribute('aria-pressed', on ? 'true' : 'false');
                setPresetOption(b.dataset.opt, on);
            };
        });

        if (!window._vtPresetsOutsideBound) {
            window._vtPresetsOutsideBound = true;
            document.addEventListener('click', function (e) {
                const dd = document.getElementById('presetsDropdown');
                const menu = document.getElementById('presetsMenu');
                if (dd && menu && !dd.contains(e.target)) menu.classList.remove('show');
            });
        }

        const presetSaveBtn = document.getElementById('presetSaveBtn');
        if (presetSaveBtn) presetSaveBtn.onclick = savePresetFromSelection;


        const presetNameInput = document.getElementById('presetNameInput');
        if (presetNameInput) {
            presetNameInput.onkeydown = function (e) {
                if (e.key === 'Enter') savePresetFromSelection();
            };
        }
    }

    // Search input
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.oninput = function () {
            searchFilter = this.value.toLowerCase();
            renderAssets();
        };
    }
}

// ===================== SIDEBAR ICON ORDER (v3.9.6) =====================
// The category icons can be dragged into any order; the order is remembered
// per panel. The right-click menu collapses the sidebar (this used to be the
// arrow button) and resets the order.
const SIDEBAR_ORDER_KEY = 'vt_sidebar_order';
const SIDEBAR_DIVIDER_TOKEN = '|';
let defaultSidebarOrder = null;
let sidebarDragJustEnded = false;
let toggleSidebarCollapsed = null;

function sidebarOrderTokens() {
    const out = [];
    if (!categorySidebar) return out;
    Array.prototype.forEach.call(categorySidebar.children, function (el) {
        if (el.classList.contains('sidebar-divider')) out.push(SIDEBAR_DIVIDER_TOKEN);
        else if (el.classList.contains('category-tile') && el.dataset.category) out.push(el.dataset.category);
    });
    return out;
}

function captureDefaultSidebarOrder() {
    if (!defaultSidebarOrder) defaultSidebarOrder = sidebarOrderTokens();
}

function applySidebarOrderTokens(tokens) {
    if (!categorySidebar || !tokens || !tokens.length) return;
    const tiles = {};
    const dividers = [];
    const rest = [];
    Array.prototype.forEach.call(Array.prototype.slice.call(categorySidebar.children), function (el) {
        if (el.classList.contains('sidebar-divider')) dividers.push(el);
        else if (el.classList.contains('category-tile') && el.dataset.category) tiles[el.dataset.category] = el;
        else rest.push(el);
    });
    const frag = document.createDocumentFragment();
    const used = {};
    tokens.forEach(function (tok) {
        if (tok === SIDEBAR_DIVIDER_TOKEN) {
            if (dividers.length) frag.appendChild(dividers.shift());
        } else if (tiles[tok] && !used[tok]) {
            used[tok] = true;
            frag.appendChild(tiles[tok]);
        }
    });
    // Categories added in a later version, and any leftovers, keep their place at the end
    Object.keys(tiles).forEach(function (cat) { if (!used[cat]) frag.appendChild(tiles[cat]); });
    dividers.forEach(function (d) { frag.appendChild(d); });
    rest.forEach(function (el) { frag.appendChild(el); });
    categorySidebar.appendChild(frag);
}

function applySidebarOrder() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(SIDEBAR_ORDER_KEY) || 'null'); } catch (e) { saved = null; }
    if (Array.isArray(saved) && saved.length) applySidebarOrderTokens(saved);
}

function saveSidebarOrder() {
    try { localStorage.setItem(SIDEBAR_ORDER_KEY, JSON.stringify(sidebarOrderTokens())); } catch (e) { /* storage unavailable */ }
}

function resetSidebarOrder() {
    try { localStorage.removeItem(SIDEBAR_ORDER_KEY); } catch (e) { /* storage unavailable */ }
    if (defaultSidebarOrder) applySidebarOrderTokens(defaultSidebarOrder);
    setStatus('Icon order reset');
}

/**
 * A separator dragged above the first icon or below the last one separates
 * nothing - it is pulled back next to the icon it was dropped on, so the
 * sidebar never opens with an empty strip at the top (v3.9.6).
 */
function tidySidebarDivider() {
    if (!categorySidebar) return;
    const kids = Array.prototype.slice.call(categorySidebar.children);
    const tiles = kids.filter(function (el) { return el.classList.contains('category-tile'); });
    if (tiles.length < 2) return;
    kids.filter(function (el) { return el.classList.contains('sidebar-divider'); })
        .forEach(function (div) {
            if (categorySidebar.firstElementChild === div) categorySidebar.insertBefore(div, tiles[1]);
            else if (categorySidebar.lastElementChild === div) categorySidebar.insertBefore(div, tiles[tiles.length - 1]);
        });
}

// The tile of the category the panel reopened on gets the highlight (v3.9.6)
function highlightSelectedCategoryTile() {
    if (!categorySidebar) return;
    categorySidebar.querySelectorAll('.category-tile').forEach(function (t) {
        t.classList.toggle('active', t.dataset.category === selectedCategory);
    });
}

function initSidebarReorder() {
    if (!categorySidebar) return;
    let drag = null;

    categorySidebar.addEventListener('mousedown', function (e) {
        if (e.button !== 0) return;
        // The group separator is draggable too, so the break between the
        // groups can be moved wherever the icons were moved (v3.9.6)
        const tile = e.target.closest('.category-tile, .sidebar-divider');
        if (!tile) return;
        drag = { tile: tile, startX: e.clientX, startY: e.clientY, moved: false };
    });

    document.addEventListener('mousemove', function (e) {
        if (!drag) return;
        if (!drag.moved) {
            if (Math.abs(e.clientY - drag.startY) < 5 && Math.abs(e.clientX - drag.startX) < 5) return;
            drag.moved = true;
            drag.tile.classList.add('vt-dragging');
            categorySidebar.classList.add('vt-reordering');
        }
        e.preventDefault();
        const tiles = categorySidebar.querySelectorAll('.category-tile');
        if (!tiles.length) return;
        const first = tiles[0], last = tiles[tiles.length - 1];
        // Above the first icon / below the last one: move to that end
        if (e.clientY < first.getBoundingClientRect().top) {
            if (first !== drag.tile) categorySidebar.insertBefore(drag.tile, first);
            return;
        }
        if (e.clientY > last.getBoundingClientRect().bottom) {
            if (last !== drag.tile) categorySidebar.insertBefore(drag.tile, last.nextSibling);
            return;
        }
        for (let i = 0; i < tiles.length; i++) {
            const t = tiles[i];
            if (t === drag.tile) continue;
            const r = t.getBoundingClientRect();
            if (e.clientY < r.top || e.clientY > r.bottom) continue;
            if (e.clientY < r.top + r.height / 2) categorySidebar.insertBefore(drag.tile, t);
            else categorySidebar.insertBefore(drag.tile, t.nextSibling);
            break;
        }
    });

    document.addEventListener('mouseup', function () {
        if (!drag) return;
        const moved = drag.moved;
        drag.tile.classList.remove('vt-dragging');
        categorySidebar.classList.remove('vt-reordering');
        drag = null;
        if (!moved) return;
        tidySidebarDivider();
        saveSidebarOrder();
        sidebarDragJustEnded = true;
        // Safety net in case no click follows the mouseup
        setTimeout(function () { sidebarDragJustEnded = false; }, 300);
    });
}

function initSidebarContextMenu() {
    if (!categorySidebar) return;
    categorySidebar.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        e.stopPropagation();
        const mainCtx = document.getElementById('contextMenu');
        if (mainCtx) mainCtx.style.display = 'none';
        document.querySelectorAll('.context-menu:not(#contextMenu)').forEach(function (m) { m.remove(); });

        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.style.left = e.clientX + 'px';
        menu.style.top = e.clientY + 'px';
        menu.style.display = 'block';
        menu.style.minWidth = '170px';

        const collapsed = categorySidebar.classList.contains('collapsed');
        const itemCollapse = document.createElement('div');
        itemCollapse.className = 'context-item';
        itemCollapse.innerHTML = '<svg viewBox="0 0 24 24" class="ctx-icon"><polyline points="' +
            (collapsed ? '9 18 15 12 9 6' : '15 18 9 12 15 6') + '"/></svg>' +
            (collapsed ? 'Show names' : 'Icons only');
        itemCollapse.onclick = function () {
            menu.remove();
            if (toggleSidebarCollapsed) toggleSidebarCollapsed();
        };

        const itemReset = document.createElement('div');
        itemReset.className = 'context-item';
        itemReset.innerHTML = '<svg viewBox="0 0 24 24" class="ctx-icon"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>Reset icon order';
        itemReset.onclick = function () {
            menu.remove();
            resetSidebarOrder();
        };

        menu.appendChild(itemCollapse);
        menu.appendChild(document.createElement('div')).className = 'context-divider';
        menu.appendChild(itemReset);
        document.body.appendChild(menu);

        // Keep the menu on screen
        const r = menu.getBoundingClientRect();
        if (r.bottom > window.innerHeight) menu.style.top = Math.max(0, window.innerHeight - r.height - 4) + 'px';
        if (r.right > window.innerWidth) menu.style.left = Math.max(0, window.innerWidth - r.width - 4) + 'px';

        setTimeout(function () {
            document.addEventListener('click', function close(ev) {
                if (menu.contains(ev.target)) return;
                menu.remove();
                document.removeEventListener('click', close);
            });
        }, 0);
    });
}

/**
 * Setup event listeners (continued)
 */
function setupEventListenersContinued() {
    // Debug buttons
    if (clearLogBtn) {
        clearLogBtn.addEventListener('click', function () {
            debugLog.innerHTML = '';
        });
    }

    // Debug panel toggle
    const toggleDebug = document.getElementById('toggleDebug');
    const debugPanel = document.getElementById('debugPanel');
    if (toggleDebug && debugPanel) {
        // Restore collapsed state from localStorage
        if (localStorage.getItem('vt_debug_collapsed') === 'false') {
            debugPanel.classList.remove('collapsed');
        }
        toggleDebug.addEventListener('click', function () {
            debugPanel.classList.toggle('collapsed');
            localStorage.setItem('vt_debug_collapsed', debugPanel.classList.contains('collapsed'));
        });
    }

    if (testCmdsBtn) {
        testCmdsBtn.addEventListener('click', function () {
            // First test DLL
            addLog('=== Testing DLL ===', 'info');
            csInterface.evalScript('VT_testDllCommand()', function (dllResult) {
                addLog('DLL Test Result: ' + dllResult);
                try {
                    const parsed = JSON.parse(dllResult);
                    if (parsed.error) {
                        addLog('DLL ERROR: ' + parsed.error, 'error');
                    } else if (parsed.testCommand === 'true') {
                        addLog('DLL working correctly!', 'info');
                    } else {
                        addLog('DLL command returned: ' + parsed.testCommand, 'error');
                    }
                } catch (e) {
                    addLog('Parse error: ' + e, 'error');
                }
            });

            // Then test QE
            addLog('Testing QE API methods...', 'info');
            csInterface.evalScript('VT_testQEMethods()', function (result) {
                try {
                    var data = JSON.parse(result);
                    addLog('QE Available: ' + data.qeAvailable);
                    if (data.appMethods && data.appMethods.length > 0) {
                        addLog('APP Methods: ' + data.appMethods.join(', '), 'info');
                    }
                    addLog('QE Methods: ' + data.qeMethods.join(', '));
                    addLog('QE Project Methods: ' + data.qeProjectMethods.join(', '));
                    if (data.interestingMethods.length > 0) {
                        addLog('INTERESTING: ' + data.interestingMethods.join(', '), 'info');
                    } else {
                        addLog('No executeCommand found', 'error');
                    }
                } catch (e) {
                    addLog('Result: ' + result);
                }
            });
        });
    }

    // Reload Scripts button
    if (reloadScriptsBtn) {
        reloadScriptsBtn.addEventListener('click', function () {
            addLog('Reloading ExtendScript...', 'info');
            // Force reload by re-evaluating the script
            const scriptPath = extensionDir + '/jsx/hostscript.jsx';
            csInterface.evalScript('$.evalFile("' + scriptPath.replace(/\\/g, '/') + '")', function (result) {
                addLog('Script reloaded: ' + result);
                // Re-initialize DLL after reload (VT_ExtObj was reset to null)
                csInterface.evalScript('VT_initExtObj()', function (dllResult) {
                    addLog('DLL re-initialized: ' + dllResult);
                    // Fetch and display new version
                    fetchScriptVersion();
                });
            });
        });
    }

    // Fetch script version on startup
    fetchScriptVersion();

    // Category sidebar: restore the user's own icon order first (v3.9.6)
    if (categorySidebar) {
        captureDefaultSidebarOrder();
        applySidebarOrder();
        tidySidebarDivider();
        initSidebarReorder();
        initSidebarContextMenu();
        highlightSelectedCategoryTile();
    }

    // Category sidebar click handler
    if (categorySidebar) {
        categorySidebar.addEventListener('click', function (e) {
            // A click that ended a drag must not switch the category
            if (sidebarDragJustEnded) { sidebarDragJustEnded = false; return; }
            const tile = e.target.closest('.category-tile');
            if (!tile) return;

            const category = tile.dataset.category;
            if (!category) return;

            // Update active state
            categorySidebar.querySelectorAll('.category-tile').forEach(t => t.classList.remove('active'));
            tile.classList.add('active');

            // Update selected category and re-render
            if (selectedCategory === category) return;
            selectedCategory = category;
            saveSelectedCategory(category);

            // Apply this category's aspect ratio and zoom
            applyCategoryAspect(category);
            applyCategoryZoom(category);

            // Hide audio preview when switching
            if (AudioPreview) AudioPreview.hide();
            if (VideoPreview) VideoPreview.hide();

            renderAssets();
        });

        // Spotlight glass effect - track mouse position on each tile
        categorySidebar.querySelectorAll('.category-tile').forEach(tile => {
            tile.addEventListener('mousemove', function (e) {
                const rect = tile.getBoundingClientRect();
                const x = ((e.clientX - rect.left) / rect.width) * 100;
                const y = ((e.clientY - rect.top) / rect.height) * 100;
                tile.style.setProperty('--mouse-x', x + '%');
                tile.style.setProperty('--mouse-y', y + '%');
            });
        });
    }

    // Sidebar collapse/expand. v3.9.6: the arrow button is gone - this now runs
    // from the sidebar's right-click menu.
    if (categorySidebar) {
        // Restore state from localStorage
        if (localStorage.getItem('vt_sidebar_collapsed') === 'true') {
            categorySidebar.classList.add('collapsed');
        }

        toggleSidebarCollapsed = function () {
            if (!assetGrid) {
                categorySidebar.classList.toggle('collapsed');
                localStorage.setItem('vt_sidebar_collapsed', categorySidebar.classList.contains('collapsed'));
                return;
            }

            const cards = Array.from(assetGrid.querySelectorAll('.asset-card'));
            if (cards.length === 0) {
                categorySidebar.classList.toggle('collapsed');
                localStorage.setItem('vt_sidebar_collapsed', categorySidebar.classList.contains('collapsed'));
                return;
            }

            // 1. Get first states
            const firstStates = cards.map(card => {
                const rect = card.getBoundingClientRect();
                const parentRect = assetGrid.getBoundingClientRect();
                return {
                    element: card,
                    left: rect.left - parentRect.left + assetGrid.scrollLeft,
                    top: rect.top - parentRect.top + assetGrid.scrollTop,
                    width: rect.width,
                    height: rect.height
                };
            });

            // 2. Measure ending state
            // Disable transitions to get final state instantly
            const origTransition = categorySidebar.style.transition;
            categorySidebar.style.transition = 'none';
            
            categorySidebar.classList.toggle('collapsed');
            
            // Force reflow
            const reflow1 = assetGrid.offsetHeight;

            const lastStates = cards.map(card => {
                const rect = card.getBoundingClientRect();
                const parentRect = assetGrid.getBoundingClientRect();
                return {
                    left: rect.left - parentRect.left + assetGrid.scrollLeft,
                    top: rect.top - parentRect.top + assetGrid.scrollTop,
                    width: rect.width,
                    height: rect.height
                };
            });

            // Revert to first state (temporarily)
            categorySidebar.classList.toggle('collapsed');
            const reflow2 = assetGrid.offsetHeight;
            categorySidebar.style.transition = origTransition;

            // 3. Put cards in absolute positioning at first state
            const origHeight = assetGrid.offsetHeight;
            assetGrid.style.height = origHeight + 'px';
            
            firstStates.forEach(state => {
                const card = state.element;
                card.style.position = 'absolute';
                card.style.left = state.left + 'px';
                card.style.top = state.top + 'px';
                card.style.width = state.width + 'px';
                card.style.height = state.height + 'px';
                card.style.margin = '0';
                card.style.transition = 'none';
            });

            // 4. Trigger the real transition
            categorySidebar.classList.toggle('collapsed');
            localStorage.setItem('vt_sidebar_collapsed', categorySidebar.classList.contains('collapsed'));

            const isCollapsing = categorySidebar.classList.contains('collapsed');
            
            // Timing configuration for Staggered Wave animation
            const baseDuration = isCollapsing ? 300 : 400; // ms
            const baseDelay = isCollapsing ? 250 : 0; // ms
            const easing = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
            const totalDuration = baseDelay + baseDuration + (cards.length * 20);

            // 5. Animate to last state
            requestAnimationFrame(() => {
                requestAnimationFrame(() => {
                    firstStates.forEach((state, i) => {
                        const card = state.element;
                        const last = lastStates[i];
                        const delay = baseDelay + i * 20; // 20ms stagger per card

                        card.style.transition = `left ${baseDuration}ms ${easing} ${delay}ms, top ${baseDuration}ms ${easing} ${delay}ms, width ${baseDuration}ms ${easing} ${delay}ms, height ${baseDuration}ms ${easing} ${delay}ms`;
                        card.style.left = last.left + 'px';
                        card.style.top = last.top + 'px';
                        card.style.width = last.width + 'px';
                        card.style.height = last.height + 'px';
                    });
                });
            });

            // 6. Cleanup
            setTimeout(() => {
                firstStates.forEach(state => {
                    const card = state.element;
                    card.style.position = '';
                    card.style.left = '';
                    card.style.top = '';
                    card.style.width = '';
                    card.style.height = '';
                    card.style.margin = '';
                    card.style.transition = '';
                });
                assetGrid.style.height = '';
            }, totalDuration + 50);
        };
    }

    // Module tabs switching
    const moduleTabs = document.querySelectorAll('.module-tab');
    const mainContent = document.querySelector('.main-content');

    moduleTabs.forEach(tab => {
        tab.addEventListener('click', function () {
            const module = this.dataset.module;

            // Update active tab
            moduleTabs.forEach(t => t.classList.remove('active'));
            this.classList.add('active');

            // Store active module
            localStorage.setItem('vt_active_module', module);

            // Hide audio preview when switching modules
            if (AudioPreview) AudioPreview.hide();

            // Handle module switching
            if (module === 'assets') {
                if (categorySidebar) categorySidebar.style.display = '';
                if (assetGrid) assetGrid.style.display = '';
                document.querySelector('.bottom-toolbar')?.style.setProperty('display', '');
                document.getElementById('toolbarAssets').style.display = '';
                document.getElementById('toolbarCaptions').style.display = 'none';
                loadAssets();
                setStatus('Assets module');
            } else if (module === 'captions') {
                if (categorySidebar) categorySidebar.style.display = 'none';
                document.querySelector('.bottom-toolbar')?.style.setProperty('display', 'none');
                document.getElementById('toolbarAssets').style.display = 'none';
                document.getElementById('toolbarCaptions').style.display = '';
                if (assetGrid) {
                    assetGrid.innerHTML = `
                            <div class="empty-state">
                                <div class="empty-icon">
                                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="color: var(--text-secondary); opacity: 0.5;">
                                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                                    </svg>
                                </div>
                                <p>Captions Create</p>
                                <p class="hint">Coming soon...</p>
                            </div>
                        `;
                }
                setStatus('Captions module - coming soon');
            }

            addLog('Switched to module: ' + module);
        });
    });

    // Restore active module from localStorage
    const savedModule = localStorage.getItem('vt_active_module') || 'assets';
    const savedTab = document.querySelector(`.module-tab[data-module="${savedModule}"]`);
    if (savedTab && savedModule !== 'assets') {
        savedTab.click();
    }

    // Hide menus on click outside
    document.addEventListener('click', function () {
        if (contextMenu) contextMenu.style.display = 'none';
        if (saveDropdownMenu) saveDropdownMenu.classList.remove('show');
    });

    // Context menu: Add Preview
    const ctxAddPreview = document.getElementById('ctxAddPreview');
    if (ctxAddPreview) {
        ctxAddPreview.addEventListener('click', function () {
            if (previewPicker && contextMenuAsset) {
                previewPicker.click();
            }
            contextMenu.style.display = 'none';
        });
    }

    // Context menu: Remove Preview
    const ctxRemovePreview = document.getElementById('ctxRemovePreview');
    if (ctxRemovePreview) {
        ctxRemovePreview.addEventListener('click', function () {
            if (contextMenuAsset) {
                const previewPath = getPreviewPath(contextMenuAsset.path);
                if (fs.existsSync(previewPath)) {
                    fs.unlinkSync(previewPath);
                    invalidatePreviewCache(contextMenuAsset.id || contextMenuAsset.path);
                    invalidateCardCache(contextMenuAsset.id);
                    addLog('Removed preview: ' + previewPath);
                    renderAssets();
                }
            }
            contextMenu.style.display = 'none';
        });
    }

    // Context menu: Delete Asset
    const ctxDelete = document.getElementById('ctxDelete');
    if (ctxDelete) {
        ctxDelete.addEventListener('click', function () {
            if (selectedAssetIds.size > 1 && contextMenuAsset && selectedAssetIds.has(contextMenuAsset.id)) {
                batchDeleteAssets(Array.from(selectedAssetIds));
            } else if (contextMenuAsset) {
                deleteAsset(contextMenuAsset);
            }
            contextMenu.style.display = 'none';
        });
    }

    /**
     * Batch delete assets
     * @param {string[]} ids - Array of asset IDs
     */
    async function batchDeleteAssets(ids) {
        // v3.9.6: no confirmation - deleted straight away
        await deleteAssetsNow(ids);
    }

    // Context menu: Rename Asset
    const ctxRename = document.getElementById('ctxRename');
    const renameDialog = document.getElementById('renameDialog');
    const renameInput = document.getElementById('renameInput');
    const cancelRenameBtn = document.getElementById('cancelRename');
    const confirmRenameBtn = document.getElementById('confirmRename');
    let renameAsset = null;

    if (ctxRename) {
        ctxRename.addEventListener('click', function () {
            if (contextMenuAsset) {
                renameAsset = contextMenuAsset;
                renameInput.value = contextMenuAsset.name;
                renameDialog.style.display = 'flex';
                renameInput.focus();
                renameInput.select();
            }
            contextMenu.style.display = 'none';
        });
    }

    if (cancelRenameBtn) {
        cancelRenameBtn.addEventListener('click', function () {
            renameDialog.style.display = 'none';
            renameAsset = null;
        });
    }

    if (confirmRenameBtn) {
        confirmRenameBtn.addEventListener('click', performRename);
    }

    if (renameInput) {
        renameInput.addEventListener('keyup', function (e) {
            if (e.key === 'Enter') {
                performRename();
            } else if (e.key === 'Escape') {
                renameDialog.style.display = 'none';
                renameAsset = null;
            }
        });
    }

    function performRename() {
        if (!renameAsset) return;
        const newName = renameInput.value.trim();

        if (newName && newName !== renameAsset.name) {
            try {
                // Update metadata
                // Metadata always lives at <ASSETS_DIR>/<id>.json. Deriving it from
                // asset.path broke renaming imported media (.jpg/.mp4/.mp3): the
                // "metadata" path was the media file itself.
                const metaPath = path.join(ASSETS_DIR, renameAsset.id + '.json');
                const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                metadata.name = newName;
                fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));

                // Update in-memory array
                const assetIndex = assets.findIndex(a => a.id === renameAsset.id);
                if (assetIndex >= 0) {
                    assets[assetIndex].name = newName;
                }

                addLog('Renamed asset to: ' + newName);
                invalidateCardCache(renameAsset.id);
                renderAssets();
            } catch (err) {
                addLog('Error renaming asset: ' + err, 'error');
            }
        }

        renameDialog.style.display = 'none';
        renameAsset = null;
    }

    // Context menu: Edit Subcategory
    const ctxEditSubcat = document.getElementById('ctxEditSubcat');
    const subcatChangeDialog = document.getElementById('subcatChangeDialog');
    const subcatChangeInput = document.getElementById('subcatChangeInput');
    const subcatArrow = document.getElementById('subcatArrow');
    const subcatSuggestions = document.getElementById('subcatSuggestions');
    const subcatChangeCancel = document.getElementById('subcatChangeCancel');
    const subcatChangeConfirm = document.getElementById('subcatChangeConfirm');
    let subcatChangeAsset = null;
    let subcatChangeIsBatch = false;

    // Populate and show subcategory suggestions
    function showSubcatSuggestions() {
        const existingSubcats = new Set();
        assets.forEach(a => {
            if (a.subcategory) existingSubcats.add(a.subcategory);
        });

        subcatSuggestions.innerHTML = '';
        Array.from(existingSubcats).sort().forEach(sub => {
            const item = document.createElement('div');
            item.className = 'suggestion-item';
            item.textContent = sub;
            item.addEventListener('click', () => {
                subcatChangeInput.value = sub;
                subcatSuggestions.style.display = 'none';
            });
            subcatSuggestions.appendChild(item);
        });

        if (existingSubcats.size > 0) {
            subcatSuggestions.style.display = 'block';
        }
    }

    if (ctxEditSubcat) {
        ctxEditSubcat.addEventListener('click', function () {
            // Check for batch selection (must include the right-clicked item)
            // If right-click on non-selected item, selection is reset to single item by card contextmenu handler first.
            if (selectedAssetIds.size > 1 && contextMenuAsset && selectedAssetIds.has(contextMenuAsset.id)) {
                // Batch Mode
                subcatChangeIsBatch = true;
                subcatChangeAsset = null;
                subcatChangeInput.value = '';
                subcatChangeInput.placeholder = `(Set for ${selectedAssetIds.size} items)`;
            } else if (contextMenuAsset) {
                // Single Mode
                subcatChangeIsBatch = false;
                subcatChangeAsset = contextMenuAsset;
                subcatChangeInput.value = contextMenuAsset.subcategory || '';
                subcatChangeInput.placeholder = 'Enter subcategory...';
            }

            // Common Dialog Open
            if (subcatChangeIsBatch || subcatChangeAsset) {
                subcatSuggestions.style.display = 'none';
                subcatChangeDialog.style.display = 'flex';
                subcatChangeInput.focus();
                // Select only if single mode or if input has value
                if (!subcatChangeIsBatch) subcatChangeInput.select();
            }
            contextMenu.style.display = 'none';
        });
    }

    // Arrow toggle for suggestions
    if (subcatArrow) {
        subcatArrow.addEventListener('click', function (e) {
            e.stopPropagation();
            if (subcatSuggestions.style.display === 'none') {
                showSubcatSuggestions();
            } else {
                subcatSuggestions.style.display = 'none';
            }
        });
    }

    // Hide suggestions on outside click
    if (subcatChangeDialog) {
        subcatChangeDialog.addEventListener('click', function (e) {
            if (!e.target.closest('.input-wrapper')) {
                subcatSuggestions.style.display = 'none';
            }
        });
    }

    if (subcatChangeCancel) {
        subcatChangeCancel.addEventListener('click', function () {
            subcatChangeDialog.style.display = 'none';
            subcatChangeAsset = null;
            subcatChangeIsBatch = false;
        });
    }

    if (subcatChangeConfirm) {
        subcatChangeConfirm.addEventListener('click', function () {
            const newSubcat = subcatChangeInput.value.trim() || null;

            if (subcatChangeIsBatch) {
                // Batch processing
                let changedCount = 0;
                Array.from(selectedAssetIds).forEach(id => {
                    const asset = assets.find(a => a.id === id);
                    if (asset) {
                        applySubcategoryChange(asset, newSubcat, true); // true = skipRender
                        changedCount++;
                    }
                });
                invalidateAllCardCache();
                renderAssets(); // Render once at the end
                addLog(`Batch updated subcategory for ${changedCount} items`);
                setStatus(`Updated ${changedCount} items`);

                // Clear batch selection? Maybe keep it.
                // selectedAssetIds.clear(); 
            } else {
                if (!subcatChangeAsset) return;
                applySubcategoryChange(subcatChangeAsset, newSubcat, false);
            }

            subcatChangeDialog.style.display = 'none';
            subcatChangeAsset = null;
            subcatChangeIsBatch = false;
        });
    }

    function applySubcategoryChange(asset, newSubcat, skipRender = false) {
        try {
            // Update in-memory
            // Use loose comparison just in case
            const assetIndex = assets.findIndex(a => String(a.id) === String(asset.id));

            if (assetIndex >= 0) {
                if (newSubcat) {
                    assets[assetIndex].subcategory = newSubcat;
                } else {
                    delete assets[assetIndex].subcategory;
                }

                // Write to file
                const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
                if (fs.existsSync(metaPath)) {
                    fs.writeFileSync(metaPath, JSON.stringify(assets[assetIndex], null, 2));
                }

                addLog(`Changed subcategory of "${asset.name}" to: ${newSubcat || '(none)'}`);
                invalidateCardCache(asset.id);
                if (!skipRender) renderAssets();
            } else {
                addLog(`Error: Asset index not found for ${asset.name}`, 'error');
            }
        } catch (err) {
            addLog('Error changing subcategory: ' + err, 'error');
        }
    }

    // File picker change handler - copy selected video as preview
    if (previewPicker) {
        previewPicker.addEventListener('change', function (e) {
            if (!e.target.files.length || !contextMenuAsset) return;

            const sourceFile = e.target.files[0].path;
            const destPath = getPreviewPath(contextMenuAsset.path);

            try {
                fs.copyFileSync(sourceFile, destPath);
                invalidatePreviewCache(contextMenuAsset.id || contextMenuAsset.path);
                invalidateCardCache(contextMenuAsset.id);
                addLog('Added preview: ' + destPath);
                renderAssets();
            } catch (err) {
                addLog('Error copying preview: ' + err, 'error');
            }

            // Reset picker
            previewPicker.value = '';
        });
    }

    // Import file picker change handler
    if (importPicker) {
        importPicker.addEventListener('change', function (e) {
            if (!e.target.files.length) return;
            const filePaths = Array.from(e.target.files).map(f => f.path).filter(Boolean);
            openImportDialog(filePaths);
            importPicker.value = '';
        });
    }

    // Drag & drop files onto asset grid
    if (assetGrid) {
        assetGrid.addEventListener('dragover', function (e) {
            // Only show drop zone for external files (not asset cards)
            if (e.dataTransfer.types.includes('Files')) {
                e.preventDefault();
                assetGrid.classList.add('drop-zone');
            }
        });

        assetGrid.addEventListener('dragleave', function (e) {
            if (!assetGrid.contains(e.relatedTarget)) {
                assetGrid.classList.remove('drop-zone');
            }
        });

        assetGrid.addEventListener('drop', function (e) {
            assetGrid.classList.remove('drop-zone');
            if (e.dataTransfer.files.length > 0) {
                e.preventDefault();
                const filePaths = Array.from(e.dataTransfer.files).map(f => f.path).filter(Boolean);
                openImportDialog(filePaths);
            }
        });
    }

    // Bottom toolbar: Zoom slider (Discrete Snapping, stored per category/group)
    const zoomSlider = document.getElementById('zoomSlider');
    if (zoomSlider && assetGrid) {
        // Restore saved step for the current category
        applyCategoryZoom(selectedCategory);

        zoomSlider.addEventListener('input', function (e) {
            const step = e.target.value;
            // Set exact min-width via CSS variable
            assetGrid.style.setProperty('--card-min-width', ZOOM_SNAP_WIDTHS[step]);
            // Remember the choice for the currently selected category
            setCategoryZoom(selectedCategory, step);
        });
    }

    // Bottom toolbar: Aspect ratio toggle (stored per category/group)
    const aspectBtns = document.querySelectorAll('.aspect-btn');
    aspectBtns.forEach(btn => {
        btn.addEventListener('click', function () {
            aspectBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            // Update card thumbnails aspect ratio
            const aspect = btn.dataset.aspect;
            document.documentElement.style.setProperty('--card-aspect', aspect === '9:16' ? '9/16' : '16/9');
            // Remember the choice for the currently selected category
            setCategoryAspect(selectedCategory, aspect);
        });
    });

    // Restore aspect for the initial category
    applyCategoryAspect(selectedCategory);
}

/**
 * Compare the running host script against the version this panel was built
 * against, and shout if they differ.
 *
 * A mismatch means Premiere is serving a cached ExtendScript engine - edits to
 * hostscript.jsx are on disk but not in effect. That failure mode is otherwise
 * invisible and burns hours: everything "works", just not the new code.
 * Warn loudly, never block - a stale host script is still a usable panel.
 *
 * @param {string} actual - version reported by VT_getVersion()
 * @returns {boolean} true when it matches what the panel expects
 */
function checkScriptVersion(actual) {
    const matches = actual === EXPECTED_SCRIPT_VERSION;

    if (scriptVersionEl) {
        scriptVersionEl.classList.toggle('mismatch', !matches);
        scriptVersionEl.title = matches
            ? 'ExtendScript v' + actual
            : 'Version mismatch: host script is v' + actual + ', panel expects v' + EXPECTED_SCRIPT_VERSION;
    }

    if (!matches) {
        addLog('VERSION MISMATCH: host script is v' + actual + ', panel expects v' +
            EXPECTED_SCRIPT_VERSION + ' - reload ExtendScript, or restart Premiere if that does not help', 'error');
    }

    return matches;
}

/**
 * Fetch and display ExtendScript version
 */
function fetchScriptVersion() {
    csInterface.evalScript('VT_getVersion()', function (result) {
        try {
            const data = JSON.parse(result);
            if (scriptVersionEl && data.version) {
                scriptVersionEl.textContent = 'v' + data.version;
                addLog('ExtendScript version: ' + data.version, 'info');
                checkScriptVersion(data.version);
            }
        } catch (e) {
            if (scriptVersionEl) {
                scriptVersionEl.textContent = 'v?.?.?';
                scriptVersionEl.classList.add('mismatch');
            }
            addLog('Could not get script version: ' + result, 'error');
        }
    });
}

/**
 * Add log entry to debug panel
 */

let subCatAppsInitialized = false;

function populateSubcategories(typeFilter) {
    const subInput = document.getElementById('assetSubcategory');
    if (subInput) subInput.value = '';

    // If no explicit filter, try to get from hidden input
    if (!typeFilter) {
        const typeInput = document.getElementById('assetType');
        if (typeInput) typeFilter = typeInput.value;
    }

    const dropdown = document.getElementById('subSuggestions');
    const arrow = document.getElementById('subArrow');

    if (dropdown) {
        dropdown.innerHTML = '';
        const subs = new Set();
        assets.forEach(a => {
            // Filter by type
            const matchesType = !typeFilter || a.type === typeFilter;
            if (a.subcategory && matchesType) subs.add(a.subcategory);
        });

        if (subs.size > 0) {
            Array.from(subs).sort().forEach(s => {
                const div = document.createElement('div');
                div.className = 'suggestion-item';
                div.textContent = s;
                div.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (subInput) subInput.value = s;
                    dropdown.style.display = 'none';
                });
                dropdown.appendChild(div);
            });
            if (arrow) arrow.style.display = 'block';
        } else {
            if (arrow) arrow.style.display = 'none';
        }
    }

    // Initialize events once
    if (!subCatAppsInitialized) {
        subCatAppsInitialized = true;
        if (arrow && dropdown) {
            arrow.addEventListener('click', function (e) {
                e.stopPropagation();
                const isVisible = dropdown.style.display === 'block';
                if (dropdown.children.length > 0) {
                    dropdown.style.display = isVisible ? 'none' : 'block';
                }
            });

            // Close on outside click
            document.addEventListener('click', function (e) {
                if (dropdown.style.display === 'block' && !dropdown.contains(e.target) && e.target !== arrow && e.target !== subInput) {
                    dropdown.style.display = 'none';
                }
            });

            if (subInput) {
                subInput.addEventListener('click', function () {
                    if (dropdown.children.length > 0) dropdown.style.display = 'block';
                });
                subInput.addEventListener('input', function () {
                    dropdown.style.display = 'none';
                });
            }
        }
    }
}

function filterAssetTypes(detectType) {
    const opts = document.querySelectorAll('.custom-option');
    opts.forEach(o => o.style.display = 'none');

    const show = (val) => {
        const el = document.querySelector(`.custom-option[data-value="${val}"]`);
        if (el) el.style.display = 'flex';
    };

    show('other');

    if (detectType === 'audio') {
        show('audio');
    } else if (detectType === 'video') {
        show('video'); show('background'); show('overlay');
    } else if (detectType === 'image') {
        show('overlay'); show('background');
    } else if (detectType === 'mogrt') {
        show('mogrt');
    } else {
        show('video'); show('audio'); show('overlay'); show('background'); show('mogrt');
    }
}

function resetAssetTypes() {
    document.querySelectorAll('.custom-option').forEach(o => o.style.display = '');
}

/**
 * Show save dialog
 */
function showSaveDialog() {
    setStatus('Checking selection...');

    // Check if there's a selection in Premiere (and whether it is all MOGRTs,
    // e.g. titles dropped in by AtomX - v3.9.0)
    csInterface.evalScript('VT_getSelectionInfo()', function (result) {
        let info = null;
        try { info = JSON.parse(result); } catch (e) { info = null; }
        if (!info) {
            // Host script older than 3.9.0 still cached - plain selection check
            csInterface.evalScript('VT_hasSelection()', function (r2) {
                openSaveDialogFor({ hasSelection: r2 === 'true' });
            });
            return;
        }
        openSaveDialogFor(info);
    });

    function openSaveDialogFor(info) {
        if (info && info.hasSelection) {
            resetAssetTypes();
            saveDialog.style.display = 'flex';
            populateSubcategories();
            assetNameInput.disabled = false;
            assetNameInput.placeholder = 'Asset name...';
            const batchNoteEl = document.getElementById('importBatchNote');
            if (batchNoteEl) batchNoteEl.style.display = 'none';
            assetNameInput.value = '';

            // Initialize custom select
            initCustomSelect();

            // MOGRT selection: preselect the MOGRT type and suggest the
            // template's name so saving is a single Enter press.
            if (info.kind === 'mogrt') {
                const mogrtOpt = document.querySelector('.custom-option[data-value="mogrt"]');
                if (mogrtOpt) mogrtOpt.click();
                if (info.name) {
                    assetNameInput.value = info.name;
                    assetNameInput.select();
                }
                addLog('Save: MOGRT selection detected (' + info.count + ' clip(s))', 'info');
            }
            assetNameInput.focus();

            setStatus('Enter asset name');
        } else {
            setStatus('No clips selected! Select clips on timeline first.');
            setTimeout(() => setStatus('Ready'), 3000);
        }
    }
}

/**
 * Hide save dialog
 */
function hideSaveDialog() {
    saveDialog.style.display = 'none';
    assetNameInput.disabled = false;
    assetNameInput.placeholder = 'Asset name...';
    const batchNoteEl = document.getElementById('importBatchNote');
    if (batchNoteEl) batchNoteEl.style.display = 'none';
    setStatus('Ready');
}

/**
 * Show duplicate asset warning dialog
 * @returns {Promise<boolean>} true if user wants to continue, false to cancel
 */
function showDuplicateDialog(assetName) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('duplicateDialog');
        const message = document.getElementById('duplicateMessage');
        const confirmBtn = document.getElementById('duplicateConfirm');
        const cancelBtn = document.getElementById('duplicateCancel');

        if (!dialog) {
            // Fallback if dialog not found
            resolve(confirm(`Asset "${assetName}" already exists. Add anyway?`));
            return;
        }

        message.textContent = `An asset named "${assetName}" already exists in your library.`;
        dialog.style.display = 'flex';

        const cleanup = () => {
            dialog.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        };

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };

        const onCancel = () => {
            cleanup();
            resolve(false);
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
    });
}

/**
 * Open the save/import dialog for a list of external files.
 * With a single file the asset name is editable; with several files
 * names are taken from filenames and type/subcategory apply to all.
 */
function openImportDialog(filePaths) {
    if (!filePaths || !filePaths.length) return;
    pendingImportFiles = filePaths;
    const isBatch = filePaths.length > 1;

    saveDialog.style.display = 'flex';
    initCustomSelect();
    populateSubcategories();

    // Auto-detect type from the first file (images have no dedicated option -> Overlay)
    const autoType = detectTypeFromExtension(filePaths[0]);
    const optionType = autoType === 'image' ? 'overlay' : autoType;
    const targetOption = Array.from(document.querySelectorAll('.custom-option')).find(el => el.dataset.value === optionType);
    if (targetOption) targetOption.click();
    filterAssetTypes(autoType);
    populateSubcategories(optionType);

    // Batch note
    const batchNote = document.getElementById('importBatchNote');
    if (batchNote) {
        if (isBatch) {
            batchNote.textContent = 'Batch import: ' + filePaths.length +
                ' files \u2014 names will be taken from filenames; type and subcategory apply to all.';
            batchNote.style.display = 'block';
        } else {
            batchNote.style.display = 'none';
        }
    }

    if (isBatch) {
        assetNameInput.disabled = true;
        assetNameInput.value = '';
        assetNameInput.placeholder = '(names from filenames)';
    } else {
        assetNameInput.disabled = false;
        assetNameInput.placeholder = 'Asset name...';
        assetNameInput.value = path.basename(filePaths[0], path.extname(filePaths[0]));
        assetNameInput.focus();
    }
}

/**
 * Confirm and save asset
 * Uses copy/paste workflow to preserve effects
 * Or imports external file(s) if pendingImportFiles is set
 */
async function confirmSaveAsset() {
    const name = assetNameInput.value.trim();
    const subcat = document.getElementById('assetSubcategory') ? document.getElementById('assetSubcategory').value.trim() : '';
    const type = assetTypeSelect ? assetTypeSelect.value : 'other';
    const isBatchImport = pendingImportFiles.length > 1;

    if (!name && !isBatchImport) {
        assetNameInput.focus();
        return;
    }

    // Check for duplicate name (single import only; batch skips the dialog)
    if (!isBatchImport) {
        const existingAsset = assets.find(a => a.name.toLowerCase() === name.toLowerCase());
        if (existingAsset) {
            const shouldContinue = await showDuplicateDialog(name);
            if (!shouldContinue) {
                assetNameInput.focus();
                assetNameInput.select();
                return;
            }
        }
    }

    hideSaveDialog();
    assetNameInput.disabled = false;
    assetNameInput.placeholder = 'Asset name...';

    // Check if this is an import (external file) or save (from timeline)
    if (pendingImportFiles.length) {
        // IMPORT external file(s)
        const files = pendingImportFiles;
        pendingImportFiles = [];
        setStatus('Importing ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '...');
        addLog('=== Importing ' + files.length + ' file(s) (' + type + ') ===', 'info');

        let okCount = 0;
        let failCount = 0;

        for (let i = 0; i < files.length; i++) {
            const srcPath = files[i];
            const fileBase = path.basename(srcPath, path.extname(srcPath));
            // Single file: user-chosen name; batch: filename
            const finalName = files.length > 1 ? fileBase : name;

            const assetId = 'asset_' + Date.now() + (files.length > 1 ? '_' + i : '');
            const ext = path.extname(srcPath);
            const assetPath = path.join(ASSETS_DIR, assetId + ext);

            try {
                fs.copyFileSync(srcPath, assetPath);

                const metadata = {
                    id: assetId,
                    name: finalName,
                    subcategory: subcat || undefined,
                    type: type,
                    path: assetPath,
                    isExternal: true, // Mark as imported (not .prproj)
                    created: new Date().toISOString()
                };

                const metaPath = path.join(ASSETS_DIR, assetId + '.json');
                fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
                assets.push(metadata);
                okCount++;
            } catch (err) {
                addLog('Import error (' + srcPath + '): ' + err, 'error');
                failCount++;
            }
        }

        renderAssets();
        if (failCount === 0) {
            setStatus('Imported: ' + okCount + ' file' + (okCount > 1 ? 's' : ''));
            addLog('=== SUCCESS! Imported ' + okCount + ' ===');
        } else {
            setStatus('Imported ' + okCount + ', failed ' + failCount);
            addLog('=== Done with errors: ' + okCount + ' ok, ' + failCount + ' failed ===', 'error');
        }
        return;
    }

    // SAVE from timeline (original logic)
    setStatus('Saving asset...');
    addLog('=== Saving Asset: ' + name + ' (' + type + ') ===', 'info');

    // Generate unique ID
    const assetId = 'asset_' + Date.now();

    const assetPath = path.join(ASSETS_DIR, assetId + '.prproj');
    const escapedPath = assetPath.replace(/\\/g, '\\\\');

    try {
        // Show blocking overlay
        const savingOverlay = document.getElementById('savingOverlay');
        const savingText = document.getElementById('savingText');
        const savingSubtext = document.getElementById('savingSubtext');

        if (savingOverlay) {
            savingText.textContent = 'Saving asset...';
            savingSubtext.textContent = 'Please wait, do not interact with Premiere Pro';
            savingOverlay.style.display = 'flex';
        }

        // Play warning beep
        if (!isAssetSoundDisabled()) playBeep('start');

        // Show status that we're generating preview (UI may freeze during render)
        setStatus('Saving & generating preview...');
        addLog('Saving with native DLL (preview generation may freeze UI briefly)...');

        // Update overlay for preview generation
        if (savingOverlay && savingText) {
            savingText.textContent = 'Generating preview...';
            savingSubtext.textContent = 'Rendering 480p preview, this may take a few seconds';
        }

        // MOGRT selection: native save - no clipboard, no sequence opened
        // (v3.9.3). Anything else (or keyframed MOGRTs) uses the classic save.
        let parsed = null;
        try {
            const nr = await evalScriptAsync(`VT_saveMogrtAsset("${escapedPath}")`);
            const nd = JSON.parse(nr);
            if (nd.success) {
                parsed = nd;
                addLog('Saved as native MOGRT asset (' + nd.meta.clips.length + ' clip(s))', 'success');
            } else if (nd.fallback) {
                addLog('Native MOGRT save not possible (' + (nd.reason || '?') + ') - classic save', 'info');
            } else {
                throw new Error(nd.error || 'Save failed');
            }
        } catch (nativeErr) {
            if (nativeErr && nativeErr.message && !/JSON|Unexpected/i.test(nativeErr.message)) throw nativeErr;
        }

        if (!parsed) {
            // Classic save: move OS focus to Premiere first so the DLL
            // copy/paste (SendInput) land although save started in the panel.
            runFocusFix();
            const result = await evalScriptAsync(`VT_saveAssetNative("${escapedPath}")`);
            addLog('Result: ' + result);
            parsed = JSON.parse(result);
            if (parsed.success) {
                addLog('Copy: ' + parsed.copyResult + ', Paste: ' + parsed.pasteResult);
                // Save's DLL paste succeeded = timeline had focus. Remember HWND.
                rememberTimelineFocus();
            }
        }

        if (parsed.success) {

            // Log preview status
            if (parsed.previewGenerated) {
                addLog('Preview generated: ' + parsed.previewPath, 'success');
            } else {
                addLog('Preview not generated (VideoSample or preset missing)', 'warning');
            }

            // Save metadata
            const metadata = {
                id: assetId,
                name: name,
                subcategory: subcat || undefined,
                type: type,
                path: assetPath,
                created: new Date().toISOString()
            };
            // Native MOGRT description (template + values): inserts need no
            // clipboard and open no sequence
            if (parsed.isNative && parsed.meta) metadata.mogrtNative = parsed.meta;

            const metaPath = path.join(ASSETS_DIR, assetId + '.json');
            fs.writeFileSync(metaPath, JSON.stringify(metadata, null, 2));
            assets.push(metadata);
            renderAssets();

            const previewMsg = parsed.previewGenerated ? ' (with preview)' : '';
            setStatus('Asset saved: ' + name + previewMsg);
            addLog('=== SUCCESS! ===');
            if (!isAssetSoundDisabled()) playBeep('success');
        } else {
            throw new Error(parsed.error || 'Save failed');
        }
    } catch (error) {
        addLog('ERROR: ' + error.message, 'error');
        setStatus('Error saving asset');
        if (!isAssetSoundDisabled()) playBeep('error');
    } finally {
        // Always hide overlay
        const savingOverlay = document.getElementById('savingOverlay');
        if (savingOverlay) {
            savingOverlay.style.display = 'none';
        }
    }
}

/**
 * Load assets from disk
 */
// ===================== PRESETS (clip property presets) =====================
// A preset stores ALL properties of ALL effects (components) of the selected
// clip - Motion, Opacity, Graphic Parameters, MOGRT sliders, etc. Applying
// a preset restores every property on the selected clip (Premiere Composer
// style). No clips are saved, no .prproj files - only property values.
let presets = [];
let currentClipKey = '';
let currentClipInfo = null;

async function refreshCurrentClipKey() {
    try {
        const res = await evalScriptAsync('VT_getSelectedClipKey()');
        const parsed = JSON.parse(res);
        if (parsed && parsed.success) {
            currentClipKey = parsed.clipKey || '';
            currentClipInfo = { kind: parsed.kind || '', name: parsed.clipName || '', mediaType: parsed.mediaType || '' };
        } else {
            currentClipKey = '';
            currentClipInfo = null;
        }
    } catch (e) { currentClipKey = ''; currentClipInfo = null; }
    renderPresetTarget();
}

const PRESET_KIND_LABEL = { mogrt: 'MOGRT', video: 'Video', image: 'Image', audio: 'Audio', sequence: 'Nest', clip: 'Clip' };
const PRESET_IMAGE_RE = /\.(jpe?g|png|gif|bmp|tiff?|psd|ai|eps|webp|heic|tga|exr|dpx)$/i;

// Kind of clip a preset belongs to (older presets carry no "kind" field)
function presetKind(p) {
    if (p.kind && PRESET_KIND_LABEL[p.kind]) return p.kind;
    const key = p.clipKey || '';
    if (isTemplateKey(key)) return 'mogrt';
    if (key.indexOf('seq:') === 0) return 'sequence';
    const fx = (p.effects || []).map(function (e) { return e.matchName || ''; });
    const isVideo = fx.indexOf('AE.ADBE Motion') !== -1 || fx.indexOf('AE.ADBE Opacity') !== -1;
    if (key.indexOf('mp:') === 0) {
        if (!isVideo && fx.length) return 'audio';
        return PRESET_IMAGE_RE.test(key) ? 'image' : 'video';
    }
    return 'clip';
}

function renderPresetTarget() {
    const el = document.getElementById('presetTarget');
    if (!el) return;
    el.innerHTML = '';
    if (!currentClipKey || !currentClipInfo) {
        el.textContent = 'Select a clip on the timeline (MOGRT, video, image or audio)';
        el.title = '';
        return;
    }
    const tag = document.createElement('span');
    tag.className = 'preset-tag';
    tag.textContent = PRESET_KIND_LABEL[currentClipInfo.kind] || 'Clip';
    el.appendChild(tag);
    el.appendChild(document.createTextNode(currentClipInfo.name || ''));
    el.title = 'Presets are saved for and shown only with this ' +
        (currentClipInfo.kind === 'mogrt' ? 'template' : (currentClipInfo.kind === 'sequence' ? 'nested sequence' : 'media file'));
}

function totalPresetProps(preset) {
    let n = 0;
    if (preset.effects) preset.effects.forEach(function (fx) { n += fx.properties ? fx.properties.length : 0; });
    return n;
}

// Every preset belongs to the clip it was saved from: a MOGRT preset to its
// template, a preset of a video/image/audio clip to that media file. The list
// shows only the selected clip's presets and they apply only to such clips.
function isTemplateKey(key) {
    return typeof key === 'string' && key.indexOf('mgt') === 0;
}

// Apply options (chips in the menu), remembered per panel
const PRESET_OPT_KEYS = ['text', 'motion', 'opacity', 'addMissing'];
function getPresetOptions() {
    let o = {};
    try { o = JSON.parse(localStorage.getItem('vt_preset_opts') || '{}') || {}; } catch (e) { o = {}; }
    const out = {};
    PRESET_OPT_KEYS.forEach(function (k) { out[k] = o[k] !== false; });
    return out;
}
function setPresetOption(key, on) {
    const o = getPresetOptions();
    o[key] = !!on;
    try { localStorage.setItem('vt_preset_opts', JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
}
function syncPresetOptionChips() {
    const o = getPresetOptions();
    document.querySelectorAll('.preset-opt').forEach(function (b) {
        b.setAttribute('aria-pressed', o[b.dataset.opt] ? 'true' : 'false');
    });
}

function loadPresets() {
    presets = [];
    try {
        if (!fs.existsSync(PRESETS_DIR)) fs.mkdirSync(PRESETS_DIR, { recursive: true });
        fs.readdirSync(PRESETS_DIR, { withFileTypes: true }).forEach(function (ent) {
            const full = path.join(PRESETS_DIR, ent.name);
            if (ent.isFile() && ent.name.endsWith('.json')) {
                try {
                    const p = JSON.parse(fs.readFileSync(full, 'utf8'));
                    if (p && p.name && p.effects) { p._file = full; presets.push(p); }
                } catch (e) { addLog('loadPresets: bad preset file ' + ent.name, 'warning'); }
            } else if (ent.isDirectory()) {
                // Older single-effect presets (presets/<effect>/preset_*.json):
                // shown again as presets with one effect.
                try {
                    fs.readdirSync(full).forEach(function (file) {
                        if (!file.endsWith('.json')) return;
                        try {
                            const q = JSON.parse(fs.readFileSync(path.join(full, file), 'utf8'));
                            if (!q || !q.properties || !q.effectMatchName) return;
                            presets.push({
                                id: q.id || file.replace(/\.json$/, ''),
                                name: q.name || file,
                                clipName: q.clipName || '',
                                clipKey: '',
                                effects: [{ matchName: q.effectMatchName, displayName: q.effectDisplayName || q.effectMatchName, properties: q.properties }],
                                created: q.created || '',
                                legacyEffect: q.effectDisplayName || q.effectMatchName,
                                _file: path.join(full, file)
                            });
                        } catch (e2) { addLog('loadPresets: bad preset file ' + file, 'warning'); }
                    });
                } catch (e3) { /* unreadable folder */ }
            }
        });
        renderPresetList();
    } catch (e) {
        addLog('loadPresets error: ' + e.message, 'error');
    }
}

function renderPresetList() {
    const list = document.getElementById('presetList');
    if (!list) return;
    list.innerHTML = '';
    let visible = presets;
    if (currentClipKey) {
        // Only this clip's / this template's own presets (plus old ones without a key)
        visible = presets.filter(function (p) { return !p.clipKey || p.clipKey === currentClipKey; });
    }
    if (!visible.length) {
        const empty = document.createElement('div');
        empty.className = 'preset-empty';
        empty.textContent = currentClipKey
            ? 'No presets for the selected clip. Save one from this clip first.'
            : 'No presets yet. Select a MOGRT, video, image or audio clip, tune its settings and press Save.';
        list.appendChild(empty);
        return;
    }
    visible.slice().sort(function (a, b) { return (b.created || '').localeCompare(a.created || ''); })
        .forEach(function (p) {
            const row = document.createElement('div');
            row.className = 'preset-row';

            const info = document.createElement('div');
            info.className = 'preset-info';
            info.style.flex = '1';
            const nm = document.createElement('div');
            nm.className = 'preset-name';
            nm.textContent = p.name;
            const sub = document.createElement('div');
            sub.className = 'preset-sub';
            let dateStr = '';
            if (p.created) {
                try { dateStr = new Date(p.created).toLocaleDateString(); } catch (e) {}
            }
            const fxNames = (p.effects || []).map(function (fx) { return fx.displayName || fx.matchName || '?'; });
            const fxText = fxNames.slice(0, 3).join(', ') + (fxNames.length > 3 ? ' +' + (fxNames.length - 3) : '');
            if (p.clipKey || p.legacyEffect) {
                const tag = document.createElement('span');
                tag.className = 'preset-tag';
                tag.textContent = p.legacyEffect ? 'Effect' : (PRESET_KIND_LABEL[presetKind(p)] || 'Clip');
                nm.insertBefore(tag, nm.firstChild);
            }
            sub.textContent = (p.clipName ? p.clipName + ' | ' : '') + fxText + (dateStr ? ' | ' + dateStr : '');
            row.title = 'Apply to the selected clip(s): ' + fxNames.join(', ') + ' (' + totalPresetProps(p) + ' properties)';
            info.appendChild(nm);
            info.appendChild(sub);

            const actions = document.createElement('div');
            actions.className = 'preset-actions';

            const applyBtn = document.createElement('button');
            applyBtn.className = 'preset-act';
            applyBtn.title = 'Apply all preset settings to the selected clip';
            applyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
            applyBtn.onclick = function (e) { e.stopPropagation(); loadPreset(p); };

            const delBtn = document.createElement('button');
            delBtn.className = 'preset-act preset-act-danger';
            delBtn.title = 'Delete preset';
            delBtn.innerHTML = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>';
            delBtn.onclick = function (e) { e.stopPropagation(); deletePreset(p); };

            actions.appendChild(applyBtn);
            actions.appendChild(delBtn);

            row.appendChild(info);
            row.appendChild(actions);
            row.ondblclick = function () { loadPreset(p); };

            list.appendChild(row);
        });
}

async function savePresetFromSelection() {
    const nameInput = document.getElementById('presetNameInput');
    const name = nameInput ? nameInput.value.trim() : '';
    if (!name) { if (nameInput) nameInput.focus(); return; }

    const existing = presets.find(function (p) { return p.name.toLowerCase() === name.toLowerCase(); });
    if (existing) {
        if (!window.confirm('Preset "' + name + '" already exists. Overwrite?')) return;
    }

    try {
        // Snapshot ALL effects and ALL properties of the selected clip
        const res = await evalScriptAsync('VT_getSelectedClipEffects()');
        const parsed = JSON.parse(res);
        if (!parsed || !parsed.success) throw new Error((parsed && parsed.error) || 'Could not read the selected clip');
        if (!parsed.effects || !parsed.effects.length) throw new Error('Selected clip has no effects');

        // Overwrite = replace the old preset (it used to be kept as a duplicate)
        const presetId = (existing && !existing.legacyEffect && existing.id) ? existing.id : 'preset_' + Date.now();
        const metadata = {
            id: presetId,
            name: name,
            clipName: parsed.clipName || '',
            isMGT: !!parsed.isMGT,
            clipKey: parsed.clipKey || '',
            kind: parsed.kind || '',
            mediaType: parsed.mediaType || '',
            effects: parsed.effects,
            created: new Date().toISOString()
        };
        const newFile = path.join(PRESETS_DIR, presetId + '.json');
        const toWrite = Object.assign({}, metadata);
        delete toWrite._file;
        fs.writeFileSync(newFile, JSON.stringify(toWrite, null, 2));
        metadata._file = newFile;
        if (existing) {
            if (existing._file && existing._file !== newFile) { try { fs.unlinkSync(existing._file); } catch (e) { /* already gone */ } }
            presets = presets.filter(function (p) { return p !== existing; });
        }
        presets.push(metadata);
        // The list follows the clip the preset was just read from
        currentClipKey = metadata.clipKey;
        currentClipInfo = { kind: metadata.kind, name: metadata.clipName, mediaType: metadata.mediaType };
        renderPresetTarget();
        renderPresetList();
        if (nameInput) nameInput.value = '';
        const kindLabel = PRESET_KIND_LABEL[presetKind(metadata)] || 'Clip';
        setStatus('Preset saved: ' + name + ' (' + kindLabel + ')');
        addLog('Preset saved: "' + name + '" for ' + kindLabel + ' "' + metadata.clipName + '" (' + parsed.effects.length + ' effects, ' + totalPresetProps(metadata) + ' properties)', 'success');
        if (!isPresetSoundDisabled()) playBeep('success');
    } catch (err) {
        addLog('Preset save error: ' + err.message, 'error');
        setStatus('Error saving preset');
        if (!isPresetSoundDisabled()) playBeep('error');
    }
}

async function loadPreset(preset) {
    if (!preset || !preset.effects) return;
    setStatus('Applying preset "' + preset.name + '"...');
    addLog('=== Apply preset: ' + preset.name + ' (' + preset.effects.length + ' effects, ' + totalPresetProps(preset) + ' properties) ===', 'info');
    try {
        if (!(await ensureHostScript())) throw new Error('Host script not loaded');
        const opts = getPresetOptions();
        const payload = JSON.stringify({
            effects: preset.effects,
            clipKey: preset.clipKey || '',
            mediaType: preset.mediaType || '',
            options: opts
        });
        // fresh group: a start left over from a cancelled insert must not be reused
        await beginUndoGroup(true);
        const result = await evalScriptAsync('VT_applyEffectPreset(' + JSON.stringify(payload) + ')');
        await endUndoGroup();

        let parsed = null;
        try { parsed = JSON.parse(result); } catch (pe) {}
        if (parsed && parsed.success) {
            let msg = 'Preset applied: ' + preset.name + ' (' + parsed.appliedProps + ' properties';
            if (parsed.addedEffects) msg += ', ' + parsed.addedEffects + ' effect(s) added';
            if (parsed.keptTexts) msg += ', own text kept';
            if (parsed.missingProps && parsed.missingProps.length) msg += ', ' + parsed.missingProps.length + ' missing';
            msg += ')';
            if (parsed.missingProps && parsed.missingProps.length) addLog('Not applied: ' + parsed.missingProps.join(', '), 'warning');
            setStatus(msg);
            addLog('=== ' + msg + ' ===', 'success');
            if (!isPresetSoundDisabled()) playBeep('success');
            const menu = document.getElementById('presetsMenu');
            if (menu) menu.classList.remove('show');
            setTimeout(function () { setStatus('Ready'); }, 2000);
        } else {
            throw new Error((parsed && parsed.error) || result || 'Apply failed');
        }
    } catch (err) {
        addLog('Preset apply error: ' + err.message, 'error');
        setStatus('Error applying preset');
        if (!isPresetSoundDisabled()) playBeep('error');
        try { await evalScriptAsync('VT_cancelUndoGroup()'); } catch (e) { /* ignore */ }
    }
}

async function deletePreset(preset) {
    if (!preset) return;
    try {
        const jsonPath = preset._file || path.join(PRESETS_DIR, preset.id + '.json');
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
        presets = presets.filter(function (p) { return p.id !== preset.id; });
        renderPresetList();
        setStatus('Preset deleted: ' + preset.name);
        addLog('Preset deleted: ' + preset.name, 'info');
    } catch (err) {
        addLog('Preset delete error: ' + err.message, 'error');
    }
}
function loadAssets() {
    assets = [];
    addLog('loadAssets: Loading assets from ' + ASSETS_DIR, 'info');

    try {
        if (!fs.existsSync(ASSETS_DIR)) {
            addLog('loadAssets: ASSETS_DIR does not exist!', 'warning');
            return;
        }

        const files = fs.readdirSync(ASSETS_DIR);
        addLog('loadAssets: Found ' + files.length + ' files in assets directory', 'info');

        files.forEach(function (file) {
            if (file.endsWith('.json')) {
                try {
                    const metaPath = path.join(ASSETS_DIR, file);
                    const content = fs.readFileSync(metaPath, 'utf8');
                    const metadata = JSON.parse(content);


                    // Check if .prproj file or external file exists
                    let fileExists = false;
                    if (metadata.path) {
                        fileExists = fs.existsSync(metadata.path);
                    } else {
                        addLog('loadAssets: Asset ' + metadata.name + ' has no path in metadata!', 'warning');
                    }

                    if (fileExists) {
                        assets.push(metadata);
                    } else {
                        addLog('loadAssets: Asset file NOT found, skipping: ' + metadata.path, 'warning');
                    }
                } catch (e) {
                    console.error('Error loading asset:', file, e);
                    addLog('loadAssets: Error parsing asset file ' + file + ': ' + e.message, 'error');
                }
            }
        });

        addLog('loadAssets: Loaded ' + assets.length + ' valid assets', 'success');
        invalidateAllCardCache();
        renderAssets();
    } catch (e) {
        console.error('Error loading assets:', e);
        addLog('loadAssets: Critical error loading assets: ' + e.message, 'error');
    }
}

let activeSubcategory = new Set(['All']);

function detectTypeFromExtension(filepath) {
    if (!filepath) return 'other';
    const ext = path.extname(filepath).toLowerCase();
    if (['.mp3', '.wav', '.aac', '.m4a', '.aif', '.aiff'].includes(ext)) return 'audio';
    if (['.mp4', '.mov', '.mxf', '.avi', '.mpg', '.webm', '.mkv'].includes(ext)) return 'video';
    if (['.png', '.jpg', '.jpeg', '.gif', '.tif', '.tiff', '.webp', '.bmp', '.psd', '.ai'].includes(ext)) return 'image'; // mapped to image/overlay
    if (ext === '.mogrt') return 'mogrt';
    return 'other';
}

function renderFilterChips(categoryAssets) {
    const filterBar = document.getElementById('filterBar');
    if (!filterBar) return;

    const subcats = new Set(['All']);
    let hasSubcats = false;

    categoryAssets.forEach(a => {
        if (a.subcategory) {
            subcats.add(a.subcategory);
            hasSubcats = true;
        }
    });

    // Validate active chip (reset vs current set)
    // Filter active set to only include valid subcats
    const validActive = new Set();
    activeSubcategory.forEach(c => {
        if (subcats.has(c)) validActive.add(c);
    });
    // If no valid selection left, default to All
    if (validActive.size === 0) validActive.add('All');
    activeSubcategory = validActive;

    if (!hasSubcats || subcats.size <= 1) {
        filterBar.style.display = 'none';
        activeSubcategory = new Set(['All']);
        return;
    }

    filterBar.style.display = 'flex';
    filterBar.innerHTML = '';

    // Convert to array and sort (All first, then alphabetical)
    const sortedCats = Array.from(subcats).sort((a, b) => {
        if (a === 'All') return -1;
        if (b === 'All') return 1;
        return a.localeCompare(b);
    });

    // HYBRID MODE: Show first MAX_VISIBLE_CHIPS, rest in dropdown
    const MAX_VISIBLE_CHIPS = 6;
    const visibleCats = sortedCats.slice(0, MAX_VISIBLE_CHIPS);
    const hiddenCats = sortedCats.slice(MAX_VISIBLE_CHIPS);

    // Render visible chips
    visibleCats.forEach(cat => {
        const chip = createFilterChip(cat, categoryAssets);
        filterBar.appendChild(chip);
    });

    // Render "More" dropdown if there are hidden chips
    if (hiddenCats.length > 0) {
        const moreContainer = document.createElement('div');
        moreContainer.className = 'filter-chip-more-container';

        const moreBtn = document.createElement('div');
        moreBtn.className = 'filter-chip filter-chip-more';
        // Check if ANY active subcategory is in hidden list
        const activeInHidden = hiddenCats.some(c => activeSubcategory.has(c));
        if (activeInHidden) {
            moreBtn.classList.add('has-active');
        }
        moreBtn.innerHTML = `<span>More</span><span style="opacity:0.7; font-size:10px;">+${hiddenCats.length}</span>`;

        const dropdown = document.createElement('div');
        dropdown.className = 'filter-chip-dropdown';

        hiddenCats.forEach(cat => {
            const isActive = activeSubcategory.has(cat);
            const item = document.createElement('div');
            item.className = `filter-chip-dropdown-item ${isActive ? 'active' : ''}`;
            const count = categoryAssets.filter(a => a.subcategory === cat).length;
            item.innerHTML = `<span class="chip-label">${cat}</span><span class="chip-count">${count}</span>`;

            item.addEventListener('click', (e) => {
                e.stopPropagation();
                // Single-select switch: click selects cat as the only filter,
                // clicking the active item again resets to All
                if (cat === 'All') {
                    activeSubcategory = new Set(['All']);
                } else if (activeSubcategory.has(cat)) {
                    activeSubcategory = new Set(['All']);
                } else {
                    activeSubcategory = new Set([cat]);
                }
                // renderAssets() rebuilds the filter bar, which closes the dropdown
                renderAssets();
            });

            // Context menu for dropdown items
            item.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                dropdown.classList.remove('show');
                showChipContextMenu(e.clientX, e.clientY, cat);
            });

            dropdown.appendChild(item);
        });

        moreBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = dropdown.classList.contains('show');

            // Close any other open dropdowns first
            document.querySelectorAll('.filter-chip-dropdown.show').forEach(d => d.classList.remove('show'));

            if (!isOpen) {
                dropdown.classList.add('show');

                // Close on outside click (delayed to prevent immediate trigger)
                setTimeout(() => {
                    const closeHandler = (evt) => {
                        if (!moreContainer.contains(evt.target)) {
                            dropdown.classList.remove('show');
                            document.removeEventListener('click', closeHandler);
                        }
                    };
                    document.addEventListener('click', closeHandler);
                }, 10);
            }
        });

        moreContainer.appendChild(moreBtn);
        moreContainer.appendChild(dropdown);
        filterBar.appendChild(moreContainer);
    }

    // Initialize rename events if not already
    if (typeof setupSubcatRenameEvents === 'function' && !window.subcatRenameInitialized) {
        setupSubcatRenameEvents();
        window.subcatRenameInitialized = true;
    }
}

/**
 * Create a single filter chip element
 */
function createFilterChip(cat, categoryAssets) {
    const chip = document.createElement('div');
    const isActive = activeSubcategory.has(cat);
    chip.className = `filter-chip ${isActive ? 'active' : ''}`;

    const count = categoryAssets.filter(a => cat === 'All' || a.subcategory === cat).length;
    chip.innerHTML = `<span class="chip-label">${cat}</span><span class="chip-count">${count}</span>`;

    chip.addEventListener('click', () => {
        // Single-select switch: click selects cat as the only filter,
        // clicking the active chip again resets to All
        if (cat === 'All') {
            activeSubcategory = new Set(['All']);
        } else if (activeSubcategory.has(cat)) {
            activeSubcategory = new Set(['All']);
        } else {
            activeSubcategory = new Set([cat]);
        }
        renderAssets();
    });

    // Add Context Menu and Drag & Drop (except for 'All')
    if (cat !== 'All') {
        chip.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showChipContextMenu(e.clientX, e.clientY, cat);
        });

        // Drag & Drop assignment
        chip.addEventListener('dragover', (e) => {
            e.preventDefault(); // Allow drop
            e.dataTransfer.dropEffect = 'copy';
            chip.classList.add('drag-over');
        });

        chip.addEventListener('dragleave', () => {
            chip.classList.remove('drag-over');
        });

        chip.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation(); // Stop bubbling
            chip.classList.remove('drag-over');

            // Try dataTransfer first, fall back to global variable
            let assetId = e.dataTransfer.getData('text/plain');
            if (!assetId && window._internalDragAssetId) {
                assetId = window._internalDragAssetId;
            }

            if (assetId) {
                // Use loose string comparison to avoid type issues
                const asset = assets.find(a => String(a.id) === String(assetId));

                if (asset) {
                    if (asset.subcategory !== cat) {
                        applySubcategoryChange(asset, cat);
                    } else {
                    }
                } else {
                    addLog('Error: Asset not found for ID: ' + assetId, 'error');
                }
            }
            // Clear global
            window._internalDragAssetId = null;
        });
    }

    return chip;
}

function showChipContextMenu(x, y, name) {
    // Hide main context menu if visible
    const mainCtx = document.getElementById('contextMenu');
    if (mainCtx) mainCtx.style.display = 'none';

    // Remove existing dynamic menus
    const existing = document.querySelectorAll('.context-menu:not(#contextMenu)');
    existing.forEach(e => e.remove());

    const menu = document.createElement('div');
    menu.className = 'context-menu';
    menu.style.left = x + 'px';
    menu.style.top = y + 'px';
    menu.style.display = 'block'; // Ensure it's visible based on CSS

    // Rename option
    const itemRename = document.createElement('div');
    itemRename.className = 'context-item';
    itemRename.innerHTML = `
        <svg viewBox="0 0 24 24" class="ctx-icon"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path class="accent" d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        Rename
    `;
    itemRename.onclick = () => {
        if (window.openSubcatRename) window.openSubcatRename(name);
        menu.remove();
    };

    // Delete option
    const itemDelete = document.createElement('div');
    itemDelete.className = 'context-item context-delete';
    itemDelete.innerHTML = `
        <svg viewBox="0 0 24 24" class="ctx-icon ctx-icon-delete"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        Delete
    `;
    itemDelete.onclick = () => {
        if (confirm('Delete category "' + name + '" from all assets?')) {
            deleteSubcategory(name);
        }
        menu.remove();
    };

    menu.appendChild(itemRename);
    menu.appendChild(itemDelete);
    document.body.appendChild(menu);

    // Close on next click
    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            // Don't close if clicking inside the menu
            if (menu.contains(e.target)) return;

            menu.remove();
            document.removeEventListener('click', close);
        });
    }, 0);
}

function setupSubcatRenameEvents() {
    const dialog = document.getElementById('subcatRenameDialog');
    const input = document.getElementById('subcatRenameInput');
    const confirmBtn = document.getElementById('confirmSubcatRename');
    const cancelBtn = document.getElementById('cancelSubcatRename');
    let currentOldName = null;

    window.openSubcatRename = (oldName) => {
        currentOldName = oldName;
        input.value = oldName;
        dialog.style.display = 'flex';
        input.focus();
        input.select();
    };

    const close = () => {
        dialog.style.display = 'none';
        currentOldName = null;
    };

    if (cancelBtn) cancelBtn.onclick = close;

    const perform = () => {
        const newName = input.value.trim();
        if (newName && currentOldName && newName !== currentOldName) {
            updateSubcategoryName(currentOldName, newName);
        }
        close();
    };

    if (confirmBtn) confirmBtn.onclick = perform;
    if (input) {
        input.onkeyup = (e) => {
            if (e.key === 'Enter') perform();
            if (e.key === 'Escape') close();
        };
    }
}

function updateSubcategoryName(oldName, newName) {
    let updatedCount = 0;
    assets.forEach(asset => {
        if (asset.subcategory === oldName) {
            asset.subcategory = newName;
            // Update file
            try {
                const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
                if (fs.existsSync(metaPath)) {
                    // Start reading fresh to avoid overwrite race? No, we trust memory 'assets' is up to date vs disk structure
                    // But good practice to read-modify-write if properties exist that are not in 'assets' array
                    // 'assets' array has full metadata.
                    fs.writeFileSync(metaPath, JSON.stringify(asset, null, 2));
                    updatedCount++;
                }
            } catch (e) { console.error('Error updating asset ' + asset.id, e); }
        }
    });

    if (updatedCount > 0) {
        addLog(`Renamed category "${oldName}" to "${newName}" in ${updatedCount} assets.`);
        if (activeSubcategory.has(oldName)) {
            activeSubcategory.delete(oldName);
            activeSubcategory.add(newName);
        }
        renderAssets();
    }
}

function deleteSubcategory(name) {
    let updatedCount = 0;
    assets.forEach(asset => {
        if (asset.subcategory === name) {
            delete asset.subcategory; // Remove property? Or set to undefined?
            // JSON.stringify will skip undefined.
            // Update file
            try {
                const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
                if (fs.existsSync(metaPath)) {
                    fs.writeFileSync(metaPath, JSON.stringify(asset, null, 2));
                    updatedCount++;
                }
            } catch (e) { console.error('Error updating asset ' + asset.id, e); }
        }
    });

    if (updatedCount > 0) {
        addLog(`Deleted category "${name}" from ${updatedCount} assets.`);
        if (activeSubcategory.has(name)) {
            activeSubcategory.delete(name);
            if (activeSubcategory.size === 0) activeSubcategory.add('All');
        }
        invalidateAllCardCache();
        renderAssets();
    }
}

/**
 * Card DOM cache avoids re-creating cards on every category switch.
 * Key = asset.id, Value = DOM element returned by createAssetCard().
 */
const _cardCache = new Map();
let _initialRenderDone = false;

/**
 * Invalidate a single card in the cache (e.g. after rename, preview change).
 */
function invalidateCardCache(assetId) {
    _cardCache.delete(assetId);
}

/**
 * Force a full cache rebuild on next render (e.g. after asset list changes).
 */
function invalidateAllCardCache() {
    _cardCache.clear();
    _initialRenderDone = false;
}

/**
 * IntersectionObserver for lazy-loading heavy card content (video src, waveforms).
 * Cards register via data-lazy-src (video) or data-lazy-waveform (audio canvas).
 * Content is loaded only when the card scrolls into view.
 */
const _lazyCardObserver = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        const card = entry.target;

        // Lazy-load video preview
        const video = card.querySelector('video[data-lazy-src]');
        if (video && !video.src) {
            video.src = video.getAttribute('data-lazy-src');
            video.removeAttribute('data-lazy-src');
        }

        // Lazy-generate waveform
        const canvas = card.querySelector('canvas[data-lazy-waveform]');
        if (canvas && !canvas._waveformLoaded) {
            canvas._waveformLoaded = true;
            const audioPath = canvas.getAttribute('data-audio-path');
            // Defer slightly so layout is settled
            requestAnimationFrame(async function () {
                const rect = canvas.parentElement.getBoundingClientRect();
                // Force a high resolution multiplier (3x) because devicePixelRatio
                // can be unreliable in CEP panels and cause blurriness.
                const dpr = 3; 
                canvas.width = Math.floor((rect.width || 200) * dpr);
                canvas.height = Math.floor((rect.height || 80) * dpr);
                const waveformData = await generateWaveform(audioPath);
                setupStaticWaveform(canvas, waveformData);
            });
        }

        // Once loaded, stop observing this card
        _lazyCardObserver.unobserve(card);
    });
}, { root: assetGrid, rootMargin: '200px 0px' });

/**
 * Render asset grid optimised version.
 *
 * Instead of destroying every card on each category switch, we:
 *  1. Cache card DOM nodes by asset.id so they are reused.
 *  2. Build the new visible set in a DocumentFragment and swap in one go.
 *  3. Only play the staggered entrance animation on the very first render;
 *     subsequent renders simply show the cards immediately.
 */
function renderAssets() {
    // 1. Filter by Main Category
    let filterBase = assets;
    if (selectedCategory === 'recent') {
        filterBase = recentAssets
            .map(id => assets.find(a => a.id === id))
            .filter(Boolean);
    } else if (selectedCategory === 'favorites') {
        const favSet = getFavoritesSet();
        filterBase = assets.filter(a => favSet.has(a.id));
    } else if (selectedCategory !== 'all') {
        filterBase = assets.filter(a => a.type === selectedCategory);
    }

    // 2. Render Filter Chips (before subcat filtering)
    renderFilterChips(filterBase);

    // 3. Apply Subcategory Filter
    let filteredAssets = filterBase;
    if (!activeSubcategory.has('All')) {
        filteredAssets = filteredAssets.filter(a => {
            return a.subcategory && activeSubcategory.has(a.subcategory);
        });
    }

    // 4. Apply Search Filter
    if (searchFilter) {
        filteredAssets = filteredAssets.filter(a =>
            a.name.toLowerCase().includes(searchFilter)
        );
    }

    // 5. Update sidebar counts
    updateCategoryCounts();

    // 6. Build the visible card set
    // Detach existing children without destroying them (keep in cache)
    while (assetGrid.firstChild) {
        assetGrid.removeChild(assetGrid.firstChild);
    }

    // Always re-attach emptyState node
    if (emptyState) {
        assetGrid.appendChild(emptyState);
    }

    if (filteredAssets.length === 0) {
        if (emptyState) emptyState.style.display = 'block';
        return;
    }
    if (emptyState) emptyState.style.display = 'none';

    // Prune stale cache entries (assets that no longer exist)
    const currentIds = new Set(assets.map(a => a.id));
    for (const cachedId of _cardCache.keys()) {
        if (!currentIds.has(cachedId)) _cardCache.delete(cachedId);
    }

    const shouldAnimate = !_initialRenderDone;
    const fragment = document.createDocumentFragment();
    const newCards = []; // Cards that need entrance animation

    for (let i = 0; i < filteredAssets.length; i++) {
        const asset = filteredAssets[i];
        let card = _cardCache.get(asset.id);

        if (!card) {
            // Create new card and cache it
            card = createAssetCard(asset);
            _cardCache.set(asset.id, card);

            if (shouldAnimate) {
                card.classList.add('card-entering');
                newCards.push(card);
            } else {
                // Skip animation show immediately
                card.classList.add('card-entered');
            }
        } else {
            // Reuse cached card make sure it's visible and up-to-date
            // Update selection state
            if (selectedAssetIds.has(asset.id)) {
                card.classList.add('selected');
            } else {
                card.classList.remove('selected');
            }
            // Re-observe for lazy loading if content hasn't been loaded yet
            if (card.querySelector('video[data-lazy-src]') || card.querySelector('canvas[data-lazy-waveform]:not([data-loaded])')) {
                _lazyCardObserver.observe(card);
            }
        }
        fragment.appendChild(card);
    }

    assetGrid.appendChild(fragment);

    // Staggered entrance animation only for first load
    if (shouldAnimate && newCards.length > 0) {
        _initialRenderDone = true;
        requestAnimationFrame(function () {
            newCards.forEach(function (card, i) {
                setTimeout(function () {
                    card.classList.remove('card-entering');
                    card.classList.add('card-entered');
                }, i * 20);
            });
        });
    } else {
        _initialRenderDone = true;
    }
}

/**
 * Update category counter badges
 */
function updateCategoryCounts() {
    var allCount = document.getElementById('count-all');
    if (allCount) allCount.textContent = assets.length;

    var recentSet = new Set(recentAssets);
    var favSet = getFavoritesSet();

    var counts = { recent: 0, favorites: 0 };
    var types = ['video', 'transition', 'effect', 'text', 'audio', 'overlay', 'background', 'mogrt', 'other'];
    var typeCounts = {};
    types.forEach(function (t) { typeCounts[t] = 0; });

    assets.forEach(function (a) {
        if (recentSet.has(a.id)) counts.recent++;
        if (favSet.has(a.id)) counts.favorites++;
        if (typeCounts[a.type] !== undefined) typeCounts[a.type]++;
    });

    var recentCount = document.getElementById('count-recent');
    if (recentCount) recentCount.textContent = counts.recent;
    var favoritesCount = document.getElementById('count-favorites');
    if (favoritesCount) favoritesCount.textContent = counts.favorites;
    types.forEach(function (type) {
        var countEl = document.getElementById('count-' + type);
        if (countEl) countEl.textContent = typeCounts[type];
    });
}

/**
 * Add asset to recent list
 */
function addToRecent(assetId) {
    // Remove if already in list
    recentAssets = recentAssets.filter(id => id !== assetId);
    // Add to front
    recentAssets.unshift(assetId);
    // Keep only MAX_RECENT
    recentAssets = recentAssets.slice(0, MAX_RECENT);
    // Save to localStorage
    localStorage.setItem('vt_recent_assets', JSON.stringify(recentAssets));
}

/**
 * Get icon for asset type - using SVG from sidebar
 */
const ASSET_TYPE_ICONS = {
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="4" ry="4"></rect><polygon class="accent" points="10 9 15 12 10 15 10 9"></polygon></svg>',
    transition: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><path class="accent" d="M8 12l8 0"></path><path class="accent" d="M13 9l3 3-3 3"></path></svg>',
    effect: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"></path><path class="accent" d="M12 4v2M12 18v2M4 12h2M18 12h2M6.34 6.34l1.42 1.42M16.24 16.24l1.42 1.42M6.34 17.66l1.42-1.42M16.24 7.76l1.42-1.42"></path></svg>',
    text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7V4h16v3"></path><path d="M9 20h6"></path><line class="accent" x1="12" y1="4" x2="12" y2="20"></line></svg>',
    audio: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V6"></path><path class="accent" d="M15 21V3"></path><path d="M5 15v-6"></path><path d="M19 15v-6"></path></svg>',
    overlay: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline class="accent" points="2 12 12 17 22 12"></polyline></svg>',
    background: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle class="accent" cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>',
    mogrt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4" ry="4"></rect><circle class="accent" cx="12" cy="12" r="3"></circle></svg>',
    other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8l-9-5-9 5v8l9 5 9-5z"></path><path class="accent" d="M12 12v9"></path></svg>'
};

function getAssetIcon(type) {
    return ASSET_TYPE_ICONS[type] || ASSET_TYPE_ICONS.other;
}

const TYPE_LABELS = {
    video: 'Video',
    transition: 'Transition',
    effect: 'Effect',
    text: 'Text',
    audio: 'Audio',
    overlay: 'Overlay',
    background: 'Background',
    mogrt: 'MOGRT',
    other: 'Other'
};

/**
 * Create an asset card element
 */
function createAssetCard(asset) {
    const card = document.createElement('div');
    card.className = 'asset-card';

    // Pre-compute these values for use in event handlers
    const hasPreviewFile = hasPreview(asset);
    const isAudio = isAudioFile(asset.path);
    const isMogrt = isMogrtFile(asset.path);
    const isImage = isImageFile(asset.path);

    // Selection State
    if (selectedAssetIds.has(asset.id)) {
        card.classList.add('selected');
    }

    // Click Handler for Selection
    card.addEventListener('click', (e) => {
        // Ignore clicks on favorite button or context menu trigger
        if (e.target.closest('.asset-favorite') || e.button === 2) return;

        const isMulti = e.ctrlKey || e.metaKey;
        const isRange = e.shiftKey;

        if (isRange && lastSelectedAssetId) {
            // Range Selection
            const allCards = Array.from(document.querySelectorAll('.asset-card'));
            const lastIdx = allCards.findIndex(c => c.dataset.assetId === lastSelectedAssetId);
            const currIdx = allCards.findIndex(c => c.dataset.assetId === asset.id);

            if (lastIdx !== -1 && currIdx !== -1) {
                const start = Math.min(lastIdx, currIdx);
                const end = Math.max(lastIdx, currIdx);

                // If not holding Ctrl, clear previous unless range extension
                if (!isMulti) {
                    selectedAssetIds.clear();
                    allCards.forEach(c => c.classList.remove('selected'));
                }

                for (let i = start; i <= end; i++) {
                    const cid = allCards[i].dataset.assetId;
                    selectedAssetIds.add(cid);
                    allCards[i].classList.add('selected');
                }
            }
        } else if (isMulti) {
            // Toggle Selection
            if (selectedAssetIds.has(asset.id)) {
                selectedAssetIds.delete(asset.id);
                card.classList.remove('selected');
            } else {
                selectedAssetIds.add(asset.id);
                card.classList.add('selected');
                lastSelectedAssetId = asset.id;
            }
        } else {
            // Single Selection
            selectedAssetIds.clear();
            document.querySelectorAll('.asset-card.selected').forEach(c => c.classList.remove('selected'));

            selectedAssetIds.add(asset.id);
            card.classList.add('selected');
            lastSelectedAssetId = asset.id;
        }

        // Show Audio Preview for audio files (if single or last selected)
        const isVideoFileAsset = isVideoFile(asset.path);
        if (isAudio && AudioPreview) {
            if (VideoPreview) VideoPreview.hide();
            if (isAutoPlayAudioEnabled()) {
                AudioPreview.showAndPlay(asset);
            } else {
                AudioPreview.show(asset);
            }
        } else if (isVideoFileAsset && VideoPreview && !isMulti && !isRange) {
            // Show Video Preview for video files (single click)
            if (AudioPreview) AudioPreview.hide();
            if (isAutoPlayAudioEnabled()) {
                VideoPreview.showAndPlay(asset);
            } else {
                VideoPreview.show(asset);
            }
        } else if (AudioPreview && !isMulti && !isRange) {
            // If we clicked a non-audio asset (single click), hide preview
            if (!isAudio) AudioPreview.hide();
            if (VideoPreview) VideoPreview.hide();
        }

        // Update Status
        if (selectedAssetIds.size > 1) {
            setStatus(`${selectedAssetIds.size} assets selected`);
        } else {
            setStatus('Double-click to apply "' + asset.name + '"');
        }
    });

    // Add class if preview exists
    if (hasPreviewFile) {
        card.classList.add('has-preview');
    }

    card.setAttribute('draggable', 'true');
    card.dataset.assetId = asset.id;
    card.dataset.assetPath = asset.path || '';
    card.dataset.assetType = asset.type || 'other';

    // Detect icon by extension for special file types (isAudio/isMogrt already computed at top)
    let icon;

    if (isMogrt) {
        icon = '📊'; // MOGRT icon
    } else if (isAudio) {
        icon = '🎵'; // Audio icon
    } else if (isImage) {
        icon = '🖼️'; // Image icon
    } else {
        icon = getAssetIcon(asset.type);
    }

    const previewPath = asset.path ? getPreviewPath(asset.path) : null;
    // hasPreviewFile was already calculated above

    const typeLabel = TYPE_LABELS[asset.type] || 'Asset';
    const isFavorite = getFavoritesSet().has(asset.id);

    // Build thumbnail content
    let thumbnailContent;
    let needsWaveformSetup = false;

    if (isImage && isImagePreviewable(asset.path)) {
        // The image itself is the preview (browser-decodable formats)
        thumbnailContent = `<img class="asset-preview asset-image" src="file://${asset.path}" alt="">`;
    } else if (hasPreviewFile) {
        // Lazy: video src is set by IntersectionObserver when card enters viewport
        thumbnailContent = `<video class="asset-preview" data-lazy-src="file://${previewPath}" loop muted playsinline preload="metadata"></video>`;
    } else if (isAudio) {
        // Canvas for interactive waveform – lazy generated via observer
        thumbnailContent = `<canvas class="waveform-canvas" data-audio-path="${asset.path}" data-lazy-waveform></canvas>`;
        needsWaveformSetup = true;
    } else {
        // Icon with watermark effect
        thumbnailContent = `
                <div class="watermark-bg">${icon}</div>
                <div class="asset-icon">${icon}</div>
            `;
    }

    // Build meta label (TYPE - Subcategory)
    let metaLabel = typeLabel;
    if (asset.subcategory) {
        metaLabel += ` · ${asset.subcategory}`;
    }

    card.innerHTML = `
            <button class="asset-favorite" title="Add to favorites"><svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26"></polygon></svg></button>
            <div class="asset-thumbnail${hasPreviewFile ? ' has-preview' : ''}">
                ${thumbnailContent}
            </div>
            <div class="asset-info">
                <div class="asset-name" title="${asset.name}">${asset.name}</div>
                <div class="asset-meta">${metaLabel}</div>
            </div>
        `;

    // Right-click context menu
    card.addEventListener('contextmenu', function (e) {
        e.preventDefault();

        // Close any dynamic context menus (like chip menus)
        const dynamicMenus = document.querySelectorAll('.context-menu:not(#contextMenu)');
        dynamicMenus.forEach(m => m.remove());

        // Batch Selection Logic for Right Click
        // If the right-clicked item is NOT in the selection, clear and select it (standard OS behavior)
        if (!selectedAssetIds.has(asset.id)) {
            selectedAssetIds.clear();
            selectedAssetIds.add(asset.id);
            document.querySelectorAll('.asset-card.selected').forEach(c => c.classList.remove('selected'));
            card.classList.add('selected');
        }

        contextMenuAsset = asset;
        const selectionCount = selectedAssetIds.size;
        const isBatch = selectionCount > 1;

        // UI Updates for Batch
        const deleteBtn = document.getElementById('ctxDelete');
        const renameBtn = document.getElementById('ctxRename');
        const subcatBtn = document.getElementById('ctxEditSubcat');
        const explorerBtn = document.getElementById('ctxExplorer');
        const previewBtn = document.getElementById('ctxAddPreview');
        const removePreviewBtn = document.getElementById('ctxRemovePreview');

        if (isBatch) {
            // Batch Mode
            deleteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" class="ctx-icon ctx-icon-delete"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                Delete (${selectionCount}) items
            `;
            subcatBtn.innerHTML = `
                <svg viewBox="0 0 24 24" class="ctx-icon"><path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9z" /><path class="accent" d="M16 9V7a4 4 0 0 0-8 0v2" /></svg>
                Edit Subcategory (${selectionCount})
            `;

            // Hide single-item actions
            if (renameBtn) renameBtn.style.display = 'none';
            if (explorerBtn) explorerBtn.style.display = 'none';
            if (previewBtn) previewBtn.style.display = 'none';
            if (removePreviewBtn) removePreviewBtn.style.display = 'none';

        } else {
            // Single Item Mode (Restore defaults)
            deleteBtn.innerHTML = `
                <svg viewBox="0 0 24 24" class="ctx-icon ctx-icon-delete"><circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" /></svg>
                Delete
            `;
            subcatBtn.innerHTML = `
                <svg viewBox="0 0 24 24" class="ctx-icon"><path d="M4 9h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V9z" /><path class="accent" d="M16 9V7a4 4 0 0 0-8 0v2" /></svg>
                Edit Subcategory
            `;

            if (renameBtn) renameBtn.style.display = 'block';
            if (explorerBtn) explorerBtn.style.display = 'block';
            if (previewBtn) previewBtn.style.display = 'block';
            if (removePreviewBtn) {
                removePreviewBtn.style.display = hasPreviewFile ? 'block' : 'none';
            }
        }

        // Show/hide remove preview based on whether preview exists (Only relevant in single mode handled above)

        // Context Actions

        // First, show menu temporarily (maybe off-screen) to calculate its size
        contextMenu.style.display = 'block';
        
        let x = e.clientX;
        let y = e.clientY;
        const menuWidth = contextMenu.offsetWidth;
        const menuHeight = contextMenu.offsetHeight;
        
        // If menu goes off the right edge, flip it to the left of the cursor
        if (x + menuWidth > window.innerWidth) {
            x = e.clientX - menuWidth;
        }
        
        // If menu goes off the bottom edge, flip it above the cursor
        if (y + menuHeight > window.innerHeight) {
            y = e.clientY - menuHeight;
        }
        
        // Safety bounds to ensure it doesn't go off the top/left edge in very small windows
        x = Math.max(5, x);
        y = Math.max(5, y);

        // Apply final position
        contextMenu.style.left = x + 'px';
        contextMenu.style.top = y + 'px';
    });

    // Double-click to apply asset at playhead
    card.addEventListener('dblclick', async function (e) {
        e.preventDefault();
        // One insert at a time: a second double-click while the first insert
        // runs used to interleave both and mix up the clipboard.
        if (window._vtInserting) {
            addLog('Insert already in progress - double-click ignored', 'warning');
            return;
        }
        window._vtInserting = true;
        try {
            await applyAsset(asset);
        } catch (err) {
            /* already logged and shown in the status bar by applyAsset */
        } finally {
            window._vtInserting = false;
        }
    });

    // Hover to play video preview (works with lazy-loaded src)
    const videoEl = card.querySelector('video.asset-preview');
    if (videoEl) {
        // When metadata loads, seek to 25% for thumbnail (avoids black frames from fade-in effects)
        videoEl.addEventListener('loadedmetadata', function () {
            // Skip if the preview bar owns this element (fresh click playback).
            // No isOpen() check: ownership is set before the 'visible'
            // class lands, and metadata can resolve within that frame.
            if (typeof VideoPreview !== 'undefined' &&
                VideoPreview.playbackEl === videoEl) {
                return;
            }
            const thumbnailPos = videoEl.duration * 0.25;
            videoEl.currentTime = thumbnailPos;
        });

        // Hover plays the thumbnail preview - except for the card currently
        // owned by the preview bar (playing OR paused after a click).
        // Only ONE hover video decodes at a time, and none while the main
        // preview-bar video plays (extra decoders cause stutter).
        card.addEventListener('mouseenter', function () {
            if (!videoEl.src) return;
            // Selected card: the preview bar drives it - don't interfere
            if (typeof VideoPreview !== 'undefined' && VideoPreview.isOpen() &&
                VideoPreview.playbackEl === videoEl) {
                return;
            }
            // Main video playing: no extra decoders
            if (typeof VideoPreview !== 'undefined' && VideoPreview.isPlaying) {
                return;
            }
            // Pause the previous hover preview
            if (_hoverVideoEl && _hoverVideoEl !== videoEl) {
                try { _hoverVideoEl.pause(); } catch (e) {}
            }
            _hoverVideoEl = videoEl;
            videoEl.currentTime = 0;
            videoEl.play().catch(() => { });
        });
        card.addEventListener('mouseleave', function () {
            if (!videoEl.src) return;
            if (typeof VideoPreview !== 'undefined' && VideoPreview.isOpen() &&
                VideoPreview.playbackEl === videoEl) {
                return;
            }
            videoEl.pause();
            if (_hoverVideoEl === videoEl) _hoverVideoEl = null;
            // Return to 25% position for thumbnail
            const thumbnailPos = videoEl.duration ? videoEl.duration * 0.25 : 0;
            try { videoEl.currentTime = thumbnailPos; } catch (e) {}
        });
    }

    // Favorite button toggle
    const favBtn = card.querySelector('.asset-favorite');
    if (favBtn) {
        // Set initial state
        if (isFavorite) {
            favBtn.classList.add('active');
        }

        favBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            let favorites = readStoredList('vt_favorites');

            if (favorites.includes(asset.id)) {
                favorites = favorites.filter(id => id !== asset.id);
                favBtn.classList.remove('active');
            } else {
                favorites.push(asset.id);
                favBtn.classList.add('active');
            }

            localStorage.setItem('vt_favorites', JSON.stringify(favorites));
            invalidateFavoritesCache();

            // Refresh grid if we are in Favorites view, or just update counts
            if (selectedCategory === 'favorites') {
                renderAssets();
            } else {
                updateCategoryCounts();
            }
        });
    }

    // Drag start - use native file for external assets, .vtbk for .prproj
    card.addEventListener('dragstart', function (e) {
        card.classList.add('dragging');

        // GLOBAL INTERNAL DRAG FALLBACK
        window._internalDragAssetId = asset.id;

        // Custom Ghost Image
        const ghost = document.getElementById('dragGhost');
        const ghostIcon = ghost.querySelector('.drag-ghost-icon');
        if (ghost && ghostIcon) {
            // Copy icon from card
            ghostIcon.innerHTML = isMogrt ? '📊' : (isAudio ? '🎵' : (isImage ? '🖼️' : getAssetIcon(asset.type)));
            // Better: clone the actual icon element from the card to keep styles
            const cardIcon = card.querySelector('.asset-icon svg, .asset-icon');
            if (cardIcon) {
                ghostIcon.innerHTML = cardIcon.outerHTML;
            }

            // Set drag image (offset by -20px so it floats above/left of cursor)
            // The 2nd and 3rd args are the position of the cursor RELATIVE to the image top-left
            // So if we set it to (50, 50) the image will be drawn so that the cursor is heavily inside it.
            // If we want the image to be AWAY from cursor, we need to be clever.
            // Actually, HTML5 setDragImage doesn't support negative offsets well in all browsers,
            // but setting it to the bottom-right corner of the image (e.g. 48, 48) makes the image appear Top-Left of cursor.

            // Set drag image (offset by -20px so it floats meant to be Bottom-Right)
            // Image location = (mouseX - x, mouseY - y)
            // We want Image = (mouseX + 20, mouseY + 20) -> x = -20, y = -20
            e.dataTransfer.setDragImage(ghost, -20, -20);
        }

        let dragPath;

        // MOGRT: native drag of the real .mogrt file - Premiere places it at
        // the drop position exactly like an Explorer drag (AtomX-style).
        // No .vtbk placeholder is created, so no _vt_trash bin appears.
        if (isMogrtFile(asset.path)) {
            dragPath = asset.path;
            window._vtDraggedAsset = null;
            window._vtVideoDragSpeed = 1.0;
            addLog('Native MOGRT drag: ' + dragPath, 'info');
            setStatus('Drop "' + asset.name + '" on timeline...');
        }
        // External files (video/audio but NOT mogrt)
        else if (asset.isExternal) {
            // Audio files: use .vtbk placeholder so we can apply pitch/reverse via polling+replacePlaceholder
            if (isAudioFile(asset.path)) {
                dragPath = createVtbkFile(asset);
                if (!dragPath) {
                    addLog('ERROR: Failed to create .vtbk file for audio', 'error');
                    e.preventDefault();
                    return;
                }
                window._vtDraggedAsset = asset;
                addLog('Audio drag with placeholder: ' + dragPath, 'info');
                setStatus('Drop audio on timeline...');
            } else {
                // Video/image files: use native path for clean import
                dragPath = asset.path;
                addLog('Native drag for external file: ' + dragPath, 'info');
                window._vtDraggedAsset = null;
                if (isVideoFile(asset.path)) {
                    window._vtVideoDragSpeed = (typeof VideoPreview !== 'undefined' && VideoPreview) ? (parseFloat(VideoPreview.speed) || 1.0) : 1.0;
                } else {
                    window._vtVideoDragSpeed = null;
                }
                setStatus('Drop "' + asset.name + '" on timeline...');
            }
        } else {
            // .prproj assets - use .vtbk placeholder system for copy/paste workflow
            dragPath = createVtbkFile(asset);
            if (!dragPath) {
                addLog('ERROR: Failed to create .vtbk file', 'error');
                e.preventDefault();
                return;
            }

            // Store for placeholder replacement
            window._vtDraggedAsset = asset;
            addLog('Drag started with .vtbk: ' + dragPath, 'info');
            setStatus('Drop on timeline where you want the asset...');
        }

        // Open the undo group BEFORE the user drops: the native placeholder
        // drop is itself an Overwrite history entry, so it must sit inside
        // the collapsed group - otherwise one Overwrite survives every Ctrl+Z.
        // Native video drops snapshot the timeline first so dragend can find
        // the new clip and apply the preview speed inside this group.
        // Remember where the playhead is BEFORE the drop (every drag type), so
        // the insert can put it back exactly there; a fresh capture also
        // replaces any stale one from an earlier drag.
        evalScriptAsync('VT_capturePlayhead()');
        // v3.9.11: no warm-up at drag start - it put greyed "Create VT_undo_..."
        // and "Rename item to ..." lines in the History panel while dragging.
        if (window._vtDraggedAsset) {
            beginUndoGroup(true, true);
        } else if (window._vtVideoDragSpeed != null) {
            evalScriptAsync('VT_markTimelineSnapshot()');
            beginUndoGroup(true, true);
        }

        // Use CEP native file drag
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('com.adobe.cep.dnd.file.0', dragPath);
        e.dataTransfer.setData('text/plain', asset.id);
    });

    card.addEventListener('dragend', function (e) {
        card.classList.remove('dragging');
        // Clear global
        setTimeout(() => { window._internalDragAssetId = null; }, 100);

        // Only poll for placeholder if using .prproj assets (not external files)
        if (window._vtDraggedAsset) {
            addLog('Drag ended, checking for placeholder...', 'info');
            startPlaceholderPolling(window._vtDraggedAsset);
            window._vtDraggedAsset = null;
        } else if (window._vtVideoDragSpeed != null) {
            const speed = window._vtVideoDragSpeed;
            window._vtVideoDragSpeed = null;
            startNativeVideoSpeedPolling(speed, isMogrt ? asset : null);
        }
    });

    // Register card with lazy observer for video/waveform loading
    if (hasPreviewFile || needsWaveformSetup) {
        _lazyCardObserver.observe(card);
    }

    return card;
}

/**
 * Start polling for placeholder on timeline after drag ends
 * @param {object} asset - The asset that was dragged
 */
function startPlaceholderPolling(asset) {
    let attempts = 0;
    const maxAttempts = 40;
    let isProcessing = false;
    let timedOut = false;
    let pollInterval = null;

    let findInFlight = false;
    pollInterval = setInterval(async function () {
        // v3.9.12: one lookup at a time - the 25 ms timer used to fire new
        // VT_findPlaceholder calls while the previous ones were still running
        // (3 identical "Found .vtbk" lines per drop in the log)
        if (isProcessing || timedOut || findInFlight || isVtBusy()) return;

        attempts++;

        // Check if placeholder is on timeline
        findInFlight = true;
        let result;
        try { result = await evalScriptAsync('VT_findPlaceholder()'); } finally { findInFlight = false; }

        if (result && result !== 'null' && result !== 'false') {
            // IMMEDIATELY set lock and clear interval BEFORE any async work
            if (isProcessing || timedOut) return; // Double-check in case of race
            isProcessing = true;
            clearInterval(pollInterval);
            pollInterval = null;

            addLog('Found placeholder at: ' + result, 'info');

            // The drop just landed on the timeline - OS focus should be on it.
            // Remember the HWND so focusfix can restore it before future
            // DLL copy/paste operations.
            rememberTimelineFocus();

            // Replace placeholder with asset (now safe from duplicates)
            await replacePlaceholderWithAsset(asset, result);
        } else if (attempts >= maxAttempts && !timedOut) {
            // Set flag FIRST so other in-flight async callbacks skip the block.
            // evalScriptAsync is async: many callbacks can be awaiting simultaneously,
            // and without this flag all of them would enter here and log duplicates.
            timedOut = true;
            clearInterval(pollInterval);
            pollInterval = null;
            addLog('No placeholder found - drag may have been cancelled', 'info');
            await evalScriptAsync('VT_cancelUndoGroup()');
            setStatus('Ready');
        }
    }, 25);
}

/**
 * After a native video drop, poll for the new clip and apply the preview
 * bar's speed to it inside the undo group opened at dragstart. On timeout
 * (drop cancelled / not on timeline) the group is cancelled instead.
 * @param {number} speed - Preview speed (1.0 wraps the drop only)
 */
function startNativeVideoSpeedPolling(speed, dropAsset) {
    let attempts = 0;
    const maxAttempts = 30;
    let isProcessing = false;
    let pollInterval = null;

    pollInterval = setInterval(async function () {
        if (isProcessing || isVtBusy()) return;
        attempts++;

        // Let the native drop settle first - polling during the drop makes
        // Premiere and ExtendScript fight over the UI thread
        if (attempts <= 2) return;

        isProcessing = true;
        try {
            const result = await evalScriptAsync('VT_applySpeedToNewClips(' + JSON.stringify(speed) + ')');
            const parsed = JSON.parse(result);
            if (parsed && parsed.success && parsed.found) {
                clearInterval(pollInterval);
                pollInterval = null;
                if (speed !== 1.0) {
                    addLog('Video speed ' + speed + 'x applied to ' + parsed.count + ' clip(s)', 'info');
                }
                if (dropAsset) {
                    addToRecent(dropAsset.id);
                    setStatus('Applied: ' + dropAsset.name);
                    addLog('MOGRT inserted at drop position (' + parsed.count + ' new clip(s))', 'info');
                }
                await endUndoGroup();
            } else if (attempts >= maxAttempts) {
                clearInterval(pollInterval);
                pollInterval = null;
                addLog(dropAsset ? 'MOGRT drop not detected - native .mogrt drop may be unsupported' : 'No new video clip detected - speed not applied', 'info');
                await evalScriptAsync('VT_cancelUndoGroup()');
            }
        } catch (e) {
            if (attempts >= maxAttempts) {
                clearInterval(pollInterval);
                pollInterval = null;
                addLog('Video speed poll failed: ' + e, 'warning');
                await evalScriptAsync('VT_cancelUndoGroup()');
            }
        }
        isProcessing = false;
    }, 150);
}

/**
 * Replace placeholder on timeline with actual asset
 * @param {object} asset - The asset to apply
 * @param {string} placeholderInfo - JSON with placeholder position info
 */
async function replacePlaceholderWithAsset(asset, placeholderInfo) {
    setStatus('Applying "' + asset.name + '" at drop position...');
    addLog('=== Replacing Placeholder with Asset ===', 'info');

    let srcPath = asset.path;
    if (typeof AudioPreview !== 'undefined' && AudioPreview && AudioPreview.asset && AudioPreview.asset.id === asset.id) {
        if (AudioPreview.isProcessing && AudioPreview.processingPromise) {
            setStatus('Rendering pitch accurately with FFmpeg...');
            addLog('Waiting for FFmpeg processing to complete...', 'info');
            setVtBusy(true);
            await AudioPreview.processingPromise;
            setVtBusy(false);
            setStatus('Applying "' + asset.name + '" at drop position...');
        }
        
        if (AudioPreview.processedAudioPath) {
            // The ffmpeg render lives in a temp dir that cleanupTempFiles deletes.
            // Copy it to the permanent dropped folder so the inserted clip keeps its
            // media (no "missing media" once temp is cleaned).
            try {
                if (!fs.existsSync(DROPPED_DIR)) fs.mkdirSync(DROPPED_DIR, { recursive: true });
                const ext = path.extname(AudioPreview.processedAudioPath);
                const permPath = path.join(DROPPED_DIR, 'vt_audio_' + Date.now() + ext);
                fs.copyFileSync(AudioPreview.processedAudioPath, permPath);
                srcPath = permPath;
            } catch (e) {
                srcPath = AudioPreview.processedAudioPath;
                addLog('Could not persist processed audio, using temp: ' + e, 'warning');
            }
        }
    }
    const escapedPath = srcPath.replace(/\\/g, '\\\\');

    try {
        let script;

        const safeplaceholderInfo = placeholderInfo
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'");

        // Build drag options from AudioPreview (speed/reverse; pitch and speed
        // for audio are baked into the FFmpeg render)
        let dragSpeed = 1.0;
        let dragReverse = false;
        if (typeof AudioPreview !== 'undefined' && AudioPreview && AudioPreview.asset && AudioPreview.asset.id === asset.id) {
            dragSpeed = parseFloat(AudioPreview.speed) || 1.0;
            dragReverse = AudioPreview.reverseCheck ? AudioPreview.reverseCheck.checked : false;
        }
        const dragOptionsStr = JSON.stringify({ speed: dragSpeed, reverse: dragReverse });

        if (isMogrtFile(asset.path)) {
            script = `VT_insertMogrtAtPosition("${escapedPath}", (${safeplaceholderInfo}))`;
            addLog('Using MOGRT insert at position');
        } else if (asset.isExternal) {
            script = `VT_insertExternalFile("${escapedPath}", (${safeplaceholderInfo}), ${dragOptionsStr})`;
            addLog('Using external file insert (speed=' + dragSpeed + ' reverse=' + dragReverse + ')');
        } else {
            addLog('Using single-call drag-drop...', 'info');

            try {
                setVtBusy(true);
                await beginUndoGroup();
                // MOGRT assets: native insert at the drop position first
                let ddResult = await tryNativeMogrtInsert(asset, escapedPath, safeplaceholderInfo);
                if (ddResult === null) {
                    // Prime (2-step copy) + focus + verified paste with retries
                    ddResult = await insertWithRetries(escapedPath, (fastOnly) =>
                        evalScriptAsync(`VT_dragDropSingleCall("${escapedPath}", (${safeplaceholderInfo}), "${asset.type}", ${fastOnly ? 'true' : 'false'})`));
                }
                setVtBusy(false);

                addLog('Result: ' + ddResult);

                const ddData = JSON.parse(ddResult);
                if (ddData.success) {
                    addToRecent(asset.id);
                    setStatus('Applied: ' + asset.name);
                    addLog('=== SUCCESS! === (' + (ddData.clipsCount || '?') + ' clips)');
                    await endUndoGroup();
                } else {
                    throw new Error('Drag-drop failed: ' + (ddData.error || 'unknown'));
                }

                setTimeout(() => setStatus('Ready'), 2000);
                return;

            } catch (stepErr) {
                setVtBusy(false);
                addLog('Single-call drag-drop error: ' + stepErr.message, 'error');
                addLog('Trying fallback applyAsset...', 'info');
                try {
                    await applyAsset(asset, true);
                    addLog('=== SUCCESS via fallback! ===');
                    return;
                } catch (fallbackErr) {
                    throw new Error('Drag-drop failed, fallback also failed: ' + stepErr.message);
                }
            }
        }

        // MOGRT and external file paths (single-call, no DLL copy/paste needed)
        if (script) {
            addLog('Executing single-call: ' + script.substring(0, 200) + '...');
            await beginUndoGroup();
            let result = await evalScriptAsync(script);
            addLog('Result: ' + result);

            let insertParsed = null;
            try { insertParsed = JSON.parse(result); } catch (jsonErr) { /* not JSON */ }

            if (insertParsed) {
                if (insertParsed.success) {
                    addToRecent(asset.id);
                    setStatus('Applied: ' + asset.name);
                    addLog('=== SUCCESS! ===');
                    // Remove the leftover vt_drag_* placeholder item from the Project
                    // panel - VT_insertExternalFile (audio/MOGRT) doesn't clean the bin
                    // like the .prproj path (VT_dragDropSingleCall) does.
                    try { await evalScriptAsync('VT_cleanupPlaceholdersFromBin()'); } catch (e) { addLog('Placeholder bin cleanup failed, vt_drag_ items left in Project panel: ' + e, 'error'); }
                    await endUndoGroup();
                } else {
                    addLog('Error in result: ' + (insertParsed.error || 'unknown'));
                    await evalScriptAsync('VT_cancelUndoGroup()');
                    setStatus('Error: ' + (insertParsed.error || 'Failed'));
                }
            } else if (result === 'true') {
                // Legacy boolean success
                addToRecent(asset.id);
                setStatus('Applied: ' + asset.name);
                await endUndoGroup();
            } else {
                addLog('Bad result: ' + result);
                await evalScriptAsync('VT_cancelUndoGroup()');
            }
        }

        setTimeout(() => setStatus('Ready'), 2000);

    } catch (error) {
        addLog('ERROR: ' + error.message, 'error');
        // Failed insert must not leave the placeholder clip or its project item
        // behind - clean both up (AtomX-style: zero leftovers).
        try { await evalScriptAsync('VT_cleanupStrayPlaceholders()'); } catch (clnErr) { addLog('Stray placeholder cleanup failed: ' + clnErr, 'warning'); }
        // Try to read debug log
        try {
            const debugLog = await evalScriptAsync('VT_readDebugLog()');
            try {
                const logData = JSON.parse(debugLog);
                if (logData.lines && logData.lines.length > 0) {
                    addLog('--- DEBUG LOG (crash point) ---');
                    logData.lines.forEach(function (l) { if (l.trim()) addLog('  ' + l); });
                    addLog('--- END DEBUG LOG ---');
                }
            } catch (pe) { addLog('Could not parse the ExtendScript debug log: ' + debugLog, 'error'); }
            await evalScriptAsync('VT_clearDebugLog()');
        } catch (dlErr) { addLog('Could not read the ExtendScript debug log: ' + dlErr, 'error'); }
        setStatus('Error: ' + error.message);
        setTimeout(() => setStatus('Ready'), 3000);
        throw error;
    }
}

/**
 * Helper to Ensure Host Script is Loaded
 */
async function ensureHostScript() {
    // Check if main function exists
    const check = await evalScriptAsync('typeof VT_applyAssetNative');
    if (check !== 'function') {
        addLog('Host script not fully loaded (VT_applyAssetNative type: ' + check + ')', 'warning');
        addLog('Reloading hostscript.jsx...', 'info');

        const scriptPath = extensionDir + '/jsx/hostscript.jsx';
        const loadResult = await evalScriptAsync('$.evalFile("' + scriptPath.replace(/\\/g, '/') + '")');
        addLog('Reload result: ' + loadResult);

        // Force clear old DLL reference to ensure fresh load
        await evalScriptAsync('try { $.global.VT_ExtObj = null; } catch(e) {}');

        // Re-init DLL
        await evalScriptAsync('VT_initExtObj()');

        // Manual definition test
        const manualDef = await evalScriptAsync('function VT_TestManualDef() { return "manual_ok"; }; VT_TestManualDef();');
        addLog('Manual definition test: ' + manualDef);

        // Re-check
        const reCheck = await evalScriptAsync('typeof VT_applyAssetNative');
        addLog('Function status after reload: Native=' + reCheck);
        return (reCheck === 'function');
    }
    // Skip if busy - script already loaded from warmup, DLL alive
    if (isVtBusy()) return true;
    // Ensure DLL is alive (no-op if already loaded, re-inits if Premiere reset it)
    await evalScriptAsync('VT_initExtObj()');
    return true;
}

/**
 * Apply asset to timeline at playhead position
 * Uses Copy/Paste via keyboard simulation
 */
async function applyAsset(asset, keepPendingGroup) {
    setStatus('Applying "' + asset.name + '"...');
    addLog('=== Starting Apply Asset ===', 'info');
    addLog('Asset: ' + asset.name);
    addLog('Path: ' + (asset.path || '(effect JSON)'));

    // Build apply options
    let applySpeed = 1.0;
    let applyReverse = false;
    let srcPath = asset.path;

    if (typeof AudioPreview !== 'undefined' && AudioPreview && AudioPreview.asset && AudioPreview.asset.id === asset.id) {
        applySpeed = parseFloat(AudioPreview.speed) || 1.0;
        applyReverse = AudioPreview.reverseCheck ? AudioPreview.reverseCheck.checked : false;
        
        if (AudioPreview.isProcessing && AudioPreview.processingPromise) {
            setStatus('Rendering pitch accurately with FFmpeg...');
            addLog('Waiting for FFmpeg processing to complete...', 'info');
            setVtBusy(true);
            await AudioPreview.processingPromise;
            setVtBusy(false);
            setStatus('Applying "' + asset.name + '"...');
        }

        if (AudioPreview.processedAudioPath) {
            srcPath = AudioPreview.processedAudioPath;
        }
    }

    if (typeof VideoPreview !== 'undefined' && VideoPreview && VideoPreview.asset && VideoPreview.asset.id === asset.id) {
        applySpeed = parseFloat(VideoPreview.speed) || 1.0;
        applyReverse = VideoPreview.isReversed ? VideoPreview.isReversed() : false;
    }

    const escapedPath = srcPath ? srcPath.replace(/\\/g, '\\\\') : '';

    try {
        const optionsStr = JSON.stringify({
            speed: applySpeed,
            reverse: applyReverse
        });

        // Ensure script is loaded
        if (!(await ensureHostScript())) {
            throw new Error('Host script failed to load function VT_applyAssetNative');
        }

        let result;

        // v3.9.12: always a fresh group. A failed insert used to leave its
        // start index pending, the next double-click reused it, and Ctrl+Z then
        // also took back everything the user did in between.
        // (keepPendingGroup: fallback from a drag - keep the group opened at
        // drag start so the placeholder drop stays inside it)
        await beginUndoGroup(!keepPendingGroup);

        // MOGRT files use sequence.importMGT API
        if (isMogrtFile(asset.path)) {
            addLog('Applying MOGRT with importMGT...');
            result = await evalScriptAsync(`VT_insertMogrt("${escapedPath}")`);
            addLog('Result: ' + result);
        } else if (asset.isExternal) {
            addLog('Applying external file (' + (isAudioFile(asset.path) ? 'audio' : 'video') + ') with speed=' + applySpeed + ' reverse=' + applyReverse);
            const applyOptionsJson = JSON.stringify({ speed: applySpeed, reverse: applyReverse });
            result = await evalScriptAsync(`VT_insertExternalFile("${escapedPath}", null, ${applyOptionsJson})`);
            addLog('Result: ' + result);
        } else {
            // Use native DLL - single call does everything!
            addLog('Applying with native DLL (SAFE)...');

            // The DLL copy/paste is a synthetic Ctrl+C/V that goes to the
            // OS-focused window, so insertWithRetries primes the clipboard in
            // two host calls and moves focus to the timeline (VT_WMCommand
            // focusfix) before every paste; every paste is verified.
            // Use _Safe version to bypass bytecode cache
            // MOGRT assets: native insert first (no clipboard, nothing opened)
            result = (applySpeed === 1 && !applyReverse) ? await tryNativeMogrtInsert(asset, escapedPath, null) : null;
            if (result === null) {
                result = await insertWithRetries(escapedPath, (fastOnly) =>
                    evalScriptAsync(`VT_applyAssetNative_Safe("${escapedPath}", ${JSON.stringify(optionsStr)}, ${fastOnly ? 'true' : 'false'})`));
            }
            addLog('Result: ' + result);
        }

        await endUndoGroup();

        // Try to parse as JSON
        let applyParsed = null;
        try { applyParsed = JSON.parse(result); } catch (jsonErr) { /* not JSON */ }

        if (applyParsed) {
            if (applyParsed.success) {
                addLog('Copy: ' + applyParsed.copyResult + ', Paste: ' + applyParsed.pasteResult + ', Clips: ' + applyParsed.clipsCount);
                setStatus('Applied: ' + asset.name);
                addLog('=== SUCCESS! ===');
                // Real DLL paste success = timeline had focus during the
                // operation. Remember its HWND for future focusfix restores.
                // Nested DOM-fallback success does not prove timeline focus.
                // Only a real clipboard paste proves the timeline had focus.
                // (Remembering after a DOM insert - e.g. an imported .jpg -
                // stored another window, and the next paste went there.)
                if (!applyParsed.nested && applyParsed.pasteResult === true) rememberTimelineFocus();
            } else {
                // Host returned structured failure - show the real error message
                throw new Error(applyParsed.error || ('Apply failed: ' + result));
            }
        } else {
            // Not JSON - legacy true/false or error string
            if (result === 'true') {
                setStatus('Applied: ' + asset.name);
                addLog('=== SUCCESS! ===');
            } else {
                throw new Error(result || 'Unknown error');
            }
        }

        setTimeout(() => setStatus('Ready'), 2000);

    } catch (error) {
        addLog('ERROR: ' + error.message, 'error');
        setStatus('Error: ' + error.message);
        setTimeout(() => setStatus('Ready'), 3000);
        try { await evalScriptAsync('VT_cancelUndoGroup()'); } catch (e) { /* ignore */ }
        throw error; // Re-throw so callers know it failed
    }
}

/**
 * Put a saved (.prproj) asset's clips on the clipboard (v3.9.2, two steps).
 * Step 1 (host) opens the asset sequence with its clips selected; the panel
 * then moves OS focus to the timeline window; step 2 (host) copies and goes
 * back to the user's sequence. Copying in the same host call as the switch
 * often hit the USER's timeline and copied its selected clip - the cause of
 * "double-click inserts a copy of the previous media".
 * Never throws; returns the parsed host result or null.
 * @param {string} escapedAssetPath - asset path with backslashes already doubled
 * @param {boolean} [force] - ignore the existing clipboard cache
 */
async function primeAssetClipboard(escapedAssetPath, force) {
    if (!/\.prproj$/i.test(escapedAssetPath || '')) return null; // only saved timeline assets
    try {
        const d1 = JSON.parse(await evalScriptAsync(`VT_primeOpen("${escapedAssetPath}", ${force ? 'true' : 'false'})`));
        if (!d1.success) {
            addLog('Clipboard prime failed: ' + (d1.error || '?') + ' - full insert path will be used', 'warning');
            return d1;
        }
        if (d1.cached) {
            addLog('Clipboard already primed (' + d1.clips + ' clip(s))', 'info');
            return d1;
        }
        runFocusFix(); // focus the timeline window that now shows the asset sequence
        const d2 = JSON.parse(await evalScriptAsync(`VT_primeCopy("${escapedAssetPath}")`));
        addLog('Clipboard ' + (d2.success ? 'primed' : 'prime FAILED') + ' (' + d2.clips + ' clip(s))', d2.success ? 'info' : 'warning');
        return d2;
    } catch (e) {
        addLog('Clipboard prime error: ' + e, 'warning');
        return null;
    }
}

/**
 * Store one field in an asset's metadata (memory + <ASSETS_DIR>/<id>.json).
 */
function persistAssetField(asset, key, value) {
    asset[key] = value;
    try {
        const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        meta[key] = value;
        fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch (e) {
        addLog('Could not update asset metadata (' + key + '): ' + e, 'warning');
    }
}

/**
 * NATIVE MOGRT INSERT (v3.9.3): a fresh instance of the saved template is put
 * straight onto the track and the saved values are applied - no clipboard,
 * no VT_Asset sequence opened, no playhead move, never a nested sequence.
 * Older MOGRT assets are described on first use and upgraded in place.
 * Returns the raw host result when it handled the insert, or null when the
 * classic (clipboard) path has to be used (not a MOGRT, keyframes, ...).
 * @param {object} asset
 * @param {string} escapedPath - asset path with backslashes doubled
 * @param {string|null} placeholderExpr - drop position object literal, or null = playhead
 */
async function tryNativeMogrtInsert(asset, escapedPath, placeholderExpr) {
    if (!asset || !/\.prproj$/i.test(asset.path || '') || asset.mogrtNative === false) return null;
    const metaArg = asset.mogrtNative ? JSON.stringify(JSON.stringify(asset.mogrtNative)) : '""';
    const phArg = placeholderExpr ? '(' + placeholderExpr + ')' : 'null';
    let d = null;
    let raw = null;
    try {
        raw = await evalScriptAsync(`VT_insertMogrtAsset("${escapedPath}", ${metaArg}, ${phArg})`);
        d = JSON.parse(raw);
    } catch (e) {
        return null; // host older than 3.9.3
    }
    if (d.meta && !asset.mogrtNative) {
        persistAssetField(asset, 'mogrtNative', d.meta);
        addLog('Asset upgraded to native MOGRT insert', 'info');
    }
    if (d.success) {
        addLog('Inserted natively (' + d.clipsCount + ' clip(s), no clipboard, no sequence switch)', 'success');
        return raw;
    }
    if (d.fallback) {
        if (d.reason === 'not-mogrt' || d.reason === 'keyframes') persistAssetField(asset, 'mogrtNative', false);
        addLog('Native MOGRT insert not used (' + (d.reason || '?') + ') - classic path', 'info');
        return null;
    }
    return raw; // hard error (e.g. no active sequence) - report it
}

/**
 * Insert a saved asset through the clipboard fast path, fixing focus or
 * re-priming between attempts (v3.9.2). Every paste is VERIFIED on the host
 * (clip names, durations, parameter values) and wrong content is removed,
 * so a stale clipboard can no longer insert other media.
 * After 3 fast attempts the full host path runs (verified paste, then the
 * nested-sequence fallback with the correct content).
 * @param {string} escapedPath - asset path with backslashes doubled
 * @param {function(boolean): Promise<string>} callHost - runs the host insert (fastOnly)
 * @returns {Promise<string>} raw host result
 */
async function insertWithRetries(escapedPath, callHost) {
    let force = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
        await primeAssetClipboard(escapedPath, force);
        runFocusFix();
        const raw = await callHost(true);
        let d = null;
        try { d = JSON.parse(raw); } catch (e) { /* legacy string result */ }
        if (!d || d.success || !d.retry) return raw;
        // 'reprime' = clipboard held other content. A second 'focus' miss can
        // also mean the copy itself missed (empty clipboard) - re-copy then too.
        force = d.retry === 'reprime' || attempt >= 2;
        addLog('Insert attempt ' + attempt + ': ' + (d.error || d.retry) + ' - ' + (force ? 're-copying asset' : 'refocusing timeline'), 'warning');
    }
    addLog('Fast insert failed 3x - full insert path', 'warning');
    runFocusFix();
    return await callHost(false);
}

/**
 * Promise wrapper for csInterface.evalScript
 */
function evalScriptAsync(script) {
    return new Promise((resolve) => {
        csInterface.evalScript(script, (result) => {
            resolve(result);
        });
    });
}

/**
 * Undo group helpers - wrap multi-step insert ops so one Ctrl+Z collapses them.
 * Collapse itself is event-driven via app.addEventListener('onProjectChanged') in hostscript.
 */
async function beginUndoGroup(force, noWarmup) {
    try {
        const r = await evalScriptAsync('VT_beginUndoGroup(' + (force ? 'true' : 'false') + ', ' + (noWarmup ? 'true' : 'false') + ')');
        const d = JSON.parse(r);
        if (!d.success) addLog('Undo group begin: ' + (d.error || 'failed'), 'warning');
    } catch (e) { /* non-fatal */ }
}
async function endUndoGroup() {
    try {
        const r = await evalScriptAsync('VT_endUndoGroup()');
        const d = JSON.parse(r);
        if (d.success) addLog('Undo group recorded [' + d.group.startIndex + '..' + d.group.endIndex + ']', 'info');
        else addLog('Undo group end: ' + (d.error || 'failed'), 'warning');
    } catch (e) { /* non-fatal */ }
}
async function registerUndoEventListener() {
    try {
        const r = await evalScriptAsync('VT_registerUndoEventListener()');
        addLog('Undo event listener: ' + r, 'info');
    } catch (e) { /* non-fatal */ }
}




/**
 * Show delete confirmation dialog
 * @returns {Promise<boolean>}
 */
function showDeleteDialog(assetName) {
    return new Promise((resolve) => {
        const dialog = document.getElementById('deleteDialog');
        const message = document.getElementById('deleteMessage');
        const confirmBtn = document.getElementById('deleteConfirm');
        const cancelBtn = document.getElementById('deleteCancel');

        if (!dialog) {
            resolve(confirm(`Delete asset "${assetName}"?`));
            return;
        }

        message.textContent = `Are you sure you want to delete "${assetName}"?`;
        dialog.style.display = 'flex';

        const cleanup = () => {
            dialog.style.display = 'none';
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        };

        const onConfirm = () => {
            cleanup();
            resolve(true);
        };

        const onCancel = () => {
            cleanup();
            resolve(false);
        };

        confirmBtn.addEventListener('click', onConfirm);
        cancelBtn.addEventListener('click', onCancel);
    });
}

/**
 * Delete an asset (v3.9.6: straight away, no confirmation)
 */
async function deleteAsset(asset) {
    if (!asset) return;
    await deleteAssetsNow([asset.id]);
}

const PENDING_DELETES_KEY = 'vt_pending_deletes';
const sleepMs = (ms) => new Promise(function (r) { setTimeout(r, ms); });

/**
 * The card's <video>/<audio>/<img> keep the media file open, and Windows
 * refuses to delete an open file (EBUSY/EPERM). That made deleting fail
 * half-way: the .json and .prproj went, the preview .mp4 stayed locked, the
 * error was swallowed and the card stayed on screen - "nothing happens".
 * Let go of every handle on the asset's files before deleting them.
 */
function releaseAssetMedia(asset, files) {
    const cards = [];
    const cached = _cardCache.get(asset.id);
    if (cached) cards.push(cached);
    document.querySelectorAll('.asset-card').forEach(function (c) {
        if (c.dataset.assetId === asset.id && cards.indexOf(c) === -1) cards.push(c);
    });
    const names = files.filter(Boolean).map(function (f) { return path.basename(f).toLowerCase(); });
    const usesFile = function (el) {
        const src = decodeURIComponent(String(el.currentSrc || el.getAttribute('src') || el.getAttribute('data-lazy-src') || '')).toLowerCase();
        return names.some(function (n) { return n && src.indexOf(n) !== -1; });
    };
    const unload = function (el) {
        try { if (typeof el.pause === 'function') el.pause(); } catch (e) { /* ignore */ }
        el.removeAttribute('data-lazy-src');
        el.removeAttribute('src');
        try { if (typeof el.load === 'function') el.load(); } catch (e) { /* ignore */ }
    };
    cards.forEach(function (c) {
        try { _lazyCardObserver.unobserve(c); } catch (e) { /* ignore */ }
        c.querySelectorAll('video, audio, img, source').forEach(unload);
    });
    // Players outside the card (preview bars) that may still hold the file
    document.querySelectorAll('video, audio').forEach(function (el) { if (usesFile(el)) unload(el); });
    try { if (AudioPreview && AudioPreview.hide) AudioPreview.hide(); } catch (e) { /* ignore */ }
    try { if (VideoPreview && VideoPreview.hide) VideoPreview.hide(); } catch (e) { /* ignore */ }
}

/** unlink, retrying while Windows still reports the file as in use. */
async function unlinkWithRetry(file) {
    for (let i = 0; i < 8; i++) {
        try {
            if (!fs.existsSync(file)) return true;
            fs.unlinkSync(file);
            return true;
        } catch (e) {
            const code = (e && e.code) || '';
            if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'EACCES') {
                addLog('Delete: could not remove ' + file + ': ' + e, 'error');
                return false;
            }
            await sleepMs(120 * (i + 1));
        }
    }
    return false;
}

function readPendingDeletes() {
    try { const v = JSON.parse(localStorage.getItem(PENDING_DELETES_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; }
}
function writePendingDeletes(list) {
    try {
        if (list.length) localStorage.setItem(PENDING_DELETES_KEY, JSON.stringify(list));
        else localStorage.removeItem(PENDING_DELETES_KEY);
    } catch (e) { /* storage unavailable */ }
}

/** Files that were still locked last time are removed on the next start. */
function retryPendingDeletes() {
    const left = [];
    readPendingDeletes().forEach(function (f) {
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) { left.push(f); }
    });
    writePendingDeletes(left);
}

/**
 * Files in the assets folder that no asset refers to any more - leftovers of
 * deletes that failed before v3.9.6 (mostly 10 MB preview videos). Only
 * plugin-named files ("asset_<digits>.<ext>") older than 10 minutes, so a save
 * that is still writing its files is never touched.
 */
function sweepOrphanAssetFiles() {
    try {
        if (!fs.existsSync(ASSETS_DIR)) return;
        const files = fs.readdirSync(ASSETS_DIR);
        const ids = new Set();
        const referenced = new Set();
        files.forEach(function (f) {
            if (!/\.json$/i.test(f)) return;
            ids.add(f.replace(/\.json$/i, '').toLowerCase());
            try {
                const meta = JSON.parse(fs.readFileSync(path.join(ASSETS_DIR, f), 'utf8'));
                if (meta.path) {
                    referenced.add(path.basename(meta.path).toLowerCase());
                    referenced.add(path.basename(getPreviewPath(meta.path)).toLowerCase());
                }
            } catch (e) { ids.add('__unreadable__'); }
        });
        if (ids.has('__unreadable__')) return; // never guess when a metadata file is damaged
        const tooNew = Date.now() - 10 * 60 * 1000;
        let removed = 0;
        files.forEach(function (f) {
            const m = /^(asset_\d+(?:_\d+)?)\.(mp4|mov|prproj|mp3|wav|aac|m4a|jpg|jpeg|png|gif|webp)$/i.exec(f);
            if (!m) return;
            if (ids.has(m[1].toLowerCase()) || referenced.has(f.toLowerCase())) return;
            const full = path.join(ASSETS_DIR, f);
            try {
                const st = fs.statSync(full);
                if (!st.isFile() || st.mtimeMs > tooNew) return;
                fs.unlinkSync(full);
                removed++;
            } catch (e) { /* locked or gone - try again next start */ }
        });
        if (removed) addLog('Removed ' + removed + ' leftover file(s) of deleted assets', 'info');
    } catch (e) {
        addLog('Leftover sweep failed: ' + e, 'warning');
    }
}

/**
 * Delete assets immediately: the asset disappears from the panel at once,
 * its metadata goes first, then its media files (with retries while the file
 * is still being released). A file that stays locked is removed on the next
 * panel start instead of blocking the delete.
 */
async function deleteAssetsNow(ids) {
    const list = (ids || []).map(function (id) { return assets.find(function (a) { return a.id === id; }); }).filter(Boolean);
    if (!list.length) return;

    const jobs = [];
    list.forEach(function (asset) {
        const files = [];
        if (asset.path) {
            files.push(asset.path);
            const pv = getPreviewPath(asset.path);
            if (pv && pv !== asset.path) files.push(pv);
        }
        releaseAssetMedia(asset, files);
        const metaPath = path.join(ASSETS_DIR, asset.id + '.json');
        try {
            if (fs.existsSync(metaPath)) fs.unlinkSync(metaPath);
        } catch (e) {
            addLog('Delete: could not remove ' + metaPath + ': ' + e, 'error');
        }
        jobs.push({ asset: asset, files: files });
    });

    // Gone from the panel right away
    const gone = new Set(list.map(function (a) { return a.id; }));
    assets = assets.filter(function (a) { return !gone.has(a.id); });
    gone.forEach(function (id) { invalidateCardCache(id); selectedAssetIds.delete(id); });
    renderAssets();
    setStatus(list.length === 1 ? 'Asset deleted' : ('Deleted ' + list.length + ' assets'));
    addLog(list.length === 1 ? ('Deleted asset: ' + list[0].name) : ('Deleted ' + list.length + ' assets'));

    // Media files: let the player release them, then remove
    await sleepMs(60);
    const stuck = [];
    for (const job of jobs) {
        for (const f of job.files) {
            const ok = await unlinkWithRetry(f);
            if (!ok && fs.existsSync(f)) stuck.push(f);
        }
    }
    if (stuck.length) {
        writePendingDeletes(readPendingDeletes().concat(stuck));
        addLog('Still in use, will be removed on next start: ' + stuck.map(function (f) { return path.basename(f); }).join(', '), 'warning');
    }
}

/**
 * Set status bar text - silently fail if removed
 */
function setStatus(text) {
    if (typeof statusText !== 'undefined' && statusText) {
        statusText.textContent = text;
    }
}

// Allow mouse wheel to adjust any range slider when hovering over it.
// Delegated on document so it covers every input[type=range] (volume,
// speed, pitch, zoom, settings sliders, and any future ones) without
// per-slider wiring. passive:false is required for preventDefault.
document.addEventListener('wheel', function (e) {
    const slider = e.target;
    if (!slider || slider.tagName !== 'INPUT' || slider.type !== 'range') return;
    e.preventDefault();
    const step = parseFloat(slider.step) || 1;
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 100;
    const dir = e.deltaY < 0 ? 1 : -1;
    let val = parseFloat(slider.value) + dir * step;
    val = Math.min(max, Math.max(min, val));
    // Round to step precision to avoid floating-point drift (0.30000000000000004)
    const decimals = (String(step).split('.')[1] || '').length;
    val = parseFloat(val.toFixed(decimals));
    slider.value = val;
    // Fire input (live update) + change (persist) so existing listeners respond
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
}, { passive: false });

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

/**
 * Clean up old temp files to prevent disk usage accumulation
 */
function cleanupTempFiles() {
    try {
        const tempDir1 = VTBK_TEMP_DIR;
        const tempDir2 = require('path').join(require('os').homedir(), 'AppData', 'Roaming', 'VibeTools', 'temp');
        
        const now = Date.now();
        const oneHour = 60 * 60 * 1000;
        
        // DROPPED_DIR also holds orphaned vt_drag_* placeholders after a swap; sweep
        // those too. vt_audio_* there are real, in-use media and never match the filter.
        [tempDir1, tempDir2, DROPPED_DIR].forEach(dir => {
            if (!require('fs').existsSync(dir)) return;
            const files = require('fs').readdirSync(dir);
            files.forEach(file => {
                if (file.startsWith('vt_drag_') || file.startsWith('ffmpeg_')) {
                    const filePath = require('path').join(dir, file);
                    try {
                        const stats = require('fs').statSync(filePath);
                        if (now - stats.mtimeMs > oneHour) {
                            require('fs').unlinkSync(filePath);
                        }
                    } catch (e) { addLog('Could not remove temp file ' + file + ': ' + e, 'error'); }
                }
            });
        });
        addLog('Cleaned up old temporary files', 'info');
    } catch (e) {
        console.error('Error cleaning temp files:', e);
    }
}
