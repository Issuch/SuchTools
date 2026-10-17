/**
 * VibeTools - ExtendScript Host Script
 * Handles Premiere Pro API calls
 */

// JSON polyfill for ExtendScript - MUST BE BEFORE any JSON usage!
if (typeof JSON === 'undefined') {
    JSON = {
        parse: function (str) {
            return eval('(' + str + ')');
        },
        stringify: function (obj) {
            var type = typeof obj;
            if (type !== 'object' || obj === null) {
                if (type === 'string') return '"' + obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
                return String(obj);
            }
            var arr = obj instanceof Array;
            var parts = [];
            for (var k in obj) {
                if (obj.hasOwnProperty(k)) {
                    var v = JSON.stringify(obj[k]);
                    parts.push(arr ? v : '"' + k + '":' + v);
                }
            }
            return arr ? '[' + parts.join(',') + ']' : '{' + parts.join(',') + '}';
        }
    };
}

// DEBUG FILE LOGGER - survives engine crashes where $.writeln doesn't flush
var VT_LOG = Folder.temp + '/vibetool_debug.txt';
function vtLog(msg) {
    try {
        var f = new File(VT_LOG);
        f.open('a');
        f.write(new Date().toTimeString() + ' ' + msg + '\n');
        f.close();
    } catch (e) {} // MUST stay silent - logging here would recurse into vtLog forever
}

// Keep the debug log small (v3.9.2): it grew without limit and every vtLog
// call re-opens it. Above 2 MB it is moved to vibetool_debug.txt.old.
(function () {
    try {
        var lf = new File(VT_LOG);
        if (lf.exists && lf.length > 2 * 1024 * 1024) {
            var oldLog = new File(VT_LOG + '.old');
            if (oldLog.exists) { oldLog.remove(); }
            lf.rename('vibetool_debug.txt.old');
        }
    } catch (rotErr) {}
})();

// VERSION for debugging cache issues - AFTER JSON polyfill!
// Keep in sync with EXPECTED_SCRIPT_VERSION in js/main.js - the panel warns on mismatch.
var VT_SCRIPT_VERSION = '3.9.12'; // presets: apply options, keep text, add missing effects
vtLog('=== SCRIPT LOADED v' + VT_SCRIPT_VERSION + ' ===');

// Max length of the hover preview rendered on save (seconds). Longer assets
// are still saved in full - only the preview .mp4 is shortened.
var VT_PREVIEW_MAX_SECONDS = 10;
// MOGRTs render several times slower than video - shorter preview for them
var VT_PREVIEW_MAX_SECONDS_MOGRT = 5;

// Clip label colors (Premiere label index per asset type)
var LABEL_COLORS = {
    video:       1,  // Iris
    audio:       3,  // Cerulean
    mogrt:       2,  // Rose
    transition:  7,  // Mint
    text:        5,  // Canary
    effect:      6,  // Mango
    overlay:     4,  // Lavender
    background:  8,  // Forest
    other:       0   // None
};

// Name of the bin where imported assets go
var VT_ASSETS_BIN_NAME = 'VibeAssets';

/**
 * Get or create the VibeAssets bin for organizing imported assets
 * @returns {ProjectItem} - The VibeAssets bin
 */
function VT_getOrCreateAssetsBin() {
    var rootItem = app.project.rootItem;

    // Search for existing bin
    for (var i = 0; i < rootItem.children.numItems; i++) {
        var child = rootItem.children[i];
        if (child.type === 2 && child.name === VT_ASSETS_BIN_NAME) { // type 2 = bin
            return child;
        }
    }

    // Create new bin if not found
    return rootItem.createBin(VT_ASSETS_BIN_NAME);
}

/**
 * Delete the VibeAssets bin when it is empty. After every insert the imported
 * asset sequence is purged, so without this the bin would linger forever as
 * an empty folder in the Project panel.
 */
function VT_cleanupEmptyAssetsBin() {
    try {
        var ri = app.project.rootItem;
        for (var i = ri.children.numItems - 1; i >= 0; i--) {
            var child = ri.children[i];
            if (child.type === 2 && child.name === VT_ASSETS_BIN_NAME && child.children.numItems === 0) {
                try { child.deleteBin(); vtLog('VIBE-BIN: removed empty VibeAssets bin'); } catch (delErr) { vtLog('VIBE-BIN: empty bin delete failed: ' + delErr); }
                break;
            }
        }
    } catch (e) { vtLog('VIBE-BIN: cleanup error: ' + e); }
}

/**
 * Project item for a media file, for inserting it (v3.9.10).
 * Reuses the item when the file is already anywhere in the project (no
 * duplicate imports); otherwise imports it into the project ROOT - the same
 * place Premiere's own drag & drop puts it - instead of a VibeAssets bin.
 */
function VT_getMediaItem(filePath) {
    var item = null;
    try { item = VT_findItemByMediaPath(filePath); } catch (fErr) { item = null; }
    if (item) {
        vtLog('VT_getMediaItem: reusing project item ' + item.name);
        return item;
    }
    var root = app.project.rootItem;
    var before = {};
    var i;
    for (i = 0; i < root.children.numItems; i++) before[root.children[i].nodeId] = true;
    app.project.importFiles([filePath], true, root, false);
    var key = VT_normPath(filePath);
    var fallback = null;
    for (i = root.children.numItems - 1; i >= 0; i--) {
        var ch = root.children[i];
        if (before[ch.nodeId] || ch.type === 2) continue;
        var mp = '';
        try { mp = VT_normPath(ch.getMediaPath()); } catch (mpErr) { }
        if (mp === key) { item = ch; break; }
        if (!fallback) fallback = ch;
    }
    if (!item) item = fallback;
    if (item) {
        try { VT_rememberItem(filePath, item); } catch (rmErr) { }
        vtLog('VT_getMediaItem: imported ' + item.name + ' into the project root');
    }
    return item;
}

/**
 * Read the source frame size of a QE track item.
 * @return {Object|null} {width, height}, or null when it can't be determined
 */
function VT_readQeClipSize(qeClip) {
    try {
        var projItem = qeClip.getProjectItem();
        if (!projItem || !projItem.clip) return null;
        var w = projItem.clip.videoFrameWidth;
        var h = projItem.clip.videoFrameHeight;
        if (!w || !h) return null;
        return { width: w, height: h };
    } catch (e) {
        return null;
    }
}

/**
 * Resolve a track item's source frame size via QE.
 * Matches on start time first (unique within a sequence) and only falls back
 * to a name match, so two clips sharing a name can't hand back each other's
 * dimensions.
 * @return {Object|null} {width, height}, or null when it can't be determined
 */
function VT_getClipFrameSize(clip) {
    if (typeof qe === 'undefined' || !qe || !qe.project) return null;

    var clipStart = NaN;
    try { clipStart = parseInt(String(clip.start.ticks), 10); } catch (e) { }

    try {
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return null;

        var nameMatch = null;
        for (var t = 0; t < qeSeq.numVideoTracks; t++) {
            var track = qeSeq.getVideoTrackAt(t);
            if (!track) continue;
            for (var c = 0; c < track.numItems; c++) {
                var qeClip = track.getItemAt(c);
                if (!qeClip || qeClip.type === 'Empty') continue;
                if (qeClip.name !== clip.name) continue;

                var size = VT_readQeClipSize(qeClip);
                if (!size) continue;

                if (!isNaN(clipStart)) {
                    var qeStart = NaN;
                    try { qeStart = parseInt(String(qeClip.start.ticks || qeClip.start), 10); } catch (e2) { }
                    if (!isNaN(qeStart) && Math.abs(qeStart - clipStart) < 100) return size;
                }
                if (!nameMatch) nameMatch = size;
            }
        }
        return nameMatch;
    } catch (qeErr) {
        vtLog('VT_getClipFrameSize: QE error: ' + qeErr);
        return null;
    }
}

/**
 * Scale clips to fit inside the sequence frame (whole picture visible).
 *
 * Only clips whose Scale is still untouched (exactly 100%, no keyframes) are
 * adjusted. An asset saved as a deliberately composed element - a PiP in the
 * corner, an animated scale ramp - keeps the look it was saved with, which is
 * the whole point of storing assets as real project fragments.
 *
 * When the source size can't be determined the clip is left alone rather than
 * scaled against a guessed 1080p, which used to silently mangle 4K assets.
 *
 * @param {Array} clips - Array of clips to scale
 * @param {Sequence} seq - Target sequence
 */
function VT_scaleClipsToFit(clips, seq) {
    if (!clips || !seq) return;

    var seqWidth = seq.frameSizeHorizontal;
    var seqHeight = seq.frameSizeVertical;
    if (!seqWidth || !seqHeight) {
        vtLog('VT_scaleClipsToFit: unknown sequence frame size, skipping');
        return;
    }

    var clipCount = 0;
    try { clipCount = clips.length; } catch (lenErr) { }

    vtLog('VT_scaleClipsToFit: Sequence size = ' + seqWidth + 'x' + seqHeight + ', clips = ' + clipCount);
    if (!clipCount) {
        vtLog('VT_scaleClipsToFit: nothing to scale (empty clip list)');
        return;
    }

    for (var i = 0; i < clips.length; i++) {
        var clip = clips[i];
        if (!clip) continue;

        var clipName = '?';
        try { clipName = clip.name; } catch (nameErr) { }

        try {
            if (!clip.components) {
                vtLog('VT_scaleClipsToFit: ' + clipName + ' has no components, skipping');
                continue;
            }

            // MOGRTs build themselves at sequence size - nothing to fit.
            // Adjustment layers deliberately are NOT skipped: one authored in a
            // 1080p project covers only the middle of a 4K frame, which is
            // precisely the case scale-to-fit exists for.
            if (clip.isMGT && clip.isMGT()) {
                vtLog('VT_scaleClipsToFit: ' + clipName + ' is a MOGRT, skipping');
                continue;
            }

            // Find Motion/Scale first - audio clips and anything without it
            // drop out here before we do any measuring work.
            var scaleProperty = null;
            var effects = clip.components;
            for (var e = 0; e < effects.numItems; e++) {
                if (effects[e].matchName === 'AE.ADBE Motion') {
                    scaleProperty = effects[e].properties[1]; // Scale
                    break;
                }
            }
            if (!scaleProperty) {
                vtLog('VT_scaleClipsToFit: ' + clipName + ' has no Motion/Scale, skipping');
                continue;
            }

            // Keyframed Scale is the user's animation - never overwrite it.
            try {
                if (scaleProperty.isTimeVarying && scaleProperty.isTimeVarying()) {
                    vtLog('VT_scaleClipsToFit: ' + clipName + ' has keyframed Scale, skipping');
                    continue;
                }
            } catch (kfErr) { }

            // A Scale other than 100% was set on purpose - leave it.
            try {
                var currentScale = scaleProperty.getValue();
                if (currentScale !== null && typeof currentScale !== 'undefined' &&
                    Math.abs(currentScale - 100) > 0.01) {
                    vtLog('VT_scaleClipsToFit: ' + clipName + ' Scale=' + currentScale + '% was set deliberately, skipping');
                    continue;
                }
            } catch (cvErr) { }

            var dims = VT_getClipFrameSize(clip);
            if (!dims) {
                vtLog('VT_scaleClipsToFit: ' + clipName + ' source size unknown, skipping (no guess)');
                continue;
            }

            // v3.9.6: "fit" - the whole frame stays visible (bars where the
            // aspect differs), exactly like Premiere's own drag & drop. It used
            // to "cover" (fill and crop), so double-click and drag looked different.
            var targetScale = Math.min(seqWidth / dims.width, seqHeight / dims.height) * 100;
            if (Math.abs(targetScale - 100) < 0.01) continue; // already fits

            scaleProperty.setValue(targetScale, true);
            vtLog('VT_scaleClipsToFit: ' + clipName + ' (' + dims.width + 'x' + dims.height + ') -> scale ' + Math.round(targetScale) + '%');
        } catch (clipErr) {
            vtLog('VT_scaleClipsToFit: Error scaling clip: ' + clipErr);
        }
    }
}

/**
 * Warmup function to force ExtendScript JIT compilation of critical paths
 * This runs through all critical code WITHOUT side effects to ensure first real call works
 * @returns {string} - JSON with warmup status
 */
function VT_warmupCriticalPaths() {
    var status = {
        jsonOk: false,
        timeOk: false,
        seqOk: false,
        dllOk: false,
        parseOk: false,
        version: VT_SCRIPT_VERSION
    };

    try {
        // 1. Test JSON stringify/parse (critical for parameter passing)
        var testObj = { test: 123, str: "hello", arr: [1, 2, 3] };
        var jsonStr = JSON.stringify(testObj);
        var parsed = JSON.parse(jsonStr);
        status.jsonOk = (parsed.test === 123);

        // 2. Test Time object (critical for setPlayerPosition)
        try {
            var t = new Time();
            t.seconds = 10.5;
            var ticks = t.ticks;
            status.timeOk = (ticks > 0 || ticks === 0);
        } catch (timeErr) {
            status.timeOk = false;
        }

        // 3. Test sequence access (critical for VT_replacePlaceholderWithAsset)
        try {
            var seq = app.project.activeSequence;
            status.seqOk = (seq !== null && seq !== undefined);
            if (seq) {
                // Access properties to force them to be compiled
                var numV = seq.videoTracks.numTracks;
                var numA = seq.audioTracks.numTracks;
                var seqId = seq.sequenceID;
            }
        } catch (seqErr) {
            status.seqOk = false;
        }

        // 4. Test DLL initialization
        status.dllOk = VT_initExtObj();

        // 5. Test parseInt/parseFloat (critical for position handling)
        var testTicks = parseInt("12345678901234", 10);
        var testSeconds = parseFloat("123.456");
        status.parseOk = (!isNaN(testTicks) && !isNaN(testSeconds));

        // 6. Project root reachable. v3.9.10: no longer creates the VibeAssets
        // bin here - it used to appear in every project just by opening the panel.
        status.binOk = false;
        try {
            var rootChk = app.project.rootItem;
            status.binOk = !!(rootChk && rootChk.children);
        } catch (binErr) {
            status.binOk = false;
            vtLog('VT_warmupCriticalPaths: bin warmup failed: ' + binErr);
        }

        // 7. Check DLL is loaded (but DON'T call it - that crashes on first use!)
        // The main function VT_replacePlaceholderWithAsset will handle DLL calls
        // with its own retry logic
        status.cmdOk = false;
        try {
            // Just check the ExternalObject exists and DLL is loaded
            status.cmdOk = VT_initExtObj();
            vtLog('VT_warmupCriticalPaths: DLL loaded = ' + status.cmdOk);
        } catch (cmdErr) {
            vtLog('VT_warmupCriticalPaths: DLL check error: ' + cmdErr);
            status.cmdOk = false;
        }

        // 8. Access app.project.sequences (used for finding imported sequence)
        status.seqListOk = false;
        try {
            var numSeqs = app.project.sequences.numSequences;
            status.seqListOk = (numSeqs >= 0);
        } catch (seqListErr) {
            status.seqListOk = false;
        }

        // 9. Test QE access
        status.qeOk = false;
        try {
            if (typeof qe !== 'undefined' && qe && qe.project) {
                var qeSeq = qe.project.getActiveSequence();
                status.qeOk = (qeSeq !== null && qeSeq !== undefined);
            }
        } catch (qeErr) {
            status.qeOk = false;
        }

    } catch (e) {
        vtLog('VT_warmupCriticalPaths error: ' + e);
    }

    vtLog('VT_warmupCriticalPaths: ' + JSON.stringify(status));
    return JSON.stringify(status);
}

/**
 * Get script version to verify Premiere is loading the correct code
 */
function VT_getVersion() {
    // Use simple string concatenation to avoid any JSON issues
    return '{"version":"' + VT_SCRIPT_VERSION + '","message":"ExtendScript loaded OK!"}';
}

/**
 * Test what methods are available on QE objects
 * Looking for executeCommand or similar
 */
function VT_testQEMethods() {
    var result = {
        qeAvailable: false,
        qeMethods: [],
        qeProjectMethods: [],
        qeSeqMethods: [],
        appMethods: [],
        interestingMethods: []
    };

    try {
        // Check app object for executeCommand/menuCommand
        if (typeof app !== 'undefined' && app) {
            for (var a in app) {
                if (a.toLowerCase().indexOf('command') !== -1 ||
                    a.toLowerCase().indexOf('execute') !== -1 ||
                    a.toLowerCase().indexOf('menu') !== -1 ||
                    a.toLowerCase().indexOf('paste') !== -1) {
                    result.appMethods.push(a);
                    result.interestingMethods.push('app.' + a);
                }
            }
        }

        // Check if qe exists
        if (typeof qe !== 'undefined' && qe) {
            result.qeAvailable = true;

            // Get methods on qe object
            for (var k in qe) {
                result.qeMethods.push(k);
                if (k.toLowerCase().indexOf('command') !== -1 ||
                    k.toLowerCase().indexOf('execute') !== -1 ||
                    k.toLowerCase().indexOf('paste') !== -1) {
                    result.interestingMethods.push('qe.' + k);
                }
            }

            // Get methods on qe.project
            if (qe.project) {
                for (var p in qe.project) {
                    result.qeProjectMethods.push(p);
                    if (p.toLowerCase().indexOf('command') !== -1 ||
                        p.toLowerCase().indexOf('execute') !== -1 ||
                        p.toLowerCase().indexOf('paste') !== -1) {
                        result.interestingMethods.push('qe.project.' + p);
                    }
                }

                // Get methods on active sequence
                try {
                    var qeSeq = qe.project.getActiveSequence();
                    if (qeSeq) {
                        for (var s in qeSeq) {
                            result.qeSeqMethods.push(s);
                            if (s.toLowerCase().indexOf('command') !== -1 ||
                                s.toLowerCase().indexOf('execute') !== -1 ||
                                s.toLowerCase().indexOf('paste') !== -1) {
                                result.interestingMethods.push('qeSeq.' + s);
                            }
                        }
                    }
                } catch (seqErr) {
                    result.qeSeqMethods.push('ERROR: ' + seqErr);
                }
            }
        }
    } catch (e) {
        result.error = e.toString();
    }

    return JSON.stringify(result);
}



// ========================================
// Native ExternalObject DLL for Commands
// Use $.global to persist ExternalObject reference across script reloads
// This is critical - ExternalObject can only be loaded once per session
// Safe initialization - check $.global exists first
try {
    if (typeof $.global === 'undefined') {
        $.global = {};
    }
    if (typeof $.global.VT_ExtObj === 'undefined') {
        $.global.VT_ExtObj = null;
    }
} catch (globalErr) {
    // $.global failed - engine not ready, will retry on next call
}
var VT_ExtensionPath = null;

/**
 * Get the extension root path
 */
function VT_getExtensionPath() {
    if (VT_ExtensionPath) return VT_ExtensionPath;

    // Try different methods to get extension path
    var scriptPath = $.fileName;
    vtLog('VT_getExtensionPath: $.fileName = ' + scriptPath);

    if (scriptPath && scriptPath.indexOf('jsx') !== -1) {
        // Remove /jsx/hostscript.jsx from end
        VT_ExtensionPath = scriptPath.replace(/[\\\/]jsx[\\\/][^\\\/]+$/, '');

        // Decode URL encoding (%20 -> space, etc)
        VT_ExtensionPath = decodeURI(VT_ExtensionPath);

        // Convert URL-style path to Windows path
        // /c/Program Files -> C:/Program Files
        if (VT_ExtensionPath.match(/^\/[a-zA-Z]\//)) {
            var driveLetter = VT_ExtensionPath.charAt(1).toUpperCase();
            VT_ExtensionPath = driveLetter + ':' + VT_ExtensionPath.substring(2);
        }
    } else {
        // Fallback: hardcode path
        VT_ExtensionPath = 'C:/Program Files (x86)/Common Files/Adobe/CEP/extensions/VibeTool';
    }

    vtLog('VT_getExtensionPath: Extension path = ' + VT_ExtensionPath);
    return VT_ExtensionPath;
}

/**
 * Get path to our DLL
 */
function VT_getDllPath() {
    var extPath = VT_getExtensionPath();

    if ($.os.indexOf('Windows') !== -1) {
        return extPath.replace(/\\/g, '/') + '/support_files/VT_ExternalObject';
    } else {
        return extPath + '/support_files/VT_ExternalObject';
    }
}

/**
 * Test function to debug DLL loading
 */
function VT_testDllPath() {
    var dllPath = VT_getDllPath();
    var fullPath = dllPath + '.dll';
    var testFile = new File(fullPath);

    return JSON.stringify({
        scriptPath: $.fileName,
        extensionPath: VT_getExtensionPath(),
        dllPath: dllPath,
        fullPath: fullPath,
        exists: testFile.exists
    });
}

/**
 * Initialize the ExternalObject DLL
 * Handles cold start scenario where $.global may not be fully ready
 */
function VT_initExtObj() {
    vtLog('VT_initExtObj: Starting...');
    try {
        if ($.global.VT_ExtObj) {
            var hasCmd = (typeof $.global.VT_ExtObj.doCommand === 'function');
            vtLog('VT_initExtObj: Already exists, doCommand=' + hasCmd);
            return hasCmd;
        }
        var dllPath = VT_getDllPath();
        vtLog('VT_initExtObj: Loading DLL from ' + dllPath);
        $.global.VT_ExtObj = new ExternalObject('lib:' + dllPath);
        if (!$.global.VT_ExtObj || typeof $.global.VT_ExtObj.doCommand !== 'function') {
            vtLog('VT_initExtObj: doCommand not found');
            return false;
        }
        vtLog('VT_initExtObj: DLL loaded OK (persistent)');
        return true;
    } catch (e) {
        vtLog('VT_initExtObj ERROR: ' + e);
        return false;
    }
}

/**
 * Execute a command via native DLL
 * @param {string} command - Command to execute (e.g. 'cmd.edit.copy', 'cmd.edit.paste')
 * @returns {boolean} - true on success, false on failure
 */
/**
 * After cmd.edit.paste the timeline does NOT update instantly - the clip count
 * is still stale for a few frames. Reading it immediately makes us think the
 * paste produced 0 clips (that's why an asset could save empty, or an insert
 * could report clipsCount:0 while paste=true). Poll until clips appear or the
 * bounded timeout is reached. Returns the number of clips in the sequence.
 */
function VT_countSequenceClips(seq) {
    var n = 0;
    for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) n += seq.videoTracks[vt].clips.numItems;
    for (var at = 0; at < seq.audioTracks.numTracks; at++) n += seq.audioTracks[at].clips.numItems;
    return n;
}

// Identify the bundled seed clip by media path, never by track position.
// Position-based capture (clips[0]) breaks when a paste lands on V1 or
// reorders tracks: we then removed the USER's clip and exported the fire
// VideoSample instead - which showed up as a junk fire .mp4 when applying
// the saved asset.
function VT_isVideoSampleClip(clip) {
    try {
        if (!clip || !clip.projectItem) return false;
        var mp = clip.projectItem.getMediaPath();
        return mp && mp.indexOf('VideoSampleLong') >= 0;
    } catch (e) {
        return false;
    }
}

// Sweep all tracks and remove every VideoSample clip found by media path.
// Returns the number of clips removed.
function VT_removeVideoSampleClips(seq) {
    var removed = 0;
    for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
        var track = seq.videoTracks[vt];
        for (var ci = track.clips.numItems - 1; ci >= 0; ci--) {
            if (VT_isVideoSampleClip(track.clips[ci])) {
                try { track.clips[ci].remove(false, false); removed++; vtLog('VT_removeVideoSampleClips: removed video V' + (vt + 1)); }
                catch (e) { vtLog('VT_removeVideoSampleClips: video remove failed: ' + e); }
            }
        }
    }
    for (var at = 0; at < seq.audioTracks.numTracks; at++) {
        var aTrack = seq.audioTracks[at];
        for (var ai = aTrack.clips.numItems - 1; ai >= 0; ai--) {
            if (VT_isVideoSampleClip(aTrack.clips[ai])) {
                try { aTrack.clips[ai].remove(false, false); removed++; vtLog('VT_removeVideoSampleClips: removed audio A' + (at + 1)); }
                catch (e) { vtLog('VT_removeVideoSampleClips: audio remove failed: ' + e); }
            }
        }
    }
    return removed;
}

function VT_waitForPaste(seq, baselineCount, timeoutMs) {
    if (!timeoutMs) timeoutMs = 800;
    var waited = 0;
    var last = VT_countSequenceClips(seq);
    while (last <= baselineCount && waited < timeoutMs) {
        $.sleep(40);
        waited += 40;
        last = VT_countSequenceClips(seq);
    }
    vtLog('VT_waitForPaste: baseline=' + baselineCount + ' final=' + last + ' after ' + waited + 'ms');
    return last;
}

/**
 * Return the clips present in seq that were NOT in the clipsBefore snapshot
 * (i.e. the clips a paste just produced).
 */
function VT_collectNewClips(seq, clipsBefore) {
    var found = [];
    var vt, c, tr, clip;
    // When the snapshot was taken with VT_snapshotClips, ignore SPLIT
    // REMAINDERS: a paste that overwrites the middle of an existing clip makes
    // Premiere cut it, and the tail becomes a new track item (new nodeId) with
    // the old clip's name and END. It is the user's clip, not pasted content -
    // treating it as pasted made verification fail and could delete it.
    var tails = clipsBefore && clipsBefore.__tails ? clipsBefore.__tails : null;
    function isTail(kind, ti, cl) {
        if (!tails) return false;
        try {
            var key = kind + ti + '|' + (cl.name || '') + '|' + String(cl.end.ticks);
            var origStart = tails[key];
            return origStart !== undefined && Number(origStart) < Number(cl.start.ticks);
        } catch (e) { return false; }
    }
    for (vt = 0; vt < seq.videoTracks.numTracks; vt++) {
        tr = seq.videoTracks[vt];
        for (c = 0; c < tr.clips.numItems; c++) {
            clip = tr.clips[c];
            if (!clipsBefore[clip.nodeId] && !isTail('V', vt, clip)) found.push(clip);
        }
    }
    for (vt = 0; vt < seq.audioTracks.numTracks; vt++) {
        tr = seq.audioTracks[vt];
        for (c = 0; c < tr.clips.numItems; c++) {
            clip = tr.clips[c];
            if (!clipsBefore[clip.nodeId] && !isTail('A', vt, clip)) found.push(clip);
        }
    }
    return found;
}

/**
 * Snapshot of the clips in seq before a paste: nodeId -> true, plus an index
 * (__tails) used by VT_collectNewClips to recognise split remainders.
 */
function VT_snapshotClips(seq) {
    var snap = { __tails: {} };
    var t, c, cl;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
        for (c = 0; c < seq.videoTracks[t].clips.numItems; c++) {
            cl = seq.videoTracks[t].clips[c];
            snap[cl.nodeId] = true;
            try { snap.__tails['V' + t + '|' + (cl.name || '') + '|' + String(cl.end.ticks)] = String(cl.start.ticks); } catch (e1) {}
        }
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
        for (c = 0; c < seq.audioTracks[t].clips.numItems; c++) {
            cl = seq.audioTracks[t].clips[c];
            snap[cl.nodeId] = true;
            try { snap.__tails['A' + t + '|' + (cl.name || '') + '|' + String(cl.end.ticks)] = String(cl.start.ticks); } catch (e2) {}
        }
    }
    return snap;
}

/**
 * Poll until a paste lands (new clips appear) or timeoutMs elapses.
 * Returns the new clips (empty array on timeout).
 */
