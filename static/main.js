document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const appContainer = document.getElementById('appContainer');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const pageList = document.getElementById('pageList');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.querySelector('.sidebar');

    const sidebarBackdrop = document.getElementById('sidebarBackdrop');

    // Mobile menu: opened by the menu button, closed by its ✕, by tapping beside it or Esc
    function setSidebarOpen(open) {
        sidebar.classList.toggle('open', open);
        sidebarBackdrop.classList.toggle('show', open);
    }

    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', () => {
            setSidebarOpen(!sidebar.classList.contains('open'));
        });
    }
    document.getElementById('sidebarCloseBtn').addEventListener('click', () => setSidebarOpen(false));
    sidebarBackdrop.addEventListener('click', () => setSidebarOpen(false));
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && sidebar.classList.contains('open')) setSidebarOpen(false);
    });

    // Canvas & Settings Elements
    const canvasContainer = document.getElementById('canvasWrapper');
    const canvas = document.getElementById('noteCanvas');
    const ctx = canvas.getContext('2d');
    const penThickness = document.getElementById('penThickness');
    const thicknessVal = document.getElementById('thicknessVal');
    const themeSelect = document.getElementById('themeSelect');
    const paperSelect = document.getElementById('paperSelect');
    const pageFormatSelect = document.getElementById('pageFormatSelect');
    const exportPdfBtn = document.getElementById('exportPdfBtn');

    // State
    let pagesData = [];
    let currentPageIndex = 0;
    let keynoteDoc = null; // Open Keynote presentation (.key files are read in the browser)

    // Page formats: canvas resolution and on-screen size at 100% zoom
    const PAGE_FORMATS = {
        'a4-portrait': { width: 2000, height: 2828, baseW: 794, baseH: 1123 },
        '16x9': { width: 2560, height: 1440, baseW: 1123, baseH: 632 },
        '4x3': { width: 2400, height: 1800, baseW: 1000, baseH: 750 }
    };
    let pageFormat = PAGE_FORMATS['a4-portrait'];
    canvas.width = pageFormat.width;
    canvas.height = pageFormat.height;

    // CNote pages use a 1404x1984 logical page
    const CNOTE_WIDTH = 1404;
    const CNOTE_HEIGHT = 1984;

    // Scales a srcW x srcH page to fit the canvas, centred
    function contentFit(srcW, srcH) {
        const scale = Math.min(canvas.width / srcW, canvas.height / srcH);
        return { scale, x: (canvas.width - srcW * scale) / 2, y: (canvas.height - srcH * scale) / 2 };
    }

    function isKeynotePage() {
        const page = pagesData[currentPageIndex];
        return !!(page && page.type === 'key' && keynoteDoc);
    }

    // --- Drag & Drop Handlers ---
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('drag-over');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('drag-over');

        if (e.dataTransfer.files.length > 0) {
            handleFileUpload(e.dataTransfer.files[0]);
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            handleFileUpload(e.target.files[0]);
        }
    });

    async function handleFileUpload(file) {
        const name = file.name.toLowerCase();
        if (name.endsWith('.key') || (name.endsWith('.zip') && await KeynoteReader.looksLikeKeynote(file))) {
            openKeynote(file);
            return;
        }
        if (!name.endsWith('.cnote') && !name.endsWith('.zip')) {
            alert('Lütfen geçerli bir .cnote, .key veya .zip dosyası yükleyin.');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        loadingOverlay.style.display = 'flex';

        fetch('/upload', {
            method: 'POST',
            body: formData
        })
            .then(response => response.json())
            .then(data => {
                loadingOverlay.style.display = 'none';
                if (data.error) {
                    alert('Hata: ' + data.error);
                    return;
                }

                if (data.pages.length === 0) {
                    alert('Dosya içinde çözümlenebilecek (.cpage) sayfa bulunamadı.');
                    return;
                }
                closeKeynote();
                pagesData = data.pages;
                currentPageIndex = 0;
                setPageFormat('a4-portrait');
                slideshowBtn.style.display = 'none';

                // Show App, Hide Dropzone
                dropZone.style.display = 'none';
                appContainer.style.display = 'flex';

                renderPageList();
                loadPage(0);
                fitPageToWindow();
            })
            .catch(error => {
                loadingOverlay.style.display = 'none';
                console.error('Upload error:', error);
                alert('Dosya yüklenirken bir hata oluştu.');
            });
    }

    // Keynote files never leave the browser: they are parsed and drawn locally.
    async function openKeynote(file) {
        loadingOverlay.style.display = 'flex';
        try {
            const doc = await KeynoteReader.open(file);
            closeKeynote();
            keynoteDoc = doc;
            doc.onChange = () => {
                isBgCached = false;
                if (slideshowOpen) renderSlideshow();
                else drawCanvas();
            };
            pagesData = doc.slides.map((slide, i) => ({ type: 'key', slideIndex: i, points: [], images: [] }));
            currentPageIndex = 0;

            const ratio = doc.width / doc.height;
            setPageFormat(ratio < 1 ? 'a4-portrait' : Math.abs(ratio - 4 / 3) < 0.05 ? '4x3' : '16x9');
            setPaper('paper-blank');
            slideshowBtn.style.display = '';

            dropZone.style.display = 'none';
            appContainer.style.display = 'flex';
            renderPageList();
            loadPage(0);
            fitPageToWindow();
        } catch (error) {
            console.error('Keynote error:', error);
            alert('Keynote dosyası açılamadı: ' + error.message);
        } finally {
            loadingOverlay.style.display = 'none';
        }
    }

    function closeKeynote() {
        if (keynoteDoc) keynoteDoc.dispose();
        keynoteDoc = null;
    }

    function setPageFormat(key) {
        if (!PAGE_FORMATS[key]) key = 'a4-portrait';
        pageFormat = PAGE_FORMATS[key];
        pageFormatSelect.value = key;
        if (canvas.width !== pageFormat.width || canvas.height !== pageFormat.height) {
            canvas.width = pageFormat.width;
            canvas.height = pageFormat.height;
        }
        isBgCached = false;
        applyZoom(parseInt(zoomInput.value) || 100);
        drawCanvas();
    }

    // Zooms so the whole page width is visible (never above 100%)
    function fitPageToWindow() {
        const wrapper = document.querySelector('.canvas-container-wrapper');
        const style = getComputedStyle(wrapper);
        // Leave room for the padding and a scrollbar that may appear
        const availableW = wrapper.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 16;
        const availableH = wrapper.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom) - 16;
        if (availableW <= 0) return;
        let ratio = availableW / pageFormat.baseW;
        // Landscape pages (slides) are shown whole; portrait pages fill the width and scroll
        if (pageFormat.baseW > pageFormat.baseH && availableH > 0) {
            ratio = Math.min(ratio, availableH / pageFormat.baseH);
        }
        const percent = Math.floor(Math.min(100, ratio * 100));
        applyZoom(Math.max(10, percent));
        autoFit = true;
    }

    // True while the zoom was picked by fitPageToWindow, so it follows window/rotation changes
    let autoFit = false;
    window.addEventListener('resize', () => {
        if (autoFit && appContainer.style.display !== 'none') fitPageToWindow();
    });

    function setPaper(paperClass) {
        document.body.classList.remove('paper-blank', 'paper-lined', 'paper-grid');
        document.body.classList.add(paperClass);
        paperSelect.value = paperClass;
    }

    // Converts a canvas position into Keynote slide points
    function toSlidePoint(pos) {
        const fit = contentFit(keynoteDoc.width, keynoteDoc.height);
        return { x: (pos.x - fit.x) / fit.scale, y: (pos.y - fit.y) / fit.scale };
    }

    // --- UI Render & Interaction ---
    function renderPageList() {
        pageList.innerHTML = '';
        pagesData.forEach((page, index) => {
            const li = document.createElement('li');
            if (page.type === 'key') {
                li.classList.add('slide-item');
                const thumb = document.createElement('img');
                thumb.className = 'slide-thumb';
                thumb.alt = '';
                keynoteDoc.thumbnailURL(page.slideIndex).then(url => {
                    if (url) thumb.src = url;
                }).catch(() => {});
                const label = document.createElement('span');
                label.className = 'slide-label';
                label.textContent = `Slayt ${index + 1}`;
                const title = keynoteDoc.slideTitle(page.slideIndex);
                if (title) {
                    const small = document.createElement('small');
                    small.textContent = title;
                    label.appendChild(small);
                }
                li.append(thumb, label);
            } else {
                li.innerHTML = `<i class="fa-solid fa-file-signature"></i> Sayfa ${index + 1} <small style="opacity:0.6;margin-left:auto;">(${page.points.length} nk)</small>`;
            }
            li.addEventListener('click', () => {
                loadPage(index);
                // Mobil cihazlarda sayfa seçilince menüyü kapat (style.css ile aynı ölçüt)
                if (window.matchMedia('(max-width: 768px), (max-height: 500px)').matches && sidebar) {
                    setSidebarOpen(false);
                }
            });
            pageList.appendChild(li);
        });
    }

    function loadPage(index) {
        if (index < 0 || index >= pagesData.length) return;

        currentPageIndex = index;

        // Update Sidebar Active state
        document.querySelectorAll('.page-list li').forEach((li, i) => {
            if (i === index) li.classList.add('active');
            else li.classList.remove('active');
        });

        // Load images into gallery and create Image objects for canvas
        const gallery = document.getElementById('imageGallery');
        const galleryHeader = document.getElementById('galleryHeader');
        if (gallery && galleryHeader) {
            gallery.innerHTML = '';
            galleryToken++;
            document.getElementById('galleryTitle').textContent =
                pagesData[index].type === 'key' ? 'Slayttaki Medya' : 'Sayfa Resimleri';

            const pageImages = pagesData[index].images || [];
            if (pagesData[index].type === 'key') {
                gallery.style.display = 'none';
                galleryHeader.style.display = 'none';
                renderKeynoteGallery(index, galleryToken, gallery, galleryHeader);
            } else if (pageImages.length > 0) {
                gallery.style.display = 'grid';
                galleryHeader.style.display = 'block';

                pageImages.forEach((imgData, imgIdx) => {
                    if (!imgData.htmlImage) {
                        const imgObj = new Image();
                        imgObj.src = imgData.src;
                        imgObj.onload = () => { drawCanvas(); };
                        imgData.htmlImage = imgObj;
                    }

                    const thumb = document.createElement('img');
                    thumb.className = 'gallery-thumbnail';
                    thumb.src = imgData.src;
                    thumb.title = `Orijinal Resim ${imgIdx + 1}`;
                    thumb.onclick = () => {
                        const w = window.open("");
                        w.document.write(`<img src="${imgData.src}" style="max-width:100%;">`);
                    };
                    gallery.appendChild(thumb);
                });
            } else {
                gallery.style.display = 'none';
                galleryHeader.style.display = 'none';
            }
        }

        drawCanvas();
    }

    // --- Keynote media (sidebar gallery + video player) ---
    let galleryToken = 0;

    async function renderKeynoteGallery(index, token, gallery, galleryHeader) {
        let media;
        try {
            media = await keynoteDoc.slideMedia(pagesData[index].slideIndex);
        } catch (error) {
            console.warn('Slide media error:', error);
            return;
        }
        if (token !== galleryToken || !media.length) return;

        gallery.style.display = 'grid';
        galleryHeader.style.display = 'block';
        media.forEach(item => {
            const cell = document.createElement('div');
            cell.className = 'gallery-item';
            cell.title = item.name;
            const thumb = document.createElement('img');
            thumb.className = 'gallery-thumbnail';
            if (item.thumb) thumb.src = item.thumb;
            cell.appendChild(thumb);
            if (item.kind === 'movie') {
                const icon = document.createElement('i');
                icon.className = 'fa-solid fa-circle-play gallery-play';
                cell.appendChild(icon);
                cell.onclick = () => openVideo(item.url, item.name);
            } else {
                cell.onclick = () => {
                    const w = window.open("");
                    w.document.write(`<img src="${item.url}" style="max-width:100%;">`);
                };
            }
            gallery.appendChild(cell);
        });
    }

    const videoModal = document.getElementById('videoModal');
    const videoPlayer = document.getElementById('videoPlayer');

    function openVideo(url, name) {
        if (!url) return;
        document.getElementById('videoModalTitle').textContent = name || 'Video';
        videoPlayer.src = url;
        videoModal.style.display = 'flex';
        videoPlayer.play().catch(() => {});
    }

    function closeVideo() {
        videoPlayer.pause();
        videoPlayer.removeAttribute('src');
        videoPlayer.load();
        videoModal.style.display = 'none';
    }

    document.getElementById('videoModalClose').addEventListener('click', closeVideo);
    videoModal.addEventListener('click', (e) => {
        if (e.target === videoModal) closeVideo();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && videoModal.style.display !== 'none') closeVideo();
    });

    // --- Slideshow (Keynote presentation mode) ---
    const slideshowBtn = document.getElementById('slideshowBtn');
    const slideshowEl = document.getElementById('slideshow');
    const slideshowCanvas = document.getElementById('slideshowCanvas');
    const slideshowCtx = slideshowCanvas.getContext('2d');
    const slideshowCounter = document.getElementById('slideshowCounter');
    let slideshowOpen = false;
    let slideshowIndex = 0;
    let slideshowIdleTimer = null;
    let swipeStart = null;
    let lastSwipeTime = 0;

    function fullscreenElement() {
        return document.fullscreenElement || document.webkitFullscreenElement;
    }

    function openSlideshow() {
        if (!keynoteDoc) return;
        slideshowOpen = true;
        slideshowIndex = isKeynotePage() ? pagesData[currentPageIndex].slideIndex : 0;
        slideshowEl.style.display = 'block';
        if (document.activeElement) document.activeElement.blur();

        // Fullscreen the whole page so the video player can still open above the slides
        const root = document.documentElement;
        const request = root.requestFullscreen || root.webkitRequestFullscreen;
        if (request) {
            try {
                const result = request.call(root);
                if (result && result.catch) result.catch(() => {});
            } catch (error) {
                // Not allowed here (e.g. iPhone): the overlay still covers the window
            }
        }
        renderSlideshow();
        wakeSlideshowControls();
    }

    function closeSlideshow() {
        if (!slideshowOpen) return;
        slideshowOpen = false;
        slideshowEl.style.display = 'none';
        clearTimeout(slideshowIdleTimer);
        if (fullscreenElement()) {
            const exit = document.exitFullscreen || document.webkitExitFullscreen;
            const result = exit && exit.call(document);
            if (result && result.catch) result.catch(() => {});
        }
        // Continue in the editor where the presentation stopped
        loadPage(slideshowIndex);
    }

    function showSlide(index) {
        slideshowIndex = Math.max(0, Math.min(keynoteDoc.slides.length - 1, index));
        renderSlideshow();
    }

    function renderSlideshow() {
        if (!slideshowOpen || !keynoteDoc) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.round(slideshowEl.clientWidth * dpr));
        const h = Math.max(1, Math.round(slideshowEl.clientHeight * dpr));
        if (slideshowCanvas.width !== w || slideshowCanvas.height !== h) {
            slideshowCanvas.width = w;
            slideshowCanvas.height = h;
        }
        slideshowCtx.fillStyle = '#000';
        slideshowCtx.fillRect(0, 0, w, h);
        const scale = Math.min(w / keynoteDoc.width, h / keynoteDoc.height);
        keynoteDoc.render(slideshowCtx, slideshowIndex,
            (w - keynoteDoc.width * scale) / 2, (h - keynoteDoc.height * scale) / 2, scale);
        slideshowCounter.textContent = `${slideshowIndex + 1} / ${keynoteDoc.slides.length}`;
        keynoteDoc.preload(slideshowIndex + 1);
    }

    // Shows the control bar and hides it (and the cursor) again after a short pause
    function wakeSlideshowControls() {
        slideshowEl.classList.remove('idle');
        clearTimeout(slideshowIdleTimer);
        slideshowIdleTimer = setTimeout(() => slideshowEl.classList.add('idle'), 2500);
    }

    slideshowBtn.addEventListener('click', openSlideshow);
    document.getElementById('slideshowPrev').addEventListener('click', () => showSlide(slideshowIndex - 1));
    document.getElementById('slideshowNext').addEventListener('click', () => showSlide(slideshowIndex + 1));
    document.getElementById('slideshowExit').addEventListener('click', closeSlideshow);
    slideshowEl.addEventListener('mousemove', wakeSlideshowControls);

    // Click a video to play it, the left third to go back, anywhere else to go forward
    slideshowCanvas.addEventListener('click', (e) => {
        if (Date.now() - lastSwipeTime < 400) return;
        const rect = slideshowCanvas.getBoundingClientRect();
        const scale = Math.min(rect.width / keynoteDoc.width, rect.height / keynoteDoc.height);
        const x = (e.clientX - rect.left - (rect.width - keynoteDoc.width * scale) / 2) / scale;
        const y = (e.clientY - rect.top - (rect.height - keynoteDoc.height * scale) / 2) / scale;
        if (keynoteDoc.isOverMovie(slideshowIndex, x, y)) {
            keynoteDoc.movieAt(slideshowIndex, x, y)
                .then(movie => { if (movie) openVideo(movie.url, movie.name); })
                .catch(error => console.warn('Video error:', error));
            return;
        }
        showSlide(slideshowIndex + (e.clientX - rect.left < rect.width / 3 ? -1 : 1));
    });

    // Swipe left/right on touch screens
    slideshowEl.addEventListener('touchstart', (e) => {
        const t = e.changedTouches[0];
        swipeStart = { x: t.clientX, y: t.clientY };
        wakeSlideshowControls();
    }, { passive: true });

    slideshowEl.addEventListener('touchend', (e) => {
        if (!swipeStart) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - swipeStart.x;
        const dy = t.clientY - swipeStart.y;
        swipeStart = null;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
            lastSwipeTime = Date.now();
            showSlide(slideshowIndex + (dx < 0 ? 1 : -1));
        }
    });

    // Capture phase so these keys never reach the editor while presenting
    document.addEventListener('keydown', (e) => {
        if (!slideshowOpen || videoModal.style.display !== 'none') return;
        if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(e.key)) showSlide(slideshowIndex + 1);
        else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(e.key)) showSlide(slideshowIndex - 1);
        else if (e.key === 'Home') showSlide(0);
        else if (e.key === 'End') showSlide(keynoteDoc.slides.length - 1);
        else if (e.key === 'Escape') closeSlideshow();
        else return;
        e.preventDefault();
        e.stopPropagation();
    }, true);

    // Leaving fullscreen (Esc is handled by the browser there) also ends the presentation
    const onFullscreenChange = () => {
        if (fullscreenElement()) renderSlideshow();
        else closeSlideshow();
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    window.addEventListener('resize', () => {
        if (slideshowOpen) requestAnimationFrame(renderSlideshow);
    });

    const toolEraser = document.getElementById('toolEraser');
    const toolText = document.getElementById('toolText');
    const textToolOptions = document.getElementById('textToolOptions');

    const drawColor = document.getElementById('drawColor');
    const drawThicknessWrap = document.getElementById('drawThicknessWrap');
    const drawThickness = document.getElementById('drawThickness');
    const drawThicknessVal = document.getElementById('drawThicknessVal');
    const imageInput = document.getElementById('imageInput');
    const clearDrawingsBtn = document.getElementById('clearDrawingsBtn');

    // Edit State
    let currentMode = 'cursor'; // 'cursor', 'pen', 'eraser'
    let isDrawing = false;
    let lastX = 0;
    let lastY = 0;
    let userDrawings = []; // Array to store user strokes
    let currentStroke = null;
    let userImages = []; // {img: Image, x, y, width, height...}
    let userTexts = []; // {text: string, x, y, color, size...}
    let draggedItem = null; // Currently selected item
    let isDragging = false; // Is the mouse held down?
    let dragOffsetX = 0;
    let dragOffsetY = 0;

    // Resize Variables
    let isResizing = false;
    let resizeStartX = 0;
    let resizeStartY = 0;
    let resizeStartWidth = 0;
    let resizeStartHeight = 0;
    let resizeStartSize = 0; // For text

    let pendingItem = null; // Can hold image or text object waiting to be placed
    let currentScale = 1.0;

    // --- Tool Selection Logic ---
    function updateToolbarVisibility() {
        const isPenOrText = currentMode === 'pen' || currentMode === 'text';
        const isTextSelected = draggedItem && !draggedItem.img;

        drawColor.style.display = (isPenOrText || isTextSelected) ? 'inline-block' : 'none';
        drawThicknessWrap.style.display = (isPenOrText || isTextSelected) ? 'flex' : 'none';
        textToolOptions.style.display = 'none';

        if (isTextSelected) {
            drawColor.value = draggedItem.color || '#111111';
            drawThickness.value = draggedItem.size / 6;
            drawThicknessVal.innerText = parseFloat(drawThickness.value).toFixed(1);
            if (activeTextEditor && activeTextEditor.txtObject === draggedItem) {
                activeTextEditor.style.color = draggedItem.color;
                const renderRatio = canvas.clientWidth / canvas.width;
                activeTextEditor.style.fontSize = (draggedItem.size * renderRatio) + 'px';
                activeTextEditor.style.height = 'auto';
                activeTextEditor.style.height = activeTextEditor.scrollHeight + 'px';
            }
        }
    }

    let activeTextEditor = null;

    function finalizeTextEditor() {
        if (!activeTextEditor) return;
        const txtItem = activeTextEditor.txtObject;
        txtItem.text = activeTextEditor.value;
        txtItem.isEditing = false;

        if (txtItem.text.trim() === '') {
            userTexts = userTexts.filter(t => t !== txtItem);
            if (draggedItem === txtItem) draggedItem = null;
        }

        if (activeTextEditor.parentNode) {
            activeTextEditor.parentNode.removeChild(activeTextEditor);
        }
        if (activeTextEditor.txtObserver) {
            activeTextEditor.txtObserver.disconnect();
        }
        activeTextEditor = null;
        drawCanvas();
        updateSelectionBox(draggedItem);
    }

    function spawnTextEditor(txtItem) {
        if (activeTextEditor) finalizeTextEditor();

        txtItem.isEditing = true;
        drawCanvas();

        activeTextEditor = document.createElement('textarea');
        activeTextEditor.className = 'inline-text-editor';
        activeTextEditor.value = txtItem.text;
        activeTextEditor.txtObject = txtItem;

        const rect = canvas.getBoundingClientRect();
        const renderRatio = rect.width / canvas.width;
        const metrics = getTextMetrics(ctx, txtItem);

        // Position relative to the canvasWrapper which has position:relative matching the canvas
        const startLeft = (txtItem.x * renderRatio);
        const startTop = ((txtItem.y - txtItem.size) * renderRatio);

        activeTextEditor.style.left = startLeft + 'px';
        activeTextEditor.style.top = startTop + 'px';
        activeTextEditor.style.width = Math.max((metrics.w * renderRatio), 100) + 'px';
        activeTextEditor.style.fontSize = (txtItem.size * renderRatio) + 'px';
        activeTextEditor.style.color = txtItem.color;

        document.getElementById('canvasWrapper').appendChild(activeTextEditor);

        // Auto-resize height
        requestAnimationFrame(() => {
            if (activeTextEditor) {
                activeTextEditor.style.height = 'auto';
                activeTextEditor.style.height = activeTextEditor.scrollHeight + 'px';
            }
        });

        setTimeout(() => {
            if (activeTextEditor) {
                activeTextEditor.focus();
                const len = activeTextEditor.value.length;
                activeTextEditor.setSelectionRange(len, len);
            }
        }, 10);

        activeTextEditor.addEventListener('input', () => {
            activeTextEditor.style.height = 'auto';
            activeTextEditor.style.height = activeTextEditor.scrollHeight + 'px';
            txtItem.text = activeTextEditor.value;
            updateSelectionBox(txtItem);
        });

        const ro = new ResizeObserver(() => {
            if (activeTextEditor) {
                const renderRatio = canvasContainer.clientWidth / canvas.width;
                txtItem.width = activeTextEditor.clientWidth / renderRatio;

                activeTextEditor.style.height = 'auto';
                activeTextEditor.style.height = activeTextEditor.scrollHeight + 'px';

                updateSelectionBox(txtItem);
                drawCanvas();
            }
        });
        ro.observe(activeTextEditor);
        activeTextEditor.txtObserver = ro;

        activeTextEditor.addEventListener('blur', finalizeTextEditor);

        draggedItem = txtItem;
        isDragging = false;
        updateSelectionBox(txtItem);
        updateToolbarVisibility();
    }

    function setActiveTool(mode, element) {
        currentMode = mode;
        pendingItem = null; // Cancel any pending item drop if tool changes

        // Deselect current item so new text doesn't modify the old one
        if (draggedItem) {
            draggedItem = null;
            isDragging = false;
            if (typeof hideSelectionBox === 'function') hideSelectionBox();
            if (typeof drawCanvas === 'function') drawCanvas();
        }

        [toolCursor, toolPen, toolEraser, toolText].forEach(el => {
            if (el) el.classList.remove('active');
        });
        if (element) element.classList.add('active');

        updateToolbarVisibility();

        if (mode === 'text') {
            canvas.style.cursor = 'default';
        } else {
            canvas.style.cursor = mode === 'cursor' ? 'default' : 'crosshair';
        }
    }

    toolCursor.addEventListener('click', () => setActiveTool('cursor', toolCursor));
    toolPen.addEventListener('click', () => setActiveTool('pen', toolPen));
    toolEraser.addEventListener('click', () => setActiveTool('eraser', toolEraser));
    if (toolText) toolText.addEventListener('click', () => setActiveTool('text', toolText));

    // --- Drawing Event Listeners ---
    function getWrappedTextLines(ctx, text, maxW) {
        const hardLines = text.split('\n');
        const outLines = [];
        hardLines.forEach(hLine => {
            let words = hLine.split(' ');
            let currentLine = '';
            for (let i = 0; i < words.length; i++) {
                let testLine = currentLine + words[i] + ' ';
                if (ctx.measureText(testLine).width > maxW && i > 0) {
                    outLines.push(currentLine.trim());
                    currentLine = words[i] + ' ';
                } else {
                    currentLine = testLine;
                }
            }
            outLines.push(currentLine.trim());
        });
        return outLines;
    }

    function getTextMetrics(ctx, txt) {
        ctx.font = `500 ${txt.size}px Outfit`;
        const lines = getWrappedTextLines(ctx, txt.text || ' ', txt.width);
        let realW = 0;
        lines.forEach(l => {
            const w = ctx.measureText(l).width;
            if (w > realW) realW = w;
        });
        return {
            lines: lines,
            w: Math.max(txt.width, realW),
            h: txt.size * lines.length
        };
    }

    function getMousePos(evt) {
        const rect = canvas.getBoundingClientRect();
        return {
            x: (evt.clientX - rect.left) * (canvas.width / rect.width),
            y: (evt.clientY - rect.top) * (canvas.height / rect.height)
        };
    }

    drawColor.addEventListener('input', (e) => {
        if (draggedItem && !draggedItem.img) {
            draggedItem.color = e.target.value;
            drawCanvas();
        }
    });

    drawThickness.addEventListener('input', (e) => {
        drawThicknessVal.innerText = parseFloat(e.target.value).toFixed(1);
        if (draggedItem && !draggedItem.img) {
            draggedItem.size = parseFloat(e.target.value) * 6;
            drawCanvas();
            updateSelectionBox(draggedItem);
            updateToolbarVisibility();
        }
    });

    canvas.addEventListener('dblclick', (e) => {
        if (currentMode !== 'cursor') return;
        e.preventDefault();
        const pos = getMousePos(e);

        for (let i = userTexts.length - 1; i >= 0; i--) {
            const txt = userTexts[i];
            const metrics = getTextMetrics(ctx, txt);

            if (pos.x >= txt.x && pos.x <= txt.x + metrics.w && pos.y >= txt.y - txt.size && pos.y <= txt.y + metrics.h - txt.size) {
                spawnTextEditor(txt);
                break;
            }
        }
    });

    canvas.addEventListener('mousedown', (e) => {
        const pos = getMousePos(e);

        // If an item is waiting to be dropped, place it here and exit
        if (pendingItem) {
            if (pendingItem.type === 'image') {
                userImages.push({
                    img: pendingItem.img,
                    x: pos.x - (pendingItem.width / 2),
                    y: pos.y - (pendingItem.height / 2),
                    width: pendingItem.width,
                    height: pendingItem.height
                });
            }
            pendingItem = null;
            canvas.style.cursor = currentMode === 'cursor' ? 'default' : 'crosshair';
            drawCanvas();
            updateToolbarVisibility();
            return;
        }

        if (currentMode === 'cursor') {
            // First check if click is on the active resize handle (if any)
            const handle = document.getElementById('activeResizeHandle');
            if (handle && handle.style.display !== 'none') {
                const hRect = handle.getBoundingClientRect();
                const cRect = canvas.getBoundingClientRect();
                // Check raw ClientX/Y against handle Rect
                if (e.clientX >= hRect.left && e.clientX <= hRect.right &&
                    e.clientY >= hRect.top && e.clientY <= hRect.bottom) {

                    if (draggedItem) {
                        isResizing = true;
                        resizeStartX = e.clientX;
                        resizeStartY = e.clientY;
                        if (draggedItem.img) {
                            resizeStartWidth = draggedItem.width;
                            resizeStartHeight = draggedItem.height;
                        } else {
                            resizeStartSize = draggedItem.size;
                        }
                        return;
                    }
                }
            }

            let found = false;
            // Check texts first (drawn on top typically visually)
            for (let i = userTexts.length - 1; i >= 0; i--) {
                const txt = userTexts[i];
                const metrics = getTextMetrics(ctx, txt);

                if (pos.x >= txt.x && pos.x <= txt.x + metrics.w && pos.y >= txt.y - txt.size && pos.y <= txt.y + metrics.h - txt.size) {
                    draggedItem = txt;
                    isDragging = true;
                    dragOffsetX = pos.x - txt.x;
                    dragOffsetY = pos.y - txt.y;
                    userTexts.splice(i, 1);
                    userTexts.push(txt);
                    canvas.style.cursor = 'grabbing';
                    found = true;
                    updateSelectionBox(txt);
                    updateToolbarVisibility();
                    break;
                }
            }

            if (!found) {
                // Check images if no text clicked
                for (let i = userImages.length - 1; i >= 0; i--) {
                    const img = userImages[i];
                    if (pos.x >= img.x && pos.x <= img.x + img.width &&
                        pos.y >= img.y && pos.y <= img.y + img.height) {

                        draggedItem = img;
                        isDragging = true;
                        dragOffsetX = pos.x - img.x;
                        dragOffsetY = pos.y - img.y;
                        userImages.splice(i, 1);
                        userImages.push(img);
                        canvas.style.cursor = 'grabbing';
                        found = true;
                        updateSelectionBox(img);
                        updateToolbarVisibility();
                        break;
                    }
                }
            }

            if (!found) {
                hideSelectionBox();
                draggedItem = null;
                isDragging = false;
                updateToolbarVisibility();

                // Clicking a video on a Keynote slide plays it
                if (isKeynotePage()) {
                    const sp = toSlidePoint(pos);
                    keynoteDoc.movieAt(pagesData[currentPageIndex].slideIndex, sp.x, sp.y)
                        .then(movie => { if (movie) openVideo(movie.url, movie.name); })
                        .catch(error => console.warn('Video error:', error));
                }
            }
            return;
        }

        if (currentMode === 'text') {
            e.preventDefault(); // Prevent native canvas focus from instantly blurring the new textarea
            // Check if clicked existing text
            let clickedExisting = false;
            for (let i = userTexts.length - 1; i >= 0; i--) {
                const txt = userTexts[i];
                const metrics = getTextMetrics(ctx, txt);

                if (pos.x >= txt.x && pos.x <= txt.x + metrics.w && pos.y >= txt.y - txt.size && pos.y <= txt.y + metrics.h - txt.size) {
                    spawnTextEditor(txt);
                    clickedExisting = true;
                    break;
                }
            }

            if (!clickedExisting) {
                let newTxt = {
                    text: '',
                    x: pos.x,
                    y: pos.y + (parseFloat(drawThickness.value) * 6), // align baseline
                    color: drawColor.value,
                    size: parseFloat(drawThickness.value) * 6,
                    width: 400,
                    isEditing: true
                };
                userTexts.push(newTxt);
                spawnTextEditor(newTxt);
            }
            return;
        }

        isDrawing = true;
        [lastX, lastY] = [pos.x, pos.y];

        if (currentMode === 'pen') {
            currentStroke = {
                color: drawColor.value,
                size: parseFloat(drawThickness.value) * 3, // Multiplier for canvas scaling
                points: [[pos.x, pos.y]]
            };
            userDrawings.push(currentStroke);
        }
    });

    canvas.addEventListener('mousemove', (e) => {
        const pos = getMousePos(e);

        if (currentMode === 'cursor') {
            if (draggedItem && isDragging && !isResizing) {
                draggedItem.x = pos.x - dragOffsetX;
                draggedItem.y = pos.y - dragOffsetY;
                drawCanvas();
                updateSelectionBox(draggedItem);
            } else if (!isDragging && !isResizing) {
                let hover = false;
                // Hover Check Images
                for (let i = 0; i < userImages.length; i++) {
                    const img = userImages[i];
                    if (pos.x >= img.x && pos.x <= img.x + img.width && pos.y >= img.y && pos.y <= img.y + img.height) {
                        hover = true; break;
                    }
                }
                // Hover Check Texts
                if (!hover) {
                    for (let i = 0; i < userTexts.length; i++) {
                        const txt = userTexts[i];
                        ctx.font = `500 ${txt.size}px Outfit`;

                        const lines = txt.text.split('\n');
                        let maxWidth = 0;
                        lines.forEach(line => {
                            const w = ctx.measureText(line).width;
                            if (w > maxWidth) maxWidth = w;
                        });

                        const w = maxWidth;
                        const h = txt.size * lines.length;

                        if (pos.x >= txt.x && pos.x <= txt.x + w && pos.y >= txt.y - txt.size && pos.y <= txt.y + h - txt.size) {
                            hover = true; break;
                        }
                    }
                }
                let overVideo = false;
                if (!hover && isKeynotePage()) {
                    const sp = toSlidePoint(pos);
                    overVideo = keynoteDoc.isOverMovie(pagesData[currentPageIndex].slideIndex, sp.x, sp.y);
                }
                canvas.style.cursor = hover ? 'grab' : overVideo ? 'pointer' : 'default';
            }
            return;
        }

        if (currentMode === 'text') return; // no mousemove actions for text

        if (!isDrawing) return;

        if (currentMode === 'pen' && currentStroke) {
            currentStroke.points.push([pos.x, pos.y]);

            // Draw ONLY the new line segment (huge performance fix)
            const pts = currentStroke.points;
            if (pts.length > 1) {
                ctx.beginPath();
                ctx.strokeStyle = currentStroke.color;
                ctx.lineWidth = currentStroke.size;
                ctx.lineCap = 'round';
                ctx.lineJoin = 'round';
                ctx.moveTo(pts[pts.length - 2][0], pts[pts.length - 2][1]);
                ctx.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
                ctx.stroke();
            }
        } else if (currentMode === 'eraser') {
            const eraserSize = 25;

            // 1. Erase Drawings
            userDrawings = userDrawings.filter(stroke => {
                return !stroke.points.some(p => {
                    const dx = p[0] - pos.x;
                    const dy = p[1] - pos.y;
                    return Math.sqrt(dx * dx + dy * dy) < eraserSize;
                });
            });

            // 2. Erase Images
            userImages = userImages.filter(img => {
                return !(pos.x >= img.x - eraserSize && pos.x <= img.x + img.width + eraserSize &&
                    pos.y >= img.y - eraserSize && pos.y <= img.y + img.height + eraserSize);
            });

            // 3. Erase Texts
            userTexts = userTexts.filter(txt => {
                const metrics = getTextMetrics(ctx, txt);
                return !(pos.x >= txt.x - eraserSize && pos.x <= txt.x + metrics.w + eraserSize &&
                    pos.y >= txt.y - txt.size - eraserSize && pos.y <= txt.y + metrics.h - txt.size + eraserSize);
            });

            drawCanvas();
        }
    });

    canvas.addEventListener('mouseup', () => {
        isDrawing = false;
        currentStroke = null;
        if (draggedItem) {
            isDragging = false;
            canvas.style.cursor = currentMode === 'cursor' ? 'default' : 'crosshair';
            // Do not null draggedItem here so it remains selected
        }
    });
    canvas.addEventListener('mouseout', () => {
        isDrawing = false;
        currentStroke = null;
        isDragging = false;
    });

    // --- Image Handling ---
    imageInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            const img = new Image();
            img.onload = () => {
                const maxWidth = canvas.width * 0.8;
                let imgWidth = img.width;
                let imgHeight = img.height;

                if (imgWidth > maxWidth) {
                    const ratio = maxWidth / imgWidth;
                    imgWidth = maxWidth;
                    imgHeight = imgHeight * ratio;
                }

                // Switch to cursor tool automatically FIRST
                setActiveTool('cursor', toolCursor);
                canvas.style.cursor = 'copy';

                // Instead of dropping instantly, hold it as pending
                pendingItem = {
                    type: 'image',
                    img: img,
                    width: imgWidth,
                    height: imgHeight
                };

                // Allow user one click to place image
            };
            img.src = event.target.result;
        };
        reader.readAsDataURL(file);
        // Reset file input so picking the same file again triggers change event
        e.target.value = '';
    });

    clearDrawingsBtn.addEventListener('click', () => {
        if (confirm('Kendi çizimlerinizi, yazılarınızı ve eklediğiniz resimleri silmek istediğinize emin misiniz?')) {
            userDrawings = [];
            userImages = [];
            userTexts = [];
            draggedItem = null;
            isDragging = false;
            hideSelectionBox();
            drawCanvas();
        }
    });

    let bgCacheCanvas = document.createElement('canvas');
    let bgCacheCtx = bgCacheCanvas.getContext('2d');
    let isBgCached = false;
    let cachedPageIndex = -1;
    let cachedThickness = -1;
    let cachedThemeMode = null;

    function drawCanvas() {
        if (!pagesData || pagesData.length === 0) return;
        const page = pagesData[currentPageIndex];
        if (!page) return;

        // Clear entire canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const size = parseFloat(penThickness.value);
        thicknessVal.innerText = size.toFixed(1);

        const isDarkMode = document.body.classList.contains('dark-mode');
        ctx.fillStyle = isDarkMode ? '#f0f0f0' : '#111';

        // 1. Draw CNote Base Points (or the Keynote slide)
        const currentThemeMode = document.body.classList.contains('dark-mode') ? 'dark' : 'light';
        const isKey = isKeynotePage();
        const fit = isKey ? contentFit(keynoteDoc.width, keynoteDoc.height) : contentFit(CNOTE_WIDTH, CNOTE_HEIGHT);

        if (!isBgCached || cachedPageIndex !== currentPageIndex ||
            (!isKey && (cachedThickness !== size || cachedThemeMode !== currentThemeMode))) {
            bgCacheCanvas.width = canvas.width;
            bgCacheCanvas.height = canvas.height;
            bgCacheCtx.clearRect(0, 0, bgCacheCanvas.width, bgCacheCanvas.height);
            bgCacheCtx.fillStyle = isDarkMode ? '#f0f0f0' : '#111';

            if (isKey) {
                keynoteDoc.render(bgCacheCtx, page.slideIndex, fit.x, fit.y, fit.scale);
            } else {
                const points = page.points;

                // Draw small rectangles instead of massive complex curved paths for extreme performance
                for (let i = 0; i < points.length; i++) {
                    let px = fit.x + points[i][0] * fit.scale;
                    let py = fit.y + points[i][1] * fit.scale;
                    bgCacheCtx.fillRect(px - size, py - size, size * 2, size * 2);
                }
            }

            cachedPageIndex = currentPageIndex;
            cachedThickness = size;
            cachedThemeMode = currentThemeMode;
            isBgCached = true;
        }

        // Draw Embedded Images FIRST (Under everything)
        const pageImages = page.images || [];
        const pageW = CNOTE_WIDTH * fit.scale, pageH = CNOTE_HEIGHT * fit.scale;
        pageImages.forEach(imgData => {
            if (imgData.htmlImage && imgData.htmlImage.complete) {
                // The bounds provided by parser are normalized relative to the page (0.0 - 1.0)
                const x = imgData.rel_x !== undefined ? fit.x + imgData.rel_x * pageW : imgData.x;
                const y = imgData.rel_y !== undefined ? fit.y + imgData.rel_y * pageH : imgData.y;
                const w = imgData.rel_w !== undefined ? imgData.rel_w * pageW : imgData.width;
                const h = imgData.rel_h !== undefined ? imgData.rel_h * pageH : imgData.height;

                ctx.drawImage(imgData.htmlImage, x, y, w, h);
            }
        });

        // Then output the cached stroke points
        ctx.drawImage(bgCacheCanvas, 0, 0);

        // 2. Draw Built-in Images
        userImages.forEach(item => {
            ctx.drawImage(item.img, item.x, item.y, item.width, item.height);
        });

        // 3. Draw User Strokes
        userDrawings.forEach(stroke => {
            ctx.beginPath();
            ctx.strokeStyle = stroke.color;
            ctx.lineWidth = stroke.size;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (stroke.points.length > 0) {
                ctx.moveTo(stroke.points[0][0], stroke.points[0][1]);
                for (let i = 1; i < stroke.points.length; i++) {
                    ctx.lineTo(stroke.points[i][0], stroke.points[i][1]);
                }
                ctx.stroke();
            }
        });

        // 4. Draw User Texts
        userTexts.forEach(txt => {
            if (txt.isEditing) return; // Hide standard text if textarea is open

            ctx.font = `500 ${txt.size}px Outfit`;
            ctx.fillStyle = txt.color;
            ctx.textBaseline = 'alphabetic';

            const lines = getWrappedTextLines(ctx, txt.text, txt.width || 800);
            lines.forEach((line, i) => {
                ctx.fillText(line, txt.x, txt.y + (i * txt.size));
            });
        });

        // Ensure selection bounding box stays synced when scale changes
        if (draggedItem) updateSelectionBox(draggedItem);
    }

    const zoomInput = document.getElementById('zoomInput');
    const zoomInBtn = document.getElementById('zoomInBtn');
    const zoomOutBtn = document.getElementById('zoomOutBtn');
    const zoomLayer = document.getElementById('zoomLayer');

    // --- Zoom Logic ---
    // Page base dimensions in CSS pixels come from the selected page format
    function applyZoom(percent) {
        if (percent < 10) percent = 10;
        if (percent > 500) percent = 500;

        zoomInput.value = percent;
        currentScale = percent / 100;

        // Resize the container div itself — no CSS transform, native scrollbars just work
        const newW = Math.round(pageFormat.baseW * currentScale);
        const newH = Math.round(pageFormat.baseH * currentScale);

        canvasContainer.style.width = newW + 'px';
        canvasContainer.style.height = newH + 'px';

        // canvas CSS size mirrors container (canvas element renders at internal resolution)
        canvas.style.width = '100%';
        canvas.style.height = '100%';
    }

    zoomInput.addEventListener('change', (e) => {
        autoFit = false;
        applyZoom(parseInt(e.target.value) || 100);
    });

    zoomInBtn.addEventListener('click', () => {
        autoFit = false;
        const currentVal = parseInt(zoomInput.value) || 100;
        applyZoom(currentVal + 5);
    });

    zoomOutBtn.addEventListener('click', () => {
        autoFit = false;
        const currentVal = parseInt(zoomInput.value) || 100;
        applyZoom(currentVal - 5);
    });

    // --- Event Listeners for Settings ---
    penThickness.addEventListener('input', drawCanvas);

    themeSelect.addEventListener('change', (e) => {
        if (e.target.value === 'dark') {
            document.body.classList.add('dark-mode');
        } else {
            document.body.classList.remove('dark-mode');
        }
        drawCanvas();
    });

    paperSelect.addEventListener('change', (e) => {
        document.body.classList.remove('paper-blank', 'paper-lined', 'paper-grid');
        document.body.classList.add(e.target.value);
    });

    pageFormatSelect.addEventListener('change', (e) => {
        setPageFormat(e.target.value);
        fitPageToWindow();
    });

    // --- PDF Export Logic ---
    exportPdfBtn.addEventListener('click', async () => {
        const originalBtnText = exportPdfBtn.innerHTML;
        exportPdfBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Dönüştürülüyor...';
        exportPdfBtn.disabled = true;

        try {
            // Save current zoom, temporarily set to 100% for exact PDF render
            const prevPercent = parseInt(zoomInput.value) || 100;
            applyZoom(100);

            // Allow DOM to update layout before taking screenshot
            await new Promise(r => setTimeout(r, 100));

            const canvasImage = await html2canvas(canvasContainer, {
                scale: 2,
                useCORS: true,
                backgroundColor: window.getComputedStyle(canvasContainer).backgroundColor
            });

            // Restore previous zoom after capture
            applyZoom(prevPercent);

            const imgData = canvasImage.toDataURL('image/jpeg', 1.0);
            const { jsPDF } = window.jspdf;
            // Landscape pages are 297 mm wide with a height that keeps the page's aspect ratio
            const landscape = canvas.width > canvas.height;
            const pdf = new jsPDF({
                orientation: landscape ? 'landscape' : 'portrait',
                unit: 'mm',
                format: landscape ? [297, 297 * canvasImage.height / canvasImage.width] : 'a4'
            });

            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = (canvasImage.height * pdfWidth) / canvasImage.width;

            pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight);
            pdf.save(isKeynotePage() ? `Slayt_${currentPageIndex + 1}.pdf` : `CollaNote_Sayfa_${currentPageIndex + 1}.pdf`);

        } catch (error) {
            console.error('PDF Export Error:', error);
            alert('PDF oluşturulurken bir hata oluştu!');
        } finally {
            exportPdfBtn.innerHTML = originalBtnText;
            exportPdfBtn.disabled = false;
        }
    });

    // --- Selection & Resize Overlay Logic ---
    let selectionBox = document.createElement('div');
    selectionBox.className = 'selection-box';
    selectionBox.style.display = 'none';
    selectionBox.innerHTML = `
        <div class="resize-handle resize-nw" data-handle="nw"></div>
        <div class="resize-handle resize-ne" data-handle="ne"></div>
        <div class="resize-handle resize-sw" data-handle="sw"></div>
        <div class="resize-handle resize-se" data-handle="se"></div>
    `;
    canvasContainer.appendChild(selectionBox);

    let activeHandleType = null;
    let resizeStartObjX = 0;
    let resizeStartObjY = 0;

    selectionBox.addEventListener('mousedown', (e) => {
        if (!draggedItem || currentMode !== 'cursor') return;
        e.preventDefault();
        e.stopPropagation();

        if (e.target.classList.contains('resize-handle')) {
            isResizing = true;
            activeHandleType = e.target.dataset.handle;
            resizeStartX = e.clientX;
            resizeStartY = e.clientY;

            if (draggedItem.img) {
                resizeStartWidth = draggedItem.width;
                resizeStartHeight = draggedItem.height;
                resizeStartObjX = draggedItem.x;
                resizeStartObjY = draggedItem.y;
            } else {
                resizeStartWidth = draggedItem.width || 400;
                resizeStartSize = draggedItem.size;
                resizeStartObjX = draggedItem.x;
            }
        } else {
            // Drag the box
            isDragging = true;
            const bounds = canvas.getBoundingClientRect();
            const pos = {
                x: (e.clientX - bounds.left) * (canvas.width / bounds.width),
                y: (e.clientY - bounds.top) * (canvas.height / bounds.height)
            };
            dragOffsetX = pos.x - draggedItem.x;
            dragOffsetY = pos.y - draggedItem.y;
        }
    });

    window.addEventListener('mousemove', (e) => {
        if (isResizing && draggedItem) {
            const dxScreen = e.clientX - resizeStartX;
            const dyScreen = e.clientY - resizeStartY;
            const renderRatio = canvasContainer.clientWidth / canvas.width;
            const dx = dxScreen / renderRatio;

            if (draggedItem.img) {
                const ratio = resizeStartWidth / resizeStartHeight;
                let newW = resizeStartWidth;
                let newH = resizeStartHeight;
                let newX = resizeStartObjX;
                let newY = resizeStartObjY;

                if (activeHandleType === 'se') {
                    newW = Math.max(20, resizeStartWidth + dx);
                    newH = newW / ratio;
                } else if (activeHandleType === 'nw') {
                    newW = Math.max(20, resizeStartWidth - dx);
                    newH = newW / ratio;
                    newX = resizeStartObjX + (resizeStartWidth - newW);
                    newY = resizeStartObjY + (resizeStartHeight - newH);
                } else if (activeHandleType === 'ne') {
                    newW = Math.max(20, resizeStartWidth + dx);
                    newH = newW / ratio;
                    newY = resizeStartObjY + (resizeStartHeight - newH);
                } else if (activeHandleType === 'sw') {
                    newW = Math.max(20, resizeStartWidth - dx);
                    newH = newW / ratio;
                    newX = resizeStartObjX + (resizeStartWidth - newW);
                }

                draggedItem.width = newW;
                draggedItem.height = newH;
                draggedItem.x = newX;
                draggedItem.y = newY;
            } else {
                // Resize text box wrap-width natively
                let newW = resizeStartWidth;
                let newX = resizeStartObjX;

                if (activeHandleType === 'se' || activeHandleType === 'ne') {
                    newW = Math.max(50, resizeStartWidth + dx);
                } else if (activeHandleType === 'nw' || activeHandleType === 'sw') {
                    newW = Math.max(50, resizeStartWidth - dx);
                    newX = resizeStartObjX + (resizeStartWidth - newW);
                }

                draggedItem.width = newW;
                draggedItem.x = newX;
            }
            drawCanvas();
            updateSelectionBox(draggedItem);
        } else if (isDragging && draggedItem && currentMode === 'cursor') {
            const bounds = canvas.getBoundingClientRect();
            const pos = {
                x: (e.clientX - bounds.left) * (canvas.width / bounds.width),
                y: (e.clientY - bounds.top) * (canvas.height / bounds.height)
            };
            draggedItem.x = pos.x - dragOffsetX;
            draggedItem.y = pos.y - dragOffsetY;
            drawCanvas();
            updateSelectionBox(draggedItem);
        }
    });

    window.addEventListener('mouseup', () => {
        if (isResizing) isResizing = false;
        if (isDragging) isDragging = false;
    });

    selectionBox.addEventListener('wheel', (e) => {
        if (draggedItem && currentMode === 'cursor') {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.95 : 1.05;
            if (draggedItem.img) {
                const newW = draggedItem.width * factor;
                const newH = draggedItem.height * factor;
                draggedItem.x += (draggedItem.width - newW) / 2;
                draggedItem.y += (draggedItem.height - newH) / 2;
                draggedItem.width = Math.max(20, newW);
                draggedItem.height = Math.max(20, newH);
            } else {
                draggedItem.size = Math.max(8, draggedItem.size * factor);
            }
            drawCanvas();
            updateSelectionBox(draggedItem);
        }
    }, { passive: false });

    function updateSelectionBox(item) {
        if (!item) {
            hideSelectionBox();
            return;
        }

        selectionBox.style.display = 'block';

        let itemWidth, itemHeight, yOffset;
        const maxLineW = canvas.width - item.x - 20;

        if (item.img) {
            itemWidth = item.width;
            itemHeight = item.height;
            yOffset = 0;
        } else {
            const metrics = getTextMetrics(ctx, item);
            itemWidth = metrics.w;
            itemHeight = metrics.h;
            yOffset = -item.size;
        }

        const renderRatio = canvasContainer.clientWidth / canvas.width;

        const scaledX = item.x * renderRatio;
        const scaledY = (item.y + yOffset) * renderRatio;
        const scaledW = itemWidth * renderRatio;
        const scaledH = itemHeight * renderRatio;

        selectionBox.style.left = scaledX + 'px';
        selectionBox.style.top = scaledY + 'px';
        selectionBox.style.width = scaledW + 'px';
        selectionBox.style.height = scaledH + 'px';
    }

    function hideSelectionBox() {
        selectionBox.style.display = 'none';
    }
