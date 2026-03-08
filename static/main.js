document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const dropZone = document.getElementById('dropZone');
    const fileInput = document.getElementById('fileInput');
    const appContainer = document.getElementById('appContainer');
    const loadingOverlay = document.getElementById('loadingOverlay');
    const pageList = document.getElementById('pageList');
    const mobileMenuBtn = document.getElementById('mobileMenuBtn');
    const sidebar = document.querySelector('.sidebar');

    if (mobileMenuBtn) {
        mobileMenuBtn.addEventListener('click', () => {
            sidebar.classList.toggle('open');
        });
    }

    // Canvas & Settings Elements
    const canvasContainer = document.getElementById('canvasWrapper');
    const canvas = document.getElementById('noteCanvas');
    const ctx = canvas.getContext('2d');
    const penThickness = document.getElementById('penThickness');
    const thicknessVal = document.getElementById('thicknessVal');
    const themeSelect = document.getElementById('themeSelect');
    const paperSelect = document.getElementById('paperSelect');
    const exportPdfBtn = document.getElementById('exportPdfBtn');

    // State
    let pagesData = [];
    let currentPageIndex = 0;

    // Virtual Dimensions (A4 Proportion)
    const CANVAS_WIDTH = 2000;
    const CANVAS_HEIGHT = 2828;
    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;

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

    function handleFileUpload(file) {
        if (!file.name.endsWith('.cnote') && !file.name.endsWith('.zip')) {
            alert('Lütfen geçerli bir .cnote veya .zip dosyası yükleyin.');
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

                pagesData = data.pages;
                if (pagesData.length === 0) {
                    alert('Dosya içinde çözümlenebilecek (.cpage) sayfa bulunamadı.');
                    return;
                }

                // Show App, Hide Dropzone
                dropZone.style.display = 'none';
                appContainer.style.display = 'flex';

                renderPageList();
                loadPage(0);
            })
            .catch(error => {
                loadingOverlay.style.display = 'none';
                console.error('Upload error:', error);
                alert('Dosya yüklenirken bir hata oluştu.');
            });
    }

    // --- UI Render & Interaction ---
    function renderPageList() {
        pageList.innerHTML = '';
        pagesData.forEach((page, index) => {
            const li = document.createElement('li');
            li.innerHTML = `<i class="fa-solid fa-file-signature"></i> Sayfa ${index + 1} <small style="opacity:0.6;margin-left:auto;">(${page.points.length} nk)</small>`;
            li.addEventListener('click', () => {
                loadPage(index);
                // Mobil cihazlarda sayfa seçilince menüyü kapat
                if (window.innerWidth <= 768 && sidebar) {
                    sidebar.classList.remove('open');
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

            const pageImages = pagesData[index].images || [];
            if (pageImages.length > 0) {
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
                canvas.style.cursor = hover ? 'grab' : 'default';
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

        // Clear entire canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const size = parseFloat(penThickness.value);
        thicknessVal.innerText = size.toFixed(1);

        const isDarkMode = document.body.classList.contains('dark-mode');
        ctx.fillStyle = isDarkMode ? '#f0f0f0' : '#111';

        // 1. Draw CNote Base Points
        const currentThemeMode = document.body.classList.contains('dark-mode') ? 'dark' : 'light';

        if (!isBgCached || cachedPageIndex !== currentPageIndex || cachedThickness !== size || cachedThemeMode !== currentThemeMode) {
            bgCacheCanvas.width = canvas.width;
            bgCacheCanvas.height = canvas.height;
            bgCacheCtx.clearRect(0, 0, bgCacheCanvas.width, bgCacheCanvas.height);
            bgCacheCtx.fillStyle = isDarkMode ? '#f0f0f0' : '#111';

            const points = pagesData[currentPageIndex].points;

            // CNote logical canvas is typically around 1404x1984. We scale it up to our 2000x2828 canvas.
            const strokeScaleX = canvas.width / 1404;
            const strokeScaleY = canvas.height / 1984;

            // Draw small rectangles instead of massive complex curved paths for extreme performance
            for (let i = 0; i < points.length; i++) {
                let px = points[i][0] * strokeScaleX;
                let py = points[i][1] * strokeScaleY;
                bgCacheCtx.fillRect(px - size, py - size, size * 2, size * 2);
            }

            cachedPageIndex = currentPageIndex;
            cachedThickness = size;
            cachedThemeMode = currentThemeMode;
            isBgCached = true;
        }

        // Draw Embedded Images FIRST (Under everything)
        const pageImages = pagesData[currentPageIndex].images || [];
        pageImages.forEach(imgData => {
            if (imgData.htmlImage && imgData.htmlImage.complete) {
                // The bounds provided by parser are normalized relative to the page (0.0 - 1.0)
                const x = imgData.rel_x !== undefined ? imgData.rel_x * canvas.width : imgData.x;
                const y = imgData.rel_y !== undefined ? imgData.rel_y * canvas.height : imgData.y;
                const w = imgData.rel_w !== undefined ? imgData.rel_w * canvas.width : imgData.width;
                const h = imgData.rel_h !== undefined ? imgData.rel_h * canvas.height : imgData.height;

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
    // A4 base dimensions in CSS pixels
    const BASE_W = 794;
    const BASE_H = 1123;

    function applyZoom(percent) {
        if (percent < 10) percent = 10;
        if (percent > 500) percent = 500;

        zoomInput.value = percent;
        currentScale = percent / 100;

        // Resize the container div itself — no CSS transform, native scrollbars just work
        const newW = Math.round(BASE_W * currentScale);
        const newH = Math.round(BASE_H * currentScale);

        canvasContainer.style.width = newW + 'px';
        canvasContainer.style.height = newH + 'px';

        // canvas CSS size mirrors container (canvas element renders at internal resolution)
        canvas.style.width = '100%';
        canvas.style.height = '100%';
    }

    zoomInput.addEventListener('change', (e) => {
        applyZoom(parseInt(e.target.value) || 100);
    });

    zoomInBtn.addEventListener('click', () => {
        const currentVal = parseInt(zoomInput.value) || 100;
        applyZoom(currentVal + 5);
    });

    zoomOutBtn.addEventListener('click', () => {
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
            const pdf = new jsPDF({
                orientation: 'portrait',
                unit: 'mm',
                format: 'a4'
            });

            const pdfWidth = pdf.internal.pageSize.getWidth();
            const pdfHeight = (canvasImage.height * pdfWidth) / canvasImage.width;

            pdf.addImage(imgData, 'JPEG', 0, 0, pdfWidth, pdfHeight);
            pdf.save(`CollaNote_Sayfa_${currentPageIndex + 1}.pdf`);

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

});