function VT_waitForNewClips(seq, clipsBefore, timeoutMs, restoreTicks) {
    var waited = 0;
    var found = VT_collectNewClips(seq, clipsBefore);
    while (found.length === 0 && waited < timeoutMs) {
        $.sleep(40);
        waited += 40;
        found = VT_collectNewClips(seq, clipsBefore);
    }
    // Premiere's Paste parks the playhead at the END of the pasted clips.
    // Put it back the moment the paste is detected (before the settle wait),
    // so the jump is as short as possible.
    if (found.length > 0 && restoreTicks !== undefined && restoreTicks !== null) {
        try { seq.setPlayerPosition(String(restoreTicks)); } catch (rpErr) { vtLog('VT_waitForNewClips: playhead restore warn: ' + rpErr); }
    }
    // A multi-clip paste lands over a few frames: once the first clip shows up,
    // keep polling until the count holds steady (max +200 ms) so selection,
    // labels and scale-to-fit see EVERY pasted clip, not just the first one.
    if (found.length > 0) {
        var settle = 0;
        var stableFor = 0;
        while (stableFor < 2 && settle < 200) {
            $.sleep(40);
            settle += 40;
            var again = VT_collectNewClips(seq, clipsBefore);
            if (again.length === found.length) { stableFor++; } else { stableFor = 0; found = again; }
        }
        waited += settle;
    }
    vtLog('VT_waitForNewClips: new=' + found.length + ' after ' + waited + 'ms');
    return found;
}

/**
 * Snapshot every clip nodeId in seq (video + audio) as a lookup map.
 */
function VT_snapshotNodeIds(seq) {
    var ids = {};
    var t, c;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
        for (c = 0; c < seq.videoTracks[t].clips.numItems; c++) { ids[seq.videoTracks[t].clips[c].nodeId] = true; }
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
        for (c = 0; c < seq.audioTracks[t].clips.numItems; c++) { ids[seq.audioTracks[t].clips[c].nodeId] = true; }
    }
    return ids;
}

/**
 * Remove every clip of seq whose nodeId is in the idMap. Returns the count removed.
 */
function VT_removeClipsByNodeIds(seq, idMap) {
    var removed = 0;
    var t, c, tr;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
        tr = seq.videoTracks[t];
        for (c = tr.clips.numItems - 1; c >= 0; c--) {
            if (idMap[tr.clips[c].nodeId]) {
                try { tr.clips[c].remove(false, false); removed++; } catch (rv) { vtLog('VT_removeClipsByNodeIds: video remove failed: ' + rv); }
            }
        }
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
        tr = seq.audioTracks[t];
        for (c = tr.clips.numItems - 1; c >= 0; c--) {
            if (idMap[tr.clips[c].nodeId]) {
                try { tr.clips[c].remove(false, false); removed++; } catch (ra) { vtLog('VT_removeClipsByNodeIds: audio remove failed: ' + ra); }
            }
        }
    }
    return removed;
}

/**
 * Poll until the sequence clip count stops changing (max timeoutMs).
 * Returns the final count.
 */
function VT_waitForStableCount(seq, lastCount, timeoutMs) {
    var waited = 0;
    var stableFor = 0;
    while (stableFor < 2 && waited < timeoutMs) {
        $.sleep(40);
        waited += 40;
        var n = VT_countSequenceClips(seq);
        if (n === lastCount) { stableFor++; } else { stableFor = 0; lastCount = n; }
    }
    return lastCount;
}

/**
 * Remove the cached imported sequence of an asset after a successful
 * clipboard paste (zero-artifact rule: no VT_Asset_* left in the project).
 * Pasted clips reference media items, not the sequence, so this is safe.
 */
/**
 * PLAYHEAD LOCK (v3.9.1): the panel calls VT_capturePlayhead() when a drag
 * starts, i.e. before anything touches the timeline. The insert restores that
 * exact position afterwards, so the playhead ends where the user left it.
 */
function VT_capturePlayhead() {
    try {
        var s = app.project.activeSequence;
        if (!s) { $.global.VT_PlayheadLock = null; return 'false'; }
        $.global.VT_PlayheadLock = { seqId: s.sequenceID, ticks: String(s.getPlayerPosition().ticks), at: new Date().getTime() };
        vtLog('PLAYHEAD: captured ' + $.global.VT_PlayheadLock.ticks);
        return 'true';
    } catch (e) {
        vtLog('PLAYHEAD: capture error: ' + e);
        return 'false';
    }
}

/**
 * Return the captured playhead for seq (if captured < 2 min ago on the same
 * sequence) and clear the lock; otherwise return fallbackTicks.
 */
function VT_takeLockedPlayhead(seq, fallbackTicks) {
    try {
        var lock = $.global.VT_PlayheadLock;
        $.global.VT_PlayheadLock = null;
        if (lock && seq && lock.seqId === seq.sequenceID && (new Date().getTime() - lock.at) < 120000) {
            return lock.ticks;
        }
    } catch (e) {}
    return fallbackTicks;
}

/**
 * CLIP SIGNATURE (v3.9.2): name + duration + the static (non-keyframed)
 * values of every effect except Motion/Opacity. Two saved assets built
 * from the same MOGRT template ("Minimal Title_02" with different text)
 * share the clip NAME, so a name check alone let a stale clipboard insert
 * the wrong title. The signature tells them apart.
 */
function VT_clipSignature(clip) {
    // "base" (name + duration) || parameter values
    var base = '';
    try { base = (clip.name || ''); } catch (nErr) {}
    try { base += '|' + String(Math.round((clip.end.seconds - clip.start.seconds) * 100)); } catch (dErr) { base += '|?'; }
    var parts = [];
    try {
        var comps = clip.components;
        var budget = 80;
        for (var ci = 0; comps && ci < comps.numItems && budget > 0; ci++) {
            var comp = comps[ci];
            if (!comp) continue;
            var mn = comp.matchName || comp.displayName || '';
            // Motion/Opacity: scale-to-fit may touch them right after a paste
            if (mn === 'AE.ADBE Motion' || mn === 'AE.ADBE Opacity') continue;
            for (var pi = 0; pi < comp.properties.numItems && budget > 0; pi++) {
                var prop = comp.properties[pi];
                try { if (prop.isTimeVarying && prop.isTimeVarying()) continue; } catch (tvErr) {}
                var v;
                try { v = prop.getValue(); } catch (gvErr) { continue; }
                var t = typeof v;
                if (t === 'number') { v = String(Math.round(v * 1000) / 1000); }
                else if (t === 'string') {
                    // GUIDs inside MOGRT values can be per-instance - ignore them
                    v = v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'G');
                    v = v.length > 400 ? v.substring(0, 400) : v;
                }
                else if (t === 'boolean') { v = v ? '1' : '0'; }
                else if (v instanceof Array) {
                    var arr = [];
                    for (var k = 0; k < v.length && k < 8; k++) { arr.push(typeof v[k] === 'number' ? String(Math.round(v[k] * 1000) / 1000) : String(v[k])); }
                    v = arr.join(',');
                } else { continue; }
                parts.push(mn + '#' + pi + '=' + v);
                budget--;
            }
        }
    } catch (cErr) {}
    return base + '||' + parts.join('|');
}

function VT_sigBase(sig) {
    var i = sig.indexOf('||');
    return i >= 0 ? sig.substring(0, i) : sig;
}

/**
 * Remember the content of the last paste that was VERIFIED as correct: when a
 * later copy misses, this is exactly what the stale clipboard still holds.
 */
function VT_markVerified(sigs) {
    try { $.global.VT_LastVerifiedSigs = sigs ? sigs.slice().sort().join('\n') : ''; } catch (e) {}
}

function VT_clipSignatures(clips) {
    var sigs = [];
    for (var i = 0; i < clips.length; i++) { sigs.push(VT_clipSignature(clips[i])); }
    return sigs;
}

/**
 * Do the clips a paste produced match the expected asset clips?
 * expected = { names: [...], sigs: [...] } (sigs optional for old caches).
 * Returns '' when they match, otherwise a short reason for the log.
 */
function VT_pasteMismatch(newClips, expected) {
    if (!expected || !expected.names || expected.names.length === 0) return 'no expected clips';
    if (newClips.length !== expected.names.length) {
        return 'count ' + newClips.length + ' != ' + expected.names.length;
    }
    if (expected.sigs && expected.sigs.length === expected.names.length) {
        var got = VT_clipSignatures(newClips).sort();
        var want = expected.sigs.slice().sort();
        var i;
        // 1) name + duration must match exactly
        var gotBase = [], wantBase = [];
        for (i = 0; i < got.length; i++) { gotBase.push(VT_sigBase(got[i])); wantBase.push(VT_sigBase(want[i])); }
        gotBase.sort(); wantBase.sort();
        for (i = 0; i < gotBase.length; i++) {
            if (gotBase[i] !== wantBase[i]) return 'clip "' + gotBase[i] + '" is not in the asset';
        }
        // 2) parameter values: identical = certainly this asset
        if (got.join('\n') === want.join('\n')) return '';
        // 3) different values and IDENTICAL to the previously inserted content:
        //    the copy missed and the clipboard still holds the previous asset
        //    (same template, other text). Otherwise accept - some values can
        //    legitimately differ per instance.
        if ($.global.VT_LastVerifiedSigs && got.join('\n') === $.global.VT_LastVerifiedSigs) {
            return 'clipboard still holds the previously inserted asset (same template, other parameters)';
        }
        vtLog('VERIFY: parameter values differ from the saved asset - accepted (name/duration match)');
        return '';
    }
    var names = [];
    for (var n = 0; n < newClips.length; n++) { names.push(newClips[n].name || ''); }
    names.sort();
    var wantNames = expected.names.slice().sort();
    for (var j = 0; j < names.length; j++) {
        if (names[j] !== wantNames[j]) return 'name "' + names[j] + '" not in asset';
    }
    return '';
}

/**
 * Remember what is on the clipboard: which asset, and the names +
 * signatures of the clips that were copied.
 */
function VT_setClipboardCache(assetPath, clips) {
    var names = [];
    for (var i = 0; i < clips.length; i++) { names.push(clips[i].name || ''); }
    $.global.VT_ClipboardCache = { path: assetPath, names: names, sigs: VT_clipSignatures(clips) };
    return names.length;
}

/**
 * Deselect everything in seq. Called before copying from an asset sequence:
 * if the synthetic Ctrl+C lands on the user's timeline instead, it must not
 * copy the user's (previously inserted) clip - that is how a double-click
 * used to insert "a copy of the previous media".
 */
function VT_deselectAll(seq) {
    try {
        var sel = seq.getSelection();
        for (var i = 0; sel && i < sel.length; i++) {
            try { sel[i].setSelected(false, true); } catch (dsErr) {}
        }
    } catch (e) { vtLog('VT_deselectAll: ' + e); }
}

function VT_collectAllClips(seq) {
    var clips = [];
    var t, c;
    for (t = 0; t < seq.videoTracks.numTracks; t++) {
        for (c = 0; c < seq.videoTracks[t].clips.numItems; c++) { clips.push(seq.videoTracks[t].clips[c]); }
    }
    for (t = 0; t < seq.audioTracks.numTracks; t++) {
        for (c = 0; c < seq.audioTracks[t].clips.numItems; c++) { clips.push(seq.audioTracks[t].clips[c]); }
    }
    return clips;
}

function VT_purgeCachedAssetSeqAfterPaste(assetPath) {
    try {
        var cachedSeq = VT_findCachedAssetSeq(assetPath);
        if (cachedSeq) { VT_purgeAssetSeq(assetPath, cachedSeq); }
    } catch (e) { vtLog('VT_purgeCachedAssetSeqAfterPaste: ' + e); }
}

function VT_executeCommand(command) {
    vtLog('CMD: ' + command);
    try {
        if (!$.global.VT_ExtObj || typeof $.global.VT_ExtObj.doCommand !== 'function') {
            vtLog('CMD: DLL not loaded, reinitializing...');
            if (!VT_initExtObj()) {
                vtLog('CMD: DLL init failed');
                return false;
            }
        }
        $.global.VT_ExtObj.doCommand(command);
        vtLog('CMD: OK');
        return true;
    } catch (e) {
        vtLog('CMD: ERROR: ' + e);
        return false;
    }
}

function VT_diagFocus() {
    var commands = [
        'cmd.focus.timeline',
        'cmd.window.activate',
        'cmd.panel.activate.timeline',
        'cmd.timeline.focus',
        'cmd.window.timeline.activate',
        'cmd.panel.focus.timeline',
        'cmd.edit.focus.timeline',
        'cmd.focus.panel.timeline',
        'cmd.window.focus',
        'cmd.focus.window'
    ];
    var results = [];
    for (var i = 0; i < commands.length; i++) {
        try {
            $.global.VT_ExtObj.doCommand(commands[i]);
            results.push(commands[i] + ': OK');
        } catch (e) {
            results.push(commands[i] + ': ERR ' + e);
        }
    }
    return results.join(' | ');
}

// Track Targeting Helpers 
function VT_saveTrackTargeting(seq) {
    var video = [];
    var audio = [];
    for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
        video[sv] = seq.videoTracks[sv].isTargeted();
    }
    for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
        audio[sa] = seq.audioTracks[sa].isTargeted();
    }
    return { video: video, audio: audio };
}

function VT_restoreTrackTargeting(seq, saved) {
    for (var rv = 0; rv < seq.videoTracks.numTracks && rv < saved.video.length; rv++) {
        seq.videoTracks[rv].setTargeted(saved.video[rv], true);
    }
    for (var ra = 0; ra < seq.audioTracks.numTracks && ra < saved.audio.length; ra++) {
        seq.audioTracks[ra].setTargeted(saved.audio[ra], true);
    }
}

function VT_setTrackTargeting(seq, videoIdx, audioIdx) {
    for (var v = 0; v < seq.videoTracks.numTracks; v++) {
        seq.videoTracks[v].setTargeted(v === videoIdx, true);
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
        seq.audioTracks[a].setTargeted(a === audioIdx, true);
    }
}

/**
 * SEQUENCE CACHE (session-level): remembers asset sequences imported earlier
 * in the session so repeat inserts skip importFiles - the main bottleneck.
 */
function VT_findCachedAssetSeq(assetPath) {
    try {
        var cache = $.global.VT_SeqCache;
        if (!cache) return null;
        var entry = cache[assetPath];
        if (!entry) return null;
        var af = new File(assetPath);
        if (!af.exists || String(af.modified) !== entry.mtime) {
            delete cache[assetPath];
            vtLog('SEQ-CACHE: stale (file changed) for ' + assetPath);
            return null;
        }
        var foundSeq = null;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var cs = app.project.sequences[i];
            if (cs.sequenceID === entry.id) {
                foundSeq = cs;
                var hasClips = false;
                for (var v = 0; v < cs.videoTracks.numTracks; v++) {
                    if (cs.videoTracks[v].clips.numItems > 0) { hasClips = true; break; }
                }
                if (hasClips) {
                    vtLog('SEQ-CACHE: hit for ' + assetPath);
                    return cs;
                }
                break;
            }
        }
        if (foundSeq) {
            vtLog('SEQ-CACHE: cached sequence has no clips, purging for ' + assetPath);
            if (!VT_purgeAssetSeq(assetPath, foundSeq)) {
                return null;
            }
        } else {
            vtLog('SEQ-CACHE: sequence gone for ' + assetPath);
        }
        delete cache[assetPath];
        return null;
    } catch (e) {
        vtLog('SEQ-CACHE: lookup error: ' + e);
        return null;
    }
}

function VT_cacheAssetSeq(assetPath, seq) {
    try {
        if (!$.global.VT_SeqCache) $.global.VT_SeqCache = {};
        var af = new File(assetPath);
        $.global.VT_SeqCache[assetPath] = {
            id: seq.sequenceID,
            mtime: af.exists ? String(af.modified) : ''
        };
        vtLog('SEQ-CACHE: stored for ' + assetPath);
    } catch (e) { vtLog('SEQ-CACHE: store error: ' + e); }
}

function VT_forgetSequenceCache(assetPath) {
    try {
        var cache = $.global.VT_SeqCache;
        if (!cache || !cache[assetPath]) return 'false';
        var cachedId = cache[assetPath].id;
        delete cache[assetPath];
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            var s = app.project.sequences[i];
            if (s.sequenceID === cachedId) {
                try { s.close(); } catch (ce) {}
                try {
                    app.project.deleteSequence(s);
                } catch (de) {
                    try { s.projectItem.deleteBin(); } catch (e1) {
                        try {
                            var b = app.project.rootItem.createBin('_vt_delete_');
                            s.projectItem.moveBin(b);
                            b.deleteBin();
                        } catch (e2) {}
                    }
                }
                break;
            }
        }
        vtLog('SEQ-CACHE: forgotten ' + assetPath);
        return 'true';
    } catch (e) { vtLog('SEQ-CACHE: forget error: ' + e); return 'false'; }
}

/**
 * Remove an asset sequence from the project AND keep the sequence cache
 * coherent. Called on every exit path (success, early error, exception) so no
 * VT_Asset_* item can linger in the Project panel.
 * Returns true when the sequence is really gone from the project.
 */
function VT_purgeAssetSeq(assetPath, seq) {
    try {
        if (!seq) return false;
        var seqId = seq.sequenceID;
        try { seq.close(); } catch (closeEx) {}

        var gone = false;
        try {
            app.project.deleteSequence(seq);
            gone = true;
        } catch (delErr) {
            // ExtendScript has no reliable direct sequence-delete: fall back to
            // the move-to-temp-bin workaround (same as VT_saveAssetNative).
            try {
                try {
                    seq.projectItem.deleteBin();
                } catch (directErr) {
                    var delBin = app.project.rootItem.createBin('_vt_delete_');
                    seq.projectItem.moveBin(delBin);
                    delBin.deleteBin();
                }
                gone = true;
            } catch (binErr) {
                vtLog('PURGE: bin-delete workaround failed: ' + binErr);
            }
        }

        if (!gone) {
            gone = true;
            for (var pi = 0; pi < app.project.sequences.numSequences; pi++) {
                if (app.project.sequences[pi].sequenceID === seqId) { gone = false; break; }
            }
        }

        if (gone) {
            try {
                var vtCache = $.global.VT_SeqCache;
                if (vtCache && assetPath && vtCache[assetPath] && vtCache[assetPath].id === seqId) {
                    delete vtCache[assetPath];
                }
            } catch (cacheErr) {}
            vtLog('PURGE: sequence removed (' + assetPath + ')');
            try { VT_cleanupEmptyAssetsBin(); } catch (binCleanErr) {}
            return true;
        }
        vtLog('PURGE: sequence still present (' + assetPath + '), cache entry kept for reuse');
        return false;
    } catch (e) {
        vtLog('PURGE: error: ' + e);
        return false;
    }
}

/* v3.9.2: the unused 3-call drag-drop (VT_prepareDragDrop / VT_copyAndSwitch /
   VT_pasteAndFinalize) was removed - the panel uses VT_dragDropSingleCall. */

// ========================================
// EVENT PAUSING
// Prevents cascading Premiere events during critical drag-drop operations
// ========================================
function VT_pauseEvents() {
    $.global.VT_EventsPausedUntil = Date.now() + 8000;
    vtLog('EVENTS: paused');
}
function VT_unpauseEvents() {
    $.global.VT_EventsPausedUntil = 0;
    vtLog('EVENTS: unpaused');
}
function VT_areEventsPaused() {
    return ($.global.VT_EventsPausedUntil > 0 && $.global.VT_EventsPausedUntil >= Date.now());
}

// Init the timer on global
if (!$.global.VT_EventsPausedUntil) $.global.VT_EventsPausedUntil = 0;

/**
 * SINGLE-CALL drag-drop: does everything in one evalScript round-trip.
 * Equivalent to prepareDragDrop + copyAndSwitch + pasteAndFinalize combined.
 */