// --- MOBİL DOKUNMATİK (TOUCH) DESTEĞİ KÖPRÜSÜ ---
    function touchToMouse(e) {
        const touch = e.changedTouches[0];
        let type = "";

        switch (e.type) {
            case "touchstart": type = "mousedown"; break;
            case "touchmove":  type = "mousemove"; break;
            case "touchend":   type = "mouseup"; break;
            case "touchcancel": type = "mouseout"; break;
            default: return;
        }

        // Dokunma hareketini, senin kodunun anladığı fare hareketine çeviriyoruz
        const simulatedEvent = new MouseEvent(type, {
            bubbles: true,
            cancelable: true,
            view: window,
            clientX: touch.clientX,
            clientY: touch.clientY,
            screenX: touch.screenX,
            screenY: touch.screenY,
            button: 0 // Sol tık olarak simüle ediyoruz
        });

    touch.target.dispatchEvent(simulatedEvent);

        // --- AKILLI KAYDIRMA (SCROLL) KONTROLÜ ---
        if (e.target === canvas || e.target.closest('.selection-box')) {
            const isHandle = e.target.classList && e.target.classList.contains('resize-handle');
            
            // SADECE şu durumlarda ekranın kaymasını engelle:
            // 1. Kalem veya silgi modundaysak
            // 2. Bir nesne sürükleniyorsa (isDragging) veya boyutu değiştiriliyorsa (isResizing)
            // 3. Doğrudan yeniden boyutlandırma noktalarına dokunuluyorsa
            if (currentMode === 'pen' || currentMode === 'eraser' || isDragging || isResizing || isHandle) {
                if (e.cancelable) e.preventDefault();
            }
        }
    }

    // Touch olaylarını ana elemanlara bağla
    canvas.addEventListener("touchstart", touchToMouse, { passive: false });
    canvas.addEventListener("touchmove", touchToMouse, { passive: false });
    canvas.addEventListener("touchend", touchToMouse, { passive: false });
    canvas.addEventListener("touchcancel", touchToMouse, { passive: false });

    selectionBox.addEventListener("touchstart", touchToMouse, { passive: false });

    // Resim/Yazı taşırken veya büyütürken parmak canvas dışına çıkarsa diye window dinleyicileri
    window.addEventListener("touchmove", (e) => {
        if (isDragging || isResizing) {
            touchToMouse(e);
            if (e.cancelable) e.preventDefault();
        }
    }, { passive: false });

    window.addEventListener("touchend", (e) => {
        if (isDragging || isResizing) {
            touchToMouse(e);
        }
    }, { passive: false });
});
