(function() {
    'use strict';
    
    // Configuration for line markers
    const config = {
        zIndex: 1000,
        fontSize: '15px',
        lineColor: '#6c6c6c',
        fontWeight: 'normal',
        minTopPosition: 120,
        markerClass: 'relative-line-marker',
        caretSelector: '.kix-cursor-caret',
        titleSelector: '.docs-title-outer',
        canvasTileSelector: '.kix-canvas-tile-content',
        editorContainerSelector: '#kix-appview > div.kix-appview-editor-container > div',
        linesToDisplay: 50,
        defaultZoom: 1
    };
    
    // State variables
    let lastCaretRect = null;
    let enabled = false; // current active state (markers shown)
    let globalEnabled = true; // respects Vim enabled toggle
    let lineNumbersPref = true; // respects Line Numbers toggle
    let initialized = false;
    let eventListenersAdded = false;
    let observers = [];
    
    // Pool for reusing marker elements
    const markersPool = [];
    
    // Detect browser environment
    const isBrowser = typeof browser !== 'undefined';
    const api = isBrowser ? browser : chrome;
    
    // Create styles for the markers
    function createStyles() {
        // Only create styles once
        if (document.getElementById('relative-line-numbers-style')) return;
        
        const styleEl = document.createElement('style');
        styleEl.id = 'relative-line-numbers-style';
        styleEl.textContent = `
            .${config.markerClass} {
                position: absolute;
                color: ${config.lineColor};
                font-family: monospace;
                font-weight: ${config.fontWeight};
                z-index: ${config.zIndex};
                font-size: ${config.fontSize};
                pointer-events: none;
                text-align: right;
                width: 30px;
                opacity: 0.8;
                user-select: none;
                will-change: transform;
                transition: top 50ms linear;
            }
        `;
        document.head.appendChild(styleEl);
    }
    
    // Remove all existing markers
    function clearMarkers() {
        const markers = document.querySelectorAll(`.${config.markerClass}`);
        markers.forEach(marker => {
            marker.remove();
            if (markersPool.length < 100) {
                markersPool.push(marker);
            }
        });
    }
    
    // Get current zoom level
    function getZoomLevel() {
        const titleElement = document.querySelector(config.titleSelector);
        return titleElement && titleElement.style.zoom 
               ? parseFloat(titleElement.style.zoom) 
               : config.defaultZoom;
    }
    
    // Create a single marker element
    function createMarker(left, top, text) {
        if (top < config.minTopPosition) return null;
        
        let marker = markersPool.pop();
        if (!marker) {
            marker = document.createElement('div');
            marker.className = config.markerClass;
        } else {
            marker.className = config.markerClass;
        }
        
        marker.textContent = text;
        marker.style.left = `${left}px`;
        marker.style.top = `${top}px`;
        return marker;
    }
    
    // Add markers to the document
    function addMarkers(markers) {
        if (!enabled) return; // Extra check before adding markers
        
        const fragment = document.createDocumentFragment();
        markers.forEach(marker => {
            if (marker) fragment.appendChild(marker);
        });
        document.body.appendChild(fragment);
    }
    
    // Update relative line number markers (instant updates, no throttling)
    function updateLineMarkers() {
        if (!enabled) { clearMarkers(); return; }
        try {
            const caret = document.querySelector(config.caretSelector);
            if (!caret) return;
            const caretRect = caret.getBoundingClientRect();
            if (caretRect.width === 0 && caretRect.height === 0) return;

            const caretTopDoc = caretRect.top + window.scrollY;
            lastCaretRect = { ...caretRect };

            // Clear existing markers
            clearMarkers();

            // Determine left position from canvas tiles if possible
            let lineNumberLeft;
            const tiles = Array.from(document.querySelectorAll(config.canvasTileSelector));
            if (tiles.length) {
                const minLeft = tiles.reduce((min, el) => Math.min(min, el.getBoundingClientRect().left + window.scrollX), Infinity);
                lineNumberLeft = isFinite(minLeft) ? minLeft : 0;
            } else {
                lineNumberLeft = 0;
            }

            // Build a list of candidate line tops near the caret
            const lineTops = getLineTopsNear(caretTopDoc);
            const markers = [];

            if (lineTops.length) {
                // Find nearest index to caretTopDoc
                let idx = 0; let best = Infinity;
                for (let i = 0; i < lineTops.length; i++) {
                    const d = Math.abs(lineTops[i] - caretTopDoc);
                    if (d < best) { best = d; idx = i; }
                }
                for (let off = -config.linesToDisplay; off <= config.linesToDisplay; off++) {
                    if (off === 0) continue;
                    const j = idx + off;
                    if (j < 0 || j >= lineTops.length) continue;
                    const y = lineTops[j];
                    const rel = Math.abs(off);
                    markers.push(createMarker(lineNumberLeft, y, String(rel)));
                }
            } else {
                // Fallback: approximate using caret height and skip gaps between tiles
                const zoomLevel = getZoomLevel();
                const lineHeight = caretRect.height * zoomLevel; // best-effort
                const intervals = getTileVerticalIntervals();
                for (let off = -config.linesToDisplay; off <= config.linesToDisplay; off++) {
                    if (off === 0) continue;
                    let y = caretTopDoc + off * lineHeight;
                    if (!isInAnyInterval(y, intervals)) continue; // skip page gaps
                    const rel = Math.abs(off);
                    markers.push(createMarker(lineNumberLeft, y, String(rel)));
                }
            }

            addMarkers(markers);
        } catch (_) {}
    }

    function getLineTopsNear(centerYDoc) {
        const selectors = [
            '.kix-lineview-content',
            '.kix-lineview',
            '.kix-paragraphrenderer',
            '.kix-paragraphrenderer *[style*="position: absolute"]'
        ];
        const seen = new Set();
        const tops = [];
        const viewMin = window.scrollY - window.innerHeight * 0.5;
        const viewMax = window.scrollY + window.innerHeight * 1.5;
        selectors.forEach(sel => {
            const els = document.querySelectorAll(sel);
            els.forEach(el => {
                const r = el.getBoundingClientRect();
                if (!r || r.height === 0 && r.width === 0) return;
                const top = Math.round(r.top + window.scrollY);
                if (top < viewMin || top > viewMax) return;
                const key = String(top);
                if (!seen.has(key)) { seen.add(key); tops.push(top); }
            });
        });
        tops.sort((a,b)=>a-b);
        return tops;
    }

    function getTileVerticalIntervals() {
        const tiles = Array.from(document.querySelectorAll(config.canvasTileSelector));
        return tiles.map(el => {
            const r = el.getBoundingClientRect();
            return [r.top + window.scrollY, r.bottom + window.scrollY];
        }).sort((a,b)=>a[0]-b[0]);
    }

    function isInAnyInterval(y, intervals) {
        for (let i=0;i<intervals.length;i++) {
            const [a,b] = intervals[i];
            if (y >= a && y <= b) return true;
        }
        return false;
    }
    
    // Handle scroll events (instant updates)
    function handleScroll() {
        if (!enabled) return;
        updateLineMarkers();
    }
    
    // Set up mutation observer to watch for caret changes
    function observeCaretChanges() {
        const caret = document.querySelector(config.caretSelector);
        if (!caret) {
            if (enabled) {
                setTimeout(observeCaretChanges, 1000);
            }
            return null;
        }
        
        const observer = new MutationObserver(() => {
            if (enabled) updateLineMarkers();
        });
        
        observer.observe(caret, { 
            attributes: true, 
            characterData: true, 
            subtree: true 
        });
        
        return observer;
    }
    
    // Observe editor position changes
    function observeEditorChanges() {
        const docContainer = document.querySelector('.kix-appview-editor');
        if (!docContainer) {
            if (enabled) {
                setTimeout(observeEditorChanges, 1000);
            }
            return null;
        }
        
        const observer = new MutationObserver(() => {
            if (enabled) {
                updateLineMarkers(true);
            }
        });
        
        observer.observe(docContainer, { 
            attributes: true,
            attributeFilter: ['style', 'class'],
            childList: true, 
            subtree: true
        });
        
        return observer;
    }
    
    // Add event listeners for user interaction
    function addEventListeners() {
        if (eventListenersAdded) return;
        
        document.addEventListener("keyup", () => {
            if (enabled) updateLineMarkers();
        }, { passive: true });
        
        document.addEventListener("keydown", () => {
            if (enabled) updateLineMarkers();
        }, { passive: true });
        
        document.addEventListener("mouseup", () => {
            if (enabled) updateLineMarkers();
        }, { passive: true });
        
        // Add scroll listeners
        document.addEventListener("scroll", handleScroll, { passive: true });
        window.addEventListener("resize", () => {
            if (enabled) updateLineMarkers(true);
        }, { passive: true });
        
        // Add scroll listener to the editor container
        const editorContainer = document.querySelector(config.editorContainerSelector);
        if (editorContainer) {
            editorContainer.addEventListener("scroll", handleScroll, { passive: true });
        }
        
        // Also monitor more DOM elements for scroll events
        const possibleScrollContainers = document.querySelectorAll('.kix-appview-editor, .docs-scrollable');
        possibleScrollContainers.forEach(container => {
            container.addEventListener("scroll", handleScroll, { passive: true });
        });
        
        eventListenersAdded = true;
    }
    
    // Set up observers for document changes
    function setupObservers() {
        if (observers.length === 0) {
            const caretObserver = observeCaretChanges();
            const editorObserver = observeEditorChanges();
            
            if (caretObserver) observers.push(caretObserver);
            if (editorObserver) observers.push(editorObserver);
        }
    }
    
    // Clean up observers if needed
    function cleanupObservers() {
        observers.forEach(observer => observer.disconnect());
        observers = [];
    }
    
    // Toggle line numbers on/off
    function toggleLineNumbers(showLineNumbers) {
        const wasEnabled = enabled;
        enabled = showLineNumbers;
        
        // If turning off, make sure markers are cleared
        if (!enabled) {
            clearMarkers();
        }
        
        // If turning on from off
        if (enabled && !wasEnabled) {
            if (!initialized) {
                init();
            } else {
                addEventListeners();
                setupObservers();
                updateLineMarkers(true);
            }
        }
        
        return enabled;
    }

    function applyEffectiveEnabled() {
        const effective = !!(globalEnabled && lineNumbersPref);
        toggleLineNumbers(effective);
    }
    
    // Initialize the script when needed
    function init() {
        if (initialized) return;
        
        try {
            createStyles();
            addEventListeners();
            
            if (enabled) {
                setupObservers();
                updateLineMarkers(true);
            }
            
            initialized = true;
        } catch (error) {
            // Silent error handling
        }
    }
    
    // Check storage for initial state
    function checkInitialState() {
        try {
            api.storage.sync.get(["enabled", "lineNumbersEnabled"], (data) => {
                try { globalEnabled = (typeof data.enabled !== 'undefined') ? !!data.enabled : true; } catch (_) { globalEnabled = true; }
                try { lineNumbersPref = (typeof data.lineNumbersEnabled !== 'undefined') ? !!data.lineNumbersEnabled : true; } catch (_) { lineNumbersPref = true; }

                if (globalEnabled && lineNumbersPref) {
                    enabled = true;
                    init();
                }

                // Listen for runtime messages (optional path)
                try {
                    api.runtime.onMessage.addListener((message, sender, sendResponse) => {
                        if (message && message.action === "updateSettings" && message.settings) {
                            if (Object.prototype.hasOwnProperty.call(message.settings, 'enabled')) {
                                globalEnabled = !!message.settings.enabled;
                            }
                            if (Object.prototype.hasOwnProperty.call(message.settings, 'lineNumbersEnabled')) {
                                lineNumbersPref = !!message.settings.lineNumbersEnabled;
                            }
                            applyEffectiveEnabled();
                        }
                        return true;
                    });
                } catch (e) {
                    // ignore
                }

                // Listen to storage changes for instant apply (no tabs permission needed)
                try {
                    api.storage.onChanged.addListener((changes, area) => {
                        if (area !== 'sync') return;
                        if (changes.enabled) globalEnabled = !!changes.enabled.newValue;
                        if (changes.lineNumbersEnabled) lineNumbersPref = !!changes.lineNumbersEnabled.newValue;
                        applyEffectiveEnabled();
                    });
                } catch (e) {
                    // ignore
                }
            });
        } catch (e) {
            // If Browser API is not available, start in enabled mode
            // silent fallback
            enabled = true;
            init();
        }
    }
    
    // Expose API to window
    window.relativeLineNumbers = {
        update: updateLineMarkers,
        toggle: toggleLineNumbers,
        clear: clearMarkers
    };
    
    // Start the initialization process
    checkInitialState();
})();