function VT_tryClipboardPaste(assetPath, placeholderInfo, assetType, insertTicks, insertSeconds, targetTrackIndex, originalTicks, savedVideoTargeting, savedAudioTargeting) {
    try {
        var cache = $.global.VT_ClipboardCache;
        if (!cache || cache.path !== assetPath || !cache.names || cache.names.length === 0) {
            return null;
        }
        var seq = app.project.activeSequence;
        if (!seq) return null;

        function restoreState() {
            var r;
            if (savedVideoTargeting) {
                for (r = 0; r < seq.videoTracks.numTracks && r < savedVideoTargeting.length; r++) {
                    try { seq.videoTracks[r].setTargeted(savedVideoTargeting[r], true); } catch (rvErr) {}
                }
            }
            if (savedAudioTargeting) {
                for (r = 0; r < seq.audioTracks.numTracks && r < savedAudioTargeting.length; r++) {
                    try { seq.audioTracks[r].setTargeted(savedAudioTargeting[r], true); } catch (raErr) {}
                }
            }
            try { seq.setPlayerPosition(String(originalTicks)); } catch (rpErr0) {}
        }

        // Snapshot timeline state BEFORE paste (with split-remainder index)
        var before = VT_snapshotClips(seq);
        var vt;

        // Targeting so paste lands on the placeholder track
        for (vt = 0; vt < seq.videoTracks.numTracks; vt++) { seq.videoTracks[vt].setTargeted(vt === targetTrackIndex, true); }
        for (vt = 0; vt < seq.audioTracks.numTracks; vt++) { seq.audioTracks[vt].setTargeted(vt === targetTrackIndex, true); }

        // Playhead to placeholder position
        try { seq.setPlayerPosition(insertTicks); }
        catch (posErr) { var pt = new Time(); pt.seconds = insertSeconds; seq.setPlayerPosition(pt.ticks); }

        // Focus the timeline before the DLL paste (SendInput goes to the focused
        // window) - same sequence the click-apply fast path uses successfully.
        VT_executeCommand('cmd.focus.timeline');
        VT_executeCommand('cmd.panel.focus.timeline');
        VT_executeCommand('cmd.timeline.focus');
        $.sleep(50);

        var pasteOk = VT_executeCommand('cmd.edit.paste');
        vtLog('CLIPBOARD-FAST: paste=' + pasteOk);

        // WAIT for the paste to land (v3.9.0: scanning immediately always saw 0)
        var newClips = VT_waitForNewClips(seq, before, 800, originalTicks);

        if (newClips.length === 0) {
            restoreState();
            vtLog('CLIPBOARD-FAST: nothing pasted after 800ms (focus) - retry');
            return JSON.stringify({ success: false, retry: 'focus', error: 'Paste did not reach the timeline' });
        }

        // Verify the pasted clips ARE this asset (name + duration + parameters)
        var why = VT_pasteMismatch(newClips, cache);
        if (why) {
            vtLog('CLIPBOARD-FAST: pasted content is NOT this asset (' + why + ') - removing it');
            // Remove exactly the clips this paste produced (by reference). The old
            // qe.project.undo() loop could also undo the placeholder removal.
            var badIds = {};
            for (var bi = 0; bi < newClips.length; bi++) { badIds[newClips[bi].nodeId] = true; }
            VT_removeClipsByNodeIds(seq, badIds);
            $.global.VT_ClipboardCache = null;
            restoreState();
            if (VT_collectNewClips(seq, before).length > 0) {
                return JSON.stringify({ success: false, error: 'Clipboard contained foreign clips - could not remove them, press Ctrl+Z and retry' });
            }
            return JSON.stringify({ success: false, retry: 'reprime', error: 'Clipboard held other content' });
        }

        // Success: re-enable + label pasted clips
        for (var e = 0; e < newClips.length; e++) {
            try { newClips[e].disabled = false; } catch (enErr) {}
            if (assetType && LABEL_COLORS[assetType]) { try { newClips[e].label = LABEL_COLORS[assetType]; } catch (lbErr) {} }
        }

        // Restore targeting
        if (savedVideoTargeting) {
            for (var sv = 0; sv < seq.videoTracks.numTracks && sv < savedVideoTargeting.length; sv++) {
                try { seq.videoTracks[sv].setTargeted(savedVideoTargeting[sv], true); } catch (svErr) {}
            }
        }
        if (savedAudioTargeting) {
            for (var sa = 0; sa < seq.audioTracks.numTracks && sa < savedAudioTargeting.length; sa++) {
                try { seq.audioTracks[sa].setTargeted(savedAudioTargeting[sa], true); } catch (saErr) {}
            }
        }

        // Restore playhead
        try { seq.setPlayerPosition(originalTicks); } catch (rpErr) { vtLog('CLIPBOARD-FAST: playhead restore warn: ' + rpErr); }

        try { VT_scaleClipsToFit(newClips, seq); } catch (scErr) { vtLog('CLIPBOARD-FAST: scale warn: ' + scErr); }
        try { VT_cleanupPlaceholdersFromBin(); } catch (clErr) { vtLog('CLIPBOARD-FAST: placeholder bin cleanup warn: ' + clErr); }
        VT_purgeCachedAssetSeqAfterPaste(assetPath);
        try { seq.setSelection(newClips); } catch (selErr) {}
        // Final playhead restore (scale/cleanup/purge can nudge it again)
        try { seq.setPlayerPosition(String(originalTicks)); } catch (rp2Err) {}

        VT_markVerified(VT_clipSignatures(newClips));
        vtLog('CLIPBOARD-FAST: SUCCESS (' + newClips.length + ' clips, no sequence switch)');
        return JSON.stringify({ success: true, clipsCount: newClips.length });
    } catch (e) {
        vtLog('CLIPBOARD-FAST: error, falling back to full path: ' + e);
        return null;
    }
}
function VT_dragDropSingleCall(assetPath, placeholderInfo, assetType, fastOnly) {
    vtLog('DRAG-SINGLE: START type=' + (assetType || '?') + (fastOnly ? ' (fast only)' : ''));
    VT_pauseEvents();
    try {
        if (!VT_initExtObj()) {
            return JSON.stringify({ success: false, error: 'DLL not available' });
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        var insertPositionTicks = parseInt(placeholderInfo.startTicks, 10);
        var insertPositionSeconds = parseFloat(placeholderInfo.startSeconds);
        var targetTrackIndex = parseInt(placeholderInfo.trackIndex, 10);
        if (isNaN(insertPositionTicks) || isNaN(insertPositionSeconds) || isNaN(targetTrackIndex)) {
            return JSON.stringify({ success: false, error: 'Invalid position values' });
        }

        var targetSeqId = seq.sequenceID;

        // Remember the playhead so the CTI does not shift after insert
        // Prefer the playhead captured when the drag STARTED (VT_capturePlayhead)
        var originalPlayheadTicks = VT_takeLockedPlayhead(seq, String(seq.getPlayerPosition().ticks));
        vtLog('DRAG-SINGLE: playhead to restore = ' + originalPlayheadTicks);

        // Remove placeholder
        try {
            if (placeholderInfo.isVideo) {
                var vtrack = seq.videoTracks[placeholderInfo.trackIndex];
                if (vtrack && vtrack.clips.numItems > placeholderInfo.clipIndex) {
                    var clipToRemove = vtrack.clips[placeholderInfo.clipIndex];
                    if (clipToRemove && clipToRemove.name && clipToRemove.name.match(/\.vtbk$/i)) {
                        clipToRemove.remove(false, false);
                    }
                }
            }
        } catch (removeErr) {
            vtLog('DRAG-SINGLE: placeholder remove failed: ' + removeErr);
            if (typeof qe !== 'undefined' && qe && qe.project) {
                try { qe.project.undo(); } catch (ue) { vtLog('DRAG-SINGLE: undo after failed remove also failed: ' + ue); }
            }
        }

        // Save targeting
        var savedVideoTargeting = [];
        var savedAudioTargeting = [];
        for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
            savedVideoTargeting[sv] = seq.videoTracks[sv].isTargeted();
        }
        for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
            savedAudioTargeting[sa] = seq.audioTracks[sa].isTargeted();
        }

        // Fast path: clipboard already primed for this asset - paste without switching sequences
        var fastRes = VT_tryClipboardPaste(assetPath, placeholderInfo, assetType, insertPositionTicks, insertPositionSeconds, targetTrackIndex, originalPlayheadTicks, savedVideoTargeting, savedAudioTargeting);
        if (fastRes) {
            var fastData = null;
            try { fastData = JSON.parse(fastRes); } catch (fpErr) {}
            if (!fastData || fastData.success || !fastData.retry || fastOnly) {
                VT_unpauseEvents();
                return fastRes;
            }
            vtLog('DRAG-SINGLE: fast path failed (' + fastData.retry + ') - full path');
        } else if (fastOnly) {
            VT_unpauseEvents();
            return JSON.stringify({ success: false, retry: 'reprime', error: 'Clipboard not primed for this asset' });
        }
        // Import .prproj (or reuse the cached sequence from a previous insert)
        var fromCache = !!VT_findCachedAssetSeq(assetPath);
        var importedSeq = VT_importAssetSeq(assetPath);

        if (!importedSeq) {
            return JSON.stringify({ success: false, error: 'Could not find imported sequence' });
        }

        // Collect clips (keep them ENABLED - Premiere excludes disabled clips
        // from Edit>Copy, which used to leave the clipboard empty and made
        // every drag-insert paste 0 clips)
        var clipsToSelect = [];
        for (var vt2 = 0; vt2 < importedSeq.videoTracks.numTracks; vt2++) {
            var vTrack = importedSeq.videoTracks[vt2];
            for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                var vclip = vTrack.clips[vc];
                clipsToSelect.push(vclip);
            }
        }
        for (var at2 = 0; at2 < importedSeq.audioTracks.numTracks; at2++) {
            var aTrack = importedSeq.audioTracks[at2];
            for (var ac2 = 0; ac2 < aTrack.clips.numItems; ac2++) {
                clipsToSelect.push(aTrack.clips[ac2]);
            }
        }

        if (clipsToSelect.length === 0) {
            VT_purgeAssetSeq(assetPath, importedSeq);
            return JSON.stringify({ success: false, error: 'No clips in asset' });
        }

        // What the paste must produce (verified below)
        var vtExpected = { names: [], sigs: VT_clipSignatures(clipsToSelect) };
        for (var vxn = 0; vxn < clipsToSelect.length; vxn++) { vtExpected.names.push(clipsToSelect[vxn].name || ''); }
        $.global.VT_ClipboardCache = null; // unknown until the paste is verified

        // A misdirected Ctrl+C must find nothing selected on the user's timeline
        VT_deselectAll(seq);

        // Open imported sequence, select, copy
        app.project.openSequence(importedSeq.sequenceID);
        importedSeq.setSelection(clipsToSelect);

        var copyResult = VT_executeCommand('cmd.edit.copy');
        vtLog('DRAG-SINGLE: copy=' + copyResult);

        // Re-enable source clips so a cached sequence stays pristine
        for (var reIdx = 0; reIdx < clipsToSelect.length; reIdx++) {
            try { clipsToSelect[reIdx].disabled = false; } catch (reEnErr) {}
        }

        // Switch back to target FIRST, then close imported (avoids a "dead" sequence state)
        app.project.openSequence(targetSeqId);
        if (typeof qe !== 'undefined' && qe && qe.project) {
            // If this fails the timeline is not refocused and the paste below
            // targets nothing - never let it pass unnoticed.
            try { qe.project.getActiveSequence().makeCurrent(); } catch (e) { vtLog('DRAG-SINGLE: makeCurrent failed - timeline not refocused: ' + e); }
        }
        try { importedSeq.close(); } catch (e) { vtLog('DRAG-SINGLE: imported sequence close failed (orphan left open): ' + e); }
        // Closing the imported sequence can steal timeline focus - re-assert
        // the target so the paste below lands in the right sequence.
        try {
            app.project.openSequence(targetSeqId);
            if (typeof qe !== 'undefined' && qe && qe.project) { qe.project.getActiveSequence().makeCurrent(); }
        } catch (reErr) { vtLog('DRAG-SINGLE: target re-assert failed: ' + reErr); }

        // Re-apply targeting
        var targetSeq = app.project.activeSequence;
        for (var vt = 0; vt < targetSeq.videoTracks.numTracks; vt++) {
            targetSeq.videoTracks[vt].setTargeted(vt === targetTrackIndex, true);
        }
        for (var at = 0; at < targetSeq.audioTracks.numTracks; at++) {
            targetSeq.audioTracks[at].setTargeted(at === targetTrackIndex, true);
        }

        // Set playhead
        try {
            targetSeq.setPlayerPosition(insertPositionTicks);
        } catch (tickErr) {
            var posTime = new Time();
            posTime.seconds = insertPositionSeconds;
            targetSeq.setPlayerPosition(posTime.ticks);
        }

        // Snapshot clips BEFORE paste so we can find new ones by nodeId
        var targetSeqNow = app.project.activeSequence;
        var clipsBeforePaste = VT_snapshotClips(targetSeqNow);

        // Paste, then WAIT for it to land before diffing
        var pasteResult = VT_executeCommand('cmd.edit.paste');
        vtLog('DRAG-SINGLE: paste=' + pasteResult);
        var pastedNow = VT_waitForNewClips(targetSeqNow, clipsBeforePaste, 800, originalPlayheadTicks);

        // VERIFY - never keep content that is not this asset
        var vtNested = false;
        if (pastedNow.length > 0) {
            var vtWhy = VT_pasteMismatch(pastedNow, vtExpected);
            if (vtWhy) {
                vtLog('DRAG-SINGLE: pasted content is NOT this asset (' + vtWhy + ') - removing it');
                var vtBadIds = {};
                for (var vbi = 0; vbi < pastedNow.length; vbi++) { vtBadIds[pastedNow[vbi].nodeId] = true; }
                VT_removeClipsByNodeIds(targetSeqNow, vtBadIds);
                pastedNow = [];
            } else {
                $.global.VT_ClipboardCache = { path: assetPath, names: vtExpected.names, sigs: vtExpected.sigs };
                VT_markVerified(VT_clipSignatures(pastedNow));
            }
        }
        if (pastedNow.length === 0) {
            // Last resort with CORRECT content: insert the asset as a nested
            // sequence at the drop position (same as the click-apply fallback)
            try {
                var nestTime = new Time();
                nestTime.seconds = insertPositionSeconds;
                if (targetSeqNow.overwriteClip(importedSeq.projectItem, nestTime, targetTrackIndex, 0) !== false) {
                    vtNested = true;
                    vtLog('DRAG-SINGLE: paste failed - asset inserted as nested sequence at drop position');
                }
            } catch (nestErr) { vtLog('DRAG-SINGLE: nested fallback failed: ' + nestErr); }
        }

        // Restore targeting
        for (var rv = 0; rv < targetSeq.videoTracks.numTracks && rv < savedVideoTargeting.length; rv++) {
            targetSeq.videoTracks[rv].setTargeted(savedVideoTargeting[rv], true);
        }
        for (var ra = 0; ra < targetSeq.audioTracks.numTracks && ra < savedAudioTargeting.length; ra++) {
            targetSeq.audioTracks[ra].setTargeted(savedAudioTargeting[ra], true);
        }

        // Restore original playhead so the CTI does not shift after insert
        try {
            targetSeq.setPlayerPosition(originalPlayheadTicks);
        } catch (restorePosErr) {
            vtLog('DRAG-SINGLE: playhead restore warning: ' + restorePosErr);
        }

        // Re-enable + label the verified pasted clips
        var pastedClips = pastedNow;
        var pastedClipsCount = 0;
        try {
            for (var ps = 0; ps < pastedClips.length; ps++) {
                pastedClips[ps].disabled = false;
                if (assetType && LABEL_COLORS[assetType]) {
                    pastedClips[ps].label = LABEL_COLORS[assetType];
                }
                pastedClipsCount++;
            }
        } catch (ee) { vtLog('DRAG-SINGLE: re-enable warn: ' + ee); }

        try { VT_scaleClipsToFit(pastedClips, targetSeq); } catch (se) { vtLog('DRAG-SINGLE: scale warn: ' + se); }

        // Zero-artifact rule: purge the imported sequence - unless the nested
        // fallback inserted it (deleting the source would break the nest).
        if (!vtNested) { VT_purgeAssetSeq(assetPath, importedSeq); }

        try { VT_cleanupPlaceholdersFromBin(); } catch (e) { vtLog('DRAG-SINGLE: placeholder bin cleanup failed, vt_drag_ items left behind: ' + e); }
        try { targetSeq.setPlayerPosition(String(originalPlayheadTicks)); } catch (rpEndErr) {}

        if (vtNested) {
            VT_unpauseEvents();
            return JSON.stringify({ success: true, clipsCount: 1, nested: true });
        }
        if (pastedClipsCount === 0) {
            vtLog('DRAG-SINGLE: paste produced 0 clips - reporting failure');
            VT_unpauseEvents();
            return JSON.stringify({ success: false, error: 'Paste produced no clips - try again' });
        }
        vtLog('DRAG-SINGLE: SUCCESS! (' + pastedClipsCount + ' clips)');
        VT_unpauseEvents();
        return JSON.stringify({ success: true, clipsCount: pastedClipsCount });

    } catch (e) {
        vtLog('DRAG-SINGLE: ERROR: ' + e);
        try {
            if (typeof importedSeq !== 'undefined' && importedSeq && typeof fromCache !== 'undefined' && !fromCache) {
                VT_purgeAssetSeq(assetPath, importedSeq);
            }
        } catch (cleanErr) { vtLog('DRAG-SINGLE: error-path cleanup failed: ' + cleanErr); }
        VT_unpauseEvents();
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function VT_getClipKey(clip) {
    try {
        if (clip.isMGT && clip.isMGT()) {
            var names = [];
            var ci, pi, comp;
            for (ci = 0; ci < clip.components.numItems; ci++) {
                comp = clip.components[ci];
                if (comp.matchName === 'AE.ADBE Capsule') {
                    for (pi = 0; pi < comp.properties.numItems; pi++) {
                        names.push(comp.properties[pi].displayName || '');
                    }
                    break;
                }
            }
            if (names.length) return 'mgt:' + names.join('|');
            var mn0 = [];
            for (ci = 0; ci < clip.components.numItems; ci++) mn0.push(clip.components[ci].matchName || '');
            return 'mgtcmp:' + mn0.join('|');
        }
    } catch (mgtErr) { }
    try {
        if (clip.projectItem) {
            var mp = clip.projectItem.getMediaPath();
            if (mp) return 'mp:' + mp;
            // Nested sequence: no media path, key it by the sequence itself (v3.9.5)
            var isSeqItem = false;
            try { isSeqItem = clip.projectItem.isSequence ? !!clip.projectItem.isSequence() : false; } catch (isqErr) { }
            if (isSeqItem && clip.projectItem.nodeId) return 'seq:' + clip.projectItem.nodeId;
        }
    } catch (mpErr) { }
    try {
        var mn = [];
        for (var cj = 0; cj < clip.components.numItems; cj++) mn.push(clip.components[cj].matchName || '');
        if (mn.length) return 'cmp:' + mn.join('|');
    } catch (cmpErr) { }
    return '';
}
/**
 * Snapshot the property values of every effect (component) of a clip.
 * Returns { effects: [...], keyframed: [names of time-varying properties] }.
 * Shared by the effect presets and the native MOGRT assets (v3.9.3).
 */
function VT_captureClipEffects(clip) {
    var keyframed = [];
        var effects = [];
        for (var ci = 0; ci < clip.components.numItems; ci++) {
            var comp = clip.components[ci];
            var props = [];
            for (var pi = 0; pi < comp.properties.numItems; pi++) {
                var prop = comp.properties[pi];
                try { if (prop.isTimeVarying && prop.isTimeVarying()) keyframed.push((comp.displayName || '') + '/' + (prop.displayName || '')); } catch (tvErr) {}
                var val = null;
                try { val = prop.getValue(); } catch (ve) { val = null; }
                var sval = null;
                var stype = 'unknown';
                var t = typeof val;
                if (t === 'number' || t === 'boolean' || t === 'string') {
                    sval = val; stype = t;
                } else if (val === null || t === 'undefined') {
                    sval = null; stype = 'null';
                } else {
                    try {
                        if (val instanceof Array) {
                            var vtArr = [];
                            for (var ai = 0; ai < val.length; ai++) vtArr.push(val[ai]);
                            sval = vtArr; stype = 'array';
                        } else {
                            sval = String(val); stype = 'stringified';
                        }
                    } catch (se) { sval = null; }
                }
                var colorRGB = null;
                if (stype === 'number' && typeof val === 'number' && val >= 281474976710656 && typeof prop.getColorValue === 'function') {
                    try {
                        var cvSave = prop.getColorValue();
                        if (cvSave instanceof Array && cvSave.length >= 4) colorRGB = [cvSave[1], cvSave[2], cvSave[3]];
                    } catch (cvSaveErr) { }
                }
                props.push({
                    index: pi,
                    displayName: prop.displayName || '',
                    paramName: prop.paramName || '',
                    valueType: stype,
                    value: sval,
                    colorRGB: colorRGB
                });
            }
            effects.push({
                index: ci,
                displayName: comp.displayName || '',
                matchName: comp.matchName || '',
                numProperties: props.length,
                properties: props
            });
        }
    return { effects: effects, keyframed: keyframed };
}

/**
 * Per-effect property presets (Premiere Composer / AtomX style).
 * Snapshots ONLY the property values of each effect (component) on the
 * currently selected clip. No clips are saved and nothing is inserted into
 * the project - the preset system only reads/writes effect properties.
 */
/**
 * 'Video' / 'Audio' for a track item ('' if unknown). TrackItem.mediaType is
 * the primary source; the component list is the fallback.
 */
function VT_clipMediaType(clip) {
    try {
        var mt = String(clip.mediaType || '');
        if (/video/i.test(mt)) return 'Video';
        if (/audio/i.test(mt)) return 'Audio';
    } catch (mtErr) { }
    try {
        for (var ci = 0; ci < clip.components.numItems; ci++) {
            var mn = String(clip.components[ci].matchName || '');
            if (mn === 'AE.ADBE Motion' || mn === 'AE.ADBE Opacity') return 'Video';
        }
        if (clip.components.numItems > 0) return 'Audio';
    } catch (cmErr) { }
    return '';
}

/** Media type a preset was made for, guessed from its effects (old presets). */
function VT_presetMediaType(effects) {
    if (!effects || !effects.length) return '';
    var sawAudio = false;
    for (var i = 0; i < effects.length; i++) {
        var mn = String(effects[i].matchName || '');
        if (mn === 'AE.ADBE Motion' || mn === 'AE.ADBE Opacity' || mn === 'AE.ADBE Capsule') return 'Video';
        if (/volume|panner|channel/i.test(mn + ' ' + (effects[i].displayName || ''))) sawAudio = true;
    }
    return sawAudio ? 'Audio' : '';
}

/** 'mogrt' | 'video' | 'image' | 'audio' | 'sequence' | 'clip' - for the preset tag. */
function VT_clipKind(clip, key, mediaType) {
    if (key && key.indexOf('mgt') === 0) return 'mogrt';
    if (key && key.indexOf('seq:') === 0) return 'sequence';
    if (mediaType === 'Audio') return 'audio';
    if (key && key.indexOf('mp:') === 0) {
        if (/\.(jpe?g|png|gif|bmp|tiff?|psd|ai|eps|webp|heic|tga|exr|dpx)$/i.test(key)) return 'image';
        return 'video';
    }
    return mediaType === 'Video' ? 'video' : 'clip';
}

/**
 * The selection track item a preset is read from. A video clip with linked
 * audio comes back as two items, and getSelection() may list the audio one
 * first - the old code took sel[0] and saved Volume/Panner instead of the
 * video's Motion/Opacity/effects. Prefer a MOGRT, then a video item.
 */
function VT_pickPresetClip(sel) {
    if (!sel || !sel.length) return null;
    var firstVideo = null;
    for (var i = 0; i < sel.length; i++) {
        var c = sel[i];
        if (!c) continue;
        var mgt = false;
        try { mgt = c.isMGT ? !!c.isMGT() : false; } catch (e1) { }
        if (mgt) return c;
        if (!firstVideo && VT_clipMediaType(c) === 'Video') firstVideo = c;
    }
    return firstVideo || sel[0];
}

function VT_findNewClipByNodeIds(seq, existingNodeIds, preferAudio) {
    var groups = preferAudio ? [seq.audioTracks, seq.videoTracks] : [seq.videoTracks, seq.audioTracks];
    for (var g = 0; g < groups.length; g++) {
        var tracks = groups[g];
        for (var t = 0; t < tracks.numTracks; t++) {
            var clips = tracks[t].clips;
            for (var k = 0; k < clips.numItems; k++) {
                if (!existingNodeIds[clips[k].nodeId]) return clips[k];
            }
        }
    }
    return null;
}

function VT_getSelectedClipEffects() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var sel = seq.getSelection();
        if (!sel || sel.length === 0) return JSON.stringify({ success: false, error: 'No clip selected' });
        var clip = VT_pickPresetClip(sel);
        var effects = VT_captureClipEffects(clip).effects;
        var clipIsMGT = false;
        try { clipIsMGT = clip.isMGT ? !!clip.isMGT() : false; } catch (mgtErr) { clipIsMGT = false; }
        var clipKey = VT_getClipKey(clip);
        var mediaType = VT_clipMediaType(clip);
        var kind = VT_clipKind(clip, clipKey, mediaType);
        var fxList = [];
        for (var fi = 0; fi < effects.length; fi++) fxList.push(effects[fi].matchName);
        vtLog('VT_getSelectedClipEffects: clip=' + (clip.name || '') + ' kind=' + kind + ' media=' + mediaType + ' selItems=' + sel.length + ' effects=' + effects.length + ' [' + fxList.join(', ') + ']');
        vtLog('VT_getSelectedClipEffects: clipKey=' + clipKey);
        if (!effects.length) return JSON.stringify({ success: false, error: 'Premiere returned no effects for "' + (clip.name || 'clip') + '" - click the clip on the timeline and try again' });
        return JSON.stringify({ success: true, clipName: clip.name || '', isMGT: clipIsMGT, clipKey: clipKey, mediaType: mediaType, kind: kind, effects: effects });
    } catch (e) {
        vtLog('VT_getSelectedClipEffects: ERROR ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * Lightweight: return only the structural clipKey of the selected clip.
 */
function VT_getSelectedClipKey() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var sel = seq.getSelection();
        if (!sel || sel.length === 0) return JSON.stringify({ success: false, error: 'No clip selected' });
        var clip = VT_pickPresetClip(sel);
        var key = VT_getClipKey(clip);
        var mediaType = VT_clipMediaType(clip);
        var kind = VT_clipKind(clip, key, mediaType);
        if (key !== VT_lastLoggedClipKey) {
            VT_lastLoggedClipKey = key;
            vtLog('VT_getSelectedClipKey: kind=' + kind + ' clipKey=' + key);
        }
        return JSON.stringify({ success: true, clipKey: key, mediaType: mediaType, kind: kind, clipName: clip.name || '' });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}
var VT_lastLoggedClipKey = null;
/**
 * Force Premiere's Effect Controls panel to re-read the selected clip's
 * property values (Premiere Composer technique: QE makeCurrent + selection
 * toggle). Use after programmatic setValue so the EC panel is not stale.
 */
function VT_refreshEffectControls() {
    vtLog('VT_refreshEffectControls: enter');
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        try { app.enableQE(); } catch (qeEnErr) { }
        var sel = seq.getSelection();
        if (sel && sel.length > 0) {
            try { seq.setSelection([]); } catch (dsErr) { vtLog('VT_refreshEffectControls: deselect err=' + dsErr.toString()); }
            try { seq.setSelection(sel); } catch (rsErr) { vtLog('VT_refreshEffectControls: reselect err=' + rsErr.toString()); }
            try { $.sleep(40); } catch (sErr) { }
        }
        try {
            var qeSeq = qe.project.getActiveSequence();
            if (qeSeq) qeSeq.makeCurrent();
        } catch (qeErr) { vtLog('VT_refreshEffectControls: qe err=' + qeErr.toString()); }
        vtLog('VT_refreshEffectControls: done (' + (sel ? sel.length : 0) + ' clips)');
        return JSON.stringify({ success: true });
    } catch (e) {
        vtLog('VT_refreshEffectControls: ERR ' + e.toString());
        return JSON.stringify({ success: false, error: e.toString() });
    }
}
/**
 * Apply a whole-clip property preset (Premiere Composer style).
 * paramsJson: { effects: [{ matchName, displayName, properties: [...] }] }
 * Applies ALL stored properties of ALL effects to the SELECTED clip(s).
 * Only property values change - no clips are inserted, no projects are touched.
 * Matching: property INDEX first (same effect type = same property order, and
 * duplicate displayNames like the two "Blend Mode" entries stay distinct),
 * then paramName, then displayName as last resort.
 * Booleans are applied FIRST so mode switches (e.g. Uniform Scale) are
 * already correct before dependent numeric values are set.
 */
/**
 * "Keep my text" for MOGRT text parameters (v3.9.4).
 * A MOGRT text value is a JSON string: font / size / style per text run plus
 * "textEditValue" (the words). Returns the saved value with the target's own
 * words put in, so a preset changes the look but not what the title says.
 * Returns null when the saved styling cannot be mapped onto the target text
 * (several differently styled runs and a different text length) - the caller
 * then leaves that text parameter untouched.
 */
function VT_keepTargetText(savedStr, targetProp) {
    var curStr = null;
    try { curStr = targetProp.getValue(); } catch (gvErr) { return savedStr; }
    if (typeof curStr !== 'string') return savedStr;
    var re = /"textEditValue":"((?:[^"\\]|\\.)*)"/;
    var mCur = curStr.match(re);
    var mSaved = savedStr.match(re);
    if (!mCur || !mSaved) return savedStr;
    var curText, savedText;
    try {
        curText = JSON.parse('"' + mCur[1] + '"');
        savedText = JSON.parse('"' + mSaved[1] + '"');
    } catch (decErr) { return savedStr; }
    var rc = savedStr.match(/"capPropTextRunCount":([0-9]+)/);
    var runs = rc ? parseInt(rc[1], 10) : 1;
    var keepRaw = mCur[1];
    var out = savedStr.replace(re, function () { return '"textEditValue":"' + keepRaw + '"'; });
    if (curText.length !== savedText.length) {
        if (runs > 1) return null;
        out = out.replace(/"fontTextRunLength":\[[^\]]*\]/, '"fontTextRunLength":[' + curText.length + ']');
    }
    return out;
}

/**
 * Add the video effects a preset contains but the clip does not have yet
 * (v3.9.4, Premiere Composer style) through the QE API, so their values can
 * be applied. Built-in components (Motion, Opacity, MOGRT parameters) are
 * never added. Works on clips of the ACTIVE sequence. Returns the number added.
 */
function VT_addMissingVideoEffects(clip, effects, opts) {
    var INTRINSIC = { 'AE.ADBE Motion': 1, 'AE.ADBE Opacity': 1, 'AE.ADBE Capsule': 1, 'AE.ADBE Time Remapping': 1 };
    try { if (clip.mediaType && clip.mediaType !== 'Video') return 0; } catch (mtErr) {}
    var need = {}, label = {}, order = [];
    var i, mn;
    for (i = 0; i < effects.length; i++) {
        mn = effects[i].matchName || '';
        if (!mn || INTRINSIC[mn] || !effects[i].displayName) continue;
        if (opts && opts.motion === false && mn === 'AE.ADBE Motion') continue;
        if (!need[mn]) { need[mn] = 0; order.push(mn); label[mn] = effects[i].displayName; }
        need[mn]++;
    }
    if (order.length === 0) return 0;
    var have = {};
    for (i = 0; i < clip.components.numItems; i++) {
        mn = clip.components[i].matchName || '';
        have[mn] = (have[mn] || 0) + 1;
    }
    var missing = [];
    for (i = 0; i < order.length; i++) {
        var lack = need[order[i]] - (have[order[i]] || 0);
        for (var k = 0; k < lack; k++) missing.push(order[i]);
    }
    if (missing.length === 0) return 0;

    if (typeof qe === 'undefined' || !qe || !qe.project) { try { app.enableQE(); } catch (eqErr) {} }
    var seq = app.project.activeSequence;
    var qeSeq = qe.project.getActiveSequence();
    var tIdx = VT_videoTrackOf(seq, clip);
    if (tIdx < 0 || !qeSeq) return 0;
    var qeTrack = qeSeq.getVideoTrackAt(tIdx);
    var qeItem = null;
    var wantTicks = parseInt(String(clip.start.ticks), 10);
    for (i = 0; qeTrack && i < qeTrack.numItems; i++) {
        var it = qeTrack.getItemAt(i);
        if (!it || it.type === 'Empty') continue;
        var st = parseInt(String(it.start.ticks || it.start || 0), 10);
        if (Math.abs(st - wantTicks) < 100) { qeItem = it; break; }
    }
    if (!qeItem) { vtLog('ADD-FX: QE clip not found for ' + (clip.name || '')); return 0; }

    var added = 0;
    for (i = 0; i < missing.length; i++) {
        var fxName = label[missing[i]];
        var qeFx = null;
        try { qeFx = qe.project.getVideoEffectByName(fxName); } catch (gfErr) {}
        if (!qeFx) { vtLog('ADD-FX: effect "' + fxName + '" not found in Premiere (other language or plug-in missing)'); continue; }
        try { qeItem.addVideoEffect(qeFx); added++; vtLog('ADD-FX: added "' + fxName + '" to ' + (clip.name || '')); }
        catch (afErr) { vtLog('ADD-FX: could not add "' + fxName + '": ' + afErr); }
    }
    return added;
}

function VT_applyEffectPreset(paramsJson, clipsOverride) {
    try {
        // v3.9.3: params may be an object, and clipsOverride lets the native
        // MOGRT insert apply saved values to a just-inserted clip directly.
        var params = (typeof paramsJson === 'string') ? JSON.parse(paramsJson) : paramsJson;
        var seq = app.project.activeSequence;
        if (!seq && !clipsOverride) return JSON.stringify({ success: false, error: 'No active sequence' });
        var sel = clipsOverride || seq.getSelection();
        if (!sel || sel.length === 0) return JSON.stringify({ success: false, error: 'No clip selected' });
        if (!params.effects || !params.effects.length) return JSON.stringify({ success: false, error: 'Preset has no effects' });

        var appliedProps = 0;
        var missingProps = [];
        var keptTexts = 0;
        var addedEffects = 0;
        var presetOpts = params.options || {};
        var clipsApplied = 0;
        var clipKeyWanted = params.clipKey || '';
        var keySkipped = 0;

        function vtIsColorValue(v) {
            return typeof v === 'number' && isFinite(v) && v >= 281474976710656;
        }
        function vtDecodeColor(v) {
            var t = v - 72057594037927936;
            var r = Math.floor(t / 1099511627776) % 256;
            var g = Math.floor(t / 16777216) % 256;
            var b = Math.floor(t / 256) % 256;
            return [r, g, b, 255];
        }
        function vtApplyColorProp(target, saved, packedVal, label) {
            var rgb = null;
            if (saved && saved.colorRGB instanceof Array && saved.colorRGB.length >= 3) {
                rgb = [saved.colorRGB[0], saved.colorRGB[1], saved.colorRGB[2], 255];
            } else {
                try { rgb = vtDecodeColor(packedVal); } catch (decErr) { }
            }
            if (rgb && typeof target.setColorValue === 'function') {
                var alpha = 1;
                try {
                    var curCv = target.getColorValue();
                    if (curCv instanceof Array && curCv.length > 0 && typeof curCv[0] === 'number') alpha = curCv[0];
                } catch (alErr) { }
                var setOk = false;
                try {
                    target.setColorValue(alpha, rgb[0], rgb[1], rgb[2], true);
                    setOk = true;
                } catch (svErr) {
                    vtLog('COLORFIX setColorValue throw prop=' + label + ' err=' + svErr.toString());
                }
                if (setOk) {
                    var cvRead = null;
                    try { cvRead = target.getColorValue(); } catch (cvErr) { }
                    if (cvRead instanceof Array && cvRead.length >= 4) {
                        if (Math.abs(cvRead[1] - rgb[0]) <= 1 && Math.abs(cvRead[2] - rgb[1]) <= 1 && Math.abs(cvRead[3] - rgb[2]) <= 1) {
                            vtLog('COLORFIX OK format=setColorValue prop=' + label + ' rgb=' + rgb[0] + ',' + rgb[1] + ',' + rgb[2]);
                        } else {
                            vtLog('COLORFIX setColorValue mismatch prop=' + label + ' want=' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ' got=' + String(cvRead));
                        }
                        return true;
                    }
                    vtLog('COLORFIX setColorValue noReadback prop=' + label + ' rgb=' + rgb[0] + ',' + rgb[1] + ',' + rgb[2]);
                    return true;
                }
            }
            var formats = [];
            if (rgb) {
                formats.push({ name: 'arrFloat', val: [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, 1] });
                formats.push({ name: 'arr255', val: [rgb[0], rgb[1], rgb[2], 255] });
            }
            formats.push({ name: 'packed', val: packedVal });
            var fi, attempt, readBack, sameArr, ai2;
            for (fi = 0; fi < formats.length; fi++) {
                attempt = formats[fi];
                try {
                    target.setValue(attempt.val, true);
                } catch (setErr) {
                    vtLog('COLORFIX set throw format=' + attempt.name + ' prop=' + label + ' err=' + setErr.toString());
                    continue;
                }
                readBack = null;
                try { readBack = target.getValue(); } catch (rbErr) { }
                if (readBack === null) {
                    vtLog('COLORFIX readback null format=' + attempt.name + ' prop=' + label);
                    continue;
                }
                if (typeof readBack === 'number' && readBack === packedVal) {
                    vtLog('COLORFIX OK format=' + attempt.name + ' prop=' + label);
                    return true;
                }
                if (readBack instanceof Array && attempt.val instanceof Array && readBack.length === attempt.val.length) {
                    sameArr = true;
                    for (ai2 = 0; ai2 < readBack.length; ai2++) {
                        if (Math.abs(readBack[ai2] - attempt.val[ai2]) > 0.01) { sameArr = false; break; }
                    }
                    if (sameArr) {
                        vtLog('COLORFIX OK format=' + attempt.name + ' prop=' + label);
                        return true;
                    }
                }
                vtLog('COLORFIX mismatch format=' + attempt.name + ' prop=' + label + ' set=' + String(attempt.val) + ' read=' + String(readBack));
            }
            vtLog('COLORFIX FAILED all formats prop=' + label + ' packedVal=' + packedVal);
            return false;
        }
        function vtFindProp(comp, saved) {
            var pj;
            if (typeof saved.index === 'number' && saved.index >= 0 && saved.index < comp.properties.numItems) {
                var byIdx = comp.properties[saved.index];
                if (!saved.displayName || byIdx.displayName === saved.displayName) return byIdx;
            }
            if (saved.paramName) {
                for (pj = 0; pj < comp.properties.numItems; pj++) {
                    if (comp.properties[pj].paramName === saved.paramName) return comp.properties[pj];
                }
            }
            if (saved.displayName) {
                for (pj = 0; pj < comp.properties.numItems; pj++) {
                    if (comp.properties[pj].displayName === saved.displayName) return comp.properties[pj];
                }
            }
            return null;
        }

        // v3.9.5: a video clip and its linked audio share the media path (and
        // so the clipKey); a video preset is applied to the video part only
        // and an audio preset to the audio part only.
        var mediaWanted = params.mediaType || VT_presetMediaType(params.effects);
        var typeSkipped = 0;
        for (var s = 0; s < sel.length; s++) {
            var clip = sel[s];
            if (clipKeyWanted) {
                var ckNow = VT_getClipKey(clip);
                if (ckNow !== clipKeyWanted) {
                    vtLog('VT_applyEffectPreset: skip clip clipKey mismatch');
                    keySkipped++;
                    continue;
                }
            }
            if (mediaWanted) {
                var mtNow = VT_clipMediaType(clip);
                if (mtNow && mtNow !== mediaWanted) {
                    vtLog('VT_applyEffectPreset: skip ' + mtNow + ' part (preset is ' + mediaWanted + ')');
                    typeSkipped++;
                    continue;
                }
            }
            var clipAppliedAny = false;

            // v3.9.4: effects the preset has but the clip lacks are added
            // first (Premiere Composer style), then their values are applied.
            if (presetOpts.addMissing !== false) {
                try { addedEffects += VT_addMissingVideoEffects(clip, params.effects, presetOpts); } catch (amErr) { vtLog('VT_applyEffectPreset: add-missing warn: ' + amErr); }
            }
            var fxSeen = {};

            for (var e = 0; e < params.effects.length; e++) {
                var savedFx = params.effects[e];
                var mnSaved = savedFx.matchName || '';
                // Apply-options (v3.9.4): leave Motion / Opacity of the clip alone
                if (presetOpts.motion === false && mnSaved === 'AE.ADBE Motion') continue;
                if (presetOpts.opacity === false && mnSaved === 'AE.ADBE Opacity') continue;
                // Time Remapping is the clip's own speed/timing: writing it from a
                // preset could change a video's duration (v3.9.5)
                if (mnSaved === 'AE.ADBE Time Remapping') continue;
                // The n-th saved instance of an effect goes to the n-th instance on
                // the clip (two Gaussian Blurs used to both land on the first one)
                var fxKey = mnSaved || ('dn:' + (savedFx.displayName || ''));
                var wantOcc = fxSeen[fxKey] || 0;
                fxSeen[fxKey] = wantOcc + 1;
                var comp = null;
                var ci;
                var occ = 0;
                for (ci = 0; ci < clip.components.numItems; ci++) {
                    if (mnSaved && clip.components[ci].matchName === mnSaved) {
                        if (occ === wantOcc) { comp = clip.components[ci]; break; }
                        occ++;
                    }
                }
                if (!comp && savedFx.displayName) {
                    occ = 0;
                    for (ci = 0; ci < clip.components.numItems; ci++) {
                        if (clip.components[ci].displayName === savedFx.displayName) {
                            if (occ === wantOcc) { comp = clip.components[ci]; break; }
                            occ++;
                        }
                    }
                }
                if (!comp) {
                    if (savedFx.properties && savedFx.properties.length) {
                        missingProps.push(savedFx.displayName || savedFx.matchName || '?');
                    }
                    continue;
                }
                clipAppliedAny = true;
                if (!savedFx.properties) continue;

                var savedUniform = null;
                var ui;
                for (ui = 0; ui < savedFx.properties.length; ui++) {
                    if (savedFx.properties[ui].displayName === 'Uniform Scale') { savedUniform = savedFx.properties[ui].value; break; }
                }

                var pass;
                for (pass = 0; pass < 3; pass++) {
                    for (var pi = 0; pi < savedFx.properties.length; pi++) {
                        var saved = savedFx.properties[pi];
                        var isBool = saved.valueType === 'boolean';
                        var isColor = false;
                        if (saved.valueType === 'number' && !isBool) {
                            var cv = saved.value;
                            if (typeof cv === 'string' && cv !== '' && !isNaN(cv)) cv = parseFloat(cv);
                            if (vtIsColorValue(cv)) isColor = true;
                        }
                        if (pass === 0 && !isBool) continue;
                        if (pass === 1 && (isBool || isColor)) continue;
                        if (pass === 2 && !isColor) continue;
                        if (saved.valueType === 'null') continue;
                        if (saved.displayName === 'Change Text') continue;
                        if (savedUniform === true && (saved.displayName === 'Scale Width' || saved.displayName === 'Scale Height')) continue;

                        var target = vtFindProp(comp, saved);
                        if (!target) {
                            missingProps.push(saved.displayName || saved.paramName || '?');
                            continue;
                        }
                        if (isColor) {
                            var packedNum = saved.value;
                            if (typeof packedNum === 'string' && packedNum !== '' && !isNaN(packedNum)) packedNum = parseFloat(packedNum);
                            if (vtApplyColorProp(target, saved, packedNum, saved.displayName || saved.paramName || '?')) {
                                appliedProps++;
                            } else {
                                missingProps.push((saved.displayName || saved.paramName || '?') + ' (color failed)');
                            }
                            continue;
                        }
                        try {
                            var v = saved.value;
                            if (saved.valueType === 'number' && typeof v === 'string' && v !== '' && !isNaN(v)) v = parseFloat(v);
                            if (saved.valueType === 'array' && typeof v === 'string') {
                                try { v = JSON.parse(v); } catch (arrErr) { }
                            }
                            // Old presets stored points as "x,y" text - turn them back into numbers
                            if (saved.valueType === 'stringified' && typeof v === 'string' && /^-?[0-9.]+(e-?[0-9]+)?(,-?[0-9.]+(e-?[0-9]+)?)+$/i.test(v)) {
                                var vParts = v.split(',');
                                v = [];
                                for (var vp = 0; vp < vParts.length; vp++) { v.push(parseFloat(vParts[vp])); }
                            }
                            // "Text" off: keep the clip's own words, apply only font/size/style
                            if (presetOpts.text === false && typeof v === 'string' && v.indexOf('"textEditValue"') >= 0) {
                                v = VT_keepTargetText(v, target);
                                if (v === null) { keptTexts++; continue; }
                                keptTexts++;
                            }
                            target.setValue(v, true);
                            appliedProps++;
                        } catch (setErr) {
                            missingProps.push((saved.displayName || saved.paramName || '?') + ' (set failed)');
                        }
                    }
                }
            }

            if (clipAppliedAny) clipsApplied++;
        }

        try {
            var auditSeq = clipsOverride ? null : app.project.activeSequence;
            var auditSel = auditSeq ? auditSeq.getSelection() : null;
            if (auditSel && auditSel.length > 0) {
                var auditClip = auditSel[0];
                for (var aci = 0; aci < auditClip.components.numItems; aci++) {
                    var acomp = auditClip.components[aci];
                    for (var api = 0; api < acomp.properties.numItems; api++) {
                        var aprop = acomp.properties[api];
                        var aval = null;
                        try { aval = aprop.getValue(); } catch (ave) { }
                        if (vtIsColorValue(aval)) {
                            var auditCv = null;
                            try { if (typeof aprop.getColorValue === 'function') auditCv = aprop.getColorValue(); } catch (cvErr) { }
                            vtLog('COLORFIX AUDIT ' + acomp.displayName + ' / ' + aprop.displayName + ' = ' + aval + ' cv=' + String(auditCv));
                        }
                    }
                }
            }
        } catch (auditErr) { vtLog('COLORFIX AUDIT err=' + auditErr.toString()); }
        vtLog('VT_applyEffectPreset: clips=' + clipsApplied + ' appliedProps=' + appliedProps + ' missing=' + missingProps.length + ' keySkipped=' + keySkipped + ' typeSkipped=' + typeSkipped + ' addedEffects=' + addedEffects + ' keptTexts=' + keptTexts + ' [' + missingProps.join(', ') + ']');
        if (clipsApplied === 0) {
            if (keySkipped > 0 && typeSkipped === 0) {
                return JSON.stringify({ success: false, error: (clipKeyWanted.indexOf('mgt') === 0) ? 'Preset is for a different clip (template mismatch)' : 'Preset belongs to a different clip (other media file)' });
            }
            if (typeSkipped > 0) {
                return JSON.stringify({ success: false, error: 'Preset is for the ' + (mediaWanted === 'Audio' ? 'audio' : 'video') + ' part of the clip - select it on the timeline' });
            }
            return JSON.stringify({ success: false, error: 'Preset effects not found on the selected clip' });
        }
        return JSON.stringify({
            success: true,
            clipsApplied: clipsApplied,
            appliedProps: appliedProps,
            missingProps: missingProps,
            addedEffects: addedEffects,
            keptTexts: keptTexts
        });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}
/**
 * Check if there are selected clips on the timeline
 */
/**
 * Selection summary for the Save dialog (v3.9.0).
 * kind = 'mogrt' when every selected clip is a Motion Graphics Template
 * instance (e.g. a title inserted by AtomX). name = first MOGRT's clip name.
 */
function VT_getSelectionInfo() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ hasSelection: false });
        var sel = seq.getSelection();
        if (!sel || sel.length === 0) return JSON.stringify({ hasSelection: false });
        var mgtCount = 0;
        var firstName = '';
        for (var i = 0; i < sel.length; i++) {
            var item = sel[i];
            var isMgt = false;
            try { isMgt = item.isMGT ? !!item.isMGT() : false; } catch (mgtErr) { isMgt = false; }
            if (!isMgt) {
                try {
                    var mp = item.projectItem ? item.projectItem.getMediaPath() : '';
                    isMgt = /\.aegraphic$/i.test(mp || '');
                } catch (mpErr) { isMgt = false; }
            }
            if (isMgt) {
                mgtCount++;
                if (!firstName) { try { firstName = item.name || ''; } catch (nmErr) {} }
            }
        }
        var kind = (mgtCount > 0 && mgtCount === sel.length) ? 'mogrt' : '';
        return JSON.stringify({ hasSelection: true, count: sel.length, kind: kind, name: kind ? firstName : '' });
    } catch (e) {
        vtLog('VT_getSelectionInfo error: ' + e);
        return VT_hasSelection() === 'true' ? JSON.stringify({ hasSelection: true, count: 0, kind: '' }) : JSON.stringify({ hasSelection: false });
    }
}

function VT_hasSelection() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) {
            return 'false';
        }

        var selection = seq.getSelection();
        if (selection && selection.length > 0) {
            return 'true';
        }

        return 'false';
    } catch (e) {
        vtLog('VT_hasSelection error: ' + e);
        return 'false';
    }
}


/**
 * Cleanup .vtbk placeholder files from project bin
 * Called after successful asset insertion to remove leftover placeholders
 */
/**
 * Remove leftover placeholder clips from the ACTIVE timeline and their
 * vt_drag_* / vt_placeholder items from the Project panel. Called after a
 * FAILED insert so nothing VT_* is left behind (AtomX-style: zero leftovers).
 */
function VT_cleanupStrayPlaceholders() {
    try {
        var seq = app.project.activeSequence;
        var removed = 0;
        if (seq) {
            for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
                var tr = seq.videoTracks[vt];
                for (var c = tr.clips.numItems - 1; c >= 0; c--) {
                    var nm = tr.clips[c].name || '';
                    if (nm.match(/\.vtbk$/i) || nm.match(/^vt_placeholder/i) || nm.match(/vt_drag_\d+/i)) {
                        try { tr.clips[c].remove(false, false); removed++; } catch (rmE) {}
                    }
                }
            }
        }
        vtLog('VT_cleanupStrayPlaceholders: removed ' + removed + ' timeline placeholder clip(s)');
    } catch (e) { vtLog('VT_cleanupStrayPlaceholders: error: ' + e); }
    try { VT_cleanupPlaceholdersFromBin(); } catch (e2) { vtLog('VT_cleanupStrayPlaceholders: bin cleanup error: ' + e2); }
    return JSON.stringify({ success: true });
}
function VT_cleanupPlaceholdersFromBin() {
    var removedCount = 0;
    var vtbkPattern = /(\.vtbk|vt_drag_\d+\.(mp3|wav|m4a|aac|ogg|aiff|flac))$/i;

    // Recursive function to find and delete .vtbk items
    function searchAndDeleteInBin(parentItem) {
        if (!parentItem || !parentItem.children) return;

        // Iterate backwards to avoid index issues when deleting
        for (var i = parentItem.children.numItems - 1; i >= 0; i--) {
            var child = parentItem.children[i];

            if (child.type === 2) { // Bin
                searchAndDeleteInBin(child);
            } else if (child.name && child.name.match(vtbkPattern)) {
                // v3.9.12: delete the item itself - one "Delete" step instead of
                // Create bin + Rename + Move + Delete bin in the History panel
                var directGone = false;
                try { child.deleteBin(); directGone = true; removedCount++; vtLog('VT_cleanupPlaceholdersFromBin: Deleted ' + child.name); } catch (dirErr) { directGone = false; }
                if (directGone) continue;
                try {
                    vtLog('VT_cleanupPlaceholdersFromBin: Deleting ' + child.name);
                    if (!$.global.VT_TrashBin) {
                        $.global.VT_TrashBin = app.project.rootItem.createBin('_vt_trash');
                    }
                    child.moveBin($.global.VT_TrashBin);
                    removedCount++;
                } catch (delErr) {
                    vtLog('VT_cleanupPlaceholdersFromBin: Could not delete ' + child.name + ': ' + delErr);
                }
            }
        }
    }

    try {
        // Sweep leftover _vt_trash* bins left behind by older versions or crashes
        try {
            var ri = app.project.rootItem;
            for (var rb = ri.children.numItems - 1; rb >= 0; rb--) {
                var rchild = ri.children[rb];
                if (rchild.type === 2 && rchild.name && (rchild.name.indexOf('_vt_trash') === 0 || rchild.name.indexOf('_vt_delete_') === 0)) {
                    try { rchild.deleteBin(); vtLog('VT_cleanupPlaceholdersFromBin: swept leftover ' + rchild.name); } catch (rdelErr) {}
                }
            }
        } catch (sweepErr) {}
        searchAndDeleteInBin(app.project.rootItem);
        vtLog('VT_cleanupPlaceholdersFromBin: Removed ' + removedCount + ' placeholder(s)');
        try {
            if ($.global.VT_TrashBin) { $.global.VT_TrashBin.deleteBin(); $.global.VT_TrashBin = null; }
        } catch (trashDelErr) { vtLog('VT_cleanupPlaceholdersFromBin: trash bin delete: ' + trashDelErr); }
    } catch (e) {
        vtLog('VT_cleanupPlaceholdersFromBin error: ' + e);
    }

    return removedCount;
}

/**
 * Find placeholder clip on timeline (for drag & drop)
 * Searches for .vtbk clips created by VT_Importer
 * @returns {string} - JSON with placeholder info or 'null' if not found
 */
function VT_findPlaceholder() {
    try {
        var seq = app.project.activeSequence;
        if (!seq) return 'null';

        // Pattern to match .vtbk placeholder files and native temp audio files
        var vtbkPattern = /\.vtbk$/i;
        var vtDragPattern = /vt_drag_\d+\.(vtbk|mp3|wav|m4a|aac|ogg|aiff|flac)$/i;

        // Search video tracks for placeholder
        for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
            var track = seq.videoTracks[vt];
            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.name && (clip.name.match(vtbkPattern) || clip.name.match(vtDragPattern))) {
                    vtLog('VT_findPlaceholder: Found .vtbk at V' + (vt + 1) + ', name: ' + clip.name + ', position: ' + clip.start.seconds);
                    return JSON.stringify({
                        trackIndex: vt,
                        clipIndex: c,
                        startTicks: String(clip.start.ticks), // STRING to avoid large number issues!
                        startSeconds: clip.start.seconds,
                        clipName: clip.name,
                        isVideo: true
                    });
                }
            }
        }

        // Search audio tracks
        for (var at = 0; at < seq.audioTracks.numTracks; at++) {
            var atrack = seq.audioTracks[at];
            for (var ac = 0; ac < atrack.clips.numItems; ac++) {
                var aclip = atrack.clips[ac];
                if (aclip.name && (aclip.name.match(vtbkPattern) || aclip.name.match(vtDragPattern))) {
                    vtLog('VT_findPlaceholder: Found .vtbk at A' + (at + 1));
                    return JSON.stringify({
                        trackIndex: at,
                        clipIndex: ac,
                        startTicks: String(aclip.start.ticks), // STRING to avoid large number issues!
                        startSeconds: aclip.start.seconds,
                        clipName: aclip.name,
                        isVideo: false
                    });
                }
            }
        }

        return 'null';
    } catch (e) {
        vtLog('VT_findPlaceholder error: ' + e);
        return 'null';
    }
}

/**
 * Snapshot all timeline clip nodeIds before a native video drag drop so
 * VT_applySpeedToNewClips can find the clip(s) created by the drop.
 */
function VT_markTimelineSnapshot() {
    try {
        var seq = app.project.activeSequence;
        var ids = {};
        var n = 0;
        if (seq) {
            for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
                var vtrack = seq.videoTracks[sv];
                for (var sc = 0; sc < vtrack.clips.numItems; sc++) {
                    var vclip = vtrack.clips[sc];
                    if (vclip.nodeId) { ids[vclip.nodeId] = true; n++; }
                }
            }
            for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
                var atrack = seq.audioTracks[sa];
                for (var ac = 0; ac < atrack.clips.numItems; ac++) {
                    var aclip = atrack.clips[ac];
                    if (aclip.nodeId) { ids[aclip.nodeId] = true; n++; }
                }
            }
        }
        $.global.VT_timelineSnapshot = ids;
        vtLog('VT_markTimelineSnapshot: ' + n + ' clips');
        return JSON.stringify({ success: true, count: n });
    } catch (e) {
        vtLog('VT_markTimelineSnapshot error: ' + e);
        return JSON.stringify({ success: false, error: String(e) });
    }
}

/**
 * Apply speed to clips that appeared since VT_markTimelineSnapshot (native
 * video drop). QE setSpeed is an absolute value, so applying to both the
 * video clip and its linked audio clip is safe. Returns found=false while
 * the drop has not landed yet - the caller keeps polling.
 */
function VT_applySpeedToNewClips(speed) {
    try {
        var snap = $.global.VT_timelineSnapshot;
        if (!snap) return JSON.stringify({ success: false, error: 'no snapshot' });
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: 'no active sequence' });
        var rate = parseFloat(speed);
        if (isNaN(rate)) rate = 1.0;

        var newV = [];
        var newA = [];
        for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
            var vtrack = seq.videoTracks[sv];
            for (var sc = 0; sc < vtrack.clips.numItems; sc++) {
                var vclip = vtrack.clips[sc];
                if (vclip.nodeId && !snap[vclip.nodeId]) newV.push({ clip: vclip, track: sv });
            }
        }
        for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
            var atrack = seq.audioTracks[sa];
            for (var ac = 0; ac < atrack.clips.numItems; ac++) {
                var aclip = atrack.clips[ac];
                if (aclip.nodeId && !snap[aclip.nodeId]) newA.push({ clip: aclip, track: sa });
            }
        }
        var total = newV.length + newA.length;
        if (total === 0) return JSON.stringify({ success: true, found: false });
        $.global.VT_timelineSnapshot = null;

        var applied = 0;
        if (rate !== 1.0) {
            try {
                $.sleep(80);
                app.enableQE();
                var qeSeq = qe.project.getActiveSequence();
                if (qeSeq) {
                    for (var i = 0; i < newV.length; i++) {
                        if (VT_qeSetSpeedByTicks(qeSeq, true, newV[i].track, newV[i].clip.start.ticks, rate)) applied++;
                    }
                    for (var j = 0; j < newA.length; j++) {
                        if (VT_qeSetSpeedByTicks(qeSeq, false, newA[j].track, newA[j].clip.start.ticks, rate)) applied++;
                    }
                }
            } catch (qeErr) {
                vtLog('VT_applySpeedToNewClips: QE failed: ' + qeErr);
            }
        }
        vtLog('VT_applySpeedToNewClips: found=' + total + ' speed=' + rate + ' applied=' + applied);


        return JSON.stringify({ success: true, found: true, count: total, applied: applied });
    } catch (e) {
        vtLog('VT_applySpeedToNewClips error: ' + e);
        return JSON.stringify({ success: false, error: String(e) });
    }
}

function VT_qeSetSpeedByTicks(qeSeq, isVideo, trackIdx, targetTicks, rate) {
    try {
        var qetrack = isVideo ? qeSeq.getVideoTrackAt(trackIdx) : qeSeq.getAudioTrackAt(trackIdx);
        if (!qetrack) return false;
        for (var qi = 0; qi < qetrack.numItems; qi++) {
            var qeItem = qetrack.getItemAt(qi);
            if (!qeItem || qeItem.type === 'Empty') continue;
            var qeStartTicks = qeItem.start.ticks || qeItem.start || 0;
            var diff = Math.abs(parseInt(String(qeStartTicks), 10) - parseInt(String(targetTicks), 10));
            if (diff < 100) {
                // QE setSpeed quirk: empty timecode first, then timecode when != 1
                qeItem.setSpeed(rate, '', false, false, false);
                if (rate != 1) {
                    qeItem.setSpeed(rate, '00;30;00;00', false, false, false);
                }
                return true;
            }
        }
    } catch (e) {
        vtLog('VT_qeSetSpeedByTicks error: ' + e);
    }
    return false;
}

/**
 * Save asset using native DLL - does everything in one ExtendScript call!
 * No PowerShell, no JS roundtrips
 * @param {string} outputPath - Path to save the .prproj file
 * @returns {string} - JSON with result details
 */
function VT_saveAssetNative(outputPath, skipPreview) {
    try {
        vtLog('VT_saveAssetNative: Starting save to ' + outputPath);

        // Ensure DLL is loaded
        if (!VT_initExtObj()) {
            return JSON.stringify({ success: false, error: 'DLL not available' });
        }

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        var selection = seq.getSelection();
        if (!selection || selection.length === 0) {
            return JSON.stringify({ success: false, error: 'No clips selected' });
        }

        vtLog('VT_saveAssetNative: Saving ' + selection.length + ' clip(s)');

        // Store current state
        var originalSeqId = seq.sequenceID;
        var originalPlayheadTicks = seq.getPlayerPosition().ticks;

        // IMPORTANT: Open sequence to ensure Premiere has focus (not CEP panel)
        // This is needed because user clicked button in CEP panel
        app.project.openSequence(originalSeqId);

        // Use QE API to ensure timeline is active
        if (typeof qe !== 'undefined' && qe && qe.project) {
            try {
                qe.project.getActiveSequence().makeCurrent();
            } catch (qeErr) {
                vtLog('VT_saveAssetNative: QE warning: ' + qeErr);
            }
        }

        // Minimal delay for UI to update
        $.sleep(50);

        // COPY selection using native DLL
        vtLog('VT_saveAssetNative: Copying...');
        var copyResult = VT_executeCommand('cmd.edit.copy');
        vtLog('VT_saveAssetNative: Copy result = ' + copyResult);

        // Create temp sequence
        var tempSeqName = 'VT_Asset_' + new Date().getTime();

        // === IMPORT VIDEOSAMPLE FIRST ===
        // We'll use it as seed to create sequence (avoids New Sequence dialog)
        var extPath = VT_getExtensionPath();
        var videoSamplePath = extPath + '/VideoSampleLong.mp4';
        var videoSampleItem = null;

        vtLog('VT_saveAssetNative: Importing VideoSample from: ' + videoSamplePath);
        var vtSaveT0 = new Date().getTime();

        var videoSampleFile = new File(videoSamplePath);
        if (videoSampleFile.exists) {
            // Import to VibeAssets bin
            var assetsBin = VT_getOrCreateAssetsBin();
            app.project.importFiles([videoSamplePath], false, assetsBin, false);

            // Find the imported item
            for (var vi = 0; vi < assetsBin.children.numItems; vi++) {
                var child = assetsBin.children[vi];
                if (child.name === 'VideoSampleLong.mp4' || child.name === 'VideoSampleLong') {
                    videoSampleItem = child;
                    vtLog('VT_saveAssetNative: Found VideoSample: ' + videoSampleItem.name);
                    break;
                }
            }
            vtLog('VT_saveAssetNative: VideoSample import took ' + (new Date().getTime() - vtSaveT0) + 'ms' + (videoSampleItem ? '' : ' - item NOT found in VibeAssets bin'));
        } else {
            vtLog('VT_saveAssetNative: WARNING - VideoSampleLong.mp4 not found at: ' + videoSamplePath);
        }

        // Create new sequence - use VideoSample as seed (no dialog!)
        var newSeq = null;
        var vtSeqT0 = new Date().getTime();

        if (videoSampleItem) {
            // Best option: use VideoSample to create sequence (VideoSample will be on V1)
            vtLog('VT_saveAssetNative: Creating sequence from VideoSample (no dialog)');
            try {
                newSeq = app.project.createNewSequenceFromClips(tempSeqName, [videoSampleItem], app.project.rootItem);
                vtLog('VT_saveAssetNative: Sequence created from VideoSample');
            } catch (seqErr) {
                vtLog('VT_saveAssetNative: createNewSequenceFromClips with VideoSample failed: ' + seqErr);
            }
        }

        // Fallback: try selection's projectItem. The seed clips it drops into the
        // new sequence are removed below (seed purge) - before v3.9.0 they stayed
        // and a MOGRT asset was saved with the title TWICE.
        if (!newSeq) {
            for (var i = 0; i < selection.length; i++) {
                if (selection[i].projectItem) {
                    try {
                        newSeq = app.project.createNewSequenceFromClips(tempSeqName, [selection[i].projectItem], app.project.rootItem);
                        vtLog('VT_saveAssetNative: Sequence created from selection projectItem');
                        break;
                    } catch (seqErr) {
                        vtLog('VT_saveAssetNative: createNewSequenceFromClips failed: ' + seqErr);
                    }
                }
            }
        }
        vtLog('VT_saveAssetNative: sequence creation took ' + (new Date().getTime() - vtSeqT0) + 'ms');

        if (!newSeq) {
            // Last resort - this will show dialog
            vtLog('VT_saveAssetNative: ERROR - Could not create sequence without dialog. Missing VideoSampleLong.mp4?');
            return JSON.stringify({ success: false, error: 'Could not create sequence. Make sure VideoSampleLong.mp4 exists in extension folder.' });
        }

        var newSeqId = newSeq.sequenceID;

        // Find sequence project item for cleanup
        var seqProjectItem = null;
        for (var j = 0; j < app.project.rootItem.children.numItems; j++) {
            var child = app.project.rootItem.children[j];
            if (child.name === tempSeqName) {
                seqProjectItem = child;
                break;
            }
        }

        // Open new sequence
        app.project.openSequence(newSeqId);

        // === SEED PURGE (v3.9.0) ===
        // The seed (VideoSample, or the selection's own projectItem when the
        // sample import fails) only exists so createNewSequenceFromClips works
        // without the New Sequence dialog. Remove ALL seed clips BEFORE pasting:
        //  - a projectItem seed (e.g. an AtomX MOGRT) used to stay in the
        //    sequence and was exported next to the pasted copy (title saved twice)
        //  - a VideoSample leftover stretched the preview to the 32 s sample and
        //    made every save ~20 s slower
        //  - pasting into an empty sequence with V1/A1 targeted lands the clips
        //    on V1/A1 directly, so the normalization copy/paste round-trip is
        //    no longer needed.
        // Seeds are identified by nodeId snapshot (works for any seed type);
        // anything that survives removal here is removed again after the paste.
        var vtSeedIds = {};
        var vtSeedCount = 0;
        var vtSeedRemoved = 0;
        var sdt, sdc;
        for (sdt = 0; sdt < newSeq.videoTracks.numTracks; sdt++) {
            for (sdc = 0; sdc < newSeq.videoTracks[sdt].clips.numItems; sdc++) { vtSeedIds[newSeq.videoTracks[sdt].clips[sdc].nodeId] = true; vtSeedCount++; }
        }
        for (sdt = 0; sdt < newSeq.audioTracks.numTracks; sdt++) {
            for (sdc = 0; sdc < newSeq.audioTracks[sdt].clips.numItems; sdc++) { vtSeedIds[newSeq.audioTracks[sdt].clips[sdc].nodeId] = true; vtSeedCount++; }
        }
        vtSeedRemoved = VT_removeClipsByNodeIds(newSeq, vtSeedIds);
        vtLog('VT_saveAssetNative: seed purge removed ' + vtSeedRemoved + '/' + vtSeedCount + ' seed clip(s) before paste');

        // The sample project item is no longer referenced - drop it now so it
        // cannot leak into the exported .prproj.
        if (videoSampleItem && vtSeedRemoved === vtSeedCount) {
            try { videoSampleItem.deleteBin(); videoSampleItem = null; vtLog('VT_saveAssetNative: VideoSample removed from project (early)'); }
            catch (earlyVsErr) { vtLog('VT_saveAssetNative: early VideoSample delete warn: ' + earlyVsErr); }
        }

        // Count clips before paste (video+audio, matching VT_waitForPaste's count).
        var clipsBefore = VT_countSequenceClips(newSeq);
        vtLog('VT_saveAssetNative: Clips before paste = ' + clipsBefore);

        // Set playhead to beginning
        newSeq.setPlayerPosition('0');

        // Kept for the cleanup code below (seed clips are already gone).
        var videoSampleClip = null;
        var videoSampleAudioClip = null;

        // Target V1/A1: the sequence is empty, so the pasted selection keeps its
        // relative track layout starting at V1/A1 (= normalized asset).
        vtLog('VT_saveAssetNative: Setting targeting to V1/A1...');
        VT_setTrackTargeting(newSeq, 0, 0);

        // Use QE API to ensure sequence is active in UI
        if (typeof qe !== 'undefined' && qe && qe.project) {
            try {
                qe.project.getActiveSequence().makeCurrent();
            } catch (qeErr) {
                vtLog('VT_saveAssetNative: QE warning: ' + qeErr);
            }
        }

        // Minimal delay - drag & drop has none, but we need UI to catch up
        $.sleep(50);

        // PASTE using native DLL
        vtLog('VT_saveAssetNative: Pasting...');
        var pasteResult = VT_executeCommand('cmd.edit.paste');
        vtLog('VT_saveAssetNative: Paste result = ' + pasteResult);

        // Wait for the paste to actually land before counting - an immediate read
        // returns a stale count and would export an EMPTY .prproj (asset with no clips).
        // 700 ms is plenty when the paste lands (it lands in ~40 ms); a miss is
        // retried below - the old 1500 ms wait just added dead time to saves.
        var clipsAfter = VT_waitForPaste(newSeq, clipsBefore, 700);
        vtLog('VT_saveAssetNative: Clips after paste = ' + clipsAfter);

        if (clipsAfter <= clipsBefore) {
            // Retry: the DLL paste uses SendInput (synthetic Ctrl+V) which goes
            // to the FOCUSED window. When the CEP panel has keyboard focus the
            // keystrokes miss the timeline. app.executeCommand does NOT exist
            // in Premiere ExtendScript (After Effects only), so a second DLL
            // paste after a short settle is the best available retry.
            vtLog('VT_saveAssetNative: DLL paste did not land, retrying...');
            $.sleep(200);
            // Re-check first: a late-landing first paste must not be doubled.
            clipsAfter = VT_countSequenceClips(newSeq);
            if (clipsAfter <= clipsBefore) {
                VT_executeCommand('cmd.edit.paste');
                clipsAfter = VT_waitForPaste(newSeq, clipsBefore, 2000);
                vtLog('VT_saveAssetNative: Retry paste -> ' + clipsAfter);
            } else {
                vtLog('VT_saveAssetNative: first paste landed late (' + clipsAfter + ' clips) - no retry');
            }
        }

        // Let a multi-clip paste finish landing (the count can grow for a few
        // frames), then drop any seed clip that survived the pre-paste purge.
        if (clipsAfter > clipsBefore) {
            clipsAfter = VT_waitForStableCount(newSeq, clipsAfter, 200);
            var vtLateSeeds = VT_removeClipsByNodeIds(newSeq, vtSeedIds);
            if (vtLateSeeds > 0) {
                vtLog('VT_saveAssetNative: removed ' + vtLateSeeds + ' leftover seed clip(s) after paste');
                clipsBefore = Math.max(0, clipsBefore - vtLateSeeds);
                clipsAfter = VT_countSequenceClips(newSeq);
            }
        }

        // Validate the user's clips made it in. VideoSample itself sits on V1, so a
        // real success has MORE clips than the sample-only baseline.
        if (clipsAfter <= clipsBefore) {
            // Clean up before bailing out: close/restore/purge so no VT_Asset_*
            // sequence or VideoSample import is left behind on a failed save.
            try { newSeq.close(); } catch (failCloseErr) { vtLog('VT_saveAssetNative: fail-close warning: ' + failCloseErr); }
            try { app.project.openSequence(originalSeqId); app.project.activeSequence.setPlayerPosition(originalPlayheadTicks); } catch (failRestoreErr) {}
            if (videoSampleItem) {
                try { videoSampleItem.deleteBin(); } catch (failVsErr) {}
            }
            VT_purgeAssetSeq(tempSeqName, newSeq);
            return JSON.stringify({
                success: false,
                error: 'Paste produced no clips - nothing was saved. Click the timeline and try again.'
            });
        }

        // === REMOVE VIDEOSAMPLE FROM V1 AND A1 ===
        // We need to remove it before export so it's not included in .prproj
        if (videoSampleClip) {
            try {
                vtLog('VT_saveAssetNative: Removing VideoSample video from V1...');
                videoSampleClip.remove(false, false);
                vtLog('VT_saveAssetNative: VideoSample video removed');
            } catch (remErr) {
                vtLog('VT_saveAssetNative: Error removing VideoSample video: ' + remErr);
            }
        }

        // Also remove VideoSample audio from A1
        if (videoSampleAudioClip) {
            try {
                vtLog('VT_saveAssetNative: Removing VideoSample audio from A1...');
                videoSampleAudioClip.remove(false, false);
                vtLog('VT_saveAssetNative: VideoSample audio removed');
            } catch (remAudioErr) {
                vtLog('VT_saveAssetNative: Error removing VideoSample audio: ' + remAudioErr);
            }
        }

        // Also remove VideoSample from project bin
        if (videoSampleItem) {
            try {
                videoSampleItem.deleteBin();
                vtLog('VT_saveAssetNative: VideoSample removed from project');
            } catch (delVsErr) {
                vtLog('VT_saveAssetNative: Could not remove VideoSample from project: ' + delVsErr);
            }
        }

        // NORMALIZATION: Move all clips to V1/A1 for correct track targeting on apply
        // IMPORTANT: We must use select+copy+paste to preserve effects!
        // overwriteClip() creates new clips and loses all applied effects!
        vtLog('VT_saveAssetNative: Normalizing clips to V1/A1...');

        // Find the lowest used video track (should be V2 since VideoSample was on V1)
        var lowestVideoTrack = -1;
        for (var vn = 0; vn < newSeq.videoTracks.numTracks; vn++) {
            if (newSeq.videoTracks[vn].clips.numItems > 0) {
                lowestVideoTrack = vn;
                break;
            }
        }

        // Find the lowest used audio track  
        var lowestAudioTrack = -1;
        for (var an = 0; an < newSeq.audioTracks.numTracks; an++) {
            if (newSeq.audioTracks[an].clips.numItems > 0) {
                lowestAudioTrack = an;
                break;
            }
        }

        vtLog('VT_saveAssetNative: Lowest video track = V' + (lowestVideoTrack + 1) + ', audio = A' + (lowestAudioTrack + 1));

        // If clips are not on V1, we need to move them using copy/paste
        if (lowestVideoTrack > 0) {
            vtLog('VT_saveAssetNative: Clips on V' + (lowestVideoTrack + 1) + ', need to move to V1 using copy/paste...');

            // Step 1: Select all clips on sequence
            var allClips = [];
            for (var vSel = 0; vSel < newSeq.videoTracks.numTracks; vSel++) {
                var vTrackSel = newSeq.videoTracks[vSel];
                for (var vClipSel = 0; vClipSel < vTrackSel.clips.numItems; vClipSel++) {
                    allClips.push(vTrackSel.clips[vClipSel]);
                }
            }
            for (var aSel = 0; aSel < newSeq.audioTracks.numTracks; aSel++) {
                var aTrackSel = newSeq.audioTracks[aSel];
                for (var aClipSel = 0; aClipSel < aTrackSel.clips.numItems; aClipSel++) {
                    allClips.push(aTrackSel.clips[aClipSel]);
                }
            }

            vtLog('VT_saveAssetNative: Found ' + allClips.length + ' clips to move');

            if (allClips.length > 0) {
                // Select all clips
                try {
                    newSeq.setSelection(allClips);
                    vtLog('VT_saveAssetNative: Selected ' + allClips.length + ' clips');
                } catch (selErr) {
                    vtLog('VT_saveAssetNative: Selection error: ' + selErr);
                }

                // Copy
                $.sleep(50);
                var normCopyResult = VT_executeCommand('cmd.edit.copy');
                vtLog('VT_saveAssetNative: Norm copy result: ' + normCopyResult);

                // Paste to V1/A1 FIRST and WAIT until the clips actually land -
                // the old flow deleted the originals before the paste completed,
                // so a slow paste exported an EMPTY .prproj (asset with no clips).
                VT_setTrackTargeting(newSeq, 0, 0);
                newSeq.setPlayerPosition('0');

                var normBaseCount = VT_countSequenceClips(newSeq);
                $.sleep(50);
                var normPasteResult = VT_executeCommand('cmd.edit.paste');
                vtLog('VT_saveAssetNative: Norm paste result: ' + normPasteResult);
                var normAfterCount = VT_waitForPaste(newSeq, normBaseCount, 1000);

                if (normAfterCount <= normBaseCount) {
                    // Retry once - clipboard is still primed
                    $.sleep(100);
                    normPasteResult = VT_executeCommand('cmd.edit.paste');
                    normAfterCount = VT_waitForPaste(newSeq, normBaseCount, 1000);
                    vtLog('VT_saveAssetNative: Norm paste retry -> ' + normAfterCount);
                }

                if (normAfterCount > normBaseCount) {
                    // Pasted copy is safely on V1/A1 - now remove the originals
                    for (var delIdx = allClips.length - 1; delIdx >= 0; delIdx--) {
                        try {
                            allClips[delIdx].remove(false, false);
                        } catch (delClipErr) {
                            // Ignore - clip might already be be gone
                        }
                    }
                    vtLog('VT_saveAssetNative: Deleted original clips after verified paste');
                } else {
                    vtLog('VT_saveAssetNative: WARNING - normalization paste failed, keeping originals (export may be off V1)');
                }
            }
        } else {
            vtLog('VT_saveAssetNative: Clips already on V1, no normalization needed');
        }

        vtLog('VT_saveAssetNative: Normalization complete');

        // === RENDER PREVIEW ===
        // Render AFTER normalization + VideoSample removal so the preview shows the
        // user's own clips/effects - not the VideoSample background (wrong preview).
        var previewGenerated = false;
        var previewPath = outputPath.replace(/\.prproj$/i, '.mp4');

        vtLog('VT_saveAssetNative: Preview output path: ' + previewPath);
        vtLog('VT_saveAssetNative: clipsBefore=' + clipsBefore + ', clipsAfter=' + clipsAfter);

        // Sweep VideoSample clips BEFORE measuring/rendering: a leftover sample
        // stretched In/Out to its 32 s length (~20 s render) and showed the
        // fire clip instead of the user's content in the preview.
        var vtPreSweep = VT_removeVideoSampleClips(newSeq);
        if (vtPreSweep > 0) {
            vtLog('VT_saveAssetNative: pre-render sweep removed ' + vtPreSweep + ' VideoSample clip(s)');
        }

        if (!skipPreview && clipsAfter > clipsBefore) {
            vtLog('VT_saveAssetNative: Generating preview...');
            var vtRenderT0 = new Date().getTime();

            try {
                // Get preset path - normalize slashes for Windows
                var presetPath = extPath + '/VT_Preview_480p.epr';
                // Convert forward slashes to backslashes for Windows
                presetPath = presetPath.replace(/\//g, '\\');

                vtLog('VT_saveAssetNative: Extension path: ' + extPath);
                vtLog('VT_saveAssetNative: Preset path: ' + presetPath);

                var presetFile = new File(presetPath);
                vtLog('VT_saveAssetNative: Preset file exists: ' + presetFile.exists);

                if (presetFile.exists) {
                    vtLog('VT_saveAssetNative: Using preset: ' + presetPath);

                    // Duration of all clips (they now live on V1/A1)
                    var maxEndTime = 0;
                    for (var vTrackIdx = 0; vTrackIdx < newSeq.videoTracks.numTracks; vTrackIdx++) {
                        var vTrack = newSeq.videoTracks[vTrackIdx];
                        for (var clipIdx = 0; clipIdx < vTrack.clips.numItems; clipIdx++) {
                            var clip = vTrack.clips[clipIdx];
                            var clipEnd = clip.end.seconds;
                            if (clipEnd > maxEndTime) {
                                maxEndTime = clipEnd;
                            }
                        }
                    }
                    for (var aTrackIdx = 0; aTrackIdx < newSeq.audioTracks.numTracks; aTrackIdx++) {
                        var aTrack = newSeq.audioTracks[aTrackIdx];
                        for (var aClipIdx = 0; aClipIdx < aTrack.clips.numItems; aClipIdx++) {
                            var aClip = aTrack.clips[aClipIdx];
                            var aClipEnd = aClip.end.seconds;
                            if (aClipEnd > maxEndTime) {
                                maxEndTime = aClipEnd;
                            }
                        }
                    }

                    vtLog('VT_saveAssetNative: Clips max end time: ' + maxEndTime + 's');

                    // The preview is a hover thumbnail - cap its length so long
                    // assets do not block Premiere for the whole render.
                    var vtCap = VT_PREVIEW_MAX_SECONDS;
                    var vtAllMgt = true;
                    var vtSaveClips = VT_collectAllClips(newSeq);
                    for (var vmg = 0; vmg < vtSaveClips.length; vmg++) {
                        var vtIsMgt = false;
                        try { vtIsMgt = vtSaveClips[vmg].isMGT ? !!vtSaveClips[vmg].isMGT() : false; } catch (mgErr) {}
                        if (!vtIsMgt) { vtAllMgt = false; break; }
                    }
                    if (vtAllMgt && vtSaveClips.length > 0) { vtCap = VT_PREVIEW_MAX_SECONDS_MOGRT; }
                    if (maxEndTime > vtCap) {
                        vtLog('VT_saveAssetNative: preview capped to ' + vtCap + 's (asset is ' + maxEndTime + 's' + (vtAllMgt ? ', MOGRT' : '') + ')');
                        maxEndTime = vtCap;
                    }

                    // Set In/Out points to match clip duration
                    if (maxEndTime > 0) {
                        newSeq.setInPoint(0);
                        newSeq.setOutPoint(maxEndTime);
                        vtLog('VT_saveAssetNative: Set In/Out points: 0 to ' + maxEndTime + 's');
                    }

                    // Render preview using IN_TO_OUT (respects In/Out points)
                    vtLog('VT_saveAssetNative: Starting render to: ' + previewPath);
                    vtLog('VT_saveAssetNative: app.encoder available: ' + (typeof app.encoder !== 'undefined'));

                    var renderResult = newSeq.exportAsMediaDirect(previewPath, presetPath, app.encoder.ENCODE_IN_TO_OUT);
                    vtLog('VT_saveAssetNative: Render result: ' + renderResult);

                    // Check if preview was created (poll instead of a fixed 500 ms wait)
                    var previewFileCheck = new File(previewPath);
                    var vtPrevWait = 0;
                    while (!previewFileCheck.exists && vtPrevWait < 500) {
                        $.sleep(50);
                        vtPrevWait += 50;
                        previewFileCheck = new File(previewPath);
                    }
                    vtLog('VT_saveAssetNative: render took ' + (new Date().getTime() - vtRenderT0) + 'ms');
                    vtLog('VT_saveAssetNative: Preview file exists after render: ' + previewFileCheck.exists);

                    if (previewFileCheck.exists) {
                        vtLog('VT_saveAssetNative: Preview generated successfully!');
                        previewGenerated = true;
                    } else {
                        vtLog('VT_saveAssetNative: Preview file not found after render');
                    }
                } else {
                    vtLog('VT_saveAssetNative: WARNING - Preset not found: ' + presetPath);
                }
            } catch (renderErr) {
                vtLog('VT_saveAssetNative: Preview render error: ' + renderErr);
            }
        } else {
            vtLog('VT_saveAssetNative: Skipping preview' + (skipPreview ? ' (fast preset save)' : ' - no clips to render'));
        }

        // FINAL SWEEP: remove any VideoSample clips that survived earlier removal
        // (paste can shift tracks/indices; belt-and-suspenders before export).
        // The fire sample must NEVER end up in the exported .prproj - old leaky
        // assets caused users to see a fire clip appear when applying saved effects.
        var sweptCount = VT_removeVideoSampleClips(newSeq);
        if (sweptCount > 0) {
            vtLog('VT_saveAssetNative: Final sweep removed ' + sweptCount + ' leftover VideoSample clip(s)');
        }

        // Final sanity check - never export an empty sequence (it would create an
        // asset that cannot be inserted: "No clips in asset")
        var exportClipCount = VT_countSequenceClips(newSeq);
        if (exportClipCount === 0) {
            try { newSeq.close(); } catch (fcErr) {}
            try { app.project.openSequence(originalSeqId); app.project.activeSequence.setPlayerPosition(originalPlayheadTicks); } catch (frErr) {}
            if (videoSampleItem) { try { videoSampleItem.deleteBin(); } catch (fvsErr) {} }
            VT_purgeAssetSeq(tempSeqName, newSeq);
            return JSON.stringify({ success: false, error: 'Save produced an empty sequence - nothing was saved. Try again.' });
        }
        vtLog('VT_saveAssetNative: Final clip count before export = ' + exportClipCount);

        // Diagnostics: log clips being exported (MOGRT/graphics clips may have no projectItem)
        for (var dvt = 0; dvt < newSeq.videoTracks.numTracks; dvt++) {
            var dTrack = newSeq.videoTracks[dvt];
            for (var dc = 0; dc < dTrack.clips.numItems; dc++) {
                var dClip = dTrack.clips[dc];
                var dMedia = '';
                try { if (dClip.projectItem) { dMedia = ' media=' + dClip.projectItem.getMediaPath(); } } catch (dMe) {}
                vtLog('VT_saveAssetNative: export clip V' + (dvt + 1) + ' "' + dClip.name + '"' + (dClip.projectItem ? '' : ' [no projectItem]') + dMedia);
            }
        }

        // Export
        vtLog('VT_saveAssetNative: Exporting...');
        var exportError = null;
        try {
            newSeq.exportAsProject(outputPath);
            var exportFileCheck = new File(outputPath);
            vtLog('VT_saveAssetNative: exportAsProject done, file exists: ' + exportFileCheck.exists);
            if (!exportFileCheck.exists) {
                exportError = 'exportAsProject produced no file at ' + outputPath;
            }
        } catch (expErr) {
            vtLog('VT_saveAssetNative: exportAsProject FAILED: ' + expErr);
            exportError = 'Export failed: ' + expErr;
            if (!app.project.path) {
                exportError += ' (project is unsaved - press Ctrl+S in Premiere and retry)';
            }
        }

        // Prime the clipboard fast-path: copy the exported clips so the FIRST
        // apply pastes directly without importing/opening a VT_Asset sequence.
        // Self-healing: if this copy misses, apply-side name verification fails
        // and the slow path re-primes the cache.
        if (!exportError) {
            try {
                var vtActiveNow = app.project.activeSequence;
                if (!vtActiveNow || vtActiveNow.sequenceID !== newSeq.sequenceID) {
                    try { app.project.openSequence(newSeq.sequenceID); } catch (vsErr) {}
                }
                VT_executeCommand('cmd.focus.timeline');
                VT_executeCommand('cmd.panel.focus.timeline');
                VT_executeCommand('cmd.timeline.focus');
                $.sleep(50);
                var vtPrimeClips = [];
                var vtPv, vtPc, vtPtr;
                for (vtPv = 0; vtPv < newSeq.videoTracks.numTracks; vtPv++) {
                    vtPtr = newSeq.videoTracks[vtPv];
                    for (vtPc = 0; vtPc < vtPtr.clips.numItems; vtPc++) { vtPrimeClips.push(vtPtr.clips[vtPc]); }
                }
                for (vtPv = 0; vtPv < newSeq.audioTracks.numTracks; vtPv++) {
                    vtPtr = newSeq.audioTracks[vtPv];
                    for (vtPc = 0; vtPc < vtPtr.clips.numItems; vtPc++) { vtPrimeClips.push(vtPtr.clips[vtPc]); }
                }
                if (vtPrimeClips.length > 0) {
                    newSeq.setSelection(vtPrimeClips);
                    var vtPrimeCopy = VT_executeCommand('cmd.edit.copy');
                    if (vtPrimeCopy === true || vtPrimeCopy === 'true') {
                        var vtPrimeN = VT_setClipboardCache(outputPath, vtPrimeClips);
                        VT_markVerified(VT_clipSignatures(vtPrimeClips));
                        vtLog('VT_saveAssetNative: clipboard primed for fast apply (' + vtPrimeN + ' clips)');
                    } else {
                        vtLog('VT_saveAssetNative: prime copy failed - fast apply unavailable until next apply');
                    }
                }
            } catch (primeErr) { vtLog('VT_saveAssetNative: clipboard prime warn: ' + primeErr); }
        }

        // Close temp sequence first (removes the tab)
        vtLog('VT_saveAssetNative: Closing temp sequence...');
        try {
            newSeq.close();
        } catch (closeErr) {
            vtLog('VT_saveAssetNative: Close warning: ' + closeErr);
        }

        // Switch back to original sequence
        try {
            app.project.openSequence(originalSeqId);
            app.project.activeSequence.setPlayerPosition(originalPlayheadTicks);
        } catch (restoreErr) {
            vtLog('VT_saveAssetNative: restore warning: ' + restoreErr);
        }

        // Wait a bit for sequence switch
        $.sleep(100);

        // Cleanup temp sequence - prefer the verified purge helper (verifies the
        // sequence is really gone); name-search moveBin stays as last-resort fallback
        vtLog('VT_saveAssetNative: Cleaning up temp sequence: ' + tempSeqName);
        var vtSavePurged = false;
        try { vtSavePurged = VT_purgeAssetSeq(tempSeqName, newSeq); } catch (purgeErr) { vtLog('VT_saveAssetNative: purge helper error: ' + purgeErr); }
        if (vtSavePurged) {
            vtLog('VT_saveAssetNative: temp sequence purged');
        } else {
        try {
            // Find the temp sequence project item
            var tempItem = null;
            for (var k = 0; k < app.project.rootItem.children.numItems; k++) {
                var item = app.project.rootItem.children[k];
                if (item.name === tempSeqName) {
                    tempItem = item;
                    break;
                }
            }

            if (tempItem) {
                // v3.9.12: delete the item directly (one step); the temp-bin
                // workaround - without the qe undo that left greyed steps - only
                // as a fallback
                try {
                    tempItem.deleteBin();
                    vtLog('VT_saveAssetNative: temp sequence item deleted');
                } catch (directDelErr) {
                    var deleteBin = app.project.rootItem.createBin('_vt_to_delete_');
                    tempItem.moveBin(deleteBin);
                    deleteBin.deleteBin();
                    vtLog('VT_saveAssetNative: Deleted via moveBin workaround');
                }
            } else {
                vtLog('VT_saveAssetNative: Could not find temp sequence to delete');
            }
        } catch (delErr) {
            vtLog('VT_saveAssetNative: Cleanup error: ' + delErr);
        }
        }

        if (exportError) {
            vtLog('VT_saveAssetNative: FAILED - ' + exportError);
            return JSON.stringify({ success: false, error: exportError });
        }

        vtLog('VT_saveAssetNative: SUCCESS! (' + (new Date().getTime() - vtSaveT0) + 'ms after import start)');
        return JSON.stringify({
            success: true,
            copyResult: copyResult,
            pasteResult: pasteResult,
            clipsSelected: selection.length,
            clipsBefore: clipsBefore,
            clipsAfter: clipsAfter,
            outputPath: outputPath,
            previewGenerated: previewGenerated,
            previewPath: previewGenerated ? previewPath : null
        });

    } catch (e) {
        vtLog('VT_saveAssetNative error: ' + e + (e.line ? ' (line ' + e.line + ')' : ''));
        return JSON.stringify({ success: false, error: e.toString() + (e.line ? ' [line ' + e.line + ']' : '') });
    }
}

/**
 * FAST apply path: paste directly from the primed clipboard cache
 * ($.global.VT_ClipboardCache - set by VT_saveAssetNative or the previous
 * slow-path apply). Skips the .prproj import and the VT_Asset sequence
 * switch entirely - nothing new opens on the timeline.
 * Pasted clips are verified by name against the cache; on mismatch they are
 * removed and null is returned so the caller runs the full slow path.
 * @param {string} assetPath - asset .prproj path (cache key)
 * @param {object} targetSeq - sequence to paste into (active at call time)
 * @param {string} targetPlayheadTicks - paste position (ticks)
 * @returns {string} JSON result on success, null when cache missing/stale
 */
function VT_applyFromClipboardCache(assetPath, targetSeq, targetPlayheadTicks) {
    try {
        var cache = $.global.VT_ClipboardCache;
        if (!cache || cache.path !== assetPath || !cache.names || cache.names.length === 0) {
            return null;
        }
        if (!targetSeq) return null;

        var clipsBefore = VT_snapshotClips(targetSeq);

        // Playhead + timeline focus, then paste. The target sequence never
        // changed (no import, no switch) so no VT_Asset tab appears.
        try { targetSeq.setPlayerPosition(targetPlayheadTicks); } catch (posErr) {}
        VT_executeCommand('cmd.focus.timeline');
        VT_executeCommand('cmd.panel.focus.timeline');
        VT_executeCommand('cmd.timeline.focus');
        $.sleep(50);
        var pasteOk = VT_executeCommand('cmd.edit.paste');
        vtLog('VT_FAST: paste=' + pasteOk);

        var newClips = VT_waitForNewClips(targetSeq, clipsBefore, 800, targetPlayheadTicks);
        if (newClips.length === 0) {
            // Ctrl+V went to another window (focus). The clipboard itself is
            // still fine - let the panel restore focus and retry.
            vtLog('VT_FAST: nothing pasted (focus) - retry');
            return JSON.stringify({ success: false, retry: 'focus', error: 'Paste did not reach the timeline' });
        }

        // Verify the pasted clips ARE this asset (name + duration + parameter
        // values). The clipboard may hold something else: a copy that missed,
        // the user's own Ctrl+C, another asset built from the same template.
        var why = VT_pasteMismatch(newClips, cache);
        if (why) {
            vtLog('VT_FAST: pasted content is NOT this asset (' + why + ') - removing it');
            var badIds = {};
            for (var bi = 0; bi < newClips.length; bi++) { badIds[newClips[bi].nodeId] = true; }
            VT_removeClipsByNodeIds(targetSeq, badIds);
            $.global.VT_ClipboardCache = null;
            try { targetSeq.setPlayerPosition(String(targetPlayheadTicks)); } catch (rpBadErr) {}
            if (VT_collectNewClips(targetSeq, clipsBefore).length > 0) {
                return JSON.stringify({
                    success: false,
                    error: 'Clipboard contained foreign clips - could not remove them, press Ctrl+Z and retry',
                    clipsCount: 0
                });
            }
            return JSON.stringify({ success: false, retry: 'reprime', error: 'Clipboard held other content' });
        }

        try { targetSeq.setSelection(newClips); } catch (selErr) { vtLog('VT_FAST: setSelection warn: ' + selErr); }
        try { VT_scaleClipsToFit(newClips, targetSeq); } catch (se) { vtLog('VT_FAST: scale warn: ' + se); }

        VT_purgeCachedAssetSeqAfterPaste(assetPath);
        // Keep the playhead where it was (Paste parks it at the clip end)
        try { targetSeq.setPlayerPosition(String(targetPlayheadTicks)); } catch (rpErr) {}
        VT_markVerified(VT_clipSignatures(newClips));
        vtLog('VT_FAST: SUCCESS ' + newClips.length + ' clips (verified, no sequence switch)');
        return JSON.stringify({
            success: true,
            copyResult: 'cache',
            pasteResult: true,
            clipsCount: newClips.length,
            fastPath: true
        });
    } catch (e) {
        vtLog('VT_applyFromClipboardCache error: ' + e);
        return null;
    }
}

/**
 * Import (or reuse) an asset's sequence and return it, or null.
 */
function VT_importAssetSeq(assetPath) {
    var importedSeq = VT_findCachedAssetSeq(assetPath);
    if (importedSeq) return importedSeq;
    var existingSeqIds = {};
    var s;
    for (s = 0; s < app.project.sequences.numSequences; s++) {
        existingSeqIds[app.project.sequences[s].sequenceID] = true;
    }
    var assetsBin = VT_getOrCreateAssetsBin();
    app.project.importFiles([assetPath], true, assetsBin, false);
    for (s = 0; s < app.project.sequences.numSequences; s++) {
        if (!existingSeqIds[app.project.sequences[s].sequenceID]) {
            importedSeq = app.project.sequences[s];
            break;
        }
    }
    if (importedSeq) { VT_cacheAssetSeq(assetPath, importedSeq); }
    return importedSeq;
}

/**
 * CLIPBOARD PRIMING, step 1 of 2 (v3.9.2).
 * Opens the asset's sequence with all its clips selected and returns to the
 * panel. The panel then moves OS keyboard focus to the timeline window
 * (VT_WMCommand focusfix) and calls VT_primeCopy(). Copying in a separate
 * call is what makes the synthetic Ctrl+C reliably hit the ASSET sequence:
 * in one call it often hit the user's timeline and copied whatever was
 * selected there (the "copy of the previous media" bug).
 * force=true ignores an existing cache entry (used after a mismatch).
 * Returns JSON { success, cached, opened, clips, error? }.
 */
function VT_primeOpen(assetPath, force) {
    try {
        var cache = $.global.VT_ClipboardCache;
        if (!force && cache && cache.path === assetPath && cache.names && cache.names.length > 0) {
            vtLog('PRIME: already primed for ' + assetPath);
            return JSON.stringify({ success: true, cached: true, opened: false, clips: cache.names.length });
        }
        $.global.VT_ClipboardCache = null;
        if (!VT_initExtObj()) return JSON.stringify({ success: false, error: 'DLL not available' });
        var targetSeq = app.project.activeSequence;
        if (!targetSeq) return JSON.stringify({ success: false, error: 'No active sequence' });
        if (!(new File(assetPath)).exists) return JSON.stringify({ success: false, error: 'File not found' });

        var t0 = new Date().getTime();
        var importedSeq = VT_importAssetSeq(assetPath);
        if (!importedSeq) return JSON.stringify({ success: false, error: 'Could not find imported sequence' });
        var clips = VT_collectAllClips(importedSeq);
        if (clips.length === 0) {
            VT_purgeAssetSeq(assetPath, importedSeq);
            return JSON.stringify({ success: false, error: 'No clips in asset' });
        }

        $.global.VT_PrimeState = {
            path: assetPath,
            assetSeqId: importedSeq.sequenceID,
            targetSeqId: targetSeq.sequenceID,
            targetPlayhead: String(targetSeq.getPlayerPosition().ticks)
        };
        // A misdirected Ctrl+C must find NOTHING selected on the user's timeline
        VT_deselectAll(targetSeq);

        app.project.openSequence(importedSeq.sequenceID);
        if (typeof qe !== 'undefined' && qe && qe.project) {
            try { qe.project.getActiveSequence().makeCurrent(); } catch (mcErr) {}
        }
        importedSeq.setSelection(clips);
        vtLog('PRIME: opened asset sequence (' + clips.length + ' clips) in ' + (new Date().getTime() - t0) + 'ms');
        return JSON.stringify({ success: true, cached: false, opened: true, clips: clips.length });
    } catch (e) {
        vtLog('PRIME open: error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * CLIPBOARD PRIMING, step 2 of 2: copy the selected asset clips, record what
 * was copied, then return to the user's sequence.
 */
function VT_primeCopy(assetPath) {
    var st = $.global.VT_PrimeState;
    try {
        if (!st || st.path !== assetPath) return JSON.stringify({ success: false, error: 'prime step 1 missing' });
        var assetSeq = null;
        for (var i = 0; i < app.project.sequences.numSequences; i++) {
            if (app.project.sequences[i].sequenceID === st.assetSeqId) { assetSeq = app.project.sequences[i]; break; }
        }
        if (!assetSeq) return JSON.stringify({ success: false, error: 'asset sequence gone' });

        var active = app.project.activeSequence;
        if (!active || active.sequenceID !== assetSeq.sequenceID) {
            app.project.openSequence(assetSeq.sequenceID);
        }
        var clips = VT_collectAllClips(assetSeq);
        assetSeq.setSelection(clips);
        var copyResult = VT_executeCommand('cmd.edit.copy');
        var primed = (copyResult === true || copyResult === 'true') && clips.length > 0;
        if (primed) { VT_setClipboardCache(assetPath, clips); }
        vtLog('PRIME: copy ' + (primed ? 'sent (' + clips.length + ' clips)' : 'FAILED'));
        return JSON.stringify({ success: primed, switched: true, clips: clips.length, error: primed ? '' : 'copy failed' });
    } catch (e) {
        vtLog('PRIME copy: error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    } finally {
        // Always go back to the user's sequence and playhead
        try {
            if (st) {
                for (var j = 0; j < app.project.sequences.numSequences; j++) {
                    var sq = app.project.sequences[j];
                    if (sq.sequenceID === st.assetSeqId) { try { sq.close(); } catch (cErr) {} break; }
                }
                app.project.openSequence(st.targetSeqId);
                if (typeof qe !== 'undefined' && qe && qe.project) {
                    try { qe.project.getActiveSequence().makeCurrent(); } catch (mc2Err) {}
                }
                try { app.project.activeSequence.setPlayerPosition(st.targetPlayhead); } catch (phErr) {}
            }
        } catch (backErr) { vtLog('PRIME: return to target warn: ' + backErr); }
        $.global.VT_PrimeState = null;
    }
}

/**
 * One-call priming (kept for compatibility; the panel uses the 2-step form).
 */
function VT_primeAssetClipboard(assetPath) {
    var r1 = VT_primeOpen(assetPath, false);
    try {
        var d1 = JSON.parse(r1);
        if (!d1.success || d1.cached) return r1;
    } catch (e) { return r1; }
    return VT_primeCopy(assetPath);
}

/**
 * Apply asset at the playhead. fastOnly=true: only the clipboard fast path
 * (returns { retry: 'focus' | 'reprime' } so the panel can fix focus or
 * re-prime and try again). fastOnly=false: fast path, then the full
 * import/copy/paste path with verification, then the nested fallback.
 * @param {string} assetPath - Path to the .prproj asset
 * @returns {string} - JSON result
 */
function VT_applyAssetNative(assetPath, fastOnly) {
    try {
        vtLog('VT_applyAssetNative: Starting with ' + assetPath + (fastOnly ? ' (fast only)' : ''));

        // Ensure DLL is loaded
        if (!VT_initExtObj()) {
            return 'DLL not available';
        }

        // Store reference to current target sequence
        var targetSeq = app.project.activeSequence;
        if (!targetSeq) {
            return 'No active sequence';
        }

        var targetSeqId = targetSeq.sequenceID;
        var targetPlayhead = targetSeq.getPlayerPosition().ticks;
        vtLog('VT_applyAssetNative: Target sequence: ' + targetSeq.name);

        // Check if file exists
        var assetFile = new File(assetPath);
        if (!assetFile.exists) {
            return 'File not found';
        }

        // FAST PATH: paste straight from the primed clipboard cache - skips the
        // .prproj import AND the open/close of the VT_Asset sequence (the main
        // source of insert latency and timeline tab churn).
        var fastRes = VT_applyFromClipboardCache(assetPath, targetSeq, targetPlayhead);
        if (fastRes !== null) {
            var fastData = null;
            try { fastData = JSON.parse(fastRes); } catch (fpErr) {}
            if (!fastData || fastData.success || !fastData.retry || fastOnly) {
                vtLog('VT_applyAssetNative: fast path result returned');
                return fastRes;
            }
            vtLog('VT_applyAssetNative: fast path failed (' + fastData.retry + ') - full path');
        } else if (fastOnly) {
            return JSON.stringify({ success: false, retry: 'reprime', error: 'Clipboard not primed for this asset' });
        }

        // Reuse cached sequence when available (skips the slow import)
        var fromCache = !!VT_findCachedAssetSeq(assetPath);
        var importedSeq = VT_importAssetSeq(assetPath);
        if (!importedSeq) {
            return 'Could not find imported sequence';
        }

        // A misdirected Ctrl+C must find nothing selected on the user's timeline
        VT_deselectAll(targetSeq);

        // Open imported sequence
        app.project.openSequence(importedSeq.sequenceID);

        // Select all clips in imported sequence
        var clipsToSelect = [];
        for (var vt = 0; vt < importedSeq.videoTracks.numTracks; vt++) {
            var vTrack = importedSeq.videoTracks[vt];
            for (var vc = 0; vc < vTrack.clips.numItems; vc++) {
                clipsToSelect.push(vTrack.clips[vc]);
            }
        }
        for (var at = 0; at < importedSeq.audioTracks.numTracks; at++) {
            var aTrack = importedSeq.audioTracks[at];
            for (var ac = 0; ac < aTrack.clips.numItems; ac++) {
                clipsToSelect.push(aTrack.clips[ac]);
            }
        }

        if (clipsToSelect.length === 0) {
            try { app.project.openSequence(targetSeqId); } catch (retErr) {}
            VT_purgeAssetSeq(assetPath, importedSeq);
            return 'No clips in imported sequence';
        }

        importedSeq.setSelection(clipsToSelect);
        vtLog('VT_applyAssetNative: Selected ' + clipsToSelect.length + ' clips');

        // COPY using native DLL!
        vtLog('VT_applyAssetNative: Copying...');
        var copyResult = VT_executeCommand('cmd.edit.copy');
        vtLog('VT_applyAssetNative: Copy result = ' + copyResult);
        // What the paste must produce (checked after the paste)
        var vtExpected = { names: [], sigs: VT_clipSignatures(clipsToSelect) };
        for (var vxn = 0; vxn < clipsToSelect.length; vxn++) { vtExpected.names.push(clipsToSelect[vxn].name || ''); }
        $.global.VT_ClipboardCache = null; // unknown until the paste is verified

        // Close imported sequence and switch back to target
        try {
            importedSeq.close();
        } catch (e) { vtLog('VT_applyAssetNative: imported sequence close failed (orphan left open): ' + e); }

        app.project.openSequence(targetSeqId);

        // Use QE for faster switch. If this fails the timeline is not
        // refocused and the paste below targets nothing.
        if (typeof qe !== 'undefined' && qe && qe.project) {
            try {
                qe.project.getActiveSequence().makeCurrent();
            } catch (e) { vtLog('VT_applyAssetNative: makeCurrent failed - timeline not refocused: ' + e); }
        }

        // Set playhead
        app.project.activeSequence.setPlayerPosition(targetPlayhead);

        // Give the timeline panel time to settle after makeCurrent + setPlayerPosition.
        // The DLL paste uses SendInput which needs the timeline to be the active
        // panel - a short pause improves the odds the UI has caught up.
        $.sleep(150);

        // Snapshot clips BEFORE paste so we can find new ones
        var targetSeqNow = app.project.activeSequence;
        var clipsBefore = VT_snapshotClips(targetSeqNow);

        // PASTE using native DLL!
        vtLog('VT_applyAssetNative: Pasting...');
        // Try to focus the timeline panel before paste. The DLL paste uses
        // SendInput which goes to the FOCUSED window - without timeline focus
        // the Ctrl+V keystrokes miss the timeline entirely.
        VT_executeCommand('cmd.focus.timeline');
        VT_executeCommand('cmd.panel.focus.timeline');
        VT_executeCommand('cmd.timeline.focus');
        $.sleep(50);
        var pasteResult = VT_executeCommand('cmd.edit.paste');
        vtLog('VT_applyAssetNative: Paste result = ' + pasteResult);

        var newClips = VT_waitForNewClips(targetSeqNow, clipsBefore, 800, targetPlayhead);

        if (newClips.length === 0) {
            // First paste missed. The full 10-command focus sweep used to run
            // on EVERY paste; now only failures pay for it.
            vtLog('VT_applyAssetNative: first paste missed - full focus sweep + retry');
            vtLog('VT_applyAssetNative: focus cmds: ' + VT_diagFocus());
            // Recheck before repasting - a late-landing first paste must not
            // double the content.
            newClips = VT_collectNewClips(targetSeqNow, clipsBefore);
            if (newClips.length === 0) {
                $.sleep(50);
                pasteResult = VT_executeCommand('cmd.edit.paste');
                vtLog('VT_applyAssetNative: retry paste result = ' + pasteResult);
                newClips = VT_waitForNewClips(targetSeqNow, clipsBefore, 800, targetPlayhead);
            }
        }

        // VERIFY: the copy above can miss the asset sequence (focus) and leave
        // OTHER content on the clipboard. Never keep a paste that is not this
        // asset - remove it and use the nested fallback (correct content).
        if (newClips.length > 0) {
            var vtWhy = VT_pasteMismatch(newClips, vtExpected);
            if (vtWhy) {
                vtLog('VT_applyAssetNative: pasted content is NOT this asset (' + vtWhy + ') - removing it');
                var vtBadIds = {};
                for (var vbi = 0; vbi < newClips.length; vbi++) { vtBadIds[newClips[vbi].nodeId] = true; }
                VT_removeClipsByNodeIds(targetSeqNow, vtBadIds);
                newClips = [];
            } else {
                $.global.VT_ClipboardCache = { path: assetPath, names: vtExpected.names, sigs: vtExpected.sigs };
                VT_markVerified(VT_clipSignatures(newClips));
            }
        }

        // Select newly pasted clips
        if (newClips.length > 0) {
            targetSeqNow.setSelection(newClips);
            vtLog('VT_applyAssetNative: Selected ' + newClips.length + ' newly pasted clips (verified)');
        }

        // Scale to fit - same treatment as the drag-drop paths
        try { VT_scaleClipsToFit(newClips, targetSeqNow); } catch (se) { vtLog('VT_applyAssetNative: scale warn: ' + se); }

        if (newClips.length === 0) {
            vtLog('VT_applyAssetNative: PASTE FAILED - trying DOM insert fallback...');

            // FALLBACK: the DLL paste uses SendInput (synthetic Ctrl+V) which
            // goes to the FOCUSED window. When the CEP panel has keyboard focus
            // (user just double-clicked an asset card) the keystrokes miss the
            // timeline entirely. Premiere Composer solves this with a native
            // Control Surface plug-in; we cannot install one, so fall back to
            // Premiere's DOM API: sequence.insertClip() inserts the imported
            // sequence as a NESTED SEQUENCE directly - it does not use the
            // clipboard and does not need keyboard focus at all.
            var fbOk = false;
            var fbErr = '';
            try {
                var fbProjItem = importedSeq.projectItem;
                if (fbProjItem) {
                    // Find first targeted video track (same as paste targeting)
                    var fbTrack = 0;
                    for (var fbt = 0; fbt < targetSeqNow.videoTracks.numItems; fbt++) {
                        try { if (targetSeqNow.videoTracks[fbt].isTargeted()) { fbTrack = fbt; break; } } catch (tge) {}
                    }
                    // insertClip(projectItem, time, videoTrackIndex, hardAudioTrackIndex)
                    // time must be a Time object, hardAudioTrackIndex 0 = let Premiere decide
                    var fbTime = targetSeqNow.getPlayerPosition();
                    var fbRes = targetSeqNow.insertClip(fbProjItem, fbTime, fbTrack, 0);
                    if (fbRes) {
                        fbOk = true;
                        vtLog('VT_applyAssetNative: DOM fallback OK - nested sequence inserted on track ' + fbTrack);
                    } else {
                        fbErr = 'insertClip returned false';
                    }
                } else {
                    fbErr = 'imported sequence has no projectItem';
                }
            } catch (fbEx) {
                fbErr = fbEx.toString();
                vtLog('VT_applyAssetNative: DOM fallback failed: ' + fbEx);
            }

            // Purge the imported sequence UNLESS the nest fallback inserted it:
            // deleting the source of a nested reference breaks the inserted
            // nest (clip disappears from the timeline). When fbOk we keep the
            // source in the VibeAssets bin instead of removing it.
            if (fbOk) {
                vtLog('VT_applyAssetNative: PURGE SKIPPED - nested source kept (referenced by nest)');
            } else {
                VT_purgeAssetSeq(assetPath, importedSeq);
            }
            try { app.project.openSequence(targetSeqId); } catch (retErr3) {}

            if (fbOk) {
                vtLog('VT_applyAssetNative: SUCCESS via DOM fallback (nested)');
                return JSON.stringify({
                    success: true,
                    copyResult: copyResult,
                    pasteResult: pasteResult,
                    clipsCount: 1,
                    nested: true
                });
            }

            return JSON.stringify({
                success: false,
                error: 'Paste missed the timeline (CEP panel had focus) and DOM fallback also failed: ' + fbErr,
                copyResult: copyResult,
                pasteResult: pasteResult,
                clipsCount: 0
            });
        }

        // Zero-artifact rule: always purge the imported sequence - even a
        // cached one must never stay in the Project panel as VT_Asset_*.
        VT_purgeAssetSeq(assetPath, importedSeq);
        try { targetSeqNow.setPlayerPosition(String(targetPlayhead)); } catch (rpEndErr) {}

        vtLog('VT_applyAssetNative: SUCCESS! (' + newClips.length + ' new clips)');
        // Return detailed result
        return JSON.stringify({
            success: true,
            copyResult: copyResult,
            pasteResult: pasteResult,
            clipsCount: newClips.length
        });

    } catch (e) {
        vtLog('VT_applyAssetNative error: ' + e);
        try {
            if (typeof targetSeqId !== 'undefined') { try { app.project.openSequence(targetSeqId); } catch (retErr2) {} }
            if (typeof importedSeq !== 'undefined' && importedSeq && typeof fromCache !== 'undefined' && !fromCache) {
                VT_purgeAssetSeq(assetPath, importedSeq);
            }
        } catch (cleanErr) { vtLog('VT_applyAssetNative: error-path cleanup failed: ' + cleanErr); }
        return 'Error: ' + e.toString();
    }
}

/**
 * Apply speed and reverse to currently selected clips via QE DOM
 */
function VT_applySpeedToSelectedClips(speed, reverse) {
    try {
        app.enableQE();
        var seq = app.project.activeSequence;
        if (!seq) return false;
        var qeSeq = qe.project.getActiveSequence();
        if (!qeSeq) return false;

        function getQEClipMatch(qeTrack, targetClipIndex) {
            var curIndex = -1;
            for (var i = 0; i < qeTrack.numItems; i++) {
                var item = qeTrack.getItemAt(i);
                if (item.type === 'Empty') continue;
                curIndex++;
                if (curIndex === targetClipIndex) return item;
            }
            return null;
        }

        var changed = 0;

        // Video Tracks
        for (var t = 0; t < seq.videoTracks.numTracks; t++) {
            var track = seq.videoTracks[t];
            var qeTrack = qeSeq.getVideoTrackAt(t);
            if (!qeTrack) continue;

            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.isSelected()) {
                    var qeClip = getQEClipMatch(qeTrack, c);
                    if (qeClip) {
                        qeClip.setSpeed(speed, '', reverse, false, false);
                        if (speed != 1) {
                            qeClip.setSpeed(speed, '00;30;00;00', reverse, false, false);
                        }
                        changed++;
                    }
                }
            }
        }

        // Audio Tracks
        for (var t = 0; t < seq.audioTracks.numTracks; t++) {
            var track = seq.audioTracks[t];
            var qeTrack = qeSeq.getAudioTrackAt(t);
            if (!qeTrack) continue;

            for (var c = 0; c < track.clips.numItems; c++) {
                var clip = track.clips[c];
                if (clip.isSelected()) {
                    var qeClip = getQEClipMatch(qeTrack, c);
                    if (qeClip) {
                        // QE setSpeed quirk: first call with empty timecode,
                        // then second call with timecode if speed != 1
                        qeClip.setSpeed(speed, '', reverse, false, false);
                        if (speed != 1) {
                            qeClip.setSpeed(speed, '00;30;00;00', reverse, false, false);
                        }
                        changed++;
                    }
                }
            }
        }

        vtLog('VT_applySpeedToSelectedClips: Applied to ' + changed + ' clips.');
        return changed > 0;
    } catch(e) {
        vtLog('VT_applySpeedToSelectedClips error: ' + e);
        return false;
    }
}

/**
 * Safe wrapper for VT_applyAssetNative - bypasses bytecode cache
 */
function VT_applyAssetNative_Safe(assetPath, optionsString, fastOnly) {
    vtLog('VT_applyAssetNative_Safe: START');

    // Parse options
    var opts = { speed: 1.0, reverse: false };
    if (optionsString) {
        try { opts = JSON.parse(optionsString); } catch(e){}
    }

    // PRE-CHECK: Verify DLL is still loaded
    try {
        if (!$.global.VT_ExtObj) {
            vtLog('VT_applyAssetNative_Safe: DLL not loaded, reinitializing...');
            VT_initExtObj();
        }
    } catch (dllErr) {
        vtLog('VT_applyAssetNative_Safe: DLL check error: ' + dllErr);
    }

    // Call main function with try/catch isolation
    try {
        vtLog('VT_applyAssetNative_Safe: Calling main function...');
        var result = VT_applyAssetNative(assetPath, !!fastOnly);
        vtLog('VT_applyAssetNative_Safe: Main function returned: ' + result);

        // Apply speed/reverse only after a REAL success. The old check
        // (result contains 'success') also fired on {"success":false}.
        var resultOk = false;
        try { resultOk = JSON.parse(result).success === true; } catch (rpErr) { resultOk = (result === 'true'); }
        if ((opts.speed !== 1.0 || opts.reverse) && resultOk) {
            vtLog('VT_applyAssetNative_Safe: Applying speed=' + opts.speed + ', reverse=' + opts.reverse);
            VT_applySpeedToSelectedClips(opts.speed, opts.reverse);
        }
        
        return result;
    } catch (mainErr) {
        vtLog('VT_applyAssetNative_Safe: MAIN FUNCTION CRASHED: ' + mainErr);
        return JSON.stringify({
            success: false,
            error: 'Main function crash: ' + mainErr.toString(),
            line: mainErr.line || 'unknown'
        });
    }
}

/**
 * Test DLL command execution
 * @returns {string} - JSON with test results
 */
function VT_testDllCommand() {
    var result = {
        dllLoaded: false,
        testCommand: false,
        error: null
    };

    try {
        // Check if DLL is loaded
        result.dllLoaded = VT_initExtObj();

        if (result.dllLoaded) {
            // Try a harmless command
            var cmdResult = VT_executeCommand('cmd.edit.selectNone');
            result.testCommand = (cmdResult === true || cmdResult === 'true');
        }
    } catch (e) {
        result.error = e.toString();
    }

    return JSON.stringify(result);
}

/**
 * Insert a MOGRT (Motion Graphics Template) at playhead position
 * @param {string} mogrtPath - Full path to the .mogrt file
 * @returns {string} - JSON result
 */
function VT_insertMogrt(mogrtPath) {
    try {
        vtLog('VT_insertMogrt: Starting with ' + mogrtPath);

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        // Get playhead position
        var playheadTicks = seq.getPlayerPosition().ticks;

        // Get first targeted video track
        var targetTrack = 0;
        for (var i = 0; i < seq.videoTracks.numTracks; i++) {
            if (seq.videoTracks[i].isTargeted()) {
                targetTrack = i;
                break;
            }
        }

        // Use sequence.importMGT API
        var mgResult = seq.importMGT(
            mogrtPath,           // path to MOGRT
            playheadTicks,       // time (as ticks string)
            targetTrack,         // video track index
            targetTrack          // audio track index
        );

        vtLog('VT_insertMogrt: importMGT result = ' + mgResult);

        return JSON.stringify({
            success: (mgResult !== null && mgResult !== undefined),
            track: targetTrack,
            position: seq.getPlayerPosition().seconds
        });

    } catch (e) {
        vtLog('VT_insertMogrt error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * Insert a MOGRT at a specific placeholder position (for drag & drop)
 * Removes the placeholder .vtbk clip first, then inserts MOGRT at its position
 * @param {string} mogrtPath - Full path to the .mogrt file
 * @param {object} placeholderInfo - { trackIndex, clipIndex, startTicks, startSeconds }
 * @returns {string} - JSON result
 */
function VT_insertMogrtAtPosition(mogrtPath, placeholderInfo) {
    try {
        vtLog('VT_insertMogrtAtPosition: Starting with ' + mogrtPath);

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        var targetTrack = parseInt(placeholderInfo.trackIndex, 10) || 0;
        var startTicks = placeholderInfo.startTicks;

        // Remember the playhead (captured at drag start when available)
        var originalMogrtPlayhead = VT_takeLockedPlayhead(seq, String(seq.getPlayerPosition().ticks));

        // Remove placeholder .vtbk clip
        try {
            if (placeholderInfo.isVideo !== false) {
                var vtrack = seq.videoTracks[targetTrack];
                if (vtrack && vtrack.clips.numItems > (placeholderInfo.clipIndex || 0)) {
                    var clip = vtrack.clips[(placeholderInfo.clipIndex || 0)];
                    if (clip && clip.name && (clip.name.match(/\.vtbk$/i) || clip.name.match(/vt_drag_\d+/i))) {
                        clip.remove(false, false);
                        vtLog('VT_insertMogrtAtPosition: Removed placeholder');
                    }
                }
            }
        } catch (removeErr) {
            vtLog('VT_insertMogrtAtPosition: Placeholder remove failed: ' + removeErr);
        }

        // importMGT takes the time and track indices itself, so neither the
        // playhead nor track targeting has to move (v3.9.2: no CTI jump).
        if (!startTicks) {
            var t = new Time();
            t.seconds = placeholderInfo.startSeconds || 0;
            startTicks = t.ticks;
        }

        // Insert MOGRT
        vtLog('VT_insertMogrtAtPosition: Inserting at track=' + targetTrack + ' ticks=' + startTicks);
        var mgResult = seq.importMGT(
            mogrtPath,
            startTicks,
            targetTrack,
            targetTrack
        );

        vtLog('VT_insertMogrtAtPosition: importMGT result = ' + mgResult);

        // Restore original playhead so the CTI does not shift after insert
        try {
            seq.setPlayerPosition(originalMogrtPlayhead);
        } catch (restorePosErr) {
            vtLog('VT_insertMogrtAtPosition: playhead restore warning: ' + restorePosErr);
        }

        return JSON.stringify({
            success: (mgResult !== null && mgResult !== undefined),
            track: targetTrack,
            position: placeholderInfo.startSeconds
        });

    } catch (e) {
        vtLog('VT_insertMogrtAtPosition error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

/**
 * Insert an external media file (video, audio, image) at playhead position
 * @param {string} filePath - Full path to the media file
 * @param {object} placeholderInfoStr - Optional info about placeholder position
 * @returns {string} - JSON result
 */
function VT_insertExternalFile(filePath, placeholderInfo, optionsString) {
    try {
        vtLog('VT_insertExternalFile: Starting with ' + filePath);

        var seq = app.project.activeSequence;
        if (!seq) {
            return JSON.stringify({ success: false, error: 'No active sequence' });
        }

        // Check if it's audio or video
        var isAudioFile = filePath.match(/\.(mp3|wav|ogg|aac|m4a|flac|aiff)$/i);

        // Parse options for Speed/Reverse (before we need them)
        var options = { speed: 1.0, reverse: false };
        if (optionsString) {
            try {
                if (typeof optionsString === 'string') {
                    optionsString = optionsString.replace(/([{,]\s*)(['"])?([a-zA-Z0-9_]+)(['"])?\s*:/g, '$1"$3":');
                    options = eval('(' + optionsString + ')');
                } else {
                    options = optionsString;
                }
            } catch (e) {
                vtLog('VT_insertExternalFile: Failed to parse options: ' + e);
            }
        }

        // Placeholder path (drag & drop)
        if (placeholderInfo && placeholderInfo.startTicks) {
            var targetTrackIndex = parseInt(placeholderInfo.trackIndex, 10) || 0;
            var insertTicks = placeholderInfo.startTicks;
            var clipIndex = parseInt(placeholderInfo.clipIndex, 10) || 0;

            var insertTime = null;
            var linkedAudioTrack = targetTrackIndex;
            var linkedAudioTime = null;
            var isPlaceholderVideo = (placeholderInfo.isVideo !== false); // Default true if missing

            var targetTrack = isPlaceholderVideo ? seq.videoTracks[targetTrackIndex] : seq.audioTracks[targetTrackIndex];

            if (targetTrack && targetTrack.clips.numItems > clipIndex) {
                var pclip = targetTrack.clips[clipIndex];
                if (pclip && pclip.name && (pclip.name.match(/\.vtbk$/i) || pclip.name.match(/vt_drag_\d+/i))) {
                    insertTime = pclip.start;

                    // For audio files with video placeholders: find the placeholder's linked audio to get audio track index
                    if (isPlaceholderVideo && isAudioFile) {
                        try {
                            var linkedItems = pclip.getLinkedItems();
                            if (linkedItems) {
                                for (var li = 0; li < linkedItems.length; li++) {
                                    for (var at = 0; at < seq.audioTracks.numTracks; at++) {
                                        var atrk = seq.audioTracks[at];
                                        for (var ac = 0; ac < atrk.clips.numItems; ac++) {
                                            if (atrk.clips[ac].nodeId === linkedItems[li].nodeId) {
                                                linkedAudioTrack = at;
                                                linkedAudioTime = atrk.clips[ac].start;
                                                vtLog('VT_insertExternalFile: Linked audio on A' + (at + 1));
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        } catch (linkErr) { vtLog('Linked audio search failed: ' + linkErr); }
                    } else if (!isPlaceholderVideo && isAudioFile) {
                        // The placeholder is already on the audio track
                        linkedAudioTrack = targetTrackIndex;
                        linkedAudioTime = insertTime;
                    }

                    pclip.remove(false, false);
                    vtLog('VT_insertExternalFile: Removed placeholder at ' + (isPlaceholderVideo ? 'V' : 'A') + (targetTrackIndex + 1));
                }
            }

            if (!insertTime) {
                vtLog('VT_insertExternalFile: Placeholder not found, using ticks position');
                var ti = new Time();
                ti.ticks = insertTicks;
                insertTime = ti;
            }

            // v3.9.10: no VibeAssets bin - the media goes to the project root like
            // Premiere's own drag & drop, and an item already in the project is reused
            var importedItem = VT_getMediaItem(filePath);

            if (!importedItem) {
                return JSON.stringify({ success: false, error: 'Could not find imported file in project' });
            }

            // Snapshot all existing clips, then overwriteClip, then diff for the new clip
            var existingNodeIds = {};
            for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
                for (var sc = 0; sc < seq.videoTracks[sv].clips.numItems; sc++) {
                    existingNodeIds[seq.videoTracks[sv].clips[sc].nodeId] = true;
                }
            }
            for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
                for (var sc = 0; sc < seq.audioTracks[sa].clips.numItems; sc++) {
                    existingNodeIds[seq.audioTracks[sa].clips[sc].nodeId] = true;
                }
            }

            if (isAudioFile) {
                var audTime = linkedAudioTime || insertTime;
                seq.overwriteClip(importedItem, audTime, 0, linkedAudioTrack);
                vtLog('VT_insertExternalFile: overwriteClip audio at A' + (linkedAudioTrack + 1));
            } else {
                seq.overwriteClip(importedItem, insertTime, targetTrackIndex, 0);
                vtLog('VT_insertExternalFile: overwriteClip video at V' + (targetTrackIndex + 1));
            }

            // Find the newly added clip by nodeId diff. v3.9.5: the VIDEO part
            // of a video file comes first - it used to pick the linked audio,
            // so Scale-to-fit was skipped ("has no Motion/Scale").
            var insertedClip = VT_findNewClipByNodeIds(seq, existingNodeIds, isAudioFile);

            if (insertedClip) {
                insertedClip.setSelected(true, true);
                vtLog('VT_insertExternalFile: Found new clip via nodeId diff');
            } else {
                vtLog('VT_insertExternalFile: WARNING - could not find new clip after overwriteClip');
            }

            // Apply speed via direct QE
            if (!isAudioFile && (options.speed !== 1.0 || options.reverse) && insertedClip) {
                $.sleep(80);
                vtLog('VT_insertExternalFile: Direct QE speed=' + options.speed + ' reverse=' + options.reverse);
                try {
                    app.enableQE();
                    var qeSeq = qe.project.getActiveSequence();
                    if (qeSeq) {
                        var targetTicks = insertedClip.start.ticks;
                        if (isAudioFile) {
                            for (var qat = 0; qat < qeSeq.numAudioTracks; qat++) {
                                var qet = qeSeq.getAudioTrackAt(qat);
                                for (var qi = 0; qi < qet.numItems; qi++) {
                                    var qeItem = qet.getItemAt(qi);
                                    if (!qeItem || qeItem.type === 'Empty') continue;
                                    var qeStartTicks = qeItem.start.ticks || qeItem.start || 0;
                                    var diff = Math.abs(parseInt(String(qeStartTicks), 10) - parseInt(String(targetTicks), 10));
                                    if (diff < 100) {
                                        qeItem.setSpeed(options.speed, '', options.reverse, false, false);
                                        if (options.speed != 1) {
                                            qeItem.setSpeed(options.speed, '00;30;00;00', options.reverse, false, false);
                                        }
                                        vtLog('VT_insertExternalFile: Speed applied OK');
                                        break;
                                    }
                                }
                            }
                        }
                    }
                } catch (qeErr) {
                    vtLog('VT_insertExternalFile: QE speed failed: ' + qeErr);
                }
            }

            // v3.9.8: no scaling here. Premiere already applies its own Default
            // Media Scaling (e.g. Fit / Scale to Frame Size) to imported media,
            // exactly as on drag & drop; scaling on top of it oversized the clip.

            return JSON.stringify({ success: true, clipsCount: insertedClip ? 1 : 0 });
        }

        // No placeholder (double-click / applyAsset path)

        var insertTicks = seq.getPlayerPosition().ticks;
        var targetTrackIndex = 0;

        // Deselect all clips first
        try {
            var selection = seq.getSelection();
            if (selection && selection.length > 0) {
                for (var si = 0; si < selection.length; si++) {
                    selection[si].setSelected(false, true);
                }
            }
        } catch (dsErr) { vtLog('Deselect warning: ' + dsErr); }

        // v3.9.10: into the project root (no VibeAssets bin), reusing the item
        // when this media is already in the project
        var importedItem = VT_getMediaItem(filePath);

        if (!importedItem) {
            return JSON.stringify({ success: false, error: 'Could not find imported file in project' });
        }

        // Snapshot + insertClip
        var existingNodeIds = {};
        for (var sv = 0; sv < seq.videoTracks.numTracks; sv++) {
            for (var sc = 0; sc < seq.videoTracks[sv].clips.numItems; sc++) {
                existingNodeIds[seq.videoTracks[sv].clips[sc].nodeId] = true;
            }
        }
        for (var sa = 0; sa < seq.audioTracks.numTracks; sa++) {
            for (var sc = 0; sc < seq.audioTracks[sa].clips.numItems; sc++) {
                existingNodeIds[seq.audioTracks[sa].clips[sc].nodeId] = true;
            }
        }

        if (isAudioFile) {
            var audioTrack = seq.audioTracks[targetTrackIndex];
            if (audioTrack) {
                audioTrack.insertClip(importedItem, insertTicks);
            }
        } else {
            var videoTrack = seq.videoTracks[targetTrackIndex];
            if (videoTrack) {
                videoTrack.insertClip(importedItem, insertTicks);
            }
        }

        // Find new clip by nodeId diff (video part first for video files, v3.9.5)
        var insertedClip = VT_findNewClipByNodeIds(seq, existingNodeIds, isAudioFile);

        if (insertedClip) {
            insertedClip.setSelected(true, true);
            vtLog('VT_insertExternalFile: Found new clip via nodeId diff');
        }

        // Apply speed via direct QE
        if (!isAudioFile && insertedClip && (options.speed !== 1.0 || options.reverse)) {
            $.sleep(80);
            vtLog('VT_insertExternalFile: Direct QE speed=' + options.speed + ' reverse=' + options.reverse);
            try {
                app.enableQE();
                var qeSeq = qe.project.getActiveSequence();
                if (qeSeq) {
                    var targetTicks = insertedClip.start.ticks;
                    if (isAudioFile) {
                        for (var qat = 0; qat < qeSeq.numAudioTracks; qat++) {
                            var qet = qeSeq.getAudioTrackAt(qat);
                            for (var qi = 0; qi < qet.numItems; qi++) {
                                var qeItem = qet.getItemAt(qi);
                                if (!qeItem || qeItem.type === 'Empty') continue;
                                var qeStartTicks = qeItem.start.ticks || qeItem.start || 0;
                                var diff = Math.abs(parseInt(String(qeStartTicks), 10) - parseInt(String(targetTicks), 10));
                                if (diff < 100) {
                                    qeItem.setSpeed(options.speed, '', options.reverse, false, false);
                                    if (options.speed != 1) {
                                        qeItem.setSpeed(options.speed, '00;30;00;00', options.reverse, false, false);
                                    }
                                    vtLog('VT_insertExternalFile: Speed applied OK');
                                    break;
                                }
                            }
                        }
                    } else {
                        for (var qvt = 0; qvt < qeSeq.numVideoTracks; qvt++) {
                            var qet = qeSeq.getVideoTrackAt(qvt);
                            for (var qi = 0; qi < qet.numItems; qi++) {
                                var qeItem = qet.getItemAt(qi);
                                if (!qeItem || qeItem.type === 'Empty') continue;
                                var qeStartTicks = qeItem.start.ticks || qeItem.start || 0;
                                var diff = Math.abs(parseInt(String(qeStartTicks), 10) - parseInt(String(targetTicks), 10));
                                if (diff < 100) {
                                    qeItem.setSpeed(options.speed, '', options.reverse, false, false);
                                    if (options.speed != 1) {
                                        qeItem.setSpeed(options.speed, '00;30;00;00', options.reverse, false, false);
                                    }
                                    vtLog('VT_insertExternalFile: Speed applied OK');
                                    break;
                                }
                            }
                        }
                    }
                }
            } catch (qeErr) {
                vtLog('VT_insertExternalFile: QE speed failed: ' + qeErr);
                try { VT_applySpeedToSelectedClips(options.speed, options.reverse); } catch (e2) { vtLog('VT_insertExternalFile: speed fallback failed too - speed/reverse NOT applied: ' + e2); }
            }
        } else if (!isAudioFile && !insertedClip && (options.speed !== 1.0 || options.reverse)) {
            vtLog('VT_insertExternalFile: No insertedClip, speed fallback');
            $.sleep(80);
            try { VT_applySpeedToSelectedClips(options.speed, options.reverse); } catch (e2) { vtLog('VT_insertExternalFile: speed fallback failed - speed/reverse NOT applied: ' + e2); }
        }

        // v3.9.8: no scaling here. Premiere already applies its own Default
        // Media Scaling (e.g. Fit / Scale to Frame Size) to imported media,
        // exactly as on drag & drop; scaling on top of it oversized the clip.

        return JSON.stringify({ success: true, clipsCount: insertedClip ? 1 : 0 });

    } catch (e) {
        vtLog('VT_insertExternalFile error: ' + e);
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function VT_readDebugLog() {
    try {
        var logFile = Folder.temp + '/vibetool_debug.txt';
        var f = new File(logFile);
        if (!f.exists) return JSON.stringify({ lines: [], msg: 'no log file' });
        f.open('r');
        var content = f.read();
        f.close();
        var lines = content.split('\n');
        var last = lines.slice(Math.max(0, lines.length - 21), lines.length);
        return JSON.stringify({ lines: last, total: lines.length });
    } catch (e) {
        return JSON.stringify({ lines: ['ERROR: ' + e], total: 0 });
    }
}

function VT_clearDebugLog() {
    try {
        var logFile = Folder.temp + '/vibetool_debug.txt';
        var f = new File(logFile);
        f.open('w');
        f.write('');
        f.close();
        return 'cleared';
    } catch (e) {
        return 'error: ' + e;
    }
}

// ========================================
// Undo Group Management (QE-based, modeled after Premiere Composer)
// Tracks multi-step operations so a single Ctrl+Z collapses the whole group.
// Diagnostic revision: EVERY onProjectChanged dispatch is logged with the
// group list and current index - tells whether the event reaches the impl
// at all and why it may not match. Remove verbose logging after diagnosis.
// ========================================
var VT_undoGroups = [];
var VT_pendingUndoStart = null;
var VT_collapsing = false;

function VT_getQEProject() {
    if (typeof qe === 'undefined') {
        app.enableQE();
    }
    if (!app.project || !app.project.path) return null;
    var projPath = app.project.path;
    try {
        var abs = new File(projPath).absoluteURI;
        if (qe.project && qe.project.path && new File(qe.project.path).absoluteURI === abs) {
            if (typeof qe.project.init === 'function') qe.project.init();
            return qe.project;
        }
    } catch (e) { /* fall through */ }
    try {
        qe.open(projPath);
        if (qe.project && typeof qe.project.init === 'function') qe.project.init();
        return qe.project;
    } catch (e) {
        vtLog('VT_getQEProject open failed: ' + e);
        return null;
    }
}

// Boundary read (PC getUndoStackIndex): init() + one read. Never call
// qp.init() inside an undo/redo burst - mid-burst init() reads come back
// wrong (0 / lagged), which made the collapse loop stop early and left
// the overwrite step in history. Inside bursts use RAW qp.undoStackIndex()
// exactly like Premiere Composer's updateProject loop does.
function VT_getUndoStackIndex(qp) {
    if (!qp) return -1;
    if (typeof qp.init === 'function') qp.init();
    return qp.undoStackIndex();
}

function VT_cancelUndoGroup() {
    VT_pendingUndoStart = null;
    return JSON.stringify({ success: true });
}

// force=true: start a fresh group even if one is pending (drag-start resets
// stale pending). force=false: keep the already-open pending start - the drag
// flow opens the group BEFORE the user drops the placeholder, so the replace
// flow must not re-warm-up and clobber the pre-drop start.
function VT_beginUndoGroup(force, noWarmup) {
    try {
        if (VT_pendingUndoStart !== null && !force) {
            return JSON.stringify({ success: true, startIndex: VT_pendingUndoStart, kept: true });
        }
        var qp = VT_getQEProject();
        if (!qp || typeof qp.undoStackIndex !== 'function') {
            VT_pendingUndoStart = null;
            return JSON.stringify({ success: false, error: 'QE undoStackIndex not available' });
        }
        // v3.9.12: no warm-up bin any more (it used to create + undo a
        // "VT_undo_..." bin). It never changed the index read - before and
        // after were equal in every logged run - but it showed up as greyed
        // "Create VT_undo_..." / "Rename item to ..." lines in the History panel.
        VT_pendingUndoStart = VT_getUndoStackIndex(qp);
        vtLog('VT_beginUndoGroup: start=' + VT_pendingUndoStart);
        return JSON.stringify({ success: true, startIndex: VT_pendingUndoStart });
    } catch (e) {
        VT_pendingUndoStart = null;
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function VT_endUndoGroup() {
    try {
        if (VT_pendingUndoStart === null) {
            return JSON.stringify({ success: false, error: 'No pending undo group' });
        }
        var qp = VT_getQEProject();
        if (!qp) {
            VT_pendingUndoStart = null;
            return JSON.stringify({ success: false, error: 'QE project not available' });
        }
        var endIdx = VT_getUndoStackIndex(qp);
        var group = { startIndex: VT_pendingUndoStart, endIndex: endIdx };
        vtLog('VT_endUndoGroup: end=' + endIdx + ' (start=' + group.startIndex + ')');
        VT_pendingUndoStart = null;
        if (endIdx > group.startIndex) {
            group.lastIdx = endIdx;
            VT_undoGroups.push(group);
            if (VT_undoGroups.length > 32) {
                VT_undoGroups = VT_undoGroups.slice(-32);
            }
        }
        return JSON.stringify({ success: true, group: group, total: VT_undoGroups.length });
    } catch (e) {
        VT_pendingUndoStart = null;
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

// Match only when the index has moved BELOW the recorded top (curIdx < endIndex):
// onProjectChanged also fires for async non-undo work (audio conform, peaks,
// previews) while the index still sits on endIndex - those must NOT collapse
// the group, otherwise the insert silently reverts by itself. After a real
// Ctrl+Z the index is below the top, so the match still fires correctly.
// Collapse one group: remove it from the list FIRST (so re-entrant/queued
// events cannot re-match and redo it), then undo/redo one step at a time
// with a fresh index read after each call: index units are NOT 1:1 with
// undo calls (some DOM ops span 2 index units), so a fixed call count
// overshoots into the previous group and cascades a second collapse.
function VT_collapseUndoGroup(qp, groupIdx, curIdx, undoDirArg) {
    var g = VT_undoGroups[groupIdx];
    if (!g) return 0;
    // v3.9.9: the direction comes from where the index was before this event
    // (see VT_matchUndoGroup). Guessing it from "which end is closer" sent a
    // single Ctrl+Z that undid most of a native drag straight back to a redo.
    var undoDir = (typeof undoDirArg === 'boolean') ? undoDirArg : !(curIdx - g.startIndex < g.endIndex - curIdx);
    var target = undoDir ? g.startIndex : g.endIndex;
    var ops = 0;
    var stuck = false;
    VT_collapsing = true;
    try {
        // PC-style: init() ONCE before the burst, RAW reads inside it.
        if (typeof qp.init === 'function') qp.init();
        var guard = 0;
        var prev = null;
        while (guard < 32) {
            var curW = qp.undoStackIndex();
            vtLog('VT collapse step: ops=' + ops + ' raw=' + curW + ' target=' + target + ' dir=' + (undoDir ? 'undo' : 'redo'));
            if (undoDir ? (curW <= target) : (curW >= target)) break;
            if (prev !== null && curW === prev) {
                // Nothing moved: the history no longer holds this group (a new
                // edit cleared the redo list) - stop instead of looping.
                stuck = true;
                break;
            }
            prev = curW;
            if (undoDir) qp.undo(); else qp.redo();
            ops++;
            guard++;
        }
        if (!stuck) {
            for (var pass = 0; pass < 3; pass++) {
                var cur = VT_getUndoStackIndex(qp);
                vtLog('VT collapse verify: pass=' + pass + ' read=' + cur + ' target=' + target);
                if (cur === target) break;
                if (undoDir && cur > target) {
                    if (typeof qp.init === 'function') qp.init();
                    if (qp.undoStackIndex() > target) { qp.undo(); ops++; } else { break; }
                } else if (!undoDir && cur < target) {
                    if (typeof qp.init === 'function') qp.init();
                    if (qp.undoStackIndex() < target) { qp.redo(); ops++; } else { break; }
                } else {
                    break;
                }
            }
        }
        var finalIdx = VT_getUndoStackIndex(qp);
        if (stuck) {
            VT_undoGroups.splice(groupIdx, 1);
            vtLog('VT collapse: group [' + g.startIndex + ',' + g.endIndex + '] dropped - history changed (idx stays ' + finalIdx + ')');
        } else {
            // Keep the group: a later Ctrl+Shift+Z / Ctrl+Z over it must again
            // move it as one step. Queued events now read a boundary index and
            // are no-ops, so it cannot re-trigger itself.
            g.lastIdx = finalIdx;
        }
        if (ops === 0) {
            vtLog('VT collapse WARNING: zero ops cur=' + curIdx + ' target=' + target + ' dir=' + (undoDir ? 'undo' : 'redo'));
        }
        vtLog('VT collapse: group [' + g.startIndex + ',' + g.endIndex + '] dir=' +
            (undoDir ? 'undo' : 'redo') + ' cur=' + curIdx + ' target=' + target +
            ' ops=' + ops + ' finalIdx=' + finalIdx);
    } finally {
        VT_collapsing = false;
    }
    return ops;
}

/**
 * Find the group the undo index is now inside of, and which way it moved.
 * Each group remembers the index it was last seen at (lastIdx): its top
 * right after the insert, its start once undone. Landing exactly on a
 * boundary (e.g. one Ctrl+Z that took the whole native drop back) is a
 * finished state - nothing to collapse, only remembered.
 * @return {Object|null} { index, undo }
 */
function VT_matchUndoGroup(curIdx) {
    var hit = null;
    for (var i = VT_undoGroups.length - 1; i >= 0; i--) {
        var g = VT_undoGroups[i];
        if (typeof g.lastIdx !== 'number') g.lastIdx = g.endIndex;
        if (curIdx <= g.startIndex) { g.lastIdx = g.startIndex; continue; }
        if (curIdx >= g.endIndex) { g.lastIdx = g.endIndex; continue; }
        if (!hit) {
            var undo;
            if (curIdx < g.lastIdx) undo = true;
            else if (curIdx > g.lastIdx) undo = false;
            else undo = !(curIdx - g.startIndex < g.endIndex - curIdx);
            hit = { index: i, undo: undo };
        }
    }
    return hit;
}

function VT_checkUndoGroups() {
    try {
        if (VT_collapsing) return JSON.stringify({ success: true, collapsed: false, note: 'already collapsing' });
        if (VT_undoGroups.length === 0) return JSON.stringify({ success: true, collapsed: false });
        var qp = VT_getQEProject();
        if (!qp) return JSON.stringify({ success: false, error: 'QE project not available' });
        var curIdx = VT_getUndoStackIndex(qp);
        var collapsed = false;
        var totalOps = 0;
        var hit = VT_matchUndoGroup(curIdx);
        if (hit) {
            totalOps += VT_collapseUndoGroup(qp, hit.index, curIdx, hit.undo);
            collapsed = true;
        }
        return JSON.stringify({ success: true, collapsed: collapsed, ops: totalOps, remaining: VT_undoGroups.length });
    } catch (e) {
        VT_collapsing = false;
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function VT_getUndoState() {
    try {
        var qp = VT_getQEProject();
        var cur = qp && typeof qp.undoStackIndex === 'function' ? VT_getUndoStackIndex(qp) : -1;
        return JSON.stringify({
            success: true,
            currentIndex: cur,
            groups: VT_undoGroups,
            pendingStart: VT_pendingUndoStart
        });
    } catch (e) {
        return JSON.stringify({ success: false, error: e.toString() });
    }
}

function VT_registerUndoEventListener() {
    try {
        if (typeof app.addEventListener !== 'function') {
            vtLog('VT_registerUndoEventListener: app.addEventListener not available');
            return 'no addEventListener';
        }
        // Permanent dispatcher: registered with app ONCE ever (flag lives in
        // $.global and survives $.evalFile re-runs). Every (re)load swaps
        // only the impl function, so handlers can never stack up.
        if (!$.global.VT_undoDispatcherInstalled) {
            $.global.VT_undoDispatchCount = 0;
            $.global.VT_undoDispatcher = function (e) {
                try {
                    $.global.VT_undoDispatchCount++;
                    var impl = $.global.VT_undoHandlerImpl;
                    if (impl) {
                        impl(e);
                    } else {
                        vtLog('VT undo dispatcher: fired#' + $.global.VT_undoDispatchCount + ' but NO IMPL installed');
                    }
                } catch (err) {
                    VT_collapsing = false;
                    vtLog('VT undo dispatcher error: ' + err);
                }
            };
            $.global.VT_undoDispatcherInstalled = true;
            app.addEventListener('onProjectChanged', $.global.VT_undoDispatcher);
            vtLog('VT_registerUndoEventListener: dispatcher INSTALLED');
        }
        $.global.VT_undoHandlerImpl = function (e) {
            try {
                var nGroups = VT_undoGroups ? VT_undoGroups.length : -1;
                if (VT_collapsing) {
                    vtLog('VT undo-event: fired#' + $.global.VT_undoDispatchCount + ' groups=' + nGroups + ' skip=collapsing');
                    return;
                }
                if (nGroups <= 0) {
                    vtLog('VT undo-event: fired#' + $.global.VT_undoDispatchCount + ' groups=' + nGroups + ' skip=no-groups');
                    return;
                }
                var qp = VT_getQEProject();
                if (!qp || typeof qp.undoStackIndex !== 'function') {
                    vtLog('VT undo-event: fired#' + $.global.VT_undoDispatchCount + ' groups=' + nGroups + ' skip=no-qe');
                    return;
                }
                var curIdx = VT_getUndoStackIndex(qp);
                var gs = '';
                for (var gi = 0; gi < VT_undoGroups.length; gi++) {
                    gs += (gi > 0 ? ',' : '') + VT_undoGroups[gi].startIndex + '-' + VT_undoGroups[gi].endIndex;
                }
                vtLog('VT undo-event: fired#' + $.global.VT_undoDispatchCount + ' groups=' + nGroups + ' cur=' + curIdx + ' [' + gs + ']');
                var hit = VT_matchUndoGroup(curIdx);
                if (hit) {
                    var hg = VT_undoGroups[hit.index];
                    vtLog('VT undo-event: match group [' + hg.startIndex + ',' + hg.endIndex + '] cur=' + curIdx + ' last=' + hg.lastIdx + ' -> ' + (hit.undo ? 'undo' : 'redo'));
                    VT_collapseUndoGroup(qp, hit.index, curIdx, hit.undo);
                }
            } catch (err) {
                VT_collapsing = false;
                vtLog('VT undo-event handler error: ' + err);
            }
        };
        $.global.VT_undoEventHandler = $.global.VT_undoDispatcher;
        vtLog('VT_registerUndoEventListener: impl swapped');
        return 'dispatcher ready';
    } catch (e) {
        vtLog('VT_registerUndoEventListener failed: ' + e);
        return 'failed: ' + e;
    }
}

// Auto-reregister undo listener on every (re)load so a freshly eval'd script
// swaps in the current handler impl (dispatcher itself is added only once).
try {
    VT_registerUndoEventListener();
} catch (eAutoReg) { /* ignore */ }

// =====================================================================
// NATIVE MOGRT ASSETS (v3.9.3)
// A saved MOGRT asset = which template (its .aegraphic project item) + the
// parameter values, duration and layout of each clip. INSERT puts a fresh
// instance of the template straight onto the track (sequence.overwriteClip)
// and applies the saved values through the effect-preset code:
//   - no clipboard (no synthetic Ctrl+C/V, no focus problems)
//   - no VT_Asset sequence opened or closed, no nested fallback
//   - the playhead does not move
// SAVE never opens a sequence or touches the clipboard either. It still
// writes the .prproj (built without opening it), so the template can be
// brought into OTHER projects: the .prproj is imported into the VibeAssets
// bin (never opened) only when the template is not in the project yet.
// Clips with keyframes keep using the classic path (values only here).
// =====================================================================

function VT_isMgtClip(clip) {
    try { if (clip.isMGT && clip.isMGT()) return true; } catch (e1) {}
    try { return /\.aegraphic$/i.test(clip.projectItem ? clip.projectItem.getMediaPath() : ''); } catch (e2) {}
    return false;
}

function VT_timeAt(seconds) {
    var t = new Time();
    t.seconds = seconds;
    return t;
}

function VT_normPath(p) {
    return String(p || '').replace(/\//g, '\\').toLowerCase();
}

/** Video track index of a clip in seq (-1 if not on a video track). */
function VT_videoTrackOf(seq, clip) {
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var tr = seq.videoTracks[t];
        for (var c = 0; c < tr.clips.numItems; c++) {
            if (tr.clips[c].nodeId === clip.nodeId) return t;
        }
    }
    return -1;
}

/**
 * Describe MOGRT clips for a native asset.
 * Returns { ok, reason, clips: [{ name, mediaPath, start, dur, inPoint, track, effects }] }
 * with start/track relative to the earliest clip / lowest track.
 */
function VT_describeMogrtClips(seq, clips) {
    if (!clips || clips.length === 0) return { ok: false, reason: 'no clips' };
    var out = [];
    var minStart = null, minTrack = null;
    for (var i = 0; i < clips.length; i++) {
        var c = clips[i];
        if (!VT_isMgtClip(c)) return { ok: false, reason: 'not-mogrt', clip: c.name || '' };
        var track = VT_videoTrackOf(seq, c);
        if (track < 0) return { ok: false, reason: 'not-mogrt', clip: c.name || '' };
        var cap = VT_captureClipEffects(c);
        if (cap.keyframed.length > 0) return { ok: false, reason: 'keyframes', clip: c.name || '', props: cap.keyframed.join(', ') };
        var mp = '';
        try { mp = c.projectItem ? c.projectItem.getMediaPath() : ''; } catch (mpErr) {}
        var inP = 0;
        try { inP = c.inPoint.seconds; } catch (ipErr) {}
        var st = c.start.seconds;
        out.push({ name: c.name || '', mediaPath: mp, start: st, dur: c.end.seconds - st, inPoint: inP, track: track, effects: cap.effects });
        if (minStart === null || st < minStart) minStart = st;
        if (minTrack === null || track < minTrack) minTrack = track;
    }
    for (var j = 0; j < out.length; j++) {
        out[j].start = Math.round((out[j].start - minStart) * 100000) / 100000;
        out[j].track = out[j].track - minTrack;
    }
    return { ok: true, clips: out };
}

/** Find a project item by media path (cached; full project walk on a miss). */
function VT_findItemByMediaPath(mediaPath) {
    if (!mediaPath) return null;
    var key = VT_normPath(mediaPath);
    if (!$.global.VT_MgtItemCache) $.global.VT_MgtItemCache = {};
    var cached = $.global.VT_MgtItemCache[key];
    if (cached) {
        try { if (cached.treePath !== undefined && VT_normPath(cached.getMediaPath()) === key) return cached; } catch (stale) {}
        delete $.global.VT_MgtItemCache[key];
    }
    var found = null;
    function walk(item, depth) {
        if (found || !item || depth > 12) return;
        for (var i = 0; i < item.children.numItems && !found; i++) {
            var ch = item.children[i];
            if (ch.type === 2) { walk(ch, depth + 1); continue; } // bin
            try {
                if (VT_normPath(ch.getMediaPath()) === key) { found = ch; }
            } catch (gmErr) {}
        }
    }
    walk(app.project.rootItem, 0);
    if (found) $.global.VT_MgtItemCache[key] = found;
    return found;
}

function VT_rememberItem(mediaPath, item) {
    try {
        if (!$.global.VT_MgtItemCache) $.global.VT_MgtItemCache = {};
        if (mediaPath && item) $.global.VT_MgtItemCache[VT_normPath(mediaPath)] = item;
    } catch (e) {}
}

/**
 * Put fresh template instances onto seq and apply the saved values.
 * items[i] is the project item for metaClips[i].
 * Returns { ok, clips: [new clips], error }.
 */
function VT_placeMogrtClips(seq, metaClips, items, baseSeconds, baseTrack) {
    var placed = [];
    for (var i = 0; i < metaClips.length; i++) {
        var mc = metaClips[i];
        var tIdx = baseTrack + (mc.track || 0);
        if (tIdx >= seq.videoTracks.numTracks) {
            vtLog('NATIVE-MOGRT: track V' + (tIdx + 1) + ' does not exist - using V' + seq.videoTracks.numTracks);
            tIdx = seq.videoTracks.numTracks - 1;
        }
        var before = VT_snapshotClips(seq);
        var at = baseSeconds + (mc.start || 0);
        try {
            seq.overwriteClip(items[i], VT_timeAt(at), tIdx, 0);
        } catch (owErr) {
            return { ok: false, clips: placed, error: 'overwriteClip failed: ' + owErr };
        }
        var fresh = VT_waitForNewClips(seq, before, 400);
        var clip = null;
        for (var f = 0; f < fresh.length; f++) {
            if (VT_videoTrackOf(seq, fresh[f]) === tIdx) { clip = fresh[f]; break; }
        }
        if (!clip) return { ok: false, clips: placed, error: 'inserted clip not found on V' + (tIdx + 1) };

        // Trim to the saved in-point and duration
        if (mc.inPoint && mc.inPoint > 0.0005) {
            try { clip.inPoint = VT_timeAt(mc.inPoint); } catch (ipErr) { vtLog('NATIVE-MOGRT: inPoint warn: ' + ipErr); }
        }
        if (mc.dur && mc.dur > 0) {
            try { clip.end = VT_timeAt(clip.start.seconds + mc.dur); } catch (endErr) { vtLog('NATIVE-MOGRT: duration warn: ' + endErr); }
        }

        // Saved parameter values (text, colours, sliders, Motion, Opacity...)
        if (mc.effects && mc.effects.length) {
            var ar = VT_applyEffectPreset({ effects: mc.effects }, [clip]);
            vtLog('NATIVE-MOGRT: values applied to ' + (clip.name || '') + ': ' + ar);
        }
        try { if (LABEL_COLORS.mogrt) clip.label = LABEL_COLORS.mogrt; } catch (lbErr) {}
        placed.push(clip);
    }
    return { ok: true, clips: placed };
}

/**
 * INSERT a MOGRT asset natively.
 * metaJson: the asset's saved description (JSON string) or '' for assets
 * saved before v3.9.3 - their description is then read from the .prproj
 * (imported into the VibeAssets bin, never opened) and returned as `meta`
 * so the panel can store it.
 * placeholderInfo: drop position (drag) or null (double-click: playhead).
 * Returns { success, clipsCount, isNative: true, meta? } or
 *         { success: false, fallback: 'legacy', reason } when this asset
 *         cannot be inserted natively (not MOGRT, keyframes, template missing).
 */
function VT_insertMogrtAsset(assetPath, metaJson, placeholderInfo) {
    var importedSeq = null;
    try {
        vtLog('NATIVE-MOGRT: insert ' + assetPath + (placeholderInfo ? ' (drop)' : ' (playhead)'));
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var t0 = new Date().getTime();

        var dropUndos = 0;

        var meta = null;
        if (metaJson) { try { meta = (typeof metaJson === 'string') ? JSON.parse(metaJson) : metaJson; } catch (mjErr) { meta = null; } }
        var migrated = null;

        // Resolve template project items
        var items = [];
        var missing = false;
        var i;
        if (meta && meta.clips && meta.clips.length) {
            for (i = 0; i < meta.clips.length; i++) {
                items[i] = VT_findItemByMediaPath(meta.clips[i].mediaPath);
                if (!items[i]) missing = true;
            }
        } else {
            missing = true;
        }

        if (missing) {
            // Bring the template(s) in from the asset's .prproj - into the
            // VibeAssets bin, WITHOUT opening the sequence.
            importedSeq = VT_importAssetSeq(assetPath);
            if (!importedSeq) return JSON.stringify({ success: false, fallback: 'legacy', reason: 'import failed' });
            var srcClips = VT_collectAllClips(importedSeq);
            if (!meta || !meta.clips || !meta.clips.length) {
                var d = VT_describeMogrtClips(importedSeq, srcClips);
                if (!d.ok) {
                    vtLog('NATIVE-MOGRT: not a native candidate (' + d.reason + (d.props ? ': ' + d.props : '') + ') - classic path');
                    importedSeq = null; // keep it cached: the classic path reuses it
                    return JSON.stringify({ success: false, fallback: 'legacy', reason: d.reason });
                }
                meta = { clips: d.clips };
                migrated = meta;
            }
            // Map each saved clip to the imported template item (by name, in order)
            var used = {};
            for (i = 0; i < meta.clips.length; i++) {
                if (items[i]) continue;
                for (var s = 0; s < srcClips.length; s++) {
                    if (used[s]) continue;
                    if ((srcClips[s].name || '') === meta.clips[i].name && srcClips[s].projectItem) {
                        items[i] = srcClips[s].projectItem;
                        used[s] = true;
                        VT_rememberItem(meta.clips[i].mediaPath, items[i]);
                        break;
                    }
                }
                if (!items[i]) {
                    return JSON.stringify({ success: false, fallback: 'legacy', reason: 'template "' + meta.clips[i].name + '" not found' });
                }
            }
        }

        // Where to insert
        var baseSeconds, baseTrack = 0;
        var restorePh = null;
        if (placeholderInfo) {
            baseSeconds = parseFloat(placeholderInfo.startSeconds);
            baseTrack = parseInt(placeholderInfo.trackIndex, 10) || 0;
            restorePh = VT_takeLockedPlayhead(seq, null);
            // v3.9.10: take Premiere's placeholder drop back with undo, so the
            // History panel ends up with one "Overwrite" (the MOGRT) instead of
            // Import Clips + Overwrite + Delete + Overwrite + Delete Project Items.
            // Only when nothing of ours was done since the drop (templates were
            // already in the project): an undo must never take back our import.
            if (!missing) {
                try { dropUndos = VT_undoPlaceholderDrop(seq, placeholderInfo); } catch (udErr) { vtLog('NATIVE-MOGRT: undo drop warn: ' + udErr); }
            }
            if (!dropUndos) {
                try {
                    var pc = VT_findPlaceholderClipAt(seq, baseTrack, placeholderInfo);
                    if (pc) { pc.remove(false, false); }
                } catch (phErr) { vtLog('NATIVE-MOGRT: placeholder remove warn: ' + phErr); }
            }
        } else {
            baseSeconds = seq.getPlayerPosition().seconds;
            for (var vt = 0; vt < seq.videoTracks.numTracks; vt++) {
                try { if (seq.videoTracks[vt].isTargeted()) { baseTrack = vt; break; } } catch (tgErr) {}
            }
        }

        var r = VT_placeMogrtClips(seq, meta.clips, items, baseSeconds, baseTrack);
        if (!r.ok) {
            // Remove a partial insert before handing over to the classic path
            var partial = {};
            for (var p = 0; p < r.clips.length; p++) { partial[r.clips[p].nodeId] = true; }
            VT_removeClipsByNodeIds(seq, partial);
            // The classic path needs the placeholder back on the timeline
            if (dropUndos && !r.clips.length) { try { VT_redoPlaceholderDrop(dropUndos); } catch (rdErr) { vtLog('NATIVE-MOGRT: redo drop warn: ' + rdErr); } }
            vtLog('NATIVE-MOGRT: ' + r.error + ' - classic path');
            return JSON.stringify({ success: false, fallback: 'legacy', reason: r.error, meta: migrated });
        }

        try { seq.setSelection(r.clips); } catch (selErr) {}
        // Only when undo could not take the placeholder's project item back
        if (placeholderInfo && VT_findPlaceholderItems().length) { try { VT_cleanupPlaceholdersFromBin(); } catch (clErr) {} }
        if (restorePh !== null) { try { seq.setPlayerPosition(String(restorePh)); } catch (rpErr) {} }

        vtLog('NATIVE-MOGRT: SUCCESS ' + r.clips.length + ' clip(s) in ' + (new Date().getTime() - t0) + 'ms (no clipboard, no sequence switch)');
        return JSON.stringify({ success: true, clipsCount: r.clips.length, isNative: true, meta: migrated });
    } catch (e) {
        vtLog('NATIVE-MOGRT: error: ' + e + (e.line ? ' (line ' + e.line + ')' : ''));
        return JSON.stringify({ success: false, fallback: 'legacy', reason: e.toString() });
    } finally {
        // The template items stay in the VibeAssets bin; the helper sequence goes
        if (importedSeq) { try { VT_purgeAssetSeq(assetPath, importedSeq); } catch (pgErr) {} }
    }
}

/** The .vtbk placeholder clip the user dropped (null if it is not there). */
function VT_findPlaceholderClipAt(seq, trackIdx, info) {
    var tr = seq.videoTracks[trackIdx];
    if (!tr) return null;
    var want = info && info.startTicks ? parseInt(String(info.startTicks), 10) : NaN;
    for (var c = 0; c < tr.clips.numItems; c++) {
        var cl = tr.clips[c];
        if (!cl || !cl.name || !/\.vtbk$/i.test(cl.name)) continue;
        if (isNaN(want)) return cl;
        try { if (Math.abs(parseInt(String(cl.start.ticks), 10) - want) < 100) return cl; } catch (tErr) { return cl; }
    }
    return null;
}

/** Placeholder project items (vt_placeholder*.vtbk) anywhere in the project. */
function VT_findPlaceholderItems() {
    var out = [];
    function walk(item, depth) {
        if (!item || !item.children || depth > 6) return;
        for (var i = 0; i < item.children.numItems; i++) {
            var ch = item.children[i];
            if (ch.type === 2) { walk(ch, depth + 1); continue; }
            if (ch.name && /\.vtbk$/i.test(ch.name)) out.push(ch);
        }
    }
    try { walk(app.project.rootItem, 0); } catch (e) { }
    return out;
}

/** Put the placeholder drop back (redo) when the native insert gives up. */
function VT_redoPlaceholderDrop(n) {
    var qp = VT_getQEProject();
    if (!qp || typeof qp.redo !== 'function') return;
    var was = VT_collapsing;
    VT_collapsing = true;
    try { for (var i = 0; i < n; i++) qp.redo(); } finally { VT_collapsing = was; }
    vtLog('UNDO-DROP: placeholder drop redone for the classic path (' + n + ')');
}

function VT_timelineSignature(seq) {
    var ids = [];
    var t, c;
    for (t = 0; t < seq.videoTracks.numTracks; t++) for (c = 0; c < seq.videoTracks[t].clips.numItems; c++) ids.push(seq.videoTracks[t].clips[c].nodeId);
    for (t = 0; t < seq.audioTracks.numTracks; t++) for (c = 0; c < seq.audioTracks[t].clips.numItems; c++) ids.push(seq.audioTracks[t].clips[c].nodeId);
    return ids.join(',');
}

/**
 * Undo Premiere's own placeholder drop (its "Overwrite" and, when it is a
 * separate step, its "Import Clips") so the insert that follows is the only
 * entry left in the History panel. Every step is verified: one undo must make
 * the placeholder clip disappear, a second one is kept only if it removed
 * nothing but the placeholder's project item - anything else is redone, so a
 * user's own edit can never be taken back. Returns how many undos were kept
 * (0 = nothing undone, the placeholder is still there).
 */
function VT_undoPlaceholderDrop(seq, info) {
    var trackIdx = parseInt(info.trackIndex, 10) || 0;
    if (!VT_findPlaceholderClipAt(seq, trackIdx, info)) return 0;
    var qp = null;
    try { qp = VT_getQEProject(); } catch (qpErr) { qp = null; }
    if (!qp || typeof qp.undo !== 'function') return 0;
    var undos = 0;

    var wasCollapsing = VT_collapsing;
    VT_collapsing = true; // our own undo events must not trigger the group collapse
    try {
        // 1) the Overwrite of the placeholder
        qp.undo();
        if (VT_findPlaceholderClipAt(seq, trackIdx, info)) {
            qp.redo();
            vtLog('UNDO-DROP: placeholder still on the timeline after undo - redone, removing it the old way');
            return 0;
        }
        undos = 1;
        // 2) its Import Clips, when that is a separate history step
        var leftovers = VT_findPlaceholderItems();
        if (leftovers.length) {
            var sigBefore = VT_timelineSignature(seq);
            var countBefore = app.project.rootItem.children.numItems;
            qp.undo();
            var ok = (VT_findPlaceholderItems().length < leftovers.length) &&
                     (VT_timelineSignature(seq) === sigBefore) &&
                     (app.project.rootItem.children.numItems >= countBefore - leftovers.length);
            if (!ok) {
                qp.redo();
                vtLog('UNDO-DROP: second undo was not the placeholder import - redone');
            } else {
                undos = 2;
            }
        }
        vtLog('UNDO-DROP: placeholder drop taken back with ' + undos + ' undo(s) (' + (VT_findPlaceholderItems().length ? 'item left' : 'clean') + ')');
        return undos;
    } catch (e) {
        vtLog('UNDO-DROP: error ' + e);
        return VT_findPlaceholderClipAt(seq, trackIdx, info) ? 0 : Math.max(undos, 1);
    } finally {
        VT_collapsing = wasCollapsing;
    }
}

/**
 * SAVE the selected MOGRT clip(s) as a native asset (v3.9.3).
 * No clipboard and no sequence is opened: the clips are described (template,
 * values, layout) and a .prproj with the same clips is built in a helper
 * sequence that stays closed, rendered for the preview, exported and deleted.
 * Returns { success, isNative: true, meta, previewGenerated, previewPath } or
 *         { success: false, fallback: 'legacy', reason } (not all MOGRT,
 *         keyframes...) so the panel uses the classic save.
 */
function VT_saveMogrtAsset(outputPath, skipPreview) {
    var helper = null, helperName = '', sampleItem = null;
    var origSeqId = null, origPh = null;
    try {
        var seq = app.project.activeSequence;
        if (!seq) return JSON.stringify({ success: false, error: 'No active sequence' });
        var sel = seq.getSelection();
        if (!sel || sel.length === 0) return JSON.stringify({ success: false, error: 'No clips selected' });
        var t0 = new Date().getTime();

        var d = VT_describeMogrtClips(seq, sel);
        if (!d.ok) {
            vtLog('NATIVE-SAVE: classic save needed (' + d.reason + (d.props ? ': ' + d.props : '') + ')');
            return JSON.stringify({ success: false, fallback: 'legacy', reason: d.reason });
        }
        var items = [];
        for (var i = 0; i < sel.length; i++) {
            // describe() keeps selection order, so items line up with d.clips
            items.push(sel[i].projectItem);
            VT_rememberItem(d.clips[i].mediaPath, sel[i].projectItem);
        }

        origSeqId = seq.sequenceID;
        origPh = String(seq.getPlayerPosition().ticks);

        // Helper sequence WITHOUT the New Sequence dialog: seed it with the
        // bundled sample (fast, proven), then remove the seed.
        var extPath = VT_getExtensionPath();
        var samplePath = extPath + '/VideoSampleLong.mp4';
        var bin = VT_getOrCreateAssetsBin();
        if ((new File(samplePath)).exists) {
            app.project.importFiles([samplePath], true, bin, false);
            for (var b = 0; b < bin.children.numItems; b++) {
                var ch = bin.children[b];
                if (ch.name === 'VideoSampleLong.mp4' || ch.name === 'VideoSampleLong') { sampleItem = ch; break; }
            }
        }
        helperName = 'VT_Asset_' + new Date().getTime();
        helper = app.project.createNewSequenceFromClips(helperName, [sampleItem || items[0]], bin);
        if (!helper) return JSON.stringify({ success: false, fallback: 'legacy', reason: 'helper sequence not created' });

        // createNewSequenceFromClips can make the new sequence active - go
        // straight back so nothing changes in the user's timeline.
        try {
            var act = app.project.activeSequence;
            if (!act || act.sequenceID !== origSeqId) {
                try { helper.close(); } catch (hcErr) {}
                app.project.openSequence(origSeqId);
                try { app.project.activeSequence.setPlayerPosition(origPh); } catch (phErr) {}
            }
        } catch (backErr) {}

        VT_removeClipsByNodeIds(helper, VT_snapshotNodeIds(helper));
        if (sampleItem) { try { sampleItem.deleteBin(); sampleItem = null; } catch (sdErr) {} }

        var r = VT_placeMogrtClips(helper, d.clips, items, 0, 0);
        if (!r.ok) return JSON.stringify({ success: false, fallback: 'legacy', reason: r.error });

        // Preview (MOGRT renders slowly - short)
        var previewGenerated = false;
        var previewPath = outputPath.replace(/\.prproj$/i, '.mp4');
        if (!skipPreview) {
            try {
                var presetPath = (extPath + '/VT_Preview_480p.epr').replace(/\//g, '\\');
                if ((new File(presetPath)).exists) {
                    var maxEnd = 0;
                    for (var c = 0; c < r.clips.length; c++) { if (r.clips[c].end.seconds > maxEnd) maxEnd = r.clips[c].end.seconds; }
                    if (maxEnd > VT_PREVIEW_MAX_SECONDS_MOGRT) maxEnd = VT_PREVIEW_MAX_SECONDS_MOGRT;
                    helper.setInPoint(0);
                    helper.setOutPoint(maxEnd);
                    var tr0 = new Date().getTime();
                    helper.exportAsMediaDirect(previewPath, presetPath, app.encoder.ENCODE_IN_TO_OUT);
                    previewGenerated = (new File(previewPath)).exists;
                    vtLog('NATIVE-SAVE: preview ' + (previewGenerated ? 'rendered' : 'NOT rendered') + ' in ' + (new Date().getTime() - tr0) + 'ms');
                }
            } catch (rendErr) { vtLog('NATIVE-SAVE: preview error: ' + rendErr); }
        }

        helper.exportAsProject(outputPath);
        if (!(new File(outputPath)).exists) return JSON.stringify({ success: false, fallback: 'legacy', reason: 'exportAsProject produced no file' });

        vtLog('NATIVE-SAVE: SUCCESS ' + d.clips.length + ' clip(s) in ' + (new Date().getTime() - t0) + 'ms (no clipboard, no sequence opened)');
        return JSON.stringify({
            success: true,
            isNative: true,
            meta: { clips: d.clips },
            outputPath: outputPath,
            previewGenerated: previewGenerated,
            previewPath: previewGenerated ? previewPath : null
        });
    } catch (e) {
        vtLog('NATIVE-SAVE: error: ' + e + (e.line ? ' (line ' + e.line + ')' : ''));
        return JSON.stringify({ success: false, fallback: 'legacy', reason: e.toString() });
    } finally {
        if (sampleItem) { try { sampleItem.deleteBin(); } catch (sd2Err) {} }
        if (helper) { try { VT_purgeAssetSeq(helperName, helper); } catch (pgErr) {} }
        try {
            if (origSeqId) {
                var a2 = app.project.activeSequence;
                if (!a2 || a2.sequenceID !== origSeqId) {
                    app.project.openSequence(origSeqId);
                    try { app.project.activeSequence.setPlayerPosition(origPh); } catch (ph2Err) {}
                }
            }
        } catch (restoreErr) {}
    }
}